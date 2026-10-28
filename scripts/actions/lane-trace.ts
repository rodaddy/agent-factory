/**
 * @module scripts/actions/lane-trace
 * @description Emit ONE Langfuse trace for an Actions-lane engine call, LIVE at
 *   the call site.
 *
 *   WHY THIS EXISTS AND WHY IT IS NOT THE WATCHER'S EMITTER. The runner-side
 *   path reconstructs a trace AFTER the fact: the agent writes `events.jsonl`,
 *   the wrapper copies it, the watcher reads it, parses it, and posts to
 *   Langfuse at the ingest boundary. That is the wrong shape and the owner ruled it so
 *   (2026-09-10): the runtime making the model call emits the span, at the call
 *   site, as it happens. A file-based trace appears only after a job ends, leaves
 *   nothing at all when a job dies, is never watchable live, and carries a model
 *   the agent self-reported about itself.
 *
 *   The Forgejo Actions lanes are where that correction is cheapest and safest:
 *   `call-engine.ts` runs in TRUSTED-REF code (the workflow checks out the base
 *   SHA, PR content arrives as data), and it already holds the cliproxyapi key.
 *   There is no untrusted box here, no file, no wrapper, and no reader — so the
 *   only thing standing between a lane and a live trace is this module.
 *
 *   NOT `src/observability/langfuse.ts`. That emitter is built around
 *   `AttemptTraceIdentity`, every field of which is resolved from the watcher's
 *   trusted DB join at the ingest boundary. A Forgejo runner has no database and
 *   no attempt row, so it cannot satisfy that contract and must not pretend to.
 *   What IS reused, deliberately and by copy rather than import: the client
 *   pins, the stripped SDK error listener, and the token-usage guard — each is
 *   a lesson this repo already paid for, and each is noted where it is applied.
 *
 *   THE SHORT-PROCESS TRAP. `langfuse` 3.38.20 defaults to `flushAt: 15` and
 *   `flushInterval: 10s`, so a process that exits promptly drops every queued
 *   event silently. This script's caller writes a reply and exits within
 *   milliseconds, so `flush()` is AWAITED on every path — the single difference
 *   between this working and this being decorative.
 *
 *   SECRETS. The Langfuse keys reach this module through the environment only,
 *   never argv and never a log line. No reply body, no request body, and no
 *   credential is ever placed in a trace: the engine reply can echo a proxy
 *   error, and this module's whole job is observability, not evidence capture.
 *
 * @outputs
 *   - `LaneTracer` -- the emit surface a lane calls
 *   - `createLaneTracer` -- build one, or a loud no-op when unconfigured
 *   - `createRecordingLaneTracer` -- the keyless twin: same bodies, to a file
 *   - `laneTokenUsage` -- the hardened token-count reader for an untrusted body
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Langfuse } from "langfuse";
import { bounded, errorClass, log, traced } from "../../src/log";
import { createActionLog, type LaneLogLevel, laneLogLevel } from "./log";

/** Max characters of any untrusted string this module puts in a trace field. */
const MAX_FIELD = 200;

/** One engine attempt, as the lane observed it. */
export interface LaneAttempt {
	/** 1-based attempt number within this call's bounded retry. */
	attempt: number;
	/** How many attempts the caller is permitted in total. */
	attempts: number;
	/** The model the lane ASKED for. Never an attestation — see `attestedModel`. */
	requestedModel: string;
	/** Bytes of the rendered request body. The size question sf#697 is about. */
	requestBytes: number;
	startedAt: Date;
	endedAt: Date;
	/** `ok`, an HTTP status as `http <n>`, or an error class. Never a body. */
	outcome: string;
	ok: boolean;
	/** The model the PROVIDER reported back, when the reply carried one. */
	attestedModel?: string | undefined;
	usage?: LaneUsage | undefined;
	/** The proxy's own request id, when the hop captured one (Surface C). */
	proxyRequestId?: string | undefined;
}

export interface LaneUsage {
	input: number | null;
	output: number | null;
	total: number | null;
}

export interface LaneTracer {
	/** Record one attempt. Never throws, never blocks the lane. */
	attempt(a: LaneAttempt): void;
	/** Flush queued events. MUST be awaited before the process exits. */
	flush(): Promise<void>;
}

/**
 * A TOKEN COUNT from an untrusted body: a non-negative safe integer, or null.
 *
 * Copied deliberately from `src/observability/event-stream.ts` rather than
 * imported, because the lesson travels with the code: a bare finite check let a
 * runner's `-7` and `1e300` pass straight into Langfuse usage fields (PR #176,
 * Sol gauntlet P2). A negative count corrupts every aggregate it lands in, and a
 * magnitude past `MAX_SAFE_INTEGER` is not faithfully the integer it claims to
 * be. The proxy reply is the same class of untrusted input as a runner artifact:
 * nonsense reads as "unknown", never as a clamped number an operator would take
 * for a measurement.
 */
function tokenCount(rec: Record<string, unknown> | null, key: string): number | null {
	const value = rec?.[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Token usage and the attested model out of a chat-completions reply body.
 *
 * Returns nothing rather than guessing: a body this module cannot parse is not
 * an error here — `extractReply` in `post-pr-review.ts` owns interpreting the
 * reply, and a shape this module does not understand is not this module's to
 * reject. Both OpenAI spellings are read (`prompt_tokens`/`input_tokens`)
 * because the proxy fronts several upstreams and normalizes neither.
 */
/**
 * The proxy's `model` is UNTRUSTED free text, and it does not stay in the
 * process: it reaches the lane trace AND rides to Langfuse as `attested_model`
 * (see `laneSpan` below). Bounding a string to MAX_FIELD does not mask a
 * secret inside it, so a proxy that placed a credential in `model` published
 * it twice (round 7).
 *
 * A CHARACTER allowlist is not enough either: `sk-proj-...`, `AKIA...` and
 * `ghp_...` are letters, digits and dashes, so every credential shape passes a
 * shape test (round 8). No regex separates "a model id" from
 * "an API key" -- they are the same alphabet.
 *
 * So this does not try. The attestation answers ONE question: did the proxy
 * serve the model the lane asked for? That is a COMPARISON against a value
 * this repo controls, never an echo of what the proxy sent.
 *
 *   equal to the requested model -> that string, which came from our own config
 *   anything else                -> `"<unattested>"`, the FACT of a mismatch
 *   absent, empty, or non-string -> undefined, no attestation at all
 *
 * A mismatching name loses its detail. It is also the one value that cannot be
 * trusted to be a name, and "the proxy served something other than what we
 * asked for" is the actionable half of that signal.
 */
const MODEL_MISMATCH = "<unattested>";

function attestedModelOf(value: unknown, requested: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const want = requested?.trim();
	if (want === undefined || want === "") return MODEL_MISMATCH;
	return trimmed === want ? want : MODEL_MISMATCH;
}

function laneTokenUsageImpl(
	raw: string,
	requestedModel?: string,
): { usage?: LaneUsage; attestedModel?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	const body = asRecord(parsed);
	if (body === null) return {};
	const usageRec = asRecord(body.usage);
	const model = attestedModelOf(body.model, requestedModel);

	if (usageRec === null) {
		return model === undefined ? {} : { attestedModel: model };
	}
	const input = tokenCount(usageRec, "prompt_tokens") ?? tokenCount(usageRec, "input_tokens");
	const output = tokenCount(usageRec, "completion_tokens") ?? tokenCount(usageRec, "output_tokens");
	const usage: LaneUsage = {
		input,
		output,
		total: tokenCount(usageRec, "total_tokens"),
	};
	return model === undefined ? { usage } : { usage, attestedModel: model };
}

/**
 * `raw` is redacted: it is the engine's whole reply body, and a rejected proxy
 * call echoes a credential there. The result is token counts and the
 * attested model name only, which is exactly what the trace is for.
 */
export const laneTokenUsage = traced("actions.laneTokenUsage", laneTokenUsageImpl, {
	redact: { args: [0] },
});

export interface LaneTraceSettings {
	baseUrl: string;
	publicKey: string;
	secretKey: string;
	/** Owning repository, e.g. `rodaddy/software-factory`. */
	repository: string;
	/** The lane, e.g. `pr-review`. Names the trace and tags it. */
	lane: string;
	/** The PR or issue number the lane is acting on, when there is one. */
	itemNumber?: string | undefined;
	/** The head SHA. THE correlation key every lane line already carries. */
	sha?: string | undefined;
	/** A link back to the Forgejo run, so a trace is one click from its job. */
	runUrl?: string | undefined;
	/** The lane's FACTORY_LOG_LEVEL; absent reads as `info`. */
	logLevel?: LaneLogLevel | undefined;
}

/**
 * Read the three Langfuse vars plus the lane's identity from the environment.
 *
 * Returns null when ANY credential field is absent or blank, which DISABLES
 * emission. That is the same contract as `loadLangfuseSettings` in the service,
 * and for the same reason: an unconfigured environment is a normal state, not a
 * fault. What is NOT the same is the silence — see `createLaneTracer`.
 */
function loadLaneTraceSettingsImpl(env: NodeJS.ProcessEnv = process.env): LaneTraceSettings | null {
	const baseUrl = env.LANGFUSE_BASE_URL?.trim() ?? "";
	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() ?? "";
	const secretKey = env.LANGFUSE_SECRET_KEY?.trim() ?? "";
	if (baseUrl === "" || publicKey === "" || secretKey === "") return null;
	return { baseUrl, publicKey, secretKey, ...loadLaneTraceIdentityImpl(env) };
}

/**
 * What a lane trace is ABOUT, with the Langfuse fields optional: enough to
 * RENDER a batch, never to post one. Under D25 the job that renders
 * holds no key, so render takes this, not `LaneTraceSettings`.
 */
export type LaneTraceIdentity = Omit<LaneTraceSettings, "baseUrl" | "publicKey" | "secretKey"> &
	Partial<Pick<LaneTraceSettings, "baseUrl" | "publicKey" | "secretKey">>;

/** The lane's identity from the same env `open`/`close` read, no keys required. */
function loadLaneTraceIdentityImpl(env: NodeJS.ProcessEnv = process.env): LaneTraceIdentity {
	return {
		repository: env.REPO?.trim() ?? "unknown",
		lane: env.LANE?.trim() ?? "engine",
		itemNumber: env.PR?.trim() || undefined,
		sha: env.HEAD_SHA?.trim() || undefined,
		runUrl: env.RUN_URL?.trim() || undefined,
		logLevel: laneLogLevel(env),
	};
}

/** The env argument is redacted (it carries every credential the job holds). */
export const loadLaneTraceIdentity: (env?: NodeJS.ProcessEnv) => LaneTraceIdentity = traced(
	"actions.loadLaneTraceIdentity",
	loadLaneTraceIdentityImpl,
	{ redact: { args: [0] } },
);

/**
 * BOTH ENDS ARE REDACTED. The argument is the whole process environment, which
 * carries `LANGFUSE_SECRET_KEY` alongside every other credential the job holds;
 * the result carries `secretKey` and `publicKey` as fields. Either one in a
 * trace is a live credential in the lane log.
 */
export const loadLaneTraceSettings: (env?: NodeJS.ProcessEnv) => LaneTraceSettings | null = traced(
	"actions.loadLaneTraceSettings",
	loadLaneTraceSettingsImpl,
	{ redact: { args: [0], result: true } },
);

/** A tracer that records nothing, for the unconfigured case. */
function noopTracer(): LaneTracer {
	return {
		attempt: () => {},
		flush: async () => {},
	};
}

/** The disabled-path warning, shared by the engine tracer and the verdict trace. */
function warnDisabled(): void {
	log("warn", "lane.trace.disabled", {
		reason: "LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is absent",
	});
}

/**
 * Build the SDK client with the service's pins and the stripped error listener,
 * or null when construction throws. Shared by the engine tracer and the verdict
 * trace, so each lesson below is applied once.
 */
function laneClient(settings: LaneTraceSettings): Langfuse | null {
	let client: Langfuse;
	try {
		client = new Langfuse({
			baseUrl: settings.baseUrl,
			publicKey: settings.publicKey,
			secretKey: settings.secretKey,
			// The service's own pins (`src/observability/langfuse.ts`): one retry, a
			// short timeout. A lane must never spend its budget on its own telemetry.
			fetchRetryCount: 1,
			fetchRetryDelay: 1000,
			requestTimeout: 2000,
			// A short-lived process: queue nothing waiting for a batch that will never
			// fill. `flush()` is awaited by the caller regardless.
			flushAt: 1,
		});
	} catch (error) {
		log("warn", "lane.trace.client_failed", { error_class: errorClass(error) });
		return null;
	}

	// Drop the SDK's built-in console.error listener, then stay silent on its
	// event channel. `langfuse-core` 3.38.20 keeps listeners on a plain object at
	// `_events.events` keyed by name — read from source, because an earlier guess
	// at a `Map` compiled, read correctly, and would have done nothing. Guarded so
	// a reshaped emitter in a future version degrades to one extra console line,
	// never a throw at startup.
	//
	// AND SUBSCRIBE BOTH CHANNELS: this SDK emits background flush failures as
	// "warning", NOT "error" (AGENTS.md known traps — an unreachable or 401
	// Langfuse is otherwise completely invisible: 20 queued events, 2 warning
	// emissions, 0 log lines).
	try {
		const events = (client as unknown as { _events?: { events?: Record<string, unknown[]> } })
			._events?.events;
		if (events !== undefined) events.error = [];
	} catch {
		// A reshaped emitter is not a reason to fail a review.
	}
	for (const channel of ["error", "warning"] as const) {
		try {
			(client as unknown as { on?: (e: string, f: (v: unknown) => void) => void }).on?.(
				channel,
				(value: unknown) => {
					log("warn", "lane.trace.sdk_event", {
						channel,
						// CLASS OR BOUNDED TEXT ONLY: an SDK message can quote the request
						// it failed on, and that request carries the review payload.
						detail: value instanceof Error ? errorClass(value) : bounded(value, MAX_FIELD),
					});
				},
			);
		} catch {
			// Same reasoning as above.
		}
	}
	return client;
}

/**
 * One engine attempt's generation metadata. `log_level` names the level the
 * lane ran at; at `debug` the metadata additionally carries a `debug`
 * block of what the lane already knows -- rendered request size, requested
 * model, start/end/duration -- and the same block goes to the lane log as a
 * `debug` line. Never prompt text, a payload body, or a credential.
 */
function laneAttemptMetadataImpl(a: LaneAttempt, logLevel: LaneLogLevel): Record<string, unknown> {
	const durationMs = a.endedAt.getTime() - a.startedAt.getTime();
	const metadata: Record<string, unknown> = {
		attempt: a.attempt,
		attempts: a.attempts,
		requested_model: a.requestedModel,
		attested_model: a.attestedModel ?? null,
		model_is_attested: a.attestedModel !== undefined,
		// THE MEASUREMENT sf#697 IS ABOUT: payload size against duration,
		// per attempt, in a place a human can group and sort.
		request_bytes: a.requestBytes,
		duration_ms: durationMs,
		outcome: a.outcome,
		ok: a.ok,
		// Surface C: joins this span to cliproxyapi's own log line, which
		// is the only place the proxy's internal retry fan-out is visible.
		proxy_request_id: a.proxyRequestId ?? null,
		log_level: logLevel,
	};
	if (logLevel === "debug") {
		const debug = {
			request_bytes: a.requestBytes,
			requested_model: a.requestedModel,
			started_at: a.startedAt.toISOString(),
			ended_at: a.endedAt.toISOString(),
			duration_ms: durationMs,
		};
		metadata.debug = debug;
		createActionLog().debug("lane.trace.attempt", { attempt: a.attempt, ...debug });
	}
	return metadata;
}

export const laneAttemptMetadata = traced("actions.laneAttemptMetadata", laneAttemptMetadataImpl);

/**
 * Build the lane tracer, or a LOUD no-op when Langfuse is unconfigured.
 *
 * THE LOUDNESS IS THE POINT. `_DOCS/STANDARDS-observability.md` opens with
 * "absence of a log line must never be used as proof of success", and a tracer
 * that quietly does nothing is indistinguishable from a lane that never ran —
 * which is precisely the state this whole issue was filed about. So the disabled
 * path says so, every time, naming which field was missing, and the enabled path
 * says so too.
 */
/** The three client calls the engine tracer makes; the real SDK client or a test fake. */
export interface EngineTraceClient {
	trace(body: object): unknown;
	generation(body: object): unknown;
	flushAsync(): Promise<void>;
}

export interface EngineTracerDeps {
	/** Injected in tests; the real SDK client otherwise. */
	client?: EngineTraceClient;
	now?: () => Date;
}

/** The engine trace id: per call, so a clock part is right here (unlike `laneTraceId`). */
function engineTraceId(identity: LaneTraceIdentity, now: Date): string {
	return `lane-${identity.lane}-${identity.sha ?? "nosha"}-${now.getTime()}`;
}

/**
 * THE ONE SOURCE for the engine trace body: the live tracer hands it to
 * `client.trace`, the recording tracer wraps it as `trace-create`.
 */
function engineTraceBody(identity: LaneTraceIdentity, traceId: string, now: Date): Body {
	return {
		id: traceId,
		name: `${identity.lane} #${identity.itemNumber ?? "-"}`,
		timestamp: now,
		sessionId: identity.sha === undefined ? undefined : `sha-${identity.sha}`,
		tags: verdictTags(identity),
		metadata: {
			repository: identity.repository,
			lane: identity.lane,
			item_number: identity.itemNumber,
			sha: identity.sha,
			run_url: identity.runUrl,
			log_level: identity.logLevel ?? "info",
			// Names the shape for a reader: this trace was emitted BY THE CALLER at
			// the call site, not reconstructed from an artifact after the fact.
			emission: "direct",
		},
	};
}

/**
 * THE ONE SOURCE for one attempt's generation body: the live tracer hands it to
 * `client.generation`, the recording tracer wraps it as `generation-create`.
 */
function engineAttemptBody(identity: LaneTraceIdentity, traceId: string, a: LaneAttempt): Body {
	return {
		// An explicit id, like the lane span's: a curl-posted batch has no SDK
		// to assign one, and both paths must post the same body.
		id: `${traceId}-attempt-${a.attempt}`,
		traceId,
		name: `engine attempt ${a.attempt}/${a.attempts}`,
		startTime: a.startedAt,
		endTime: a.endedAt,
		// The PROVIDER-attested model when the reply carried one; the
		// requested model otherwise, and the metadata says which is which.
		model: a.attestedModel ?? a.requestedModel,
		usage:
			a.usage === undefined
				? undefined
				: {
						input: a.usage.input ?? undefined,
						output: a.usage.output ?? undefined,
						total: a.usage.total ?? undefined,
						unit: "TOKENS",
					},
		metadata: laneAttemptMetadataImpl(a, identity.logLevel ?? "info"),
	};
}

function createLaneTracerImpl(
	settings: LaneTraceSettings | null,
	deps: EngineTracerDeps = {},
): LaneTracer {
	if (settings === null) {
		warnDisabled();
		return noopTracer();
	}
	const client = deps.client ?? laneClient(settings);
	if (client === null) return noopTracer();

	const now = (deps.now ?? (() => new Date()))();
	const traceId = engineTraceId(settings, now);

	try {
		client.trace(engineTraceBody(settings, traceId, now));
	} catch (error) {
		log("warn", "lane.trace.open_failed", { error_class: errorClass(error) });
		return noopTracer();
	}

	log("info", "lane.trace.enabled", {
		base_url: settings.baseUrl,
		trace_id: traceId,
		lane: settings.lane,
		sha: settings.sha,
	});

	return {
		attempt(a: LaneAttempt): void {
			try {
				client.generation(engineAttemptBody(settings, traceId, a));
			} catch (error) {
				// Telemetry never fails a review.
				log("warn", "lane.trace.attempt_failed", { error_class: errorClass(error) });
			}
		},
		async flush(): Promise<void> {
			try {
				await client.flushAsync();
				log("info", "lane.trace.flushed", { trace_id: traceId });
			} catch (error) {
				log("warn", "lane.trace.flush_failed", { error_class: errorClass(error) });
			}
		},
	};
}

/**
 * The ARGUMENT is redacted: `LaneTraceSettings` carries `secretKey` and
 * `publicKey`, the Langfuse credentials this module's header says reach it
 * through the environment and never a log line. The result is the tracer
 * object (two closures), which carries nothing sensitive.
 */
export const createLaneTracer = traced("actions.createLaneTracer", createLaneTracerImpl, {
	redact: { args: [0] },
});

/**
 * The four client calls the verdict trace makes. Method syntax on purpose: it
 * lets the real `Langfuse` client and a test's recording fake both satisfy it.
 */
export interface LaneTraceClient {
	trace(body: object): unknown;
	span(body: object): unknown;
	_updateSpan(body: object): unknown;
	flushAsync(): Promise<void>;
}

/** The verdict a lane posted: its commit-status state and description. */
export interface LaneVerdict {
	/** `success`, `failure`, `error`, `pending`, `warning`, as the lane posted it. */
	state: string;
	description?: string | undefined;
}

export interface LaneTraceDeps {
	/** Injected in tests; the real SDK client otherwise. */
	client?: LaneTraceClient;
	now?: () => Date;
}

/**
 * The trace id of a lane run, derived from the lane, the head SHA and the
 * Forgejo run number ONLY.
 *
 * A workflow opens the trace in its first step and closes it in its last, and
 * those are different processes: nothing can be handed from one to the other
 * except the environment both already share. So the id is a pure function of
 * that environment -- no clock, no random part -- and the close step recomputes
 * exactly the id the open step used. Absent fields become named placeholders
 * (`nosha`, `norun`), never a timestamp that would split one run into two.
 */
function laneTraceIdImpl(settings: Pick<LaneTraceSettings, "lane" | "sha" | "runUrl">): string {
	const run = settings.runUrl?.match(/\/runs\/(\d+)\/?$/)?.[1] ?? "norun";
	return `lane-${settings.lane}-${settings.sha ?? "nosha"}-${run}`;
}

/**
 * The argument is redacted: callers pass the whole `LaneTraceSettings`, which
 * carries `secretKey` and `publicKey`. The id itself carries nothing sensitive.
 */
export const laneTraceId = traced("actions.laneTraceId", laneTraceIdImpl, {
	redact: { args: [0] },
});

/** The lane's one span: named from the trace so open and close agree. */
function laneSpanId(traceId: string): string {
	return `${traceId}-lane`;
}

function verdictTags(settings: LaneTraceIdentity): string[] {
	const tags = [`lane:${settings.lane}`, `repo:${settings.repository}`];
	if (settings.itemNumber !== undefined) tags.push(`item:${settings.itemNumber}`);
	return tags;
}

type Body = Record<string, unknown>;

/**
 * THE ONE SOURCE for what an open sends: the trace body and the lane
 * span body. The SDK path hands these to `client.trace`/`client.span`; the
 * render path wraps the same objects as ingestion events. Neither re-derives.
 */
function openBodies(
	identity: LaneTraceIdentity,
	now: Date,
): { traceId: string; trace: Body; span: Body } {
	const traceId = laneTraceIdImpl(identity);
	return {
		traceId,
		trace: {
			id: traceId,
			name: `${identity.lane} #${identity.itemNumber ?? "-"}`,
			timestamp: now,
			sessionId: identity.sha === undefined ? undefined : `sha-${identity.sha}`,
			tags: verdictTags(identity),
			metadata: {
				repository: identity.repository,
				lane: identity.lane,
				item_number: identity.itemNumber,
				sha: identity.sha,
				run_url: identity.runUrl,
				log_level: identity.logLevel ?? "info",
				emission: "direct",
			},
		},
		span: { id: laneSpanId(traceId), traceId, name: identity.lane, startTime: now },
	};
}

/** THE ONE SOURCE for what a close sends: the span update and the trace upsert. */
function closeBodies(
	identity: LaneTraceIdentity,
	verdict: LaneVerdict,
	now: Date,
): { traceId: string; state: string; span: Body; trace: Body } {
	const traceId = laneTraceIdImpl(identity);
	const state = bounded(verdict.state, MAX_FIELD);
	const output =
		verdict.description === undefined
			? { state }
			: { state, description: bounded(verdict.description, MAX_FIELD) };
	const level =
		state === "success"
			? "DEFAULT"
			: state === "failure" || state === "error"
				? "ERROR"
				: "WARNING";
	return {
		traceId,
		state,
		span: { id: laneSpanId(traceId), traceId, endTime: now, output, level, statusMessage: state },
		trace: { id: traceId, output, tags: [...verdictTags(identity), `verdict:${state}`] },
	};
}

/** One event of Langfuse's `POST /api/public/ingestion` batch. */
export interface IngestionEvent {
	id: string;
	timestamp: string;
	type: "trace-create" | "span-create" | "span-update" | "generation-create";
	body: Body;
}

/**
 * Wrap a body as an ingestion event. The JSON round trip is what the SDK's own
 * wire does: a Date becomes its ISO string and an undefined field is dropped.
 */
function ingestionEvent(type: IngestionEvent["type"], body: Body, now: Date): IngestionEvent {
	return {
		id: crypto.randomUUID(),
		timestamp: now.toISOString(),
		type,
		body: JSON.parse(JSON.stringify(body)) as Body,
	};
}

/**
 * RENDER the open batch with no key (D25): a credential-free job runs
 * this, a credential job posts the JSON with curl and runs no repository code.
 */
function renderOpenBatchImpl(identity: LaneTraceIdentity, now: Date): { batch: IngestionEvent[] } {
	const b = openBodies(identity, now);
	return {
		batch: [
			ingestionEvent("trace-create", b.trace, now),
			ingestionEvent("span-create", b.span, now),
		],
	};
}

/** RENDER the close batch: the same span update and trace upsert `closeLaneTrace` sends. */
function renderCloseBatchImpl(
	identity: LaneTraceIdentity,
	verdict: LaneVerdict,
	now: Date,
): { batch: IngestionEvent[] } {
	const b = closeBodies(identity, verdict, now);
	return {
		batch: [
			ingestionEvent("span-update", b.span, now),
			ingestionEvent("trace-create", b.trace, now),
		],
	};
}

/** Argument 0 is redacted: a caller may pass full settings that carry the keys. */
export const renderOpenBatch = traced("actions.renderOpenBatch", renderOpenBatchImpl, {
	redact: { args: [0] },
});
export const renderCloseBatch = traced("actions.renderCloseBatch", renderCloseBatchImpl, {
	redact: { args: [0] },
});

/**
 * The engine tracer with NO Langfuse key (D25): the same `LaneTracer`
 * surface, recording the bodies the live tracer would send -- from the same
 * builders -- as one ingestion batch. `flush()` writes `<outDir>/<traceId>.json`
 * for a curl-only credential job to post. A write failure is logged and
 * swallowed: telemetry never fails a lane.
 */
function createRecordingLaneTracerImpl(
	identity: LaneTraceIdentity,
	outDir: string,
	deps: Pick<EngineTracerDeps, "now"> = {},
): LaneTracer {
	const clock = deps.now ?? (() => new Date());
	const now = clock();
	const traceId = engineTraceId(identity, now);
	const batch: IngestionEvent[] = [
		ingestionEvent("trace-create", engineTraceBody(identity, traceId, now), now),
	];
	return {
		attempt(a: LaneAttempt): void {
			try {
				batch.push(
					ingestionEvent("generation-create", engineAttemptBody(identity, traceId, a), clock()),
				);
			} catch (error) {
				log("warn", "lane.trace.attempt_failed", { error_class: errorClass(error) });
			}
		},
		async flush(): Promise<void> {
			const file = join(outDir, `${traceId}.json`);
			try {
				await mkdir(outDir, { recursive: true });
				await writeFile(file, `${JSON.stringify({ batch })}\n`);
				log("info", "lane.trace.recorded", { trace_id: traceId, events: batch.length, file });
			} catch (error) {
				log("warn", "lane.trace.record_failed", { error_class: errorClass(error), file });
			}
		},
	};
}

/** Argument 0 is redacted: a caller may pass full settings that carry the keys. */
export const createRecordingLaneTracer = traced(
	"actions.createRecordingLaneTracer",
	createRecordingLaneTracerImpl,
	{ redact: { args: [0] } },
);

function clientFor(settings: LaneTraceSettings, deps: LaneTraceDeps): LaneTraceClient | null {
	return deps.client ?? laneClient(settings);
}

/** Flush, logging the outcome by class. Never throws: telemetry never fails a lane. */
async function flushQuietly(client: LaneTraceClient, traceId: string): Promise<void> {
	try {
		await client.flushAsync();
		log("info", "lane.trace.flushed", { trace_id: traceId });
	} catch (error) {
		log("warn", "lane.trace.flush_failed", { error_class: errorClass(error) });
	}
}

/**
 * OPEN the verdict trace for a lane with no engine call (823a): the
 * trace plus ONE lane span, started now and flushed before returning.
 *
 * Returns the trace id, or null when Langfuse is unconfigured -- and then it
 * SAYS so (`lane.trace.disabled`), for the reason `createLaneTracer` gives. A
 * client failure is logged by class and the id is still returned: the close
 * step recomputes it anyway, and a lane never fails on its own telemetry.
 */
async function openLaneTraceImpl(
	settings: LaneTraceSettings | null,
	deps: LaneTraceDeps = {},
): Promise<string | null> {
	if (settings === null) {
		warnDisabled();
		return null;
	}
	const client = clientFor(settings, deps);
	if (client === null) return null;
	const now = (deps.now ?? (() => new Date()))();
	const { traceId, trace, span } = openBodies(settings, now);
	try {
		client.trace(trace);
		client.span(span);
	} catch (error) {
		log("warn", "lane.trace.open_failed", { error_class: errorClass(error) });
	}
	log("info", "lane.trace.opened", { trace_id: traceId, lane: settings.lane, sha: settings.sha });
	await flushQuietly(client, traceId);
	return traceId;
}

/**
 * CLOSE the verdict trace with the status the lane posted (823a): end
 * the lane span with the verdict as its output, and tag the trace
 * `verdict:<state>` so a failing lane is one filter away.
 *
 * The verdict is the lane's OWN text (the commit-status state and description
 * it posts), bounded to MAX_FIELD. A state other than `success` marks the span
 * `ERROR` (failure/error) or `WARNING` (anything else), so an unhealthy run is
 * visible in the Langfuse level column without reading the output.
 *
 * A close with NO prior open (the workflow close-trace job runs even when
 * prepare was cancelled or failed before its open, PR 937) needs nothing from
 * the open: both calls are upserts by id, so Langfuse records a close-only
 * trace. That is acceptable telemetry -- a visible signal prepare died early.
 */
async function closeLaneTraceImpl(
	settings: LaneTraceSettings | null,
	verdict: LaneVerdict,
	deps: LaneTraceDeps = {},
): Promise<void> {
	if (settings === null) {
		warnDisabled();
		return;
	}
	const client = clientFor(settings, deps);
	if (client === null) return;
	const now = (deps.now ?? (() => new Date()))();
	const { traceId, state, span, trace } = closeBodies(settings, verdict, now);
	try {
		client._updateSpan(span);
		client.trace(trace);
	} catch (error) {
		log("warn", "lane.trace.close_failed", { error_class: errorClass(error) });
	}
	log("info", "lane.trace.closed", { trace_id: traceId, verdict: state });
	await flushQuietly(client, traceId);
}

/**
 * The SETTINGS argument (index 0) is redacted on both: it carries `secretKey`
 * and `publicKey`. The verdict and the returned trace id carry nothing
 * sensitive.
 */
export const openLaneTrace = traced("actions.openLaneTrace", openLaneTraceImpl, {
	redact: { args: [0] },
});
export const closeLaneTrace = traced("actions.closeLaneTrace", closeLaneTraceImpl, {
	redact: { args: [0] },
});

/**
 * CLI for a workflow step:
 *
 *   bun scripts/actions/lane-trace.ts open
 *   bun scripts/actions/lane-trace.ts close <state> [description]
 *   bun scripts/actions/lane-trace.ts render open
 *   bun scripts/actions/lane-trace.ts render close <state> [description]
 *
 * Identity and credentials come from the same env `call-engine.ts` reads
 * (LANGFUSE_*, LANE, REPO, PR, HEAD_SHA, RUN_URL). Exit 0 whatever Langfuse
 * does -- a lane never fails on its own telemetry; exit 2 only on a usage
 * error, which is a wiring bug in the workflow and should be loud. `render`
 * needs NO Langfuse key: it prints the ingestion batch JSON to stdout for a
 * credential job to post.
 */
if (import.meta.main) {
	const usage = (): void => {
		process.stderr.write(
			"usage: lane-trace.ts open | close <state> [description] | render open | render close <state> [description]\n",
		);
		process.exitCode = 2;
	};
	const [verb, ...rest] = process.argv.slice(2);
	if (verb === "render") {
		const [what, state, description] = rest;
		const identity = loadLaneTraceIdentity();
		const now = new Date();
		if (what === "open") {
			process.stdout.write(`${JSON.stringify(renderOpenBatch(identity, now))}\n`);
		} else if (what === "close" && state !== undefined && state !== "") {
			process.stdout.write(
				`${JSON.stringify(renderCloseBatch(identity, { state, description }, now))}\n`,
			);
		} else {
			usage();
		}
	} else {
		const [state, description] = rest;
		const settings = loadLaneTraceSettings();
		if (verb === "open") {
			await openLaneTrace(settings);
		} else if (verb === "close" && state !== undefined && state !== "") {
			await closeLaneTrace(settings, { state, description });
		} else {
			usage();
		}
	}
}
