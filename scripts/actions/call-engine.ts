/**
 * @module scripts/actions/call-engine
 * @description Call the cliproxyapi chat-completions endpoint with a bounded
 *   retry, and hand the raw reply body back unread.
 *
 *   Forgejo 16 exposes no rerun API, so a single transient upstream failure is
 *   terminal for the whole job: run 458 on PR #475 died on ONE HTTP 408. The owner
 *   ruling 2026-08-30 — the CALLER re-asks. Three attempts with backoff, then
 *   it fails loudly and the workflow's failure guard posts the terminal status.
 *
 *   Which failures earn a retry is a judgment about CAUSE, not about
 *   convenience. A thrown fetch error (transport, DNS; NOT the per-attempt
 *   timeout, which the same payload hits again -- sf#697),
 *   408, 425, 429, and any 5xx are the upstream having a bad moment. Every
 *   other 4xx is a configuration fault — a 401 with the wrong key, a 400 with a
 *   malformed request — and re-asking three times only turns one clear failure
 *   into three noisy ones, so those return immediately.
 *
 *   The reason string that reaches the log is the HTTP status or the error's
 *   name and message, capped. NEVER the response body (a proxy 401 body can
 *   echo the credential — sf#246) and never the key itself, which reaches only
 *   the `Authorization` header.
 *
 *   The reply body is passed through VERBATIM. This module does not parse it;
 *   `extractReply` in `post-pr-review.ts` owns that, and a shape this module
 *   does not understand is not this module's to reject.
 *
 * @outputs
 *   - `callEngine` -- pure, injectable: request text -> ok body, or a reason
 *   - `ENGINE_ATTEMPTS` / `ENGINE_BACKOFF_MS` / `ENGINE_TIMEOUT_MS` -- the bounds
 *   - CLI: stdin is the request JSON, stdout is the raw reply on success;
 *     exit 0 on success, 22 on final failure (curl's HTTP-error code, which the
 *     workflows already read), 3 on a missing env var
 *   - CLI: `ENGINE_ATTEMPTS` overrides the attempt budget; when
 *     `ENGINE_FAILURE_FILE` is set, a failed call writes its class there
 *     (`timeout:<ms>`, `http:<code>:retryable|final`, `network`)
 *   - CLI: when `ENGINE_ATTEMPTS_FILE` is set, the attempt count that ended the
 *     call is written there on BOTH paths. Attempts are the one metric
 *     that exists only inside the job: Forgejo exposes no job-log API, so the
 *     number has to leave the step through a file the next step can read.
 */

import { traced } from "../../src/log";
import {
	createLaneTracer,
	createRecordingLaneTracer,
	laneTokenUsage,
	loadLaneTraceIdentity,
	loadLaneTraceSettings,
} from "./lane-trace";

/** How many times the engine is asked before the call fails. */
export const ENGINE_ATTEMPTS = 3;

/**
 * The waits BETWEEN attempts: after attempt 1, then after attempt 2. There is
 * deliberately no entry for the last attempt — nothing follows it to wait for.
 */
export const ENGINE_BACKOFF_MS: readonly number[] = [60_000, 120_000];

/**
 * The per-attempt ceiling. A review is a long call; the job's own cap is higher.
 * 30 min since sf#810: gpt-5.6-luna through cliproxyapi answered reviews in
 * 483-851 s and two hit the old 900 s wall (runs 2189, 2205) -- latency, not
 * content.
 */
export const ENGINE_TIMEOUT_MS = 1_800_000;

/** The cap on a reason string, so a verbose error cannot flood the log. */
const MAX_REASON_CHARS = 200;

/** Statuses that mean "ask again", as opposed to "you asked wrong". */
function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** A thrown fetch error rendered without its cause chain or any request detail. */
function reasonForError(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
	}
	return String(error).slice(0, MAX_REASON_CHARS);
}

export type EngineResult =
	| { ok: true; body: string; attempt: number }
	| { ok: false; attempt: number; reason: string; failure: string };

export interface EngineOptions {
	url: string;
	apiKey: string;
	attempts?: number;
	delaysMs?: readonly number[];
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	/**
	 * Called once per attempt with what the lane observed. Injected
	 * so `callEngine` stays pure and every existing test keeps its shape: a caller
	 * that passes nothing is traced by nothing and behaves exactly as before.
	 *
	 * It must never throw and never be awaited on the hot path — telemetry does
	 * not get to fail or slow a review.
	 */
	onAttempt?: (observed: EngineAttemptObservation) => void;
	/** The model the request asked for, carried into the trace. */
	model?: string;
	/** Wall clock, injectable so a test can assert duration without sleeping. */
	now?: () => Date;
	/** The per-attempt ceiling in ms; defaults to ENGINE_TIMEOUT_MS. */
	timeoutMs?: number;
}

/** One attempt as the caller observed it, handed to `onAttempt`. */
export interface EngineAttemptObservation {
	attempt: number;
	attempts: number;
	startedAt: Date;
	endedAt: Date;
	/** `ok`, `http <status>`, or an error class. NEVER a response body. */
	outcome: string;
	ok: boolean;
	requestBytes: number;
	/** The raw reply on success, for usage extraction. Absent on failure. */
	body?: string;
	/**
	 * cliproxyapi's per-request id (the `[e40a61b8]` on its log lines), when the
	 * reply carried one in a shape-valid header.
	 * Absent on a thrown fetch: there was no reply to carry it.
	 */
	proxyRequestId?: string;
}

/** Headers a proxy may carry its request id in, checked in order. */
const PROXY_ID_HEADERS = ["x-request-id", "x-cliproxy-request-id", "request-id"] as const;

/**
 * The proxy's request id from a reply's headers, or undefined.
 *
 * ONLY the proxy's own shape is accepted: exactly 8 hex characters, lowercased.
 * A header is proxy-controlled text headed for a Langfuse span, and a strict
 * shape is what keeps it from being a channel for anything else -- 8 hex
 * characters cannot carry a credential. Anything else reads as "no id".
 */
function proxyRequestIdOf(headers: Headers): string | undefined {
	for (const name of PROXY_ID_HEADERS) {
		const value = headers.get(name)?.trim();
		if (value !== undefined && /^[0-9a-f]{8}$/i.test(value)) return value.toLowerCase();
	}
	return undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the engine, retrying only the failures that a retry can fix.
 *
 * `request` is sent as the body verbatim: this module does not re-encode it, so
 * whatever the renderer produced is what the proxy receives, byte for byte.
 */
async function callEngineImpl(request: string, opts: EngineOptions): Promise<EngineResult> {
	const attempts = opts.attempts ?? ENGINE_ATTEMPTS;
	const delays = opts.delaysMs ?? ENGINE_BACKOFF_MS;
	const doFetch = opts.fetchImpl ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const log = opts.log ?? ((line: string) => void process.stderr.write(line));

	const timeoutMs = opts.timeoutMs ?? ENGINE_TIMEOUT_MS;
	const now = opts.now ?? (() => new Date());
	const onAttempt = opts.onAttempt;
	const requestBytes = Buffer.byteLength(request, "utf8");
	let reason = "no attempt was made";
	// The terminal failure CLASS: `timeout:<ms>`, `http:<code>:retryable|final`, or
	// `network`. Machine-readable, so the failure() step can name the cause.
	let failure = "network";

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		let retryable: boolean;
		let failedProxyRequestId: string | undefined;
		const startedAt = now();
		try {
			const res = await doFetch(`${opts.url}/v1/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${opts.apiKey}`,
					"Content-Type": "application/json",
				},
				body: request,
				signal: AbortSignal.timeout(timeoutMs),
				// Bun's fetch carries its own hard-coded 5-minute READ timeout
				// (oven-sh/bun PR #6217) on top of the signal; a review takes ~10
				// minutes, so without this every attempt dies at 300s (run 463 on
				// PR #475: two 499s at 5m0s on the proxy). `timeout: false` lifts
				// it and leaves the signal above as the only per-attempt bound.
				timeout: false,
			} as RequestInit);
			const proxyRequestId = proxyRequestIdOf(res.headers);
			if (res.ok) {
				const body = await res.text();
				// Observed AFTER the body is read, so the duration covers the whole
				// call: a proxy that answers headers fast and streams slowly is the
				// exact shape sf#676 was, and a header-time measurement would hide it.
				onAttempt?.({
					attempt,
					attempts,
					startedAt,
					endedAt: now(),
					outcome: "ok",
					ok: true,
					requestBytes,
					body,
					...(proxyRequestId === undefined ? {} : { proxyRequestId }),
				});
				return { ok: true, body, attempt };
			}
			// The status only. The body of a rejected call is the one place a
			// proxy has been seen to echo the credential back.
			reason = `http ${res.status}`;
			retryable = isRetryableStatus(res.status);
			// Retryability rides in the class: a 408/425/429 was
			// re-asked, so the failure() step must not call it a one-shot refusal.
			failure = `http:${res.status}:${retryable ? "retryable" : "final"}`;
			failedProxyRequestId = proxyRequestId;
		} catch (error) {
			reason = reasonForError(error);
			// A per-attempt timeout is NOT re-asked: the payload is
			// unchanged, so a call that could not finish in ENGINE_TIMEOUT_MS will
			// not finish in it 60 s later. Run 1116 spent 48 min proving that thrice.
			const timedOut = (error as { name?: unknown } | null)?.name === "TimeoutError";
			failure = timedOut ? `timeout:${timeoutMs}` : "network";
			retryable = !timedOut;
		}

		// Every non-success path lands here exactly once, so a failed attempt is
		// traced with the same fidelity as a successful one. A lane that burns its
		// whole retry budget is precisely the run worth looking at afterwards.
		onAttempt?.({
			attempt,
			attempts,
			startedAt,
			endedAt: now(),
			outcome: reason,
			ok: false,
			requestBytes,
			...(failedProxyRequestId === undefined ? {} : { proxyRequestId: failedProxyRequestId }),
		});

		if (!retryable || attempt === attempts) {
			log(`engine call failed after ${attempt} attempts: ${reason}\n`);
			return { ok: false, attempt, reason, failure };
		}

		const delay = delays[attempt - 1] ?? delays[delays.length - 1] ?? 0;
		log(
			`engine attempt ${attempt}/${attempts} failed (${reason}); retrying in ${Math.round(delay / 1000)}s\n`,
		);
		await sleep(delay);
	}

	// Unreachable while `attempts >= 1`; kept so a zero-attempt call is defined.
	return { ok: false, attempt: 0, reason, failure };
}

/**
 * `opts` (index 1) carries `apiKey`, the cliproxyapi credential this module's
 * header says reaches only the `Authorization` header — a trace of it is that
 * key in the lane log. The RESULT is redacted too: on success it carries the
 * engine's whole reply body verbatim, which is the review payload
 * `lane-trace.ts` refuses to place in a trace, and which on a proxy error can
 * echo the credential back. `request` (index 0) is redacted too: the
 * prompt this repo builds EMBEDS the untrusted diff or issue body, so tracing
 * it re-exposes exactly what `buildRequest` was redacted to withhold
 * (round 3).
 */
export const callEngine = traced("actions.callEngine", callEngineImpl, {
	redact: { args: [0, 1], result: true },
});

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		process.stderr.write(`call-engine: ${name} is required\n`);
		process.exit(3);
	}
	return value;
}

/**
 * A TEST SEAM, CLI only: `ENGINE_BACKOFF_MS="1,2"` replaces the real waits so a
 * done-means probe can drive three attempts in under a second. Ignored when it
 * does not parse as comma-separated non-negative integers, so a typo degrades
 * to the real backoff rather than to no backoff.
 */
function backoffFromEnv(): readonly number[] {
	const raw = process.env.ENGINE_BACKOFF_MS;
	if (raw === undefined || raw.trim() === "") return ENGINE_BACKOFF_MS;
	const parsed = raw.split(",").map((part) => Number(part.trim()));
	if (parsed.some((n) => !Number.isFinite(n) || n < 0)) return ENGINE_BACKOFF_MS;
	return parsed;
}

/**
 * `ENGINE_ATTEMPTS`: the attempt budget for this call. The pr-review
 * lane sets 2 so two 30-minute attempts fit its job bound. Only
 * 1..MAX_ENGINE_ATTEMPTS is accepted; anything else (zero, a huge digit string
 * that would become Infinity or lose precision, junk) falls back to the module
 * default with one bounded warning line, so retries never loop past the bound.
 */
export const MAX_ENGINE_ATTEMPTS = 5;

function parseEngineAttemptsImpl(value: string | undefined): number {
	const raw = value?.trim() ?? "";
	if (raw === "") return ENGINE_ATTEMPTS;
	const n = /^[1-9][0-9]?$/.test(raw) ? Number(raw) : Number.NaN;
	if (Number.isSafeInteger(n) && n <= MAX_ENGINE_ATTEMPTS) return n;
	process.stderr.write(
		`call-engine: ignoring ENGINE_ATTEMPTS=${JSON.stringify(raw.slice(0, 32))}; using ${ENGINE_ATTEMPTS}\n`,
	);
	return ENGINE_ATTEMPTS;
}

export const parseEngineAttempts = traced("actions.parseEngineAttempts", parseEngineAttemptsImpl);

function attemptsFromEnv(): number {
	return parseEngineAttempts(process.env.ENGINE_ATTEMPTS);
}

/**
 * `ENGINE_TIMEOUT_MS`: the per-attempt ceiling for this call. The
 * pr-review second pass sets 600000 so its term in the job bound is 10 min.
 * Only an integer in 60000..1800000 is accepted; absent or anything else falls
 * back to the module constant.
 */
export const MIN_ENGINE_TIMEOUT_MS = 60_000;

function parseEngineTimeoutMsImpl(value: string | undefined): number {
	const raw = value?.trim() ?? "";
	if (!/^[1-9][0-9]{4,6}$/.test(raw)) return ENGINE_TIMEOUT_MS;
	const n = Number(raw);
	return n >= MIN_ENGINE_TIMEOUT_MS && n <= ENGINE_TIMEOUT_MS ? n : ENGINE_TIMEOUT_MS;
}

export const parseEngineTimeoutMs = traced(
	"actions.parseEngineTimeoutMs",
	parseEngineTimeoutMsImpl,
);

if (import.meta.main) {
	const url = required("ENGINE_URL");
	// Read in process and never printed: it reaches the Authorization header only.
	const apiKey = required("CLIPROXY_API_KEY");
	const request = await Bun.stdin.text();

	// LIVE EMISSION, AT THE CALL SITE. This is the correction to the
	// reconstruct-from-a-file shape: the runtime making the model call emits the
	// span as it happens, so a crashed lane still leaves everything up to the
	// crash, the model is provider-attested rather than self-reported, and the
	// duration-against-payload question sf#697 asks is answerable by grouping in
	// the Langfuse UI instead of by hand-correlating a proxy log against Forgejo
	// timestamps. Unconfigured it emits nothing and SAYS SO — see
	// `createLaneTracer`; a silent tracer is indistinguishable from a dead lane.
	//
	// LANE_TRACE_OUT set (D25): the job holding the engine key must not
	// also hold the Langfuse keys. The same span bodies are RECORDED to
	// `<LANE_TRACE_OUT>/<traceId>.json` and a curl-only job posts them; no
	// LANGFUSE_* variable is read on this path.
	const traceOut = process.env.LANE_TRACE_OUT?.trim() ?? "";
	const tracer =
		traceOut === ""
			? createLaneTracer(loadLaneTraceSettings())
			: createRecordingLaneTracer(loadLaneTraceIdentity(), traceOut);
	const result = await callEngine(request, {
		url,
		apiKey,
		attempts: attemptsFromEnv(),
		delaysMs: backoffFromEnv(),
		timeoutMs: parseEngineTimeoutMs(process.env.ENGINE_TIMEOUT_MS),
		model: process.env.ENGINE_MODEL?.trim() || "unknown",
		onAttempt: (observed) => {
			const { usage, attestedModel } =
				observed.body === undefined
					? {}
					: laneTokenUsage(observed.body, process.env.ENGINE_MODEL?.trim() || "unknown");
			tracer.attempt({
				attempt: observed.attempt,
				attempts: observed.attempts,
				requestedModel: process.env.ENGINE_MODEL?.trim() || "unknown",
				requestBytes: observed.requestBytes,
				startedAt: observed.startedAt,
				endedAt: observed.endedAt,
				outcome: observed.outcome,
				ok: observed.ok,
				attestedModel,
				usage,
				// Surface C: the proxy's id when its reply carried one in a
				// shape-valid header. A probe on 2026-09-10 saw a 401 reply carrying
				// only `Date`, so this may stay absent until the proxy echoes one;
				// the capture is in place so the join works the moment it does.
				proxyRequestId: observed.proxyRequestId,
			});
		},
	});

	// The attempt count is written before the exit path is chosen, so a failed
	// call reports its attempts too — a run that took three tries and still
	// failed is exactly the run the metric exists to surface. A write failure
	// here is not the job's failure: the metric is a by-product, and losing it
	// must not turn a completed review into a failed one.
	const attemptsFile = process.env.ENGINE_ATTEMPTS_FILE;
	if (attemptsFile !== undefined && attemptsFile !== "") {
		try {
			await Bun.write(attemptsFile, String(result.attempt));
		} catch (error) {
			process.stderr.write(
				`call-engine: could not write ENGINE_ATTEMPTS_FILE: ${reasonForError(error)}\n`,
			);
		}
	}

	// The failure CLASS, on the failure path only: `attempts=1` alone was
	// read as "the engine answered". Same by-product rule as the attempts file.
	const failureFile = process.env.ENGINE_FAILURE_FILE;
	if (!result.ok && failureFile !== undefined && failureFile !== "") {
		try {
			await Bun.write(failureFile, result.failure);
		} catch (error) {
			process.stderr.write(
				`call-engine: could not write ENGINE_FAILURE_FILE: ${reasonForError(error)}\n`,
			);
		}
	}

	// AWAITED ON EVERY PATH, BEFORE EXIT. `langfuse` 3.38.20 defaults to
	// `flushAt: 15` / `flushInterval: 10s`, and this process exits within
	// milliseconds of writing its reply — so an unflushed queue is silently
	// dropped and the whole instrumentation becomes decorative. This one `await`
	// is the difference between a trace existing and not. It cannot fail the
	// review: `flush()` catches and logs its own failure by class.
	await tracer.flush();

	if (result.ok) {
		process.stdout.write(result.body);
	} else {
		process.exitCode = 22;
	}
}
