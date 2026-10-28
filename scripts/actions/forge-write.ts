/**
 * @module scripts/actions/forge-write
 * @description One Forge write (a comment, a commit status) that survives the
 *   forge being DOWN for a while.
 *
 *   The nightly `forgejo-backup.service` on the Forgejo host stops Forgejo for
 *   one consistent backup boundary — measured 2026-09-09: 23:17:20 to 23:26:02,
 *   8m42s, during which Caddy answers every request with 502. Task 8195's
 *   engine call finished INSIDE that window, so its publish step got a 502 on
 *   the comment and the status, the `failure()` step's bare curl got a 502 too,
 *   and the runner could not even report the job's final state
 *   ("unable to send final job logs and status: All attempts fail"). Forgejo
 *   came back to a task it had not heard from and marked it failed at its own
 *   zombie timeout; `factory/pr-review` stayed `pending` until a close+reopen.
 *
 *   The answer is the same as the engine hop's (call-engine.ts, the owner ruling
 *   2026-08-30 — the caller re-asks): a write that meets a 5xx, a 408/425/429,
 *   or a thrown fetch error is re-asked on a FIXED backoff whose total length
 *   (attempts x backoff) outlasts the quiesce. A 4xx the caller caused (a 401
 *   with a stale token, a 422 with a malformed body) is returned at once.
 *
 *   TWO THINGS A RE-ASK MUST NOT DO (PR #684 review, round 1). It must not
 *   REPLAY a write the forge already accepted: a response lost on the wire
 *   after Forgejo stored the comment would otherwise post it twice, so before
 *   every retry the caller's `alreadyApplied` probe reads the forge back and a
 *   `true` ends the write as ok without a second POST (`listProbe` +
 *   `hasIdenticalComment` / `hasIdenticalStatus` are the probes the pr-review
 *   lane uses). And it must not WAIT FOREVER on one attempt: a black-holed
 *   socket would otherwise hold the lane past the whole 20-attempt schedule,
 *   so each attempt runs under its own `AbortController` with a fixed deadline,
 *   chained to the caller's own signal when it passed one.
 *
 *   The log carries the endpoint path, the HTTP status or the error name, and
 *   the attempt count. NEVER the token (it reaches only the header the caller
 *   built) and never the response body.
 *
 * @outputs
 *   - `postForge` -- injectable: url + init -> the final Response's ok/status,
 *     plus the attempt that produced it
 *   - `FORGE_WRITE_ATTEMPTS` / `FORGE_WRITE_BACKOFF_MS` -- the schedule
 *   - `FORGE_WRITE_ATTEMPT_TIMEOUT_MS` -- the deadline on one attempt
 *   - `listProbe`, `hasIdenticalComment`, `hasIdenticalStatus` -- the
 *     did-it-land probes a retry asks first
 *   - `backoffFromEnv` -- the CLI test seam (`FORGE_WRITE_BACKOFF_MS`)
 */

import { traced } from "../../src/log";

/** How many times a write is tried before the caller is told it failed. */
export const FORGE_WRITE_ATTEMPTS = 20;

/**
 * The fixed wait between attempts. 20 x 30 s = 9.5 min of retrying, longer
 * than the measured 8m42s quiesce, and short enough that a write that meets a
 * forge already back up lands within one wait.
 */
export const FORGE_WRITE_BACKOFF_MS = 30_000;

/**
 * The deadline on ONE attempt. A socket the proxy black-holes is abandoned here
 * and re-asked on the schedule, instead of holding the lane open indefinitely.
 */
export const FORGE_WRITE_ATTEMPT_TIMEOUT_MS = 30_000;

const MAX_REASON_CHARS = 200;

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function reasonForError(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
	}
	return String(error).slice(0, MAX_REASON_CHARS);
}

/** The endpoint as the log names it: the path only, never the host or a query. */
function pathOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "<invalid url>";
	}
}

export type ForgeWriteResult = { ok: boolean; status: number; attempt: number; reason: string };

export interface ForgeWriteOptions {
	attempts?: number;
	backoffMs?: number;
	/** The deadline on one attempt; `FORGE_WRITE_ATTEMPT_TIMEOUT_MS` by default. */
	attemptTimeoutMs?: number;
	/**
	 * Asked BEFORE every retry: did the previous attempt land after all? `true`
	 * ends the write as ok without re-POSTing; `false`, or a probe that throws,
	 * re-asks as before.
	 */
	alreadyApplied?: (signal?: AbortSignal) => Promise<boolean>;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The backoff, cut short the moment the caller's signal aborts (PR #684
 * round 5 P1): a cancelled write must not sit through 30 s sleeps it will
 * never use. Resolves, never rejects; the loop reads `signal.aborted` next.
 */
function sleepUnlessAborted(
	sleep: (ms: number) => Promise<void>,
	ms: number,
	signal: AbortSignal | null | undefined,
): Promise<void> {
	if (!signal) return sleep(ms);
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const onAbort = () => resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		void sleep(ms).then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

type AttemptResult =
	| { kind: "response"; status: number; ok: boolean }
	| { kind: "thrown"; reason: string };

/**
 * One attempt under its own deadline. The caller's signal, when present, is
 * chained in so its abort still cancels the attempt; the deadline's abort is
 * reported like any thrown fetch (retryable).
 */
async function attemptOnce(
	doFetch: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<AttemptResult> {
	const controller = new AbortController();
	const outer = init.signal ?? undefined;
	const onOuterAbort = () => controller.abort(outer?.reason);
	if (outer?.aborted) onOuterAbort();
	else outer?.addEventListener("abort", onOuterAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error(`attempt timed out after ${timeoutMs} ms`)),
		timeoutMs,
	);
	try {
		const res = await doFetch(url, { ...init, signal: controller.signal });
		return { kind: "response", status: res.status, ok: res.ok };
	} catch (error) {
		return { kind: "thrown", reason: reasonForError(error) };
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onOuterAbort);
	}
}

/**
 * The CALLER's abort is terminal: it is not a forge outage
 * to re-ask through, and a cancelled request must not be probed, slept on, or
 * sent again. Checked before every attempt and after each one; only the
 * per-attempt deadline is retryable.
 */
function callerAborted(
	signal: AbortSignal | null | undefined,
	log: (line: string) => void,
	path: string,
	attempt: number,
): ForgeWriteResult | undefined {
	if (!signal?.aborted) return undefined;
	const reason = `aborted by the caller: ${reasonForError(signal.reason)}`;
	log(`forge write ${path} ${reason}; not re-asked\n`);
	return { ok: false, status: 0, attempt, reason };
}

/** Ask the probe; a probe that cannot answer is "not proven", and the write is re-asked. */
async function landedAfterAll(
	probe: ((signal?: AbortSignal) => Promise<boolean>) | undefined,
	log: (line: string) => void,
	path: string,
	signal?: AbortSignal | null,
): Promise<boolean> {
	if (probe === undefined) return false;
	try {
		// The caller's signal reaches the probe, so a
		// cancellation during it ends the probe now rather than at its deadline,
		// and an answer that arrives after the cancellation is not acted on:
		// the loop re-checks the signal right after this returns.
		return await probe(signal ?? undefined);
	} catch (error) {
		log(`forge write ${path}: could not ask whether it landed (${reasonForError(error)})\n`);
		return false;
	}
}

/**
 * Send `init` to `url`, re-asking through a forge outage. The request is sent
 * as given: method, headers and body are the caller's, byte for byte.
 */
async function postForgeImpl(
	url: string,
	init: RequestInit,
	opts: ForgeWriteOptions = {},
): Promise<ForgeWriteResult> {
	const attempts = opts.attempts ?? FORGE_WRITE_ATTEMPTS;
	const backoff = opts.backoffMs ?? FORGE_WRITE_BACKOFF_MS;
	const attemptTimeoutMs = opts.attemptTimeoutMs ?? FORGE_WRITE_ATTEMPT_TIMEOUT_MS;
	const doFetch = opts.fetchImpl ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const log = opts.log ?? ((line: string) => void process.stderr.write(line));
	const path = pathOf(url);

	let reason = "no attempt was made";
	let status = 0;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const cancelledBefore = callerAborted(init.signal, log, path, attempt - 1);
		if (cancelledBefore) return cancelledBefore;
		// A retry asks first: a response lost AFTER the forge stored the write
		// must not become a second comment or status.
		if (attempt > 1) {
			const landed = await landedAfterAll(opts.alreadyApplied, log, path, init.signal);
			const cancelledProbing = callerAborted(init.signal, log, path, attempt - 1);
			if (cancelledProbing) return cancelledProbing;
			if (landed) {
				log(`forge write ${path} landed on attempt ${attempt - 1} after all; not re-asked\n`);
				return { ok: true, status, attempt: attempt - 1, reason: "already applied" };
			}
		}
		const result = await attemptOnce(doFetch, url, init, attemptTimeoutMs);
		const cancelledDuring = callerAborted(init.signal, log, path, attempt);
		if (cancelledDuring) return cancelledDuring;
		let retryable: boolean;
		if (result.kind === "response") {
			status = result.status;
			if (result.ok) {
				return { ok: true, status, attempt, reason: "" };
			}
			reason = `http ${status}`;
			retryable = isRetryableStatus(status);
		} else {
			status = 0;
			reason = result.reason;
			retryable = true;
		}

		if (!retryable || attempt === attempts) {
			// A lost FINAL response is probed once more before the failure is
			// reported: Forgejo may have stored the write and
			// lost only the answer, and a false failure status is the outage's
			// second casualty after a duplicate.
			const landed =
				retryable && (await landedAfterAll(opts.alreadyApplied, log, path, init.signal));
			const cancelledProbing = callerAborted(init.signal, log, path, attempt);
			if (cancelledProbing) return cancelledProbing;
			if (landed) {
				log(`forge write ${path} landed on attempt ${attempt} after all; not re-asked\n`);
				return { ok: true, status, attempt, reason: "already applied" };
			}
			log(`forge write ${path} failed after ${attempt} attempts: ${reason}\n`);
			return { ok: false, status, attempt, reason };
		}

		log(
			`forge write ${path} attempt ${attempt}/${attempts} failed (${reason}); retrying in ${Math.round(backoff / 1000)}s\n`,
		);
		await sleepUnlessAborted(sleep, backoff, init.signal);
	}

	return { ok: false, status, attempt: 0, reason };
}

/**
 * `init` (index 1) is redacted: every caller builds it with the Forge token in
 * an `Authorization` header, which this module's header says is the one place
 * the token travels. `url` is not redacted — the log already names its path —
 * and the result is only ok/status/attempt/reason, which carry no credential.
 */
export const postForge: (
	url: string,
	init: RequestInit,
	opts?: ForgeWriteOptions,
) => Promise<ForgeWriteResult> = traced("actions.postForge", postForgeImpl, {
	redact: { args: [1] },
});

/** A Forge issue comment as the list endpoint returns it: only `body` is compared. */
/** A Forge issue comment row, the one field the probe reads. */
export type CommentRow = { body?: unknown };

function hasIdenticalCommentImpl(comments: readonly CommentRow[], body: string): boolean {
	return comments.some((comment) => comment.body === body);
}

export const hasIdenticalComment = traced("actions.hasIdenticalComment", hasIdenticalCommentImpl, {
	redact: { args: [0, 1] },
});

/** The four fields a commit status is identified by; `state` is what the POST sends. */
export interface StatusIdentity {
	context: string;
	state: string;
	description: string;
	target_url: string;
}

/**
 * A Forge commit status as the list endpoint returns it. The list's field for
 * the state is `status` (Forgejo's CommitStatus JSON), NOT `state`; the POST
 * body's field is `state`. Probed against the live API, not assumed.
 */
/** A Forge commit status row, the four fields the probe reads. */
export type StatusRow = {
	context?: unknown;
	status?: unknown;
	description?: unknown;
	target_url?: unknown;
};

function hasIdenticalStatusImpl(statuses: readonly StatusRow[], want: StatusIdentity): boolean {
	return statuses.some(
		(row) =>
			row.context === want.context &&
			row.status === want.state &&
			row.description === want.description &&
			row.target_url === want.target_url,
	);
}

/**
 * Both arguments are redacted: a Forge status row carries `description` and
 * `target_url`, which are external API content, and a URL can carry credentials
 * in its userinfo. The boolean result is the part worth tracing
 * (round 4).
 */
export const hasIdenticalStatus = traced("actions.hasIdenticalStatus", hasIdenticalStatusImpl, {
	redact: { args: [0, 1] },
});

/**
 * An `alreadyApplied` probe over a Forge LIST endpoint: GET `url` with the
 * caller's headers, and let `pick` decide over the rows. A non-2xx answer or a
 * body that is not an array is "not proven" (`false`), and the write is
 * re-asked; only a list that CONTAINS the write ends the retry.
 *
 * BOUNDED LIKE AN ATTEMPT: the GET runs under its own
 * deadline (`timeoutMs`, the attempt deadline by default), and a probe that
 * hangs into the outage is abandoned and read as "not proven" rather than
 * holding the re-ask forever.
 */
function listProbeImpl<Row>(
	url: string,
	init: { headers: RequestInit["headers"]; timeoutMs?: number },
	pick: (rows: Row[]) => boolean,
	fetchImpl: typeof fetch = fetch,
): (signal?: AbortSignal) => Promise<boolean> {
	return async (signal?: AbortSignal) => {
		const controller = new AbortController();
		// The caller's abort ends the probe too; the answer
		// is then "not proven", and the loop reads the signal next.
		const onOuterAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) onOuterAbort();
		else signal?.addEventListener("abort", onOuterAbort, { once: true });
		const timer = setTimeout(
			() => controller.abort(),
			init.timeoutMs ?? FORGE_WRITE_ATTEMPT_TIMEOUT_MS,
		);
		try {
			const res = await fetchImpl(url, {
				method: "GET",
				headers: init.headers,
				signal: controller.signal,
			});
			if (!res.ok) return false;
			const rows: unknown = await res.json();
			return Array.isArray(rows) ? pick(rows as Row[]) : false;
		} catch (error) {
			if (controller.signal.aborted) return false;
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onOuterAbort);
		}
	};
}

/** The generic call signature `traced()` cannot infer — see `listProbe`. */
type ListProbe = <Row>(
	url: string,
	init: { headers: RequestInit["headers"]; timeoutMs?: number },
	pick: (rows: Row[]) => boolean,
	fetchImpl?: typeof fetch,
) => (signal?: AbortSignal) => Promise<boolean>;

/**
 * `init` (index 1) is redacted: it carries the caller's `Authorization` header,
 * the same Forge token `postForge` sends. `url` and `pick` are not — the URL is
 * a list endpoint and `pick` is a predicate — and the result is the probe
 * closure, which carries nothing on its own.
 *
 * The annotation restores `Row`: `traced()` infers a concrete parameter tuple
 * from the implementation and would erase the type parameter, which both call
 * sites in `post-pr-review.ts` supply explicitly. The wrapper is type-erasing,
 * not behaviour-changing, so the cast re-states the signature it already has.
 */
export const listProbe: ListProbe = traced("actions.listProbe", listProbeImpl, {
	redact: { args: [1] },
}) as ListProbe;

/**
 * A TEST SEAM, CLI only: `FORGE_WRITE_BACKOFF_MS=1` replaces the real wait so a
 * probe can drive the schedule in under a second. Ignored unless it parses as
 * a non-negative integer, so a typo degrades to the real backoff, never to none.
 */
function backoffFromEnvImpl(): number {
	const raw = process.env.FORGE_WRITE_BACKOFF_MS;
	if (raw === undefined || raw.trim() === "") return FORGE_WRITE_BACKOFF_MS;
	const n = Number(raw.trim());
	return Number.isInteger(n) && n >= 0 ? n : FORGE_WRITE_BACKOFF_MS;
}

// No redaction: it takes no argument and returns a millisecond count. The one
// environment variable it reads is a test seam, not a credential.
export const backoffFromEnv = traced("actions.backoffFromEnv", backoffFromEnvImpl);
