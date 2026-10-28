/**
 * @module tests/actions/lane-trace-proxy-id
 * @description The engine hop captures cliproxyapi's per-request id so one
 *   client span joins the proxy's own log lines.
 *
 *   The id is taken ONLY when it has the proxy's shape (8 hex characters, the
 *   `[e40a61b8]` its log prints). A header is proxy-controlled text, and a
 *   strict shape is what keeps it from being a channel for anything else.
 */
import { describe, expect, test } from "bun:test";
import { callEngine, type EngineAttemptObservation } from "../../scripts/actions/call-engine";

function observe(status: number, headers: Record<string, string>) {
	const seen: EngineAttemptObservation[] = [];
	const fetchImpl = (async () =>
		new Response("{}", { status, headers })) as unknown as typeof fetch;
	return {
		seen,
		run: () =>
			callEngine("{}", {
				url: "http://proxy",
				apiKey: "k",
				attempts: 1,
				fetchImpl,
				sleep: async () => {},
				log: () => {},
				onAttempt: (o) => seen.push(o),
			}),
	};
}

describe("proxy request id", () => {
	test("a success reply carries the proxy's id into the attempt observation", async () => {
		const o = observe(200, { "x-request-id": "e40a61b8" });
		await o.run();
		expect(o.seen[0]?.proxyRequestId).toBe("e40a61b8");
	});

	test("a failed reply carries it too: the failed call is the one worth joining", async () => {
		const o = observe(503, { "X-Request-Id": "E40A61B8" });
		await o.run();
		expect(o.seen[0]?.ok).toBe(false);
		expect(o.seen[0]?.proxyRequestId).toBe("e40a61b8");
	});

	test("anything not shaped like the proxy's id is dropped, never echoed", async () => {
		for (const value of ["sk-proj-abc123XYZ", "e40a61b8e40a61b8", "zzzzzzzz", ""]) {
			const o = observe(200, { "x-request-id": value });
			await o.run();
			expect(o.seen[0]?.proxyRequestId).toBeUndefined();
		}
		const none = observe(200, {});
		await none.run();
		expect(none.seen[0]?.proxyRequestId).toBeUndefined();
	});
});
