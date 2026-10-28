import { describe, expect, test } from "bun:test";
import {
	KBOARD_ACTOR,
	KBOARD_BASE_URL,
	KBOARD_PASS_ENABLED,
	loadKboardToken,
} from "../../src/kboard/config";
import { resolveKboardClient } from "../../src/kboard/resolve";

describe("kboard/config", () => {
	test("base URL is the pinned vlan-20 constant", () => {
		expect(KBOARD_BASE_URL).toBe("http://10.0.20.71:8803");
	});

	test("the k-board pass is switched off while its API is off (SOF-11143)", () => {
		expect(KBOARD_PASS_ENABLED).toBe(false);
	});

	test("pass off: no client is built even with a token, so no request is made", () => {
		let calls = 0;
		const fetch = (async () => {
			calls++;
			return new Response("[]", { status: 200 });
		}) as unknown as Parameters<typeof resolveKboardClient>[0]["kboardFetch"];
		const deps = { kboardEnv: { KBOARD_TOKEN: "SENTINEL_KBOARD_TOKEN" }, kboardFetch: fetch };
		expect(resolveKboardClient(deps)).toBeNull();
		expect(resolveKboardClient(deps, false)).toBeNull();
		expect(calls).toBe(0);
	});

	test("pass on: a token still builds a client (the flip-back path)", () => {
		const deps = { kboardEnv: { KBOARD_TOKEN: "SENTINEL_KBOARD_TOKEN" } };
		expect(resolveKboardClient(deps, true)).not.toBeNull();
		expect(resolveKboardClient({ kboardEnv: {} }, true)).toBeNull();
	});

	test("actor is the ruled factory-watcher name", () => {
		expect(KBOARD_ACTOR).toBe("factory-watcher");
	});

	test("a present KBOARD_TOKEN yields a wrapper that only exposes a Bearer header", () => {
		const result = loadKboardToken({ KBOARD_TOKEN: "SENTINEL_KBOARD_TOKEN" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.token.authorization()).toBe("Bearer SENTINEL_KBOARD_TOKEN");
	});

	test("a missing token is a bounded failure that never echoes a value", () => {
		const result = loadKboardToken({});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).not.toContain("Bearer");
		expect(result.error.toLowerCase()).toContain("kboard_token");
	});

	test("a whitespace-only token is treated as missing", () => {
		const result = loadKboardToken({ KBOARD_TOKEN: "   " });
		expect(result.ok).toBe(false);
	});

	test("the token wrapper does not stringify or JSON-serialize the secret", () => {
		const result = loadKboardToken({ KBOARD_TOKEN: "SENTINEL_KBOARD_TOKEN" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(String(result.token)).not.toContain("SENTINEL_KBOARD_TOKEN");
		expect(JSON.stringify(result.token)).not.toContain("SENTINEL_KBOARD_TOKEN");
	});
});
