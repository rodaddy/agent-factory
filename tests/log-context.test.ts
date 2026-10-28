/**
 * @module tests/log-context
 * @description Covers the sf#526 log context in `src/log.ts`: fields seeded by
 *   `withLogFields()` stamp every line emitted inside the scope (`log()` and
 *   `traced()` enter/exit alike), are absent outside it, merge when nested, and
 *   survive an `await`.
 *
 *   pino writes straight to fd 2, so the lines are observed the same way
 *   `tests/log-traced.test.ts` observes them: a child `bun -e` with
 *   `LOG_LEVEL=debug`, its stderr parsed as NDJSON.
 */

import { describe, expect, test } from "bun:test";

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

/** The single line whose `msg` is `event`. */
function line(lines: Record<string, unknown>[], event: string): Record<string, unknown> {
	const found = lines.filter((entry) => entry.msg === event);
	expect(found).toHaveLength(1);
	return found[0] as Record<string, unknown>;
}

describe("withLogFields", () => {
	test("stamps log() and traced() lines inside the scope, not outside", async () => {
		const lines = await emittedLines(`
			import { log, traced, withLogFields } from "./src/log.ts";
			const step = traced("ctx.step", (n) => n + 1);
			log("info", "ctx.before");
			withLogFields({ pass_id: "p-1" }, () => {
				log("info", "ctx.inside");
				step(1);
			});
			log("info", "ctx.after");
		`);
		expect(line(lines, "ctx.inside").pass_id).toBe("p-1");
		expect(line(lines, "ctx.step.enter").pass_id).toBe("p-1");
		expect(line(lines, "ctx.step.exit").pass_id).toBe("p-1");
		expect(line(lines, "ctx.before").pass_id).toBeUndefined();
		expect(line(lines, "ctx.after").pass_id).toBeUndefined();
	});

	test("nested scopes merge over the parent and restore it on exit", async () => {
		const lines = await emittedLines(`
			import { log, withLogFields } from "./src/log.ts";
			withLogFields({ pass_id: "p-1", event: "push" }, () => {
				withLogFields({ job_id: "j-9", event: "pull_request" }, () => log("info", "ctx.inner"));
				log("info", "ctx.outer");
			});
		`);
		const inner = line(lines, "ctx.inner");
		expect(inner.pass_id).toBe("p-1");
		expect(inner.job_id).toBe("j-9");
		expect(inner.event).toBe("pull_request");
		const outer = line(lines, "ctx.outer");
		expect(outer.event).toBe("push");
		expect(outer.job_id).toBeUndefined();
	});

	test("the scope survives an await and returns the callback's value", async () => {
		const lines = await emittedLines(`
			import { log, withLogFields } from "./src/log.ts";
			const value = await withLogFields({ delivery_id: "d-3" }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5)); // fixed-sleep-ok: simulated latency in a fake (the async hop the scope must survive)
				log("info", "ctx.awaited");
				return 42;
			});
			log("info", "ctx.value", { value });
		`);
		expect(line(lines, "ctx.awaited").delivery_id).toBe("d-3");
		const done = line(lines, "ctx.value");
		expect(done.value).toBe("42");
		expect(done.delivery_id).toBeUndefined();
	});

	test("a call-site field wins over the same key in the context", async () => {
		const lines = await emittedLines(`
			import { log, withLogFields } from "./src/log.ts";
			withLogFields({ job_id: "ctx" }, () => log("info", "ctx.override", { job_id: "site" }));
		`);
		expect(line(lines, "ctx.override").job_id).toBe("site");
	});

	// pino's default mixin merge is `Object.assign(mixinObject, mergeObject)`:
	// it writes the call's fields INTO the object the mixin returned. Handing it
	// the live AsyncLocalStorage store let one line's fields stick to every later
	// line of the same pass: a `kboard.list_failed` `outcome: "transport_failed"`
	// rode on every traced debug line after it, ~20k lines an hour that the
	// fleet-verify log-signatures sweep counted as errors (SOF-9237).
	test("a call-site field does not leak into later lines of the same scope", async () => {
		const lines = await emittedLines(`
			import { log, traced, withLogFields } from "./src/log.ts";
			const step = traced("ctx.later", (n) => n);
			withLogFields({ pass_id: "p-1" }, () => {
				log("warn", "ctx.first", { outcome: "transport_failed" });
				log("info", "ctx.second");
				step(1);
			});
		`);
		expect(line(lines, "ctx.first").outcome).toBe("transport_failed");
		const second = line(lines, "ctx.second");
		expect(second.pass_id).toBe("p-1");
		expect(second.outcome).toBeUndefined();
		expect(line(lines, "ctx.later.enter").outcome).toBeUndefined();
		expect(line(lines, "ctx.later.exit").outcome).toBeUndefined();
	});
});
