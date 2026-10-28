/**
 * @module log
 * @description The service's only logger. One preconfigured pino instance,
 *   NDJSON to stderr; every call site uses `log()`/`errorMessage()`/
 *   `errorClass()`/`bounded()` and never touches pino directly.
 *
 *   WHY THIS EXISTS. The service had 4 `console.*` calls — all CLI
 *   help/usage text — against 60 unbound catch blocks that discarded the error
 *   without binding it. (This sentence deliberately avoids writing that construct
 *   literally: the issue's acceptance check is a grep for it across `src/`, and a
 *   mention in prose would keep that count from ever reaching zero.)
 *   Every one of those was a place where something failed and
 *   nothing was recorded, so diagnosing the #59 dependency-staging bug meant
 *   hand-reading `agent.log` on a runner box and running `tar -tf` on a staged
 *   artifact. The information existed and was thrown away.
 *
 *   CONTRACT. Silence means success: every degraded or failed path emits a line.
 *   Lines are single-object NDJSON so they survive being read out of a runner log
 *   and are ingestible by Loki/Prometheus tooling without a parser.
 *
 *   ENGINE (issue #88, RULED by the owner 2026-08-01, ticket Option B). The hand-rolled
 *   `key=value` emitter is retired in favor of pino — never hand-roll a solved
 *   problem, and logs must be ingestible by the Loki/Prometheus stack. `log()`
 *   delegates to a single preconfigured pino instance owned by this module, so
 *   the ~35 call sites keep byte-identical signatures and NO other file imports
 *   pino. The two security controls from #60 — `errorClass()` (class name only,
 *   never the message) and `bounded()` (clamp arbitrary untrusted text) — are
 *   preserved verbatim, because pino's `redact` masks known key paths but does
 *   NOT clamp runaway message text or strip an unknown-shaped secret out of an
 *   `Error.message`. Redact is added belt-over-belt on top of them.
 *
 *   DELTAS FROM THE GENERATED STANDARD (`_DOCS/STANDARDS-observability.md`,
 *   `_DOCS/STANDARDS-typescript.md`), each a deliberate repo-local ruling:
 *     - STREAM is STDERR, not stdout. This repo's CLI contract reserves stdout
 *       for command output (`--version`/`--help`, the reconcile summary a caller
 *       may pipe); `tests/index.test.ts` asserts `--version` stdout carries no
 *       log lines. Under systemd both streams land in journald, where Alloy
 *       tails into Loki, so stderr is not a downgrade.
 *     - NO app-side rotating file. journald owns persistence and rotation; the
 *       app must never know its destination.
 *     - `message` is the stable EVENT NAME (mapped to pino `msg`), not a
 *       sentence — matching the standard's "message = stable event name".
 *     - Correlation keys ride an `AsyncLocalStorage` log context:
 *       `withLogFields()` seeds `delivery_id`/`pass_id`/`job_id` at a boundary
 *       and a pino `mixin` stamps them on every line in that scope, `traced()`
 *       emissions included. The earlier deferral pointed at #87, which is the
 *       file-size ticket; #526 is the real home.
 *     - `MAX_FIELD` is 200 (the standard's per-string cap); repo-local may be
 *       lower than the standard, never higher.
 *
 *   LEVEL FROM CONFIG. `LOG_LEVEL` selects the level, validated at module init
 *   against pino's own level names — an invalid value throws at boot (pino
 *   rejects an unknown default level on construction) rather than silently
 *   defaulting. Absent, the level is `info`. `RODADDY_WATCHER_DEBUG` stays
 *   honored for deploy compat: set non-empty with `LOG_LEVEL` unset, the level
 *   is `debug`.
 *
 *   NEVER LOG SECRETS. Callers pass only identifiers and bounded summaries — no
 *   tokens, credentials, or candidate file contents. `bounded()` caps any
 *   untrusted string so one runaway stderr cannot flood a log line, and pino
 *   `redact` masks the standard's minimum key list as a second layer.
 *
 * @outputs
 *   - `log` -- emit one structured NDJSON line at a level
 *   - `bounded` -- clamp untrusted text to a safe length for a log line
 *   - `errorMessage` -- the message of an unknown caught value
 *   - `errorClass` -- the class only, for errors whose message may carry a secret
 *   - `summarize` -- bounded recursive sanitizer for arbitrary log context
 *   - `traced` -- wrap a function so entry/exit/duration/failure emit automatically
 *   - `withLogFields` -- run a function with correlation fields on every line it emits
 */

import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

/**
 * The per-scope correlation fields. Read by the root logger's `mixin`,
 * so every line emitted inside a `withLogFields()` scope carries them without
 * the call site passing them. Fields a call site passes explicitly win (pino
 * merges the call's object over the mixin's).
 */
const logContext = new AsyncLocalStorage<Record<string, unknown>>();

/** Max characters of untrusted text allowed into a single log line. */
const MAX_FIELD = 200;

/**
 * Levels, in the five places the standard requires a line: `debug` on entry,
 * `info` on result, `warn` on a degraded/fallback/guard path, `error` on failure.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Resolve the configured level. `LOG_LEVEL` wins and is validated by pino at
 * construction (an unknown default level throws). `RODADDY_WATCHER_DEBUG`
 * non-empty with `LOG_LEVEL` unset selects `debug` for deploy compat. Absent,
 * `info`.
 */
function resolveLevel(): string {
	const configured = (process.env.LOG_LEVEL ?? "").trim();
	if (configured !== "") return configured;
	if ((process.env.RODADDY_WATCHER_DEBUG ?? "") !== "") return "debug";
	return "info";
}

/**
 * The one preconfigured logger instance. Base fields carry `service`; the level
 * formatter emits the level NAME (pino's native numeric level is not the stable
 * signal the standard asks for); `redact` masks the standard's minimum key list
 * at depth 1 and 2. Writes synchronous NDJSON to fd 2 (stderr).
 *
 * Constructed eagerly so an invalid `LOG_LEVEL` fails loudly at module init.
 */
const rootLogger = pino(
	{
		level: resolveLevel(),
		base: { service: "rodaddy-watcher" },
		// A COPY of the store, never the store itself: pino's default merge is
		// `Object.assign(mixinObject, mergeObject)`, which writes the call's fields
		// into whatever the mixin returned. Returning the live store made one
		// line's fields (`outcome`, `result`, `ms`) stick to every later line of
		// the same scope (SOF-9237).
		mixin: () => ({ ...logContext.getStore() }),
		formatters: {
			level: (label) => ({ level: label }),
		},
		redact: {
			paths: [
				"password",
				"*.password",
				"passphrase",
				"*.passphrase",
				"secret",
				"*.secret",
				"token",
				"*.token",
				"api_key",
				"*.api_key",
				"authorization",
				"*.authorization",
				"cookie",
				"*.cookie",
				"session",
				"*.session",
				"credential",
				"*.credential",
				"private_key",
				"*.private_key",
			],
			censor: "[REDACTED]",
		},
	},
	pino.destination({ dest: 2, sync: true }),
);

/** Clamp untrusted text to one bounded, single-line field. */
export function bounded(value: unknown, max = MAX_FIELD): string {
	const text = typeof value === "string" ? value : String(value);
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…(${flat.length})`;
}

/** The message of an unknown caught value, for `catch (err)` sites. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The CLASS of a caught value, with NO message — for errors whose message may
 * carry a secret.
 *
 * Some thrown errors quote the thing that failed: a database driver puts the
 * connection string (with password) in its message, and an HTTP client can echo a
 * token. Those sites deliberately surface fixed text to the operator, and the log
 * line must obey the same rule, so record only the constructor name. Use
 * `errorMessage` everywhere the message is known to be safe.
 */
export function errorClass(err: unknown): string {
	if (err instanceof Error) return err.constructor?.name ?? "Error";
	return typeof err;
}

/**
 * Emit one NDJSON line: `{ time, level, msg: <event>, service, ...context }`.
 *
 * `event` is a stable dot-separated name (`prepush.stage.failed`) mapped to pino
 * `msg` so lines can be grouped by subsystem. Context values are bounded
 * automatically; `null`/`undefined` values are dropped, preserving the original
 * omit-empty contract. Pass only identifiers and summaries, never secrets — but
 * `redact` masks the standard's key list as a second layer regardless.
 */
export function log(level: LogLevel, event: string, context: Record<string, unknown> = {}): void {
	const bindings: Record<string, string> = {};
	for (const [key, value] of Object.entries(context)) {
		if (value === undefined || value === null) continue;
		bindings[key] = bounded(value);
	}
	rootLogger[level](bindings, event);
}

/**
 * Run `fn` with `fields` stamped on every line it emits, synchronously or across
 * any `await` inside it. Nested scopes merge over the parent; the
 * parent's fields return when the inner scope ends. Returns `fn`'s value
 * unchanged, promise included. Seed only identifiers (`delivery_id`,
 * `pass_id`, `job_id`), never secrets: context values are not bounded.
 */
export function withLogFields<R>(fields: Record<string, unknown>, fn: () => R): R {
	return logContext.run({ ...logContext.getStore(), ...fields }, fn);
}

/*
 * ---------------------------------------------------------------------------
 * TRACED BUILD PHASE
 *
 * The build phase runs at DEBUG with a trace on every function input and
 * output. `_DOCS/STANDARDS-observability.md` asks for "a wrapper that emits
 * entry/exit/duration/failure automatically" rather than hand-written pairs,
 * and for a RECURSIVE SANITIZER on anything that goes into a line. This block
 * is that wrapper plus that sanitizer. Nothing above it changes.
 *
 * WHY `summarize()` DOES ITS OWN REDACTION rather than leaning on pino
 * `redact`: pino's key paths are declared at construction and match fixed
 * depths (`token`, `*.token`), so a secret nested three levels down inside an
 * argument array is NOT masked by it. Arguments are arbitrary caller data, so
 * the masking has to travel with the recursion. `redact` stays as the second
 * layer it always was.
 *
 * WHY THESE LINES DO NOT GO THROUGH `log()`: `log()` maps every context value
 * through `bounded()`, which stringifies — a summarized argument tree would
 * arrive on the wire as `"[object Object]"` and the depth/count metadata the
 * standard requires would be unreadable. `traced()` therefore emits through the
 * same `rootLogger`, at the same levels, with the same `service` base and the
 * same `redact` layer; only the value shape differs. `log()`'s signature, level
 * resolution, and redact list are untouched.
 * ---------------------------------------------------------------------------
 */

/** Max container nesting kept before a value collapses to type + count. */
const MAX_DEPTH = 4;

/** Max entries kept per container before a `truncated` count replaces the tail. */
const MAX_ITEMS = 50;

/**
 * Key words that mask their value. Matched against the NORMALIZED key
 * (lowercased, `-`/` `/`.` folded to `_`) by substring, so `Token`,
 * `X-Authorization` -> `x_authorization`, `api-key` -> `api_key`, and
 * `accessToken` -> `accesstoken` all mask, while an unrelated key does not.
 */
const SECRET_WORDS = [
	"password",
	"passphrase",
	"secret",
	"token",
	"api_key",
	"apikey",
	"authorization",
	"cookie",
	"session",
	"credential",
	"private_key",
] as const;

/**
 * Replace the userinfo of every URL-shaped substring with `[REDACTED]`.
 *
 * Key-based redaction cannot see a secret carried inside a value — a connection
 * string passed positionally (`postgresql://user:pw@host/db`) has no key to
 * match, so the password reaches the wire verbatim.
 *
 * Runs BEFORE `bounded()`, on the full string. Truncating first is a hole: the
 * cut is by character count, so a URL whose `@` falls past `MAX_FIELD` never
 * matches and its password prefix ships. The pattern is deliberately scheme-free
 * (anchored on `://`) — a `[a-z][a-z0-9+.-]*` scheme prefix backtracks
 * quadratically over a long run of letters (5.4s at 100k characters, which
 * wedged the suite), while this form scans linearly (0.2ms at 1M).
 */
function scrubUrlUserinfo(text: string): string {
	return scrubSecretQueryParams(text.replace(/:\/\/[^/\s@]+@/g, "://[REDACTED]@"));
}

/**
 * A credential in a URL QUERY is not userinfo and survived the `@` scrub: a
 * Forge list endpoint reached `postForge`/`listProbe` as `?token=...` and the
 * value shipped to the lane log intact (round 5).
 *
 * The parameter NAME is judged by `isSecretKey`, the same predicate that masks
 * object keys, rather than a second list. A hand-rolled alternation was tried
 * first and immediately diverged from it -- missing `authorization`,
 * `private_key`, `cookie` and `passphrase`, which `SECRET_WORDS` has carried
 * all along (round 9). One policy, one place.
 *
 * The name is percent-DECODED before the test, so `%61pi_key` is judged as
 * `api_key`. Only the VALUE is replaced, so `?state=all&page=2` still reads
 * normally and the line stays queryable.
 */
function scrubSecretQueryParams(text: string): string {
	// Bounded by the pair separator on both sides, so this is linear in the
	// length of the string and has no nested quantifier to backtrack over.
	return text.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (whole, lead, rawName, _value) => {
		const name = decodeQueryName(rawName);
		if (name === undefined) return whole;
		return isSecretKey(name) ? `${lead}${rawName}=[REDACTED]` : whole;
	});
}

/** Percent-decode a parameter name, falling back to the raw form when invalid. */
function decodeQueryName(raw: string): string | undefined {
	try {
		return decodeURIComponent(raw.replace(/\+/g, " "));
	} catch {
		return raw;
	}
}

/** Fold a key to the form `SECRET_WORDS` is matched against. */
function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[-. ]/g, "_");
}

/** True when a key's normalized form carries any secret word. */
function isSecretKey(key: string): boolean {
	const normalized = normalizeKey(key);
	return SECRET_WORDS.some((word) => normalized.includes(word));
}

/** The constructor name of a non-plain object, else its `typeof`. */
function typeLabel(value: unknown): string {
	if (value === null) return "null";
	if (typeof value !== "object") return typeof value;
	const ctor = (value as { constructor?: { name?: string } }).constructor;
	return ctor?.name ?? "object";
}

/** True for `{}`/`Object.create(null)` literals — the only recursed object shape. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Recurse a sequence under the item cap, appending a `truncated` total. */
function summarizeList(items: unknown[], depth: number): unknown[] {
	const kept = items.slice(0, MAX_ITEMS).map((item) => {
		if (item === undefined) return "undefined";
		return summarize(item, depth + 1);
	});
	if (items.length > MAX_ITEMS) kept.push({ truncated: items.length });
	return kept;
}

/** Recurse a plain object under the item cap, masking secret keys, omitting `undefined`. */
function summarizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
	const entries = Object.entries(value).filter(([, item]) => item !== undefined);
	const out: Record<string, unknown> = {};
	for (const [key, item] of entries.slice(0, MAX_ITEMS)) {
		out[key] = isSecretKey(key) ? "[REDACTED]" : summarize(item, depth + 1);
	}
	if (entries.length > MAX_ITEMS) out.truncated = entries.length;
	return out;
}

/** Non-plain object shapes that get an allowlisted summary rather than recursion. */
function summarizeExotic(value: object, depth: number): unknown {
	if (value instanceof Error) return { error_class: errorClass(value) };
	if (value instanceof Uint8Array) return { type: "bytes", length: value.length };
	if (Array.isArray(value)) return summarizeList(value, depth);
	if (value instanceof Map) return summarizeList([...value.entries()], depth);
	if (value instanceof Set) return summarizeList([...value], depth);
	if (isPlainObject(value)) return summarizeObject(value, depth);
	return { type: typeLabel(value) };
}

/**
 * Recursively reduce an arbitrary value to something safe to put in a log line.
 *
 * Bounded per `_DOCS/STANDARDS-observability.md`: at most `MAX_DEPTH` container
 * levels, `MAX_ITEMS` entries per container, `MAX_FIELD` characters per string.
 * At a limit the value collapses to its type plus shape metadata rather than
 * being stringified — the standard forbids an arbitrary `repr` fallback. Keys
 * carrying a secret word are masked before their value is ever visited, and an
 * `Error` yields its class only, never its message (same rule as `errorClass`).
 */
export function summarize(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return bounded(scrubUrlUserinfo(value));
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (value === null) return null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return { type: typeLabel(value) };
	if (value instanceof Error) return { error_class: errorClass(value) };
	if (depth >= MAX_DEPTH)
		return { type: Array.isArray(value) ? "array" : "object", count: countOf(value) };
	return summarizeExotic(value, depth);
}

/** Entry count used by the depth-cap summary. */
function countOf(value: object): number {
	if (Array.isArray(value)) return value.length;
	if (value instanceof Map || value instanceof Set) return value.size;
	if (value instanceof Uint8Array) return value.length;
	return Object.keys(value).length;
}

/** Emit one traced line with structured (already-summarized) context. */
function emitTrace(level: LogLevel, event: string, context: Record<string, unknown>): void {
	rootLogger[level](context, event);
}

/** Whether a call's return value is thenable and therefore needs the async path. */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/** Integer milliseconds elapsed since a `performance.now()` mark. */
function elapsedMs(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}

/**
 * Wrap a function so every call emits `<name>.enter` / `<name>.exit` at debug
 * and `<name>.failed` at error, with arguments, result, and duration summarized.
 *
 * `name` is a stable dot-separated event prefix (`dispatch.claimJob`); it is not
 * validated beyond being non-empty. `this` is preserved, so a method keeps
 * working when wrapped. Both sync and promise-returning functions are handled:
 * a returned promise is observed, never swallowed, and the original rejection
 * value is rethrown unchanged.
 *
 * `opts.redact.args` names argument INDEXES whose summarized value is replaced
 * by `"[REDACTED]"` on `.enter`, for a parameter that is a secret in itself (a
 * bare token, a whole `process.env`) and so has no key for `summarize()` to
 * match. `opts.redact.result` does the same for the `.exit` result on both the
 * sync and promise paths; `.failed` is unaffected either way.
 */
export type TracedOptions = {
	redact?: { args?: readonly number[]; result?: boolean };
};

/**
 * Overload for a TYPE GUARD, so wrapping one does not silently erase it.
 *
 * The general signature below returns `(...args: A) => R`, a plain function
 * type, so a `x is T` predicate is lost the moment the guard is wrapped — the
 * call still works and every downstream narrowing stops compiling. That reads
 * as "traced() broke my code" rather than "the predicate was dropped", which is
 * how it presented the first time (on `carriesTraceparent`). This
 * overload keeps the predicate in the returned type. It is declaration-only:
 * the implementation below is unchanged and covers both.
 *
 * ONE PARAMETER ONLY, deliberately. A `...rest` variant was tried and
 * reverted: a variadic tail is inferred greedily on the general overload too,
 * so `Rest[0]` leaked into unrelated call sites as an argument type and broke
 * three of them. A multi-parameter guard therefore keeps its predicate with an
 * explicit annotation at the export instead — see `isSafeText` in
 * `src/github/publish-decode.ts`.
 */
export function traced<T>(
	name: string,
	fn: (value: unknown) => value is T,
	opts?: TracedOptions,
): (value: unknown) => value is T;
export function traced<A extends unknown[], R>(
	name: string,
	fn: (...args: A) => R,
	opts?: TracedOptions,
): (...args: A) => R;
export function traced<A extends unknown[], R>(
	name: string,
	fn: (...args: A) => R,
	opts: TracedOptions = {},
): (...args: A) => R {
	if (name.trim() === "") throw new Error("traced() requires a non-empty event name");
	const redactArgs = opts.redact?.args ?? [];
	const redactResult = opts.redact?.result === true;
	return function tracedCall(this: unknown, ...args: A): R {
		emitTrace("debug", `${name}.enter`, { args: redactedArgs(args, redactArgs) });
		const startedAt = performance.now();
		let result: R;
		try {
			result = fn.apply(this, args) as R;
		} catch (err) {
			emitTrace("error", `${name}.failed`, {
				error_class: errorClass(err),
				ms: elapsedMs(startedAt),
			});
			throw err;
		}
		if (isPromiseLike(result)) return observePromise(name, result, startedAt, redactResult) as R;
		emitTrace("debug", `${name}.exit`, {
			result: redactResult ? "[REDACTED]" : summarize(result),
			ms: elapsedMs(startedAt),
		});
		return result;
	};
}

/** The summarized argument list with the opted-in indexes masked. */
function redactedArgs(args: unknown[], indexes: readonly number[]): unknown {
	const summarized = summarize(args) as unknown[];
	for (const index of indexes) {
		if (index >= 0 && index < summarized.length) summarized[index] = "[REDACTED]";
	}
	return summarized;
}

/** Attach exit/failed emission to a promise result without altering its settlement. */
function observePromise(
	name: string,
	pending: PromiseLike<unknown>,
	startedAt: number,
	redactResult = false,
): Promise<unknown> {
	return Promise.resolve(pending).then(
		(value) => {
			emitTrace("debug", `${name}.exit`, {
				result: redactResult ? "[REDACTED]" : summarize(value),
				ms: elapsedMs(startedAt),
			});
			return value;
		},
		(err: unknown) => {
			emitTrace("error", `${name}.failed`, {
				error_class: errorClass(err),
				ms: elapsedMs(startedAt),
			});
			throw err;
		},
	);
}
