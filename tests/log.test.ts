/**
 * @module tests/log
 * @description Contract tests for the service logger. The
 *   engine is pino now, so a line is one NDJSON object; the properties that make
 *   a log line safe and useful are unchanged: it goes to stderr (stdout belongs
 *   to the CLI), it is one line per call, untrusted text is bounded so a runaway
 *   subprocess stderr cannot flood the log, an error whose message may carry a
 *   secret is logged by CLASS only, and secrets are redacted by key.
 */
import { describe, expect, test } from "bun:test";
import { bounded, errorClass, errorMessage } from "../src/log";

/** Run a snippet in a child so stderr/stdout can be captured separately. */
async function emit(
	snippet: string,
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(
		[
			"bun",
			"-e",
			`import {log} from "${new URL("../src/log.ts", import.meta.url).pathname}";${snippet}`,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, RODADDY_WATCHER_DEBUG: "", LOG_LEVEL: "", ...env },
		},
	);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/** Parse the single NDJSON line a snippet is expected to emit. */
function line(stderr: string): Record<string, unknown> {
	const lines = stderr.trimEnd().split("\n").filter(Boolean);
	expect(lines).toHaveLength(1);
	const [only] = lines;
	if (only === undefined) throw new Error("expected exactly one log line");
	return JSON.parse(only) as Record<string, unknown>;
}

describe("log", () => {
	test("writes NDJSON to stderr, never stdout, so the CLI keeps stdout", async () => {
		const { stdout, stderr } = await emit('log("error","x.failed",{sha:"abc"});');
		const obj = line(stderr);
		expect(obj.level).toBe("error");
		expect(obj.msg).toBe("x.failed");
		expect(obj.sha).toBe("abc");
		expect(obj.service).toBe("rodaddy-watcher");
		expect(obj.time).toEqual(expect.any(Number));
		expect(stdout).toBe("");
	});

	test("emits exactly one line per call, even with multiline context", async () => {
		const { stderr } = await emit('log("warn","x.degraded",{cause:"line one\\nline two"});');
		const obj = line(stderr);
		expect(obj.level).toBe("warn");
		// Whitespace collapse keeps the multiline cause on one field, one line.
		expect(obj.cause).toBe("line one line two");
	});

	test("debug is suppressed unless the level is lowered", async () => {
		const { stderr } = await emit('log("debug","x.entry",{});');
		expect(stderr).toBe("");
	});

	test("debug is emitted when RODADDY_WATCHER_DEBUG is set", async () => {
		const { stderr } = await emit('log("debug","x.entry",{k:"v"});', {
			RODADDY_WATCHER_DEBUG: "1",
		});
		const obj = line(stderr);
		expect(obj.level).toBe("debug");
		expect(obj.msg).toBe("x.entry");
		expect(obj.k).toBe("v");
	});

	test("omits null/undefined fields instead of printing them", async () => {
		const { stderr } = await emit('log("info","x.ok",{vmid:null,host:undefined,job:"j1"});');
		const obj = line(stderr);
		expect(obj.job).toBe("j1");
		expect(obj).not.toHaveProperty("vmid");
		expect(obj).not.toHaveProperty("host");
	});

	test("bounded truncation reaches the emitted line (cap 200)", async () => {
		const { stderr } = await emit('log("info","x.big",{blob:"x".repeat(1000)});');
		const obj = line(stderr);
		const blob = obj.blob as string;
		// A runaway subprocess stderr must not become a 1000-char field.
		expect(blob.length).toBeLessThan(300);
		expect(blob).toContain("(1000)");
	});

	test("invalid LOG_LEVEL fails loudly at boot (non-zero exit)", async () => {
		const { exitCode } = await emit('log("info","x.ok",{});', { LOG_LEVEL: "bogus" });
		expect(exitCode).not.toBe(0);
	});

	test("redacts a secret by key: the sentinel never reaches the line", async () => {
		const { stderr } = await emit('log("info","x.ok",{token:"SENTINEL_TOKEN_VALUE"});');
		const obj = line(stderr);
		expect(obj.token).toBe("[REDACTED]");
		expect(stderr).not.toContain("SENTINEL_TOKEN_VALUE");
	});
});

describe("bounded", () => {
	test("clamps untrusted text and records the true length", () => {
		const out = bounded("x".repeat(1000));
		// A runaway subprocess stderr must not become a 1000-char log line.
		expect(out.length).toBeLessThan(300);
		expect(out).toContain("(1000)");
	});

	test("collapses whitespace so a field cannot break the line format", () => {
		expect(bounded("a\n\tb   c")).toBe("a b c");
	});

	test("passes short text through unchanged", () => {
		expect(bounded("runner unavailable")).toBe("runner unavailable");
	});
});

describe("errorClass — for errors whose message may carry a secret", () => {
	test("records the class and NEVER the message", () => {
		// THE NEAR-MISS THIS GUARDS. The GitHub probe's comment claimed its
		// thrown error was "already status-only and token-free", so the first version
		// of that log line used errorMessage(). The sentinel-token test immediately
		// caught `Bearer ghp_SENTINEL_TOKEN_DO_NOT_LEAK_...` in the log output — the
		// client error echoes the Authorization header. Any error that can quote a
		// credential (db driver connection strings, HTTP auth headers) must be logged
		// by CLASS only.
		const leaky = new Error("request with Bearer ghp_SECRET_VALUE_0000 failed");
		expect(errorClass(leaky)).toBe("Error");
		expect(errorClass(leaky)).not.toContain("ghp_");
		expect(errorClass(leaky)).not.toContain("Bearer");
	});

	test("names a subclass so the failure mode is still identifiable", () => {
		class TimeoutError extends Error {}
		expect(errorClass(new TimeoutError("connect ETIMEDOUT 10.0.1.9:5432"))).toBe("TimeoutError");
	});

	test("reports the type of a non-Error throw", () => {
		expect(errorClass("postgres://user:password@host/db")).toBe("string");
		expect(errorClass(undefined)).toBe("undefined");
	});
});

describe("errorMessage", () => {
	test("reads the message of an Error", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});

	test("stringifies a non-Error throw", () => {
		expect(errorMessage("plain string")).toBe("plain string");
		expect(errorMessage(42)).toBe("42");
	});
});
