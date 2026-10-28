/**
 * @module tests/actions/call-engine
 * @description Functional tests for the bounded-retry engine hop. The
 *   load-bearing properties: a transient failure is re-asked and a
 *   configuration fault is not, the waits are the declared backoff in order,
 *   and neither a log line nor a failure reason ever carries the api key or the
 *   response body — a proxy's 401 body is the one place the credential has been
 *   seen to come back.
 *
 *   `fetchImpl` and `sleep` are injected, so no test touches the network or
 *   waits: the sleep fake RECORDS its arguments, which is what makes the
 *   backoff an assertion rather than a comment.
 */
import { describe, expect, test } from "bun:test";
import {
	callEngine,
	ENGINE_ATTEMPTS,
	ENGINE_BACKOFF_MS,
	ENGINE_TIMEOUT_MS,
	parseEngineTimeoutMs,
} from "../../scripts/actions/call-engine";

const KEY = "sk-do-not-log-me-9f3a";

/** A fetch fake driven by a script; it THROWS on an unscripted call. */
function scriptedFetch(steps: readonly (number | Error)[], body = "{}") {
	const urls: string[] = [];
	const inits: RequestInit[] = [];
	let i = 0;
	const impl = (async (url: string, init: RequestInit) => {
		const step = steps[i];
		i += 1;
		if (step === undefined) throw new Error(`unscripted fetch call ${i}`);
		urls.push(String(url));
		inits.push(init);
		if (step instanceof Error) throw step;
		return new Response(body, { status: step });
	}) as unknown as typeof fetch;
	return { impl, urls, inits, calls: () => i };
}

function recorder() {
	const slept: number[] = [];
	const logs: string[] = [];
	return {
		slept,
		logs,
		sleep: async (ms: number) => void slept.push(ms),
		log: (line: string) => void logs.push(line),
	};
}

const OK_BODY = JSON.stringify({ choices: [{ message: { content: "verdict: approve\n" } }] });

describe("callEngine", () => {
	test("a 200 on the first try succeeds with no sleep", async () => {
		const f = scriptedFetch([200], OK_BODY);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result).toEqual({ ok: true, body: OK_BODY, attempt: 1 });
		expect(r.slept).toEqual([]);
		expect(r.logs).toEqual([]);
		expect(f.calls()).toBe(1);
	});

	test("posts to the chat-completions path with the bearer header and the body verbatim", async () => {
		const f = scriptedFetch([200], OK_BODY);
		const r = recorder();
		await callEngine('{"model":"m"}', {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(f.urls[0]).toBe("http://engine/v1/chat/completions");
		const init = f.inits[0] as RequestInit & { headers: Record<string, string> };
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(init.headers["Content-Type"]).toBe("application/json");
		// Bun's own 300s fetch read timeout must be lifted; the signal is the bound.
		expect((init as { timeout?: unknown }).timeout).toBe(false);
		expect(init.body).toBe('{"model":"m"}');
	});

	test("a 408 then a 200 succeeds on attempt 2 after one 60s wait", async () => {
		const f = scriptedFetch([408, 200], OK_BODY);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result.ok).toBe(true);
		expect(result.attempt).toBe(2);
		expect(r.slept).toEqual([60_000]);
		expect(r.logs).toHaveLength(1);
		expect(r.logs[0]).toContain("engine attempt 1/3 failed (http 408); retrying in 60s");
	});

	test("408 then 503 then 200 succeeds on attempt 3 with both declared waits, in order", async () => {
		const f = scriptedFetch([408, 503, 200], OK_BODY);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result.ok).toBe(true);
		expect(result.attempt).toBe(3);
		expect(r.slept).toEqual([60_000, 120_000]);
		expect(r.slept).toEqual([...ENGINE_BACKOFF_MS]);
		expect(r.logs[1]).toContain("engine attempt 2/3 failed (http 503); retrying in 120s");
	});

	test("three 408s fail loudly on attempt 3, having slept the full backoff", async () => {
		const f = scriptedFetch([408, 408, 408]);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result).toEqual({
			ok: false,
			attempt: 3,
			reason: "http 408",
			failure: "http:408:retryable",
		});
		expect(r.slept).toEqual([60_000, 120_000]);
		expect(f.calls()).toBe(ENGINE_ATTEMPTS);
		expect(r.logs.at(-1)).toContain("failed after 3 attempts");
	});

	test("a thrown transport error is retried like a retryable status", async () => {
		const f = scriptedFetch([new TypeError("fetch failed"), 200], OK_BODY);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result.ok).toBe(true);
		expect(result.attempt).toBe(2);
		expect(r.slept).toEqual([60_000]);
		expect(r.logs[0]).toContain("TypeError: fetch failed");
	});

	test("a 401 is a configuration fault: one attempt, zero sleeps", async () => {
		const f = scriptedFetch([401]);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result).toEqual({
			ok: false,
			attempt: 1,
			reason: "http 401",
			failure: "http:401:final",
		});
		expect(r.slept).toEqual([]);
		expect(f.calls()).toBe(1);
	});

	test("a 400 is likewise not retried", async () => {
		const f = scriptedFetch([400]);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result.ok).toBe(false);
		expect(f.calls()).toBe(1);
		expect(r.slept).toEqual([]);
	});

	// sf#246: a proxy's auth-failure body can echo the credential back, and
	// shape-based redaction matches nothing on a bare opaque token. The only
	// reliable scrub is never reading the body of a failed call at all.
	test("neither the reason nor any log line carries the key or the error body", async () => {
		const leaky = `{"error":"bad key ${KEY}","detail":"secret-body-do-not-log"}`;
		const f = scriptedFetch([401], leaky);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		const all = `${r.logs.join("")}${result.ok ? "" : result.reason}`;
		expect(all).not.toContain(KEY);
		expect(all).not.toContain("secret-body-do-not-log");
		expect(all).toContain("http 401");
	});

	test("the retry path's logs are likewise clean", async () => {
		const f = scriptedFetch([500, 500, 500], `boom ${KEY} secret-body-do-not-log`);
		const r = recorder();
		await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(r.logs.join("")).not.toContain(KEY);
		expect(r.logs.join("")).not.toContain("secret-body-do-not-log");
	});

	test("the success body passes through verbatim, including non-JSON", async () => {
		const weird = "<html>not json</html>\n\n  trailing  ";
		const f = scriptedFetch([200], weird);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result.ok && result.body).toBe(weird);
	});

	test("the declared bounds are the ones the module exports", () => {
		expect(ENGINE_ATTEMPTS).toBe(3);
		expect(ENGINE_BACKOFF_MS).toEqual([60_000, 120_000]);
		expect(ENGINE_BACKOFF_MS).toHaveLength(ENGINE_ATTEMPTS - 1);
		expect(ENGINE_TIMEOUT_MS).toBe(1_800_000);
	});
});

describe("sf#697: a timeout is not re-asked with the same payload", () => {
	test("a TimeoutError ends the call in one attempt, zero sleeps", async () => {
		const timeout = new Error("The operation timed out.");
		timeout.name = "TimeoutError";
		const f = scriptedFetch([timeout, 200], OK_BODY);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result).toEqual({
			ok: false,
			attempt: 1,
			reason: "TimeoutError: The operation timed out.",
			failure: `timeout:${ENGINE_TIMEOUT_MS}`,
		});
		expect(r.slept).toEqual([]);
		expect(f.calls()).toBe(1);
	});
});

describe("sf#810: the terminal failure is classified, not guessed", () => {
	test("a thrown transport error is classed network", async () => {
		const f = scriptedFetch([new TypeError("fetch failed")]);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			attempts: 1,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result.ok === false && result.failure).toBe("network");
	});
});

describe("sf#939 fix1: ENGINE_TIMEOUT_MS overrides the per-attempt ceiling", () => {
	test("an integer in 60000..1800000 is taken; anything else is the constant", () => {
		expect(parseEngineTimeoutMs("600000")).toBe(600_000);
		expect(parseEngineTimeoutMs("60000")).toBe(60_000);
		expect(parseEngineTimeoutMs("1800000")).toBe(1_800_000);
		expect(parseEngineTimeoutMs(undefined)).toBe(ENGINE_TIMEOUT_MS);
		expect(parseEngineTimeoutMs("")).toBe(ENGINE_TIMEOUT_MS);
		expect(parseEngineTimeoutMs("59999")).toBe(ENGINE_TIMEOUT_MS);
		expect(parseEngineTimeoutMs("1800001")).toBe(ENGINE_TIMEOUT_MS);
		expect(parseEngineTimeoutMs("10m")).toBe(ENGINE_TIMEOUT_MS);
		expect(parseEngineTimeoutMs("600000.5")).toBe(ENGINE_TIMEOUT_MS);
	});

	test("the timeout class reports the overridden ms", async () => {
		const timeout = new Error("The operation timed out.");
		timeout.name = "TimeoutError";
		const f = scriptedFetch([timeout]);
		const r = recorder();
		const result = await callEngine("{}", {
			url: "http://engine",
			apiKey: KEY,
			timeoutMs: 600_000,
			fetchImpl: f.impl,
			sleep: r.sleep,
			log: r.log,
		});
		expect(result.ok === false && result.failure).toBe("timeout:600000");
	});
});
