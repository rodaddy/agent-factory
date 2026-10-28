/**
 * @module results/ingest
 * @description Ingest a runner's completed result from the shared filesystem.
 *   Runners write `DONE`, `result.json`, and `agent.log` under
 *   `collab/runners/jobs/<job-id>/<hostname>/` on the share. This module reads
 *   that output through an injectable filesystem seam, treats it as untrusted:
 *   it enforces a byte cap, JSON-parses defensively, validates against the
 *   versioned result schema, redacts secret-shaped tokens from bounded text,
 *   and returns a discriminated outcome. Malformed or oversized results fail
 *   safe (an `invalid` outcome the operator can see) rather than corrupting
 *   state. Ingest is idempotent: re-reading the same DONE yields the same
 *   outcome, so it reconciles cleanly after a restart.
 *
 * @outputs
 *   - `ingestResult` -- read + validate one job's result
 *   - `IngestOutcome` -- discriminated ingest result
 *   - `ResultStore` / `ResultReader` -- injectable filesystem + persistence seams
 *   - `ChangeVerifier` -- the seam that PROVES a claimed change before acceptance
 *   - `redactSecrets` -- bounded secret-shaped redaction
 *
 * @dependencies
 *   - ./schema -- the versioned result schema and caps
 */
import { errorClass, log, traced } from "../log";
import { MAX_RESULT_BYTES, type RunnerResult, resultSchema } from "./schema";
import { classifyWrapperFailure, isWrapperEnvelope } from "./wrapper-verdict";

/** Injectable reader over the share; tests supply an in-memory implementation. */
export interface ResultReader {
	/** True when the runner wrote its DONE marker for this job/host. */
	isDone(jobRunnerId: string, hostname: string): Promise<boolean>;
	/** Raw result bytes for the sought artifact, or null if absent. Reads at most `maxBytes`+1. */
	readResult(jobRunnerId: string, hostname: string, maxBytes: number): Promise<string | null>;
	/**
	 * The artifact filename this reader seeks, used ONLY to name it in the
	 * missing-artifact reason so the operator sees which file was actually absent.
	 * Defaults to `result.json` when unset (the wrapper-owned default reader).
	 */
	resultName?: string;
	/**
	 * Classify a MISSING sought artifact from wrapper-owned side-channel state (the
	 * fleet wrapper's `verdict.json`/envelope plus the agent's own `agent.log`),
	 * returning a bounded, sanitized failure reason — or null to fall back to the
	 * generic missing-artifact reason.
	 *
	 * Only the agent-lane adapter implements this: when its named artifact is absent
	 * but the wrapper reached a terminal state, the wrapper's verdict names the cause
	 * (e.g. "no usable agent credentials"), which is a far more useful invalid reason
	 * than "missing". A runtime auth death gets its own class prefix because
	 * a present-but-dead credential passes the wrapper's preflight and leaves its only
	 * trace in the agent log. Every source is UNTRUSTED (the share is writable by
	 * other principals), so the adapter bounds and sanitizes every field it copies and
	 * the log is scanned rather than copied. Absent on the default reader, so ordinary
	 * lanes keep the generic reason unchanged.
	 */
	classifyMissing?(jobRunnerId: string, hostname: string): Promise<string | null>;
	/**
	 * Read this attempt's OPTIONAL agent event stream (`events.jsonl`),
	 * bounded to `maxBytes`, or null when the lane wrote none.
	 *
	 * OBSERVABILITY ONLY. The stream is the input to one Langfuse trace and to the
	 * attempt's attested-model stamp; nothing about validation, verification,
	 * publication, or job state reads it, so its absence, its emptiness, and its
	 * total garbage are all the SAME outcome to ingest: no trace, no attestation,
	 * everything else byte-identical. Absent on readers whose lane has no stream.
	 */
	readEventStream?(jobRunnerId: string, hostname: string, maxBytes: number): Promise<string | null>;
}

/**
 * The OBSERVABILITY seam. Handed the bounded per-attempt trace summary
 * plus the outcome of the gates that ran, so it can emit one Langfuse trace and
 * stamp the attested model on the attempt row.
 *
 * MUST NOT BLOCK and MUST NOT THROW. `observe` is void-returning on purpose:
 * ingest cannot await it, so an unreachable or slow Langfuse cannot stall the
 * ingest boundary or the cycle it runs in. Its implementation catches its own
 * failures and logs one line; ingest additionally guards the call site, so even
 * a faulty observer cannot escape into the ingest path.
 */
export interface IngestObserver {
	/**
	 * Register an in-flight observation chain so a shutdown can DRAIN it before
	 * flushing. Optional: a sink with no flush of its own has nothing to drain.
	 *
	 * Ingest's own read of `events.jsonl` happens BEFORE `observe` is called and
	 * is itself detached, so an implementation that tracks only what `observe`
	 * starts still races its own shutdown — the flush can ship an empty queue
	 * while the read that would have filled it is still in flight (PR #176, Sol
	 * gauntlet P1). Handing the whole chain here is what makes drain-before-flush
	 * mean the read too.
	 *
	 * MUST NOT THROW and MUST NOT BLOCK: it takes the promise and returns.
	 */
	track?(work: Promise<void>): void;
	observe(args: {
		jobRunnerId: string;
		hostname: string;
		/** Raw, UNTRUSTED event-stream text as read from the share. */
		rawEventStream: string;
		/** Whether the result validated and was accepted for persistence. */
		ingested: boolean;
		/**
		 * Whether the document PARSED and validated against `resultSchema` — the
		 * outcome of `decodeResultDocument` alone.
		 *
		 * DISTINCT FROM `ingested` ON PURPOSE. A result can be perfectly
		 * schema-valid and still not be ingested: the change verifier can reject
		 * its proposed change, or the store can refuse it from trusted state.
		 * Deriving the schema score from `ingested` scored those as schema
		 * failures, which is actively false — schema validation had SUCCEEDED and a
		 * later boundary rejected the change. Only a byte-level parse failure or a
		 * schema violation is false here.
		 */
		schemaValid: boolean;
		/** Whether a claimed change was PROVEN; undefined when none was claimed. */
		changeVerified?: boolean;
	}): void;
}

/** Injectable persistence seam for the ingested outcome. */
export interface ResultStore {
	/**
	 * Persist an ingest outcome idempotently for (jobRunnerId, hostname). Must be
	 * safe to call more than once for the same DONE (restart reconciliation).
	 */
	persist(record: PersistedResult): Promise<PersistDecision | undefined>;
}

/** A store may reject an otherwise schema-valid result using trusted state. */
export interface PersistDecision {
	status: "invalid";
	reason: string;
}

/** The record handed to the store for one ingested (or rejected) result. */
export interface PersistedResult {
	jobRunnerId: string;
	hostname: string;
	status: "ingested" | "invalid";
	result?: RunnerResult;
	/** Bounded, redacted reason when status is `invalid`. */
	reason?: string;
	outputPath?: string;
}

/** Outcome of ingesting one job's result. */
export type IngestOutcome =
	| { status: "pending" } // no DONE yet
	| { status: "missing" } // DONE but no result.json
	| { status: "ingested"; result: RunnerResult }
	| { status: "invalid"; reason: string };

/**
 * The change-verification seam (#65 -> #66).
 *
 * A result may CLAIM a change (`result.change`), and that claim is untrusted in
 * every part: the bundle path, the base it says it applies to, the files it says
 * it touched. `results/change-ingest` is what proves it — confined to the job's
 * own output directory, snapshotted to a path the runner cannot write, ancestry-
 * proved against the EXACT dispatched base, and refused if it touches a CI
 * workflow path.
 *
 * It is injected rather than imported directly because verification is
 * filesystem and subprocess work: it must not run inside the result store's
 * `FOR UPDATE` transaction, and tests must be able to ingest without a git repo
 * or a share. When absent, a result carrying a change is REFUSED rather than
 * accepted unverified — a missing verifier must never become an open gate.
 */
export interface ChangeVerifier {
	verify(
		jobRunnerId: string,
		hostname: string,
		result: RunnerResult,
	): Promise<{ status: "ok" } | { status: "rejected"; reason: string }>;
}

/** Cap on a redacted failure reason. */
const MAX_REASON = 300;

/**
 * Byte cap on the OPTIONAL per-attempt event stream, ~4MB.
 *
 * Declared HERE rather than in `observability/event-stream` on purpose: that
 * module imports `redactSecrets` from this one, so importing the cap back would
 * make the two files a cycle. The cap belongs with the other ingest-boundary
 * caps regardless — it is the size of untrusted share content this boundary is
 * willing to read.
 */
export const MAX_EVENT_STREAM_BYTES = 4_000_000;

/**
 * Apply the byte cap, JSON parse, and schema validation to the raw runner
 * document. Every failure is a bounded, redacted `invalid` reason — never a
 * throw, and never the untrusted document text itself.
 */
function decodeResultDocument(
	raw: string,
	jobRunnerId: string,
	hostname: string,
): { status: "ok"; data: RunnerResult } | { status: "invalid"; reason: string } {
	// Byte cap first: an oversized document is rejected without parsing.
	if (byteLength(raw) > MAX_RESULT_BYTES) {
		return { status: "invalid", reason: `result.json exceeds ${MAX_RESULT_BYTES} bytes` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		// Class only, never the message: a JSON parse error quotes the offending span
		// of the untrusted runner document, which is exactly the file content that
		// must not reach a log line.
		log("warn", "results.ingest.unparseable", {
			job_runner_id: jobRunnerId,
			host: hostname,
			error_class: errorClass(err),
		});
		return { status: "invalid", reason: "result.json is not valid JSON" };
	}

	const validated = resultSchema.safeParse(parsed);
	if (!validated.success) {
		// A schema failure is usually a malformed result, but one specific shape is
		// not a result at all: when an agent lane never ran, the fleet wrapper writes
		// its OWN terminal FAILURE ENVELOPE into result.json ({job_id,lane,status,
		// host,state}, no result_version). The zod summary for that document is
		// "invalid_union at result_version", which reads to an operator like a
		// watcher version-skew bug rather than the real cause: the agent never
		// produced a result. Detect that exact envelope and classify it through the
		// wrapper machinery — bounded, sanitized, never throwing — instead. The
		// envelope is UNTRUSTED share content, so the reason is built by
		// classifyWrapperFailure's sanitize/cap discipline over the raw bytes, never
		// echoed field-by-field. Publication stays suppressed either way (invalid);
		// this only fixes WHICH invalid reason the operator sees. Any document that
		// is neither a valid result nor this exact envelope keeps the zod summary
		// byte-identical.
		const classified = isWrapperEnvelope(parsed) ? classifyWrapperFailure(null, raw) : null;
		const reason = (classified ?? redactSecrets(summarizeZodError(validated.error))).slice(
			0,
			MAX_REASON,
		);
		return { status: "invalid", reason };
	}

	return { status: "ok", data: validated.data };
}

/**
 * Ingest one job's result. Returns `pending` until the runner writes DONE, then
 * validates the result and persists a bounded, redacted record. Any parse or
 * validation failure is a safe `invalid` outcome, never a throw that could stall
 * the reconciliation loop.
 */
/** Arguments for {@link ingestResult}. */
export type IngestResultArgs = {
	reader: ResultReader;
	store: ResultStore;
	jobRunnerId: string;
	hostname: string;
	changeVerifier?: ChangeVerifier;
	/** Optional observability sink; absent leaves ingest byte-identical. */
	observer?: IngestObserver;
};

async function ingestResultImpl(args: IngestResultArgs): Promise<IngestOutcome> {
	const { reader, store, jobRunnerId, hostname, changeVerifier } = args;
	if (!(await reader.isDone(jobRunnerId, hostname))) {
		return { status: "pending" };
	}
	// Fire the observability sink on every TERMINAL outcome below (ingested or
	// invalid), never on `pending`: an attempt that has not written DONE has not
	// produced a run to trace. The read and the call are both fully isolated —
	// see `observeAttempt`.
	// `schemaValid` is threaded SEPARATELY from `ingested`: it is the
	// verdict of `decodeResultDocument` and nothing downstream of it. Every call
	// below states it explicitly rather than deriving it, so a later boundary that
	// refuses an otherwise-valid result cannot be recorded as a schema failure.
	const observe = (ingested: boolean, schemaValid: boolean, changeVerified?: boolean): void =>
		launchObservation(args, { ingested, schemaValid, changeVerified });

	const raw = await reader.readResult(jobRunnerId, hostname, MAX_RESULT_BYTES);
	if (raw === null) {
		await persistMissingArtifact(reader, store, jobRunnerId, hostname);
		// No document at all: schema validation never ran, so it did not pass.
		observe(false, false);
		return { status: "missing" };
	}

	const decoded = decodeResultDocument(raw, jobRunnerId, hostname);
	if (decoded.status === "invalid") {
		await store.persist({ jobRunnerId, hostname, status: "invalid", reason: decoded.reason });
		// The one genuine schema failure: unparseable JSON or a schema violation.
		observe(false, false);
		return { status: "invalid", reason: decoded.reason };
	}

	const result = redactResult(decoded.data);
	// Undefined for a report-only lane (no change claimed), so the trace records no
	// change-verification score at all rather than a misleading zero.
	let changeVerified: boolean | undefined;

	// A CLAIMED change must be PROVEN before the result that carries it is
	// accepted (#65 -> #66). The schema has only checked the claim's shape; it
	// cannot know whether the bundle is confined to the job's own directory, whether
	// it descends from the exact commit the watcher dispatched, or whether it edits
	// a CI workflow. Verification runs HERE — outside the store's `FOR UPDATE`
	// transaction, because it reads the filesystem and shells out to git — and its
	// verdict decides whether the result is accepted at all.
	//
	// Fails CLOSED in both directions: an unverifiable change is `invalid`, and a
	// change with no verifier configured is `invalid` too. Accepting the result
	// while silently skipping publication would mark the job completed and leave a
	// change that was never proved looking exactly like one that was.
	if (result.change !== undefined) {
		const verdict = changeVerifier
			? await changeVerifier.verify(jobRunnerId, hostname, result)
			: { status: "rejected" as const, reason: "no change verifier is configured" };
		changeVerified = verdict.status === "ok";
		if (verdict.status === "rejected") {
			const reason = redactSecrets(verdict.reason).slice(0, MAX_REASON);
			await store.persist({ jobRunnerId, hostname, status: "invalid", reason });
			// SCHEMA-VALID, change rejected. The document decoded and validated;
			// the change verifier refused what it proposed. Scoring this as a schema
			// failure blamed the wrong boundary.
			observe(false, true, changeVerified);
			return { status: "invalid", reason };
		}
	}

	const decision = await store.persist({
		jobRunnerId,
		hostname,
		status: "ingested",
		result,
		outputPath: result.output_path,
	});
	if (decision?.status === "invalid") {
		// Schema-valid too: the store refused it from trusted state, not the schema.
		observe(false, true, changeVerified);
		return decision;
	}
	observe(true, true, changeVerified);
	return { status: "ingested", result };
}

/**
 * `traced()` build-phase wrapper for {@link ingestResultImpl}.
 *
 * Kept in the `nameImpl` form because the body is long; the `as typeof`
 * preserves the exact declared signature.
 *
 * The RESULT is masked: an `ingested` outcome carries the full `RunnerResult`,
 * whose free-text fields are runner-authored and only pass `redactSecrets` on
 * the persistence path, not on the value returned here.
 */
export const ingestResult = traced("results.ingestResult", ingestResultImpl, {
	redact: { result: true },
}) as typeof ingestResultImpl;

/**
 * Persist the bounded `invalid` record for a MISSING sought artifact.
 *
 * Prefers a wrapper-verdict classification when the reader offers one (the agent
 * lanes: "runner agent failed before producing a result: <state> — <language>");
 * otherwise falls back to a generic message that names the artifact actually
 * sought — never a hardcoded `result.json` when a named artifact was expected.
 * Both reasons are already bounded/sanitized by the adapter; the generic name is
 * a fixed author literal.
 */
async function persistMissingArtifact(
	reader: ResultReader,
	store: ResultStore,
	jobRunnerId: string,
	hostname: string,
): Promise<void> {
	const artifact = reader.resultName ?? "result.json";
	const classified = reader.classifyMissing
		? await reader.classifyMissing(jobRunnerId, hostname)
		: null;
	const reason = classified ?? `DONE present but ${artifact} is missing`;
	await store.persist({ jobRunnerId, hostname, status: "invalid", reason });
}

/**
 * Read this attempt's optional event stream and hand it to the observability
 * sink. FULLY ISOLATED from ingest in three ways, because an observability path
 * that can fail an ingest is worse than no observability at all:
 *
 *   1. It is never awaited by `ingestResult` — the caller fires it and returns,
 *      so a slow or hanging Langfuse cannot stall the ingest boundary.
 *   2. Every throw is caught here and reduced to one log line. That includes a
 *      throw from the READ (a faulty reader) and from the sink itself.
 *   3. It runs only when both a sink and a stream-capable reader are present,
 *      and an absent or empty stream produces no trace and no attestation — so a
 *      lane that writes no `events.jsonl` is unchanged in every OUTCOME it
 *      reaches. It is no longer SILENT, though: since #240 that case emits one
 *      `info` line naming the job/attempt, because "the lane wrote no stream"
 *      and "the reader never ran" were indistinguishable from outside for two
 *      days.
 *
 * The stream is UNTRUSTED runner output; the byte cap is applied at the read, and
 * every field derived from it is clipped and redacted downstream.
 */
/**
 * Start one observation and hand the WHOLE chain to the observer's drain set.
 *
 * DETACHED, BUT TRACKED. Ingest awaits nothing here — that is the non-blocking
 * contract and it is unchanged. What changed is that the promise now has a
 * holder: `track` lets the observer's shutdown wait for this read+stamp+enqueue
 * to finish before it flushes. Untracked, the flush raced the read and shipped
 * an empty queue while the traces were still being assembled (PR #176, Sol
 * gauntlet P1).
 *
 * `track` is OPTIONAL on the interface, so an observer without one keeps the
 * old fire-and-forget behavior rather than failing.
 */
function launchObservation(
	args: IngestResultArgs,
	outcome: { ingested: boolean; schemaValid: boolean; changeVerified?: boolean },
): void {
	const work = observeAttempt(args, outcome);
	const observer = args.observer;
	if (observer?.track === undefined) {
		void work;
		return;
	}
	observer.track(work);
}

async function observeAttempt(
	args: IngestResultArgs,
	outcome: { ingested: boolean; schemaValid: boolean; changeVerified?: boolean },
): Promise<void> {
	const { reader, observer, jobRunnerId, hostname } = args;
	if (observer === undefined || reader.readEventStream === undefined) {
		return;
	}
	try {
		const raw = await reader.readEventStream(jobRunnerId, hostname, MAX_EVENT_STREAM_BYTES);
		if (raw === null || raw.trim() === "") {
			// VISIBLE, at `info`. This return is where a genuinely ABSENT stream
			// stops: `observer.observe` is never called, so the observer's own
			// unusable-stream skip — raised to `info` by #219 — is unreachable from
			// here and covers present-but-unparseable streams only. The two-day
			// zero-signal outage #219 describes ran through THIS path: with the
			// producer unwired, 214 attempt directories held no stream at all and
			// ingest returned silently at every log level.
			//
			// `info`, not `debug`, for the reason stated one module over in
			// `attempt-observer.ts`: the level is fixed at module init from
			// `LOG_LEVEL`, so a debug line does not exist in the default deployment —
			// exactly where "the lane wrote no stream" and "the reader never ran" look
			// identical from outside.
			//
			// NOT per-attempt noise once a lane writes its stream: a present stream
			// skips this branch entirely, and the control clause in
			// `tests/results/absent-stream-visibility.test.ts` asserts that absence.
			// `reason` separates the two producer faults that share this return — a
			// file that was never written from one written empty — because they are
			// diagnosed differently.
			log("info", "results.ingest.event_stream_absent", {
				job_runner_id: jobRunnerId,
				host: hostname,
				reason: raw === null ? "absent" : "empty",
			});
			return;
		}
		observer.observe({
			jobRunnerId,
			hostname,
			rawEventStream: raw,
			ingested: outcome.ingested,
			schemaValid: outcome.schemaValid,
			changeVerified: outcome.changeVerified,
		});
	} catch (err) {
		// Class only, never the message: a read error can quote a share path, and a
		// sink error can quote the request body it failed on.
		log("warn", "results.ingest.observe_failed", {
			job_runner_id: jobRunnerId,
			host: hostname,
			error_class: errorClass(err),
		});
	}
}

/** Byte length of a UTF-8 string. */
function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/**
 * One-line, bounded summary of a Zod failure. Emits only the issue code and the
 * field path — never the issue message, which can embed the raw untrusted value
 * (e.g. an unrecognized key name), letting runner output steer the reason.
 */
function summarizeZodError(error: {
	issues: ReadonlyArray<{ code?: string; path: PropertyKey[] }>;
}): string {
	const first = error.issues[0];
	if (!first) {
		return "result failed schema validation";
	}
	// Only the path segments that are safe identifiers are echoed; anything else
	// (e.g. an attacker-chosen key that appears in the path) is masked.
	const path = first.path
		.map((seg) =>
			typeof seg === "number" || /^[A-Za-z0-9_]+$/.test(String(seg)) ? String(seg) : "*",
		)
		.join(".");
	const code = first.code ?? "invalid";
	return `${code} at ${path || "(root)"}`;
}

/**
 * Ordered, linear-time redaction rules. Each pattern is anchored and has no
 * adjacent unbounded quantifiers, so redaction is O(n) in the input and cannot
 * be driven into catastrophic backtracking by a crafted, keyword-dense result.
 * Defence-in-depth: results should never contain secrets, but a runner could
 * echo one into any bounded text field.
 */
// The token-prefix patterns below carry NO leading `\b`: a runner can echo a
// token glued to a preceding word character (`runid12ghp_...`), and a leading
// word boundary never matches there, so the token survived redaction.
// The distinctive prefix (`ghp_`, `github_pat_`, `xox`, `AKIA`, `eyJ`) plus the
// length floor is the anchor; the TRAILING `\b` is kept so the match still ends
// at the token. Over-redacting a rare glued false positive is the correct trade
// for defence-in-depth. Dropping a leading `\b` adds no quantifier, so the
// linear-time property documented above is unchanged.
//
// #204 is the MIRROR half of that leak class, and it is a LENGTH property
// rather than an anchor one. The fixed-length AWS pattern was `{16}` closed by
// `\b`: a 17th word character made the `\b` fail with no shorter alternative to
// fall back to, the whole match failed, and `AKIAIOSFODNN7EXAMPLEz` was emitted
// INTACT. The chosen span is the conservative one from the issue — consume the
// maximal surrounding word-character run — expressed by closing the token span
// with `\w*` rather than `\b`.
//
// Widening the body to `{16,}` looks like the obvious fix and is NOT sufficient:
// the body class `[A-Z0-9]` cannot match a lowercase suffix, so the run still
// halts at 16 and the `\b` still fails. Probed before this change landed. `\w*`
// is case-blind, so it closes the leak for any word-character suffix, and it
// leaves no residue dangling beside `[REDACTED]` — the residue is the risk, not
// the over-redaction. A `\w*` tail adds no adjacent unbounded quantifier (it
// follows a fixed-length body), so the linear-time property is unchanged.
//
// This widens the over-redaction trade disclosed on #198: an uppercase digest
// containing `AKIA`/`ASIA` now redacts its whole word run rather than 20
// characters of it. That is the direction #204 asked for.
const SECRET_PATTERNS: RegExp[] = [
	// GitHub tokens: classic (ghp_/gho_/...) and fine-grained (github_pat_).
	/gh[posru]_[A-Za-z0-9]{20,}\b/g,
	/github_pat_[A-Za-z0-9_]{20,}\b/g,
	// mcp2cli tokens, bare. A bare `m2c_...` passed through
	// because only the `token `/`token=`/`Bearer` forms had a pattern. The span is
	// closed by `\w*` per the #204 note; once the 16-character floor is met the
	// `\w*` tail always succeeds, so there is no backtracking and matching stays
	// linear.
	//
	// A Forgejo API token (40 hex, no prefix) deliberately has NO pattern: it
	// cannot be told apart from a git SHA, and a regex would redact every commit
	// id. The control has to be keeping that token out of runner-visible text, and
	// it is NOT in place yet (push mode puts a repo-write credential in the box,
	// standing ruling 1), so that residual exposure is tracked on sf#826.
	// tests/results/ingest.test.ts pins it.
	/\bm2c_[A-Za-z0-9]{16,}\w*/g,
	// Slack tokens.
	/xox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	// AWS access key ids and their secret keys. The id body stays exactly 16, but
	// the span is closed by `\w*` instead of `\b` — see the #204 note above.
	// Widening the body to `{16,}` is NOT sufficient and was verified insufficient:
	// `[A-Z0-9]` cannot match a LOWERCASE suffix, so `AKIAIOSFODNN7EXAMPLEz` still
	// stops the run at 16 and still fails the `\b` against the `z`. `\w*` consumes
	// the remainder of the word-character run whatever its case, which both closes
	// the leak and leaves no residue beside `[REDACTED]`.
	/(?:AKIA|ASIA)[A-Z0-9]{16}\w*/g,
	/\baws_secret_access_key\b\s*[:=]\s*[A-Za-z0-9/+]{40}/gi,
	// JWTs (three base64url segments).
	/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
	// Authorization: Bearer <token>.
	/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
	// Authorization: token <token> -- the SPACE-separated scheme Forgejo and the
	// Gitea API use, distinct from the `token:`/`token=` assignment forms the
	// generic patterns below already cover. It is the shape the runner transport's
	// stderr carries when a gateway quotes its own credential back, and it reached
	// a public forge issue body unredacted because `Bearer` had a pattern and this
	// did not. Anchored on `token` preceded by `Authorization:` OR at a
	// word boundary followed by a long opaque run, so ordinary prose like
	// "token count" cannot match.
	/\btoken\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
	// Basic-auth credentials embedded in a URL / connection string. The userinfo
	// may be user:pass or credentials-only (:pass). Only the secret span is
	// replaced; the scheme prefix is dropped with it.
	//
	// #205: EVERY quantifier here is bounded, and the SCHEME bound is the one
	// that matters. The old pattern was `[a-zA-Z][a-zA-Z0-9+.-]*://` — on a long
	// dotted run (`a.b-c` repeated) that unbounded scheme tail re-scans to the
	// end of the run from every one of the n start positions before failing on
	// the literal `:`, which is O(n^2): measured 4x per doubling, 92.7ms at 80KB.
	// Bounding the scheme to 32 characters caps the per-position work at a
	// constant, making the whole pattern linear — measured 1.3ms at 80KB, a ~70x
	// improvement, with 2x per doubling. Note that bounding the USERINFO instead
	// does NOT fix it (probed: still 1445ms at 80KB); the scheme tail is the
	// quadratic term. No registered URI scheme approaches 32 chars.
	//
	// The first pass keeps the common path bounded. Its bounds are not permission
	// to emit larger credentials: the companion pass requires either side of the
	// userinfo separator to exceed 256 and redacts that whole span fail-closed.
	// Both passes keep the scheme bound that owns the linear-time guarantee.
	/\b[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s/:@]{0,256}:[^\s/@]{1,256}@/g,
	/\b[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/(?:[^\s/:@]{257,}:[^\s/@]+|[^\s/:@]{0,256}:[^\s/@]{257,})@/g,
	// PEM private key blocks (lazy, single scan).
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	// A secret-labelled assignment. The keyword must be the TAIL of the key —
	// immediately followed by an optional closing quote then `:`/`=` — so a
	// snake-cased key whose last segment is the keyword (`client_secret=`,
	// `refresh_token:`) is redacted, while an identifier that merely CONTAINS the
	// keyword followed by more characters (`token_refresh.ts:42`) is left intact.
	// A leading quote/word chars before the keyword are allowed. No adjacent
	// unbounded quantifiers, so matching stays linear.
	/(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)"?\s*[:=]\s*"?[^\s"]+/gi,
];

/** Redact secret-shaped content from a bounded string (linear time). */
export const redactSecrets = traced(
	"results.redactSecrets",
	function redactSecrets(value: string): string {
		let out = value;
		for (const pattern of SECRET_PATTERNS) {
			out = out.replace(pattern, "[REDACTED]");
		}
		return out;
	},
	// BOTH ENDS, and the return is the subtle one. The INPUT is by definition the
	// un-redacted string, so tracing it verbatim would defeat the function this
	// wrapper observes. The OUTPUT is redacted only as far as SECRET_PATTERNS
	// above reaches, and that list is deliberately finite: a bare 40-hex Forgejo
	// token is NOT in it (tracked on sf#826). The `m2c_` shape was the same
	// gap until sf#814 added it, so the RESULT of the redactor can
	// still emit a live credential into a debug trace line.
	//
	// Persisting that result is still correct: the caller needs the best-effort
	// redacted text, and a bounded column an operator reads is a different
	// exposure from a log shipped to Loki. Widening SECRET_PATTERNS is issue #60's
	// job, not this wrapper's.
	{ redact: { args: [0], result: true } },
);

/** Apply redaction to every bounded, free-text field that gets persisted. */
function redactResult(result: RunnerResult): RunnerResult {
	return {
		...result,
		output_path: result.output_path ? redactSecrets(result.output_path) : result.output_path,
		checks: result.checks.map((c) => ({
			...c,
			name: redactSecrets(c.name),
			summary: c.summary ? redactSecrets(c.summary) : c.summary,
		})),
		findings: result.findings.map((f) => ({
			...f,
			title: redactSecrets(f.title),
			detail: f.detail ? redactSecrets(f.detail) : f.detail,
			location: f.location ? redactSecrets(f.location) : f.location,
		})),
		// The v2 change block is runner-authored free text like every field above:
		// `bundle_path` allows 1024 chars and `branch` 255, both chosen by the box.
		// Omitting it here would make the one NEW field set in schema v2 the only
		// persisted runner text that is never redacted.
		change: result.change
			? {
					...result.change,
					bundle_path: result.change.bundle_path
						? redactSecrets(result.change.bundle_path)
						: result.change.bundle_path,
					branch: result.change.branch ? redactSecrets(result.change.branch) : result.change.branch,
				}
			: result.change,
	};
}
