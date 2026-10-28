/**
 * @module observability/langfuse
 * @description Emit ONE Langfuse trace per ingested attempt, from the bounded
 *   summary `observability/event-stream` produced. Uses the official `langfuse`
 *   SDK, which owns batching, retry, and the HTTP transport — never hand-rolled
 *   (repo standard: do not re-solve a solved problem).
 *
 *   NON-BLOCKING IS THE CONTRACT. Langfuse is an
 *   observability sink, and an observability sink must never be able to fail,
 *   stall, or slow the ingest boundary it observes. `emitAttemptTrace` is
 *   therefore synchronous-return, fire-and-forget: it hands the events to the
 *   SDK's in-memory queue and returns. The SDK flushes on its own timer with its
 *   own bounded retry; any failure — unreachable host, refused auth, DNS gone —
 *   surfaces as ONE `observability.langfuse.emit_failed` log line and nothing
 *   else. That line is bound to BOTH SDK failure channels: a background flush
 *   failure arrives on `warning`, not `error`, so subscribing `error` alone
 *   made this contract unreachable (measured, PR #176 review). The caller's
 *   promise chain is never joined to a network call, so an
 *   unreachable Langfuse costs the cycle nothing. This mirrors the cycle-step
 *   isolation the rest of the service already uses.
 *
 *   DISABLED BY DEFAULT. Configuration is three optional env vars
 *   (`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`). With
 *   any of them absent, emission is DISABLED: the factory returns null, one boot
 *   log line records it, and every call site behaves exactly as it did before
 *   this module existed. Key VALUES never appear in code, tests, logs, or an
 *   error message — only the fact that a variable was absent.
 *
 *   UNTRUSTED PAYLOAD. Everything in an `AttemptTrace` came off a runner box.
 *   `event-stream` already clipped and redacted every text field; this module
 *   adds only watcher-owned identity (job id, repository, sha, vmid) from the
 *   trusted DB join, never from runner output.
 *
 *   TRACE TIMESTAMP IS INGEST TIME. The trace itself is
 *   stamped when the watcher ingested it; the real run timing lives on the
 *   generation/span start and end times. A trace backdated to its run time hides
 *   behind the Langfuse UI's default "Past 1 day" filter — observed 2026-08-03.
 *
 * @outputs
 *   - `LangfuseSettings` -- the resolved env configuration
 *   - `loadLangfuseSettings` -- read the three optional env vars
 *   - `AttemptTraceIdentity` -- the watcher-owned identity a trace is tagged with
 *   - `TraceEmitter` -- the injectable emission seam (tests supply a fake)
 *   - `traceIdFor` -- the trace id for one (attempt, host); exported so the
 *     observer stamps `job_attempts.trace_id` with it rather than re-spelling it
 *   - `emitterOn` -- bind an emitter to an already-built client; exported so a
 *     test can intercept the client and assert the exact bodies the SDK is handed
 *   - `createLangfuseEmitter` -- build the real SDK-backed emitter, or null
 *   - `buildClient` -- the configured SDK client; exported so the console-handler
 *     removal and the bounded retry settings are directly assertable
 *
 * @dependencies
 *   - langfuse -- the official SDK; owns batching, retry, and transport
 *   - ../log -- the one logger
 *   - ./event-stream -- the bounded summary shape
 */
import { Langfuse } from "langfuse";
import { errorClass, log, traced } from "../log";
import type { AttemptTrace } from "./event-stream";

/** The resolved Langfuse configuration; every field is required to enable it. */
export interface LangfuseSettings {
	baseUrl: string;
	publicKey: string;
	secretKey: string;
}

/**
 * Read the three optional env vars. Returns null when ANY is absent or blank,
 * which DISABLES emission — the intended default for every environment that has
 * not been given a Langfuse project. The returned error path carries no value:
 * a caller learns only that configuration is incomplete.
 *
 * @param env - environment to read (defaults to `process.env`)
 * @returns the settings when all three are present, otherwise null
 */
export const loadLangfuseSettings = traced(
	"observability.loadLangfuseSettings",
	function loadLangfuseSettings(env: NodeJS.ProcessEnv = process.env): LangfuseSettings | null {
		const baseUrl = env.LANGFUSE_BASE_URL?.trim() ?? "";
		const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() ?? "";
		const secretKey = env.LANGFUSE_SECRET_KEY?.trim() ?? "";
		if (baseUrl === "" || publicKey === "" || secretKey === "") {
			return null;
		}
		return { baseUrl, publicKey, secretKey };
	},
	{ redact: { args: [0] } },
);

/**
 * The WATCHER-OWNED identity one trace is tagged with. Every field is resolved
 * from the trusted DB join at the ingest boundary — never from runner output,
 * which decides nothing here.
 */
export interface AttemptTraceIdentity {
	/**
	 * Trace id (with `hostname`): the attempt. Requeues of one job — and the
	 * several hosts one attempt can be ingested from — produce distinct traces.
	 */
	attemptId: number;
	/** Session id: the job. Groups every attempt/requeue of the same work. */
	jobId: number;
	repository: string;
	jobType: string;
	sha: string;
	itemNumber: number | null;
	vmid: number | null;
	hostname: string;
}

/** Gate outcomes recorded as scores on the trace. */
export interface AttemptTraceScores {
	/** 1 when the result ingested cleanly, 0 when it was invalid. */
	ingestOk: number;
	/** 1 when the result validated against the versioned schema. */
	schemaValid: number;
	/** 1/0 when a change was verified/rejected; omitted for a report-only lane. */
	changeVerified?: number;
}

/** The injectable emission seam. Production is the SDK; tests supply a fake. */
export interface TraceEmitter {
	/**
	 * Emit one attempt trace. MUST return synchronously (void, not a promise) so
	 * no caller can accidentally await a network call at the ingest boundary.
	 */
	emit(args: {
		identity: AttemptTraceIdentity;
		trace: AttemptTrace;
		scores: AttemptTraceScores;
		at: Date;
	}): void;
	/** Flush pending events; called only at shutdown, never on the hot path. */
	shutdown(): Promise<void>;
}

/**
 * The trace id for one ingested result: the attempt, QUALIFIED BY HOST.
 *
 * Results are per (job, host) — one attempt can be ingested from two hosts, and
 * `attempt-N` alone made both upsert the SAME Langfuse trace: metadata
 * overwritten, generations merged, tokens double-counted (PR #176 review, the
 * #86 shape). The hostname is watcher-owned and already `isSafeSegment`-
 * validated upstream, so it is safe to place in an id. Grouping is unaffected:
 * `sessionId` stays `job-N`, so every attempt and every host still collapse
 * under one session in the UI.
 *
 * EXPORTED so the observer stamps `job_attempts.trace_id` with THIS
 * function rather than re-spelling the format at a second call site. A copied
 * format is a copy that drifts: the host qualifier was added here by #176 and a
 * duplicate elsewhere would still be writing `attempt-N`, pointing every db row
 * at a trace id nothing emits.
 */
export const traceIdFor = traced(
	"observability.traceIdFor",
	function traceIdFor(identity: AttemptTraceIdentity): string {
		return `attempt-${identity.attemptId}-${identity.hostname}`;
	},
);

/**
 * An ISO string, or null when the Date is not finite.
 *
 * `toISOString()` THROWS a `RangeError` on an invalid Date, and this call sits
 * inside the trace body — one bad runner timestamp took the whole trace with it.
 * `event-stream` now clamps stamps to a plausible window, so
 * this is the second, independent guard rather than the only one.
 */
function isoOrNull(value: Date): string | null {
	return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Tags on the trace, all watcher-owned identity. */
function traceTags(identity: AttemptTraceIdentity, trace: AttemptTrace): string[] {
	const tags = [
		`lane:${identity.jobType}`,
		`repo:${identity.repository}`,
		`sha:${identity.sha}`,
		`host:${identity.hostname}`,
	];
	if (identity.itemNumber !== null) tags.push(`item:${identity.itemNumber}`);
	if (identity.vmid !== null) tags.push(`vmid:${identity.vmid}`);
	if (trace.provider !== null) tags.push(`runtime:${trace.provider}`);
	return tags;
}

/** Write the generations and folded tool spans onto an opened trace. */
function writeObservations(
	client: Langfuse,
	traceId: string,
	trace: AttemptTrace,
	identity: AttemptTraceIdentity,
): void {
	for (const generation of trace.generations) {
		client.generation({
			traceId,
			name: generation.name,
			startTime: generation.startTime,
			endTime: generation.endTime,
			model: generation.model ?? undefined,
			output: generation.text,
			usage: {
				input: generation.input ?? undefined,
				output: generation.output ?? undefined,
				total: generation.total ?? undefined,
				unit: "TOKENS",
			},
			metadata: {
				provider: generation.provider,
				api: generation.api,
				stop_reason: generation.stopReason,
				reasoning_tokens: generation.reasoning,
				cache_read_tokens: generation.cacheRead,
				attempt_id: identity.attemptId,
			},
		});
	}
	for (const span of trace.toolSpans) {
		client.span({
			traceId,
			name: span.name,
			startTime: span.startTime,
			endTime: span.endTime,
			input: span.input,
			output: span.output,
			// approx_timing is NOT decoration: pi tool events carry no timestamps, so
			// this span's duration is inferred from its neighbours, not measured.
			metadata: { ok: span.ok, approx_timing: span.approxTiming },
		});
	}
}

/**
 * Open the trace itself: watcher-owned identity, ingest-observed timestamp, and
 * the attested model in metadata.
 */
function openTrace(
	client: Langfuse,
	traceId: string,
	args: { identity: AttemptTraceIdentity; trace: AttemptTrace; at: Date },
): void {
	const { identity, trace, at } = args;
	client.trace({
		id: traceId,
		name: `${identity.jobType} #${identity.itemNumber ?? "-"}`,
		// INGEST-observed time, not the run's own start: a backdated trace hides
		// behind the UI's default Past-1-day filter (observed 2026-08-03).
		timestamp: at,
		sessionId: `job-${identity.jobId}`,
		tags: traceTags(identity, trace),
		metadata: {
			attempt_id: identity.attemptId,
			job_id: identity.jobId,
			repository: identity.repository,
			sha: identity.sha,
			host: identity.hostname,
			vmid: identity.vmid,
			// The PROVIDER-attested model, never the agent's self-report.
			attested_model: trace.observedModel,
			run_started_at: isoOrNull(trace.startTime),
			run_ended_at: isoOrNull(trace.endTime),
			event_count: trace.eventCount,
			// The observation list is a PREFIX of the run when this is true; the
			// attestation above is not affected, it is tracked past the cap.
			truncated: trace.truncated,
			// Tool calls that started and never ended. Non-zero is real operational
			// signal, not an error: a killed or timed-out attempt ends mid-tool, and
			// the trace should say so rather than silently showing one fewer span.
			unclosed_tool_spans: trace.unclosedToolSpans,
			// How many stamps arrived out of order and were clamped forward. The
			// clamp is otherwise invisible — a clamped interval and an instant one
			// both read as zero duration — so without this a runner with broken NTP
			// looks like a fast turn rather than a box whose clock is what the
			// durations are actually describing.
			clamped_timestamps: trace.clampedTimestamps,
		},
	});
}

/** Write the gate-outcome scores onto an opened trace. */
function writeScores(client: Langfuse, traceId: string, scores: AttemptTraceScores): void {
	const entries: Array<[string, number]> = [
		["ingest_ok", scores.ingestOk],
		["result_schema_valid", scores.schemaValid],
	];
	if (scores.changeVerified !== undefined) {
		entries.push(["change_verified", scores.changeVerified]);
	}
	for (const [name, value] of entries) {
		client.score({ traceId, name, value });
	}
}

/**
 * Build and configure the SDK client.
 *
 * TWO SETTINGS ARE LOAD-BEARING, both verified against the SDK source
 * (`langfuse-core` 3.38.20) rather than assumed:
 *
 *   - `fetchRetryCount`/`fetchRetryDelay` default to 3 retries at 3s. Against an
 *     unreachable Langfuse that is ~18s of background retry per flush, measured.
 *     An observability sink gets ONE quick retry and then gives up: the events
 *     are already lost either way, and the only thing a long retry buys is a
 *     process that stays busy failing.
 *   - `requestTimeout` is dropped to 2s from 5s for the same reason.
 *
 * The SDK ALSO installs its own unconditional `console.error` handler on the
 * `error` event at construction (`this._events.on("error", ...)`), and `on()`
 * ADDS a listener rather than replacing it. This repo bans `console.*` — `log`
 * is the only writer to stderr, and NDJSON is the contract — so the built-in
 * handler is removed here and replaced with one bounded `log` line. Verified by
 * reading the constructor, not inferred from the docs.
 */
/**
 * sf#704: arg 0 is the whole settings object, and key-based masking only
 * catches PART of it. `secretKey` masks because the word "secret" is in the
 * key; `publicKey` does not, and ships verbatim — but it is a vault-held
 * credential (`bin/langfuse-public-key`), not public configuration. Redacting
 * the argument covers both keys and the baseUrl, none of which the trace needs.
 */
export const buildClient = traced(
	"observability.buildClient",
	function buildClient(settings: LangfuseSettings): Langfuse {
		const client = new Langfuse({
			baseUrl: settings.baseUrl,
			publicKey: settings.publicKey,
			secretKey: settings.secretKey,
			fetchRetryCount: 1,
			fetchRetryDelay: 1000,
			requestTimeout: 2000,
		});
		// Drop the SDK's built-in console.error listener, then install ours.
		//
		// The emitter is `SimpleEventEmitter`, whose listeners live on a plain object
		// `events` keyed by event name (read from `langfuse-core` 3.38.20 source — an
		// earlier guess at a `Map` on `.listeners` compiled, read correctly, and would
		// have silently done nothing, which is the failure mode this repo's "verify the
		// mechanism against the real tool" rule exists for). Guarded: a future version
		// that reshapes the emitter must degrade to "one extra console line", never to
		// a throw at boot.
		try {
			const events = (client as unknown as { _events?: { events?: Record<string, unknown[]> } })
				._events?.events;
			if (events !== undefined) {
				events.error = [];
			}
		} catch {
			// The built-in handler stays; noisier than intended, but never fatal.
		}
		// Bound to a single log line so an unreachable or refusing Langfuse is visible
		// exactly once per failure and never louder.
		//
		// BOTH CHANNELS, and `warning` is the one that actually fires. The SDK routes
		// a BACKGROUND flush failure — the only kind this fire-and-forget emitter can
		// produce — through `warning`, not `error` (`langfuse-core` 3.38.20, and
		// measured: unreachable host + 20 queued events yielded 2 `warning` events and
		// 0 `error` events, PR #176 review probe). Subscribing `error` alone made the
		// documented failure-visibility contract unreachable: an unreachable or 401ing
		// Langfuse was completely silent.
		let failureSeq = 0;
		const onFailure = (err: unknown): void => {
			log("warn", "observability.langfuse.emit_failed", {
				error_class: errorClass(err),
				// A monotonic counter, NOT an attempt id. The SDK's failure channel fires
				// from the background flush timer and carries no reference to the emit
				// that queued the events, so no correlation to an attempt/host is
				// available at this seam — the counter at least distinguishes N distinct
				// failures from one line printed N times.
				emit_seq: ++failureSeq,
			});
		};
		client.on("error", onFailure);
		client.on("warning", onFailure);
		return client;
	},
	{ redact: { args: [0] } },
);

/**
 * Bind an emitter to an ALREADY-BUILT client.
 *
 * Exported as its own seam so a test can build the client, intercept its
 * `enqueue`, and then drive the REAL emit path — asserting the exact trace id,
 * session id, and metadata the SDK is handed. Reconstructing that body in a
 * test would assert the test's own copy of the mapping, not the mapping.
 *
 * @param client - the configured SDK client
 * @returns the emitter bound to it
 */
export const emitterOn = traced(
	"observability.emitterOn",
	function emitterOn(client: Langfuse): TraceEmitter {
		return {
			emit({ identity, trace, scores, at }): void {
				try {
					// Trace id = the attempt, host-qualified (issue #170 behavior 2, #86
					// shape). Requeues of one job — and the several hosts one attempt can be
					// ingested from — are distinct traces, grouped by the job as sessionId.
					const traceId = traceIdFor(identity);
					openTrace(client, traceId, { identity, trace, at });
					writeObservations(client, traceId, trace, identity);
					writeScores(client, traceId, scores);
				} catch (err) {
					// Class only: an SDK error message can quote the request it failed on.
					log("warn", "observability.langfuse.emit_failed", { error_class: errorClass(err) });
				}
			},
			/**
			 * KNOWN, ACCEPTED SDK BEHAVIOR: `shutdownAsync` catches its own flush failure
			 * and writes it with a HARDCODED `console.error` (`langfuse-core` 3.38.20,
			 * inside its own catch — not routed through the event emitter, so it cannot
			 * be removed the way the constructor's listener was). Against an unreachable
			 * Langfuse a shutdown therefore prints one non-NDJSON line to stderr.
			 *
			 * Accepted rather than worked around: it fires only at process shutdown,
			 * never on the ingest hot path, and the alternatives — monkey-patching the
			 * global `console`, or skipping the flush entirely — are both worse than one
			 * stray line in a stopping process. Stated here so a future reader knows it
			 * was found and judged, not missed.
			 */
			async shutdown(): Promise<void> {
				try {
					await client.shutdownAsync();
				} catch (err) {
					log("warn", "observability.langfuse.emit_failed", { error_class: errorClass(err) });
				}
			},
		};
	},
);

/**
 * Build the SDK-backed emitter, or null when configuration is absent.
 *
 * Emission is fire-and-forget: `emit` queues events on the SDK and returns
 * synchronously. A throw from the SDK (a malformed body, a queue fault) is
 * caught and logged by CLASS ONLY — an SDK error message can quote the request
 * it failed on, which would put the configured credential into a log line.
 *
 * @param settings - the resolved env settings, or null to stay disabled
 * @returns an emitter, or null when Langfuse is not configured
 */
export const createLangfuseEmitter = traced(
	"observability.createLangfuseEmitter",
	function createLangfuseEmitter(settings: LangfuseSettings | null): TraceEmitter | null {
		if (settings === null) {
			log("info", "observability.langfuse.disabled", { reason: "no configuration" });
			return null;
		}
		const emitter = emitterOn(buildClient(settings));
		log("info", "observability.langfuse.enabled", { base_url: settings.baseUrl });
		return emitter;
	},
);
