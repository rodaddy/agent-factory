/**
 * @module tests/log-traced
 * @description Covers the sf#503 step-1 additions to `src/log.ts`: the bounded
 *   recursive sanitizer `summarize()` and the `traced()` entry/exit/failure
 *   wrapper.
 *
 *   `rootLogger` is module-private and pino writes straight to fd 2, so the
 *   emitted lines cannot be observed by spying inside this process. The wire
 *   assertions therefore SPAWN a child `bun -e` with `LOG_LEVEL=debug`, call a
 *   traced function there, and parse its stderr NDJSON. That is the only way to
 *   prove the wrapper-side redaction rather than pino's declarative `redact`:
 *   a secret nested inside an argument array sits below the fixed key paths
 *   pino masks, so a clean line proves `summarize()` is what cleaned it.
 */

import { describe, expect, test } from "bun:test";
import { summarize, traced } from "../src/log";

/** Walk a summarized tree by key/index, keeping the assertions readable under strict TS. */
function at(value: unknown, ...path: (string | number)[]): unknown {
	let current: unknown = value;
	for (const step of path) {
		current = (current as Record<string | number, unknown>)[step];
	}
	return current;
}

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Run a snippet in a child bun with debug logging on; return its stderr NDJSON. */
async function emittedLines(snippet: string): Promise<Record<string, unknown>[]> {
	const proc = Bun.spawn(["bun", "-e", snippet], {
		cwd: REPO_ROOT,
		env: { ...process.env, LOG_LEVEL: "debug" },
		stderr: "pipe",
		stdout: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;
	return stderr
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("summarize", () => {
	test("passes scalars through and bounds strings", () => {
		expect(summarize(7)).toBe(7);
		expect(summarize(true)).toBe(true);
		expect(summarize(null)).toBeNull();
		const long = "x".repeat(500);
		expect(String(summarize(long))).toContain("…(500)");
		expect(String(summarize(long)).length).toBeLessThan(220);
	});

	test("renders bigint as a string", () => {
		expect(summarize(10n ** 20n)).toBe("100000000000000000000");
	});

	test("omits undefined in objects and marks it in arrays", () => {
		expect(summarize({ a: 1, b: undefined })).toEqual({ a: 1 });
		expect(summarize([1, undefined])).toEqual([1, "undefined"]);
	});

	test("redacts secret keys case-insensitively across separator forms", () => {
		const value = summarize({
			Token: "tok-live-1",
			"api-key": "ak-1",
			"X-Authorization": "Bearer abc",
			accessToken: "at-1",
			apiKey: "ak-2",
			"private.key": "pk-1",
			user_id: "u-1",
		}) as Record<string, unknown>;
		expect(value.Token).toBe("[REDACTED]");
		expect(value["api-key"]).toBe("[REDACTED]");
		expect(value["X-Authorization"]).toBe("[REDACTED]");
		expect(value.accessToken).toBe("[REDACTED]");
		expect(value.apiKey).toBe("[REDACTED]");
		expect(value["private.key"]).toBe("[REDACTED]");
		expect(value.user_id).toBe("u-1");
	});

	test("redacts a secret nested below pino's declarative redact depth", () => {
		const value = summarize({ a: { b: { c: { token: "deep-secret" } } } });
		expect(at(value, "a", "b", "c", "token")).toBe("[REDACTED]");
		expect(JSON.stringify(value)).not.toContain("deep-secret");
	});

	test("collapses containers at depth 4 to type plus count", () => {
		const deep = { l1: { l2: { l3: { l4: { a: 1, b: 2 } } } } };
		expect(at(summarize(deep), "l1", "l2", "l3", "l4")).toEqual({ type: "object", count: 2 });

		// The outer array is depth 0, so the fifth container is the first one capped.
		expect(at(summarize([[[[[1, 2, 3]]]]]), 0, 0, 0, 0)).toEqual({ type: "array", count: 3 });
		// One level shallower is still recursed in full.
		expect(at(summarize([[[[1, 2, 3]]]]), 0, 0, 0)).toEqual([1, 2, 3]);
	});

	test("caps a container at 50 entries and reports the total", () => {
		const list = summarize(Array.from({ length: 120 }, (_, i) => i)) as unknown[];
		expect(list.length).toBe(51);
		expect(list[50]).toEqual({ truncated: 120 });

		const wide: Record<string, number> = {};
		for (let i = 0; i < 60; i += 1) wide[`k${i}`] = i;
		const obj = summarize(wide) as Record<string, unknown>;
		expect(Object.keys(obj).length).toBe(51);
		expect(obj.truncated).toBe(60);
	});

	test("reduces an Error to its class and never its message", () => {
		expect(summarize(new TypeError("connstring password=hunter2"))).toEqual({
			error_class: "TypeError",
		});
		expect(JSON.stringify(summarize({ err: new Error("hunter2") }))).not.toContain("hunter2");
	});

	test("summarizes bytes as type and length", () => {
		expect(summarize(new Uint8Array([1, 2, 3]))).toEqual({ type: "bytes", length: 3 });
	});

	test("summarizes Map and Set as capped entry lists", () => {
		expect(summarize(new Map([["a", 1]]))).toEqual([["a", 1]]);
		expect(summarize(new Set([1, 2]))).toEqual([1, 2]);
	});

	test("reduces functions and class instances to a type label", () => {
		class Widget {
			readonly secretField = "s";
		}
		expect(summarize(() => 1)).toEqual({ type: "function" });
		expect(summarize(new Widget())).toEqual({ type: "Widget" });
	});
});

describe("traced", () => {
	test("rejects an empty event name", () => {
		expect(() => traced("", () => 1)).toThrow();
		expect(() => traced("  ", () => 1)).toThrow();
	});

	test("passes a sync return value through unchanged", () => {
		const wrapped = traced("t.sum", (a: number, b: number) => a + b);
		expect(wrapped(2, 3)).toBe(5);
	});

	test("passes an async resolution through unchanged", async () => {
		const wrapped = traced("t.load", async (id: string) => ({ id }));
		expect(await wrapped("x")).toEqual({ id: "x" });
	});

	test("rethrows the same sync error instance", () => {
		const boom = new RangeError("boom");
		const wrapped = traced("t.boom", () => {
			throw boom;
		});
		let caught: unknown;
		try {
			wrapped();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBe(boom);
	});

	test("rethrows the same rejection instance", async () => {
		const boom = new Error("nope");
		const wrapped = traced("t.reject", () => Promise.reject(boom));
		let caught: unknown;
		try {
			await wrapped();
		} catch (err) {
			caught = err;
		}
		expect(caught).toBe(boom);
	});

	test("preserves `this` for a wrapped method", () => {
		const owner = {
			base: 10,
			add(n: number): number {
				return this.base + n;
			},
		};
		owner.add = traced("t.add", owner.add);
		expect(owner.add(5)).toBe(15);
	});

	test("emits enter then exit on the wire with args, result and ms", async () => {
		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			traced("wire.sync", (n) => ({ doubled: n * 2 }))(21);
		`);
		const traceLines = lines.filter((line) => String(line.msg).startsWith("wire.sync"));
		expect(traceLines.map((line) => line.msg)).toEqual(["wire.sync.enter", "wire.sync.exit"]);
		const [enter, exit] = traceLines;
		expect(enter?.args).toEqual([21]);
		expect(enter?.level).toBe("debug");
		expect(exit?.result).toEqual({ doubled: 42 });
		expect(Number.isInteger(exit?.ms)).toBe(true);
	});

	test("redacts a nested token in the args on the wire", async () => {
		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			traced("wire.auth", () => "ok")({ opts: { headers: { token: "tok-live-XYZ" } } });
		`);
		const enter = lines.find((line) => line.msg === "wire.auth.enter");
		expect(enter).toBeDefined();
		expect(JSON.stringify(enter)).not.toContain("tok-live-XYZ");
		expect(JSON.stringify(enter)).toContain("[REDACTED]");
	});

	test("emits failed at error with the class only when a call rejects", async () => {
		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			const wrapped = traced("wire.fail", async () => { throw new TypeError("pw=hunter2"); });
			try { await wrapped(); } catch {}
		`);
		const failed = lines.find((line) => line.msg === "wire.fail.failed");
		expect(failed).toBeDefined();
		expect(failed?.level).toBe("error");
		expect(failed?.error_class).toBe("TypeError");
		expect(JSON.stringify(failed)).not.toContain("hunter2");
	});

	test("scrubs URL userinfo from a positional string argument", async () => {
		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			traced("wire.url", (u) => "ok")("postgresql://u:p@h:5432/db");
		`);
		const enter = lines.find((line) => line.msg === "wire.url.enter");
		expect(enter).toBeDefined();
		expect(at(enter, "args", 0)).toBe("postgresql://[REDACTED]@h:5432/db");
		expect(JSON.stringify(enter)).not.toContain("p@");
	});

	test("scrubs a credential carried in a URL query parameter", async () => {
		// Userinfo and a query secret are different shapes: `?token=...` has no
		// `@`, so the userinfo scrub never saw it and a Forge list URL shipped
		// its token to the lane log intact (round 5).
		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			traced("wire.q", (u) => "ok")("https://h/api?access_token=SEKRIT&state=all&cookie=ALSO");
		`);
		const enter = lines.find((line) => line.msg === "wire.q.enter");
		expect(enter).toBeDefined();
		// Only the VALUE of a secret-named parameter goes; `state=all` is what
		// makes the line worth having, so masking the whole query is wrong.
		//
		// This case first used `sig=`, which an earlier hand-rolled alternation
		// masked. `SECRET_WORDS` does not carry `sig`, and adding it would mask
		// `signal=` too -- so the canonical list wins and the fixture moved to a
		// word that is actually policy (round 9).
		expect(at(enter, "args", 0)).toBe(
			"https://h/api?access_token=[REDACTED]&state=all&cookie=[REDACTED]",
		);
		expect(JSON.stringify(enter)).not.toContain("SEKRIT");
		expect(JSON.stringify(enter)).not.toContain("ALSO");
	});

	test("judges a query parameter with the SAME policy that masks object keys", () => {
		// A hand-rolled alternation was written first and immediately diverged
		// from `SECRET_WORDS`: it missed `authorization`, `private_key`, `cookie`
		// and `passphrase`, which that list has carried all along (
		// round 9). The scrub now calls `isSecretKey`, so there is one policy.
		const scrub = (url: string) => summarize(url);

		expect(scrub("https://h/x?authorization=A&private_key=B&cookie=C")).toBe(
			"https://h/x?authorization=[REDACTED]&private_key=[REDACTED]&cookie=[REDACTED]",
		);
		// Separator spellings fold through `normalizeKey`, so no `api[-_.]?key`
		// special case is needed here either.
		expect(scrub("https://h/x?api-key=A&x-api-key=B&access_token=C")).toBe(
			"https://h/x?api-key=[REDACTED]&x-api-key=[REDACTED]&access_token=[REDACTED]",
		);
		// The NAME is percent-decoded before the test: `%61pi_key` is `api_key`.
		expect(scrub("https://h/x?%61pi_key=A")).toBe("https://h/x?%61pi_key=[REDACTED]");
		// An innocent field keeps its value, or the line stops being queryable.
		expect(scrub("https://h/x?state=all&page=2&signal=keep")).toBe(
			"https://h/x?state=all&page=2&signal=keep",
		);
		// Userinfo and query are both handled, in one pass.
		expect(scrub("https://u:P@h/x?token=K&state=open")).toBe(
			"https://[REDACTED]@h/x?token=[REDACTED]&state=open",
		);
	});
	test("scrubs a long string in linear time, not quadratically", () => {
		// A scheme-prefixed pattern backtracks quadratically (100k characters
		// took 5.4s and wedged the suite); the scheme-free pattern is linear.
		// Generous ceiling — this catches the pattern regression, not machine speed.
		const started = performance.now();
		summarize(`${"a".repeat(200_000)}://u:p@h/`);
		expect(performance.now() - started).toBeLessThan(500);
	});

	test("scrubs a URL whose userinfo straddles the field cap", () => {
		// Scrub must run BEFORE bounded(): truncation is by character count, so
		// a URL whose `@` lies past MAX_FIELD would otherwise never match and its
		// password prefix would ship.
		const text = `${"x".repeat(180)} postgresql://user:hunter2pw@h:5432/db`;
		const out = summarize(text) as string;
		expect(out).not.toContain("hunter2");
		expect(out).not.toContain("user:");
		expect(out.length).toBeGreaterThan(200); // truncated, so the cap was crossed
	});

	test("scrubs URL userinfo nested inside an object argument", async () => {
		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			traced("wire.nested", (o) => "ok")({ url: "nats://user:pw@host:4222" });
		`);
		const enter = lines.find((line) => line.msg === "wire.nested.enter");
		expect(enter).toBeDefined();
		expect(at(enter, "args", 0, "url")).toBe("nats://[REDACTED]@host:4222");
		expect(JSON.stringify(enter)).not.toContain("pw@");
	});

	test("redacts the arg indexes named by the redact option", async () => {
		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			traced("wire.idx", (a, b) => "ok", { redact: { args: [1] } })("keep", "hide");
		`);
		const enter = lines.find((line) => line.msg === "wire.idx.enter");
		expect(enter).toBeDefined();
		expect(enter?.args).toEqual(["keep", "[REDACTED]"]);
	});

	test("redacts the async result when the redact option asks for it", async () => {
		const wrapped = traced("t.redactresult", async () => "real-value", {
			redact: { result: true },
		});
		expect(await wrapped()).toBe("real-value");

		const lines = await emittedLines(`
			const { traced } = await import("./src/log.ts");
			await traced("wire.res", async () => "real-value", { redact: { result: true } })();
		`);
		const exit = lines.find((line) => line.msg === "wire.res.exit");
		expect(exit).toBeDefined();
		expect(exit?.result).toBe("[REDACTED]");
		expect(JSON.stringify(exit)).not.toContain("real-value");
	});
});

/**
 * The three sf#704 call sites, asserted on the WIRE rather than by reading the
 * source. A `redact` option that is present but wrong (an index off by one, an
 * argument that moved) still looks correct in a diff, so each of these drives
 * the real exported function in a child at `LOG_LEVEL=debug` and greps the
 * emitted NDJSON for the secret itself.
 */
describe("sf#704 positional credentials never reach the wire", () => {
	test("observability.buildClient does not emit the Langfuse keys", async () => {
		const lines = await emittedLines(`
			const { buildClient } = await import("./src/observability/langfuse.ts");
			try {
				buildClient({
					baseUrl: "http://127.0.0.1:7199",
					publicKey: "pk-lf-PUBLICCANARY",
					secretKey: "sk-lf-SECRETCANARY",
				});
			} catch {}
		`);
		const enter = lines.find((line) => line.msg === "observability.buildClient.enter");
		expect(enter).toBeDefined();
		// publicKey is the one key-based masking misses: no secret word in the name,
		// but it is a vault-held credential all the same.
		expect(JSON.stringify(enter)).not.toContain("pk-lf-PUBLICCANARY");
		expect(JSON.stringify(enter)).not.toContain("sk-lf-SECRETCANARY");
	});

	test("observability.parseEventStream does not emit the untrusted raw stream", async () => {
		const lines = await emittedLines(`
			const { parseEventStream } = await import("./src/observability/event-stream.ts");
			parseEventStream("a bare ghp_TOKENCANARY in agent prose\\n");
		`);
		const enter = lines.find((line) => line.msg === "observability.parseEventStream.enter");
		expect(enter).toBeDefined();
		// A bare token matches no key and no URL pattern, so only an explicit
		// redact keeps runner output off the wire.
		expect(JSON.stringify(enter)).not.toContain("ghp_TOKENCANARY");
	});

	test("reconcile.followThroughSink does not emit the environment it reads", async () => {
		const lines = await emittedLines(`
			const { followThroughSink } = await import("./src/reconcile/follow-through.ts");
			followThroughSink(null, { NATS_NKEY_SEED: "SUAC-NKEYCANARY", ARGOCD_SERVER: "https://a.example" });
		`);
		const enter = lines.find((line) => line.msg === "reconcile.followThroughSink.enter");
		expect(enter).toBeDefined();
		// The second argument is process.env at the live call site. The canary is an
		// nkey seed on purpose: `nkey` is in no SECRET_WORDS entry, so key-based
		// masking does NOT catch it and only the explicit redact keeps it off the wire.
		expect(JSON.stringify(enter)).not.toContain("SUAC-NKEYCANARY");
	});
});

/**
 * The `.exit` line is a SECOND, separate leak surface, and it was unpinned.
 *
 * `traced()` logs both ends, but `opts.redact.args` masks arguments ONLY -- the
 * return needs the distinct `opts.redact.result` flag. Nine wraps across three
 * modules masked their arguments correctly and republished the identical secret
 * as `result`. Every one was found by PROBING the emitted lines; reading the
 * code found none of them, twice, and a review lane found five that a first
 * sweep of the same tree reported clean.
 *
 * So this is a table, not nine hand-written cases: reverting any single wrap to
 * `{ redact: { args: [...] } }` must turn exactly one row red. Mutation-proved
 * per row at the time of writing.
 *
 * All NINE wraps are covered. A first version of this table held eight and
 * silently omitted `runner.runFailureMessage`, which the PR review caught: a
 * pinning test that misses a row leaves exactly the gap it was written to close.
 */
describe("traced result redaction", () => {
	const CANARY = "m2c_EXITLINECANARY";

	const cases: { name: string; event: string; snippet: string }[] = [
		{
			name: "runner.boundedPayload",
			event: "runner.boundedPayload.exit",
			snippet: `
				const { boundedPayload } = await import("./src/runner/transport.ts");
				boundedPayload("verb said ${CANARY} and died");
			`,
		},
		{
			name: "runner.runFailureMessage",
			event: "runner.runFailureMessage.exit",
			// The return interpolates `boundedPayload`'s output, so it inherits that
			// wrap's incomplete redaction rather than being sanitized by it.
			snippet: `
				const { runFailureMessage } = await import("./src/runner/transport.ts");
				runFailureMessage(1, "", "verb died carrying ${CANARY}");
			`,
		},
		{
			name: "runner.runnerBoxArgv",
			event: "runner.runnerBoxArgv.exit",
			// The sharpest of the nine: `summarize()` masks the token by KEY on
			// `.enter`, then `JSON.stringify` flattens the object and destroys the
			// very key that masking keyed on, so `.exit` republishes it in full.
			snippet: `
				const { runnerBoxArgv } = await import("./src/runner/transport.ts");
				runnerBoxArgv("mcp2cli", "run", { token: "${CANARY}", vmid: 9001 });
			`,
		},
		{
			name: "runner.parseDoneRefusal",
			event: "runner.parseDoneRefusal.exit",
			snippet: `
				const { parseDoneRefusal } = await import("./src/runner/transport.ts");
				parseDoneRefusal("REFUSED: vmid 9001 is owned by job '${CANARY}', not 'rw-other'");
			`,
		},
		{
			name: "results.redactSecrets",
			event: "results.redactSecrets.exit",
			// The subtle one: SECRET_PATTERNS is a FIXED list and the `m2c_` shape
			// is not in it, so "it went through the redactor" is not
			// the same as "the output is safe".
			snippet: `
				const { redactSecrets } = await import("./src/results/ingest.ts");
				redactSecrets("token ${CANARY} in runner output");
			`,
		},
		{
			name: "github.capText",
			event: "github.capText.exit",
			snippet: `
				const { capText } = await import("./src/github/publication-text.ts");
				capText("token ${CANARY} in runner output", 4000);
			`,
		},
		{
			name: "github.sanitizeRunnerText",
			event: "github.sanitizeRunnerText.exit",
			snippet: `
				const { sanitizeRunnerText } = await import("./src/github/publication-text.ts");
				sanitizeRunnerText("token ${CANARY} in runner output");
			`,
		},
		{
			name: "github.renderFindings",
			event: "github.renderFindings.exit",
			snippet: `
				const { renderFindings } = await import("./src/github/publication-text.ts");
				renderFindings({ findings: [{ severity: "high", title: "tok ${CANARY}", location: "l" }] });
			`,
		},
		{
			name: "github.renderCheckTrail",
			event: "github.renderCheckTrail.exit",
			snippet: `
				const { renderCheckTrail } = await import("./src/github/publication-text.ts");
				renderCheckTrail([{ name: "tok ${CANARY}", status: "pass", summary: "s" }], []);
			`,
		},
	];

	for (const { name, event, snippet } of cases) {
		test(`${name} does not emit the secret on its exit line`, async () => {
			const lines = await emittedLines(snippet);
			const exit = lines.find((line) => line.msg === event);
			expect(exit).toBeDefined();
			// Markdown escaping inserts a backslash into the token, so assert on the
			// distinctive tail rather than the whole shape.
			expect(JSON.stringify(exit)).not.toContain("EXITLINECANARY");
		});
	}
});
