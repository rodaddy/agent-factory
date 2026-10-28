/**
 * @module results/wrapper-verdict
 * @description Classify an agent-lane failure from the fleet runner wrapper's
 *   OWN terminal-state side channel. The wrapper
 *   (`rtech-infra scripts/runner-job`) writes `$SHARE/verdict.json`
 *   (`{job_id,lane,host,state,rc,agent_status,language}`) and mirrors an envelope
 *   into `$SHARE/result.json` (`{job_id,lane,status,host,state}`) on EVERY
 *   terminal path, success included. When an agent lane's named result artifact
 *   is ABSENT, that side channel is the only record of WHY the agent produced no
 *   result — the wrapper's `state` names the terminal state and `language` is its
 *   human-readable cause ("no usable agent credentials...", "agent runtime ran to
 *   completion...").
 *
 *   This share is writable by other principals, so the verdict and envelope are
 *   UNTRUSTED input: every field copied out is sanitized to a conservative safe
 *   charset and hard-bounded before it reaches a persisted reason string. A
 *   malformed, oversized, or absent verdict yields `null` (fall back to the
 *   generic missing-artifact reason) rather than a throw.
 *
 *   RUNTIME AUTH DEATH IS ITS OWN CLASS. The wrapper's terminal state
 *   cannot express it: `ST_NO_CREDENTIALS` fires only when the credential FILE
 *   is absent or empty, so a structurally-valid but DEAD credential passes
 *   preflight, the agent runs, dies on the expired session, and the wrapper
 *   finishes `completed` with a nonzero `agent_status`. The only record of the
 *   cause is the agent's own log. `classifyRuntimeAuthFailure` reads that
 *   signature and `classifyWrapperFailure` prefixes the reason with
 *   `RUNTIME_AUTH_FAILURE_CLASS`, so an operator sees a credential to re-auth
 *   instead of a path to go hunting.
 *
 * @outputs
 *   - `classifyWrapperFailure` -- bounded failure reason from verdict/envelope/agent-log bytes
 *   - `classifyRuntimeAuthFailure` -- true when bytes carry a runtime auth-death signature
 *   - `isWrapperEnvelope` -- true when a parsed document is the wrapper's failure envelope
 *   - `WRAPPER_VERDICT_NAME` / `WRAPPER_ENVELOPE_NAME` / `AGENT_LOG_NAME` -- the artifacts read
 *   - `RUNTIME_AUTH_FAILURE_CLASS` / `MAX_AGENT_LOG_BYTES`
 *
 * @dependencies
 *   - ../log -- `traced()`, the build-phase debug trace wrapper
 */
import { traced } from "../log";

/** The wrapper's richer per-job verdict artifact (carries `state` and `language`). */
export const WRAPPER_VERDICT_NAME = "verdict.json" as const;

/** The wrapper's caller-facing envelope (carries `state`; no `language`). */
export const WRAPPER_ENVELOPE_NAME = "result.json" as const;

/** The agent's own stdout/stderr transcript, written by the wrapper's `tee`. */
export const AGENT_LOG_NAME = "agent.log" as const;

/** Max chars of any single wrapper field copied into the reason (untrusted). */
const MAX_FIELD = 200;

/** Max bytes of a wrapper artifact we will parse — it is a tiny fixed envelope. */
export const MAX_WRAPPER_BYTES = 8 * 1024;

/**
 * Max bytes of `agent.log` scanned for the auth signature. Far larger than a
 * wrapper envelope because the log is a full agent transcript, and still hard
 * bounded — this is UNTRUSTED runner output on a share other principals can
 * write, so it is scanned, never copied into the reason.
 */
export const MAX_AGENT_LOG_BYTES = 256 * 1024;

/**
 * The distinct failure class for an agent that died because its runtime
 * credential would not authenticate.
 *
 * A FIXED AUTHOR LITERAL. It is prefixed onto the reason OUTSIDE the sanitized
 * untrusted fields, so no crafted verdict or log can forge it and none of the
 * sanitizer's charset stripping applies to it.
 *
 * Deliberately narrow: it names AUTH death specifically, not agent death
 * generally. A class that matched every agent failure would distinguish
 * nothing, which is the whole point of carving it out of "artifact missing".
 */
export const RUNTIME_AUTH_FAILURE_CLASS = "runtime-auth-failure" as const;

/**
 * The auth-death signatures, matched case-insensitively against the agent's log
 * and against the wrapper's `language` field.
 *
 * PROBED, NOT GUESSED (AGENTS.md: verify the mechanism against the real tool).
 * Read from `rtech-infra scripts/runner-job` on 2026-08-14:
 *
 *   - `finish()` builds `language` from a FIXED `state_language()` enum — it is
 *     never the agent's own text. The one auth-shaped state,
 *     `ST_NO_CREDENTIALS` ("no usable agent credentials on the share..."), is
 *     reachable ONLY from the preflight `[ -s "$AUTH/claude-credentials.json" ]`
 *     test, i.e. an ABSENT or EMPTY credential file.
 *   - The live 71/71 deaths are NOT that case. The credential file was present
 *     and structurally valid but its session was dead, so preflight passed, the
 *     agent ran, and the wrapper finished `ST_COMPLETED` with a nonzero
 *     `agent_status`. `agent.log` carries the only cause text:
 *     "Failed to authenticate: OAuth session expired and could not be refreshed".
 *
 * So both sources are scanned. The log is where the live defect actually lives;
 * the `language` scan catches the wrapper's own credential-preflight state and
 * any future wrapper that does surface agent text there.
 *
 * Each entry is a phrase specific to CREDENTIAL/SESSION failure. Bare "auth" or
 * "error" are deliberately excluded: they appear in agent logs that have
 * nothing to do with a dead credential, and stamping the class onto those
 * destroys the distinction it exists to make.
 */
const AUTH_FAILURE_SIGNATURES: readonly string[] = [
	"failed to authenticate",
	"oauth session expired",
	"oauth token expired",
	"could not be refreshed",
	"invalid api key",
	"authentication_error",
	"no usable agent credentials",
	"credentials are invalid",
	"please run /login",
	"please log in again",
] as const;

/**
 * True when the given UNTRUSTED bytes carry a runtime auth-death signature.
 *
 * Pure and total: `null`, oversized, and unmatched bytes all return `false`,
 * never a throw. Nothing from `bytes` is retained — the function answers a
 * yes/no question, so a crafted log can at most cause a MISclassification, never
 * an injection.
 */
export const classifyRuntimeAuthFailure = traced(
	"results.classifyRuntimeAuthFailure",
	function classifyRuntimeAuthFailure(bytes: string | null): boolean {
		if (bytes === null) {
			return false;
		}
		// Bound the scan the same way every other untrusted read here is bounded. A
		// log past the cap is scanned up to the cap rather than refused outright:
		// unlike a JSON envelope there is nothing to parse, and the auth failure the
		// agent dies on is emitted early.
		const haystack = bytes.slice(0, MAX_AGENT_LOG_BYTES).toLowerCase();
		return AUTH_FAILURE_SIGNATURES.some((signature) => haystack.includes(signature));
	},
	// `bytes` is a raw agent transcript: untrusted free text that can carry a
	// bare token with no key for `summarize()` to match on.
	{ redact: { args: [0] } },
);

/**
 * Reduce an untrusted wrapper field to a conservative safe charset and bound its
 * length. Newlines, quotes, and control characters are dropped so a crafted
 * verdict cannot inject structure into the reason line or a downstream log. An
 * empty result after sanitization becomes `null` so the caller can omit it.
 */
function sanitizeField(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const cleaned = value
		.replace(/[^A-Za-z0-9 ._:;/()-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_FIELD);
	return cleaned.length > 0 ? cleaned : null;
}

/**
 * Parse one wrapper artifact's bytes and extract the sanitized `state` and
 * `language`. Returns `null` when the bytes are absent, oversized, not an object,
 * or carry no usable `state`. Never throws on malformed JSON.
 */
function readVerdict(bytes: string | null): { state: string; language: string | null } | null {
	if (bytes === null || bytes.length > MAX_WRAPPER_BYTES) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return null;
	}
	const record = parsed as Record<string, unknown>;
	const state = sanitizeField(record.state);
	if (state === null) {
		return null;
	}
	return { state, language: sanitizeField(record.language) };
}

/**
 * Build a bounded, sanitized agent-failure reason from the wrapper's verdict
 * and/or envelope bytes, plus the agent's own log.
 *
 * Prefers `verdict.json` (it carries the human-readable `language`); falls back
 * to the `result.json` envelope's `state` when the verdict is absent or
 * unusable. Returns `null` when NEITHER source yields a usable `state`, so the
 * caller falls back to the generic missing-artifact reason.
 *
 * Shape: `runner agent failed before producing a result: <state> — <language>`
 * (the ` — <language>` clause is omitted when no language is present).
 *
 * AUTH CARVE-OUT. When the agent log OR the wrapper's language carries
 * a runtime auth-death signature, the reason is prefixed with the fixed
 * `RUNTIME_AUTH_FAILURE_CLASS` literal:
 *
 *   `runtime-auth-failure: runner agent failed before producing a result: ...`
 *
 * The class goes in FRONT of the untrusted remainder so it is the first thing an
 * operator reads and so no crafted field can forge or displace it. The existing
 * suffix is unchanged, which keeps every non-auth reason byte-identical to
 * before — the class ADDS a distinction rather than replacing the detail.
 *
 * `agentLogBytes` is OPTIONAL and defaults to `null`, so every existing
 * two-argument caller keeps its exact prior behaviour except for a verdict whose
 * own `language` already names an auth failure, which is the case that was
 * misfiling itself as generic.
 */
export const classifyWrapperFailure = traced(
	"results.classifyWrapperFailure",
	function classifyWrapperFailure(
		verdictBytes: string | null,
		envelopeBytes: string | null,
		agentLogBytes: string | null = null,
	): string | null {
		const verdict = readVerdict(verdictBytes) ?? readVerdict(envelopeBytes);
		if (verdict === null) {
			return null;
		}
		const tail = verdict.language ? ` — ${verdict.language}` : "";
		const base = `runner agent failed before producing a result: ${verdict.state}${tail}`;
		// Scan the agent's own transcript AND the wrapper language clause. The live
		// defect (a dead-but-present credential) leaves its only trace in the log;
		// the language scan catches the wrapper's own no-credentials preflight state.
		const isAuth =
			classifyRuntimeAuthFailure(agentLogBytes) || classifyRuntimeAuthFailure(verdict.language);
		return isAuth ? `${RUNTIME_AUTH_FAILURE_CLASS}: ${base}` : base;
	},
	// All three arguments are raw runner-written bytes (verdict, envelope, agent
	// transcript) and the reason is built from them, so both sides are masked.
	{ redact: { args: [0, 1, 2], result: true } },
);

/**
 * Recognize the fleet wrapper's terminal FAILURE ENVELOPE among documents that
 * already failed the result schema. When an agent lane never produced a result,
 * the wrapper (`rtech-infra scripts/runner-job` `finish()`) still writes its own
 * envelope into `result.json`:
 *
 *   `{"job_id":"…","lane":"…","status":<agent_status|null>,"host":"…","state":"…"}`
 *
 * That envelope carries NONE of a real result's markers — no `result_version`,
 * no `repository`, no `job_type` — so the schema rejects it, and the zod summary
 * ("invalid_union at result_version") reads to an operator like a watcher
 * version-skew bug rather than "the agent never ran". This detector lets the
 * ingest boundary route such a document to `classifyWrapperFailure` for a
 * meaningful reason instead.
 *
 * The match is deliberately narrow and closed: the parsed value must be a plain
 * object carrying EXACTLY the envelope's five fields with string `job_id`,
 * `lane`, `host`, and `state`, and it must NOT carry `result_version` (the field
 * every real result — including a partially-formed one — is required to have).
 * A document that is neither a valid result nor this exact envelope is left to
 * keep the zod summary, byte-identical to before. This is a shape probe only; it
 * copies no bytes and trusts nothing — the reason itself is still built by the
 * sanitize/cap discipline in `classifyWrapperFailure`.
 */
export const isWrapperEnvelope = traced(
	"results.isWrapperEnvelope",
	function isWrapperEnvelope(parsed: unknown): boolean {
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return false;
		}
		const record = parsed as Record<string, unknown>;
		// A real result always carries result_version; its presence rules the document
		// out as a wrapper envelope regardless of the other keys.
		if ("result_version" in record) {
			return false;
		}
		// Require the wrapper's exact field set: the four string fields plus `status`
		// (a number or null — the agent exit code), and no extra keys, so an arbitrary
		// malformed result that merely happens to include `state` is not swept in.
		const keys = Object.keys(record);
		if (keys.length !== 5) {
			return false;
		}
		for (const field of ["job_id", "lane", "host", "state"] as const) {
			if (typeof record[field] !== "string") {
				return false;
			}
		}
		const status = record.status;
		return typeof status === "number" || status === null;
	},
	// `parsed` is an arbitrary runner-written JSON document; it reaches here
	// before any schema has bounded its key set.
	{ redact: { args: [0] } },
);
