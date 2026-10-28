import { describe, expect, test } from "bun:test";
import { createGitHubClient, type FetchLike } from "../../src/github/client";

interface Recorded {
	url: string;
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
}

function recordingFetch(
	responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): { fetch: FetchLike; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let i = 0;
	const fetch: FetchLike = async (url, init) => {
		const headers = (init?.headers as Record<string, string>) ?? {};
		calls.push({
			url,
			method: init?.method,
			body: init?.body ? JSON.parse(init.body as string) : undefined,
			headers,
		});
		const spec = responses[Math.min(i, responses.length - 1)];
		i++;
		if (!spec) throw new Error("no queued response");
		return new Response(spec.body === undefined ? "" : JSON.stringify(spec.body), {
			status: spec.status,
			headers: spec.headers ?? {},
		});
	};
	return { fetch, calls };
}

const noSleep = async () => {};

describe("GitHubClient.write", () => {
	test("POSTs a bounded JSON body and returns parsed data", async () => {
		const { fetch, calls } = recordingFetch([{ status: 201, body: { id: 5 } }]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.write<{ id: number }>("POST", "/repos/o/r/issues/1/comments", {
			body: "hello",
		});
		expect(res.data.id).toBe(5);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual({ body: "hello" });
		expect(calls[0]?.headers?.["Content-Type"]).toBe("application/json");
	});

	test("tolerates an empty 204 response body", async () => {
		const { fetch } = recordingFetch([{ status: 204 }]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.write("DELETE", "/repos/o/r/issues/1/labels/x");
		expect(res.status).toBe(204);
		expect(res.data).toBeNull();
	});

	test("does not retry a non-idempotent POST after a 5xx", async () => {
		const { fetch, calls } = recordingFetch([{ status: 502 }, { status: 201, body: { id: 9 } }]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		await expect(client.write("POST", "/x", { a: 1 })).rejects.toThrow("HTTP 502");
		expect(calls.length).toBe(1);
	});

	test("does not retry a non-idempotent POST after an ambiguous network failure", async () => {
		let calls = 0;
		const fetch: FetchLike = async () => {
			calls++;
			throw new Error("connection reset after send");
		};
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		await expect(client.write("POST", "/x", { a: 1 })).rejects.toThrow("network error");
		expect(calls).toBe(1);
	});

	test("still retries an idempotent PATCH after a 5xx", async () => {
		const { fetch, calls } = recordingFetch([{ status: 502 }, { status: 200, body: { id: 9 } }]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.write<{ id: number }>("PATCH", "/x", { a: 1 });
		expect(res.data.id).toBe(9);
		expect(calls.length).toBe(2);
	});

	test("fails fast on a non-retryable status without leaking token or body", async () => {
		const { fetch, calls } = recordingFetch([{ status: 422, body: { message: "bad" } }]);
		const client = createGitHubClient("super-secret", { fetch, sleep: noSleep });
		let message = "";
		try {
			await client.write("POST", "/x", { secret: "super-secret" });
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).toContain("HTTP 422");
		expect(message).not.toContain("super-secret");
		expect(calls.length).toBe(1); // not retried
	});

	test("sends the auth header without logging it in errors on timeout", async () => {
		const fetch: FetchLike = async () => {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		};
		const client = createGitHubClient("tok", { fetch, sleep: noSleep, maxRetries: 0 });
		await expect(client.write("POST", "/x", {})).rejects.toThrow("request timed out");
	});
});
