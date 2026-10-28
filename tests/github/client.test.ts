import { describe, expect, test } from "bun:test";
import { createGitHubClient, type FetchLike, parseNextLink } from "../../src/github/client";

/** A queued response spec; a fresh Response is built per call so bodies are
 * never consumed twice. */
interface ResponseSpec {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): ResponseSpec {
	return { status, body, headers };
}

/** A fetch fake that returns queued responses in order and records calls. */
function fakeFetch(responses: ResponseSpec[]): { fetch: FetchLike; calls: string[] } {
	const calls: string[] = [];
	let i = 0;
	const fetch: FetchLike = async (url) => {
		calls.push(url);
		const spec = responses[Math.min(i, responses.length - 1)];
		i++;
		if (!spec) {
			throw new Error("no queued response");
		}
		return new Response(JSON.stringify(spec.body), {
			status: spec.status,
			headers: spec.headers ?? {},
		});
	};
	return { fetch, calls };
}

const noSleep = async () => {};

describe("parseNextLink", () => {
	test("extracts the next url", () => {
		const link =
			'<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
		expect(parseNextLink(link)).toBe("https://api.github.com/x?page=2");
	});
	test("returns null when there is no next", () => {
		expect(parseNextLink('<https://api.github.com/x?page=5>; rel="last"')).toBeNull();
		expect(parseNextLink(null)).toBeNull();
	});
});

describe("GitHubClient.get", () => {
	test("returns parsed data and rate-limit headers on success", async () => {
		const { fetch } = fakeFetch([
			jsonResponse(200, { hello: "world" }, { "x-ratelimit-remaining": "42" }),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.get<{ hello: string }>("/x");
		expect(res.status).toBe(200);
		expect(res.data.hello).toBe("world");
		expect(res.rateRemaining).toBe(42);
	});

	test("retries on 5xx then succeeds", async () => {
		const { fetch, calls } = fakeFetch([
			jsonResponse(503, { error: "unavailable" }),
			jsonResponse(200, { ok: true }),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.get<{ ok: boolean }>("/x");
		expect(res.data.ok).toBe(true);
		expect(calls.length).toBe(2);
	});

	test("retries on 429 rate limit then succeeds", async () => {
		const { fetch, calls } = fakeFetch([
			jsonResponse(429, {}, { "retry-after": "0" }),
			jsonResponse(200, { ok: true }),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.get<{ ok: boolean }>("/x");
		expect(res.data.ok).toBe(true);
		expect(calls.length).toBe(2);
	});

	test("retries a 403 only when it carries a Retry-After signal", async () => {
		const { fetch, calls } = fakeFetch([
			jsonResponse(403, { message: "rate limited" }, { "retry-after": "0" }),
			jsonResponse(200, { ok: true }),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.get<{ ok: boolean }>("/x");
		expect(res.data.ok).toBe(true);
		expect(calls.length).toBe(2);
	});

	test("retries a 403 when the primary rate limit is exhausted (remaining 0)", async () => {
		const { fetch, calls } = fakeFetch([
			jsonResponse(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }),
			jsonResponse(200, { ok: true }),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const res = await client.get<{ ok: boolean }>("/x");
		expect(res.data.ok).toBe(true);
		expect(calls.length).toBe(2);
	});

	test("does not retry a bare 403 authorization failure", async () => {
		const { fetch, calls } = fakeFetch([jsonResponse(403, { message: "forbidden" })]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep, maxRetries: 3 });
		await expect(client.get("/x")).rejects.toThrow("HTTP 403");
		expect(calls.length).toBe(1); // no blind retry on a genuine permission error
	});

	test("never retries a POST 403 even with a Retry-After signal", async () => {
		const { fetch, calls } = fakeFetch([
			jsonResponse(403, {}, { "retry-after": "0" }),
			jsonResponse(201, { id: 1 }),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		await expect(client.write("POST", "/x", { a: 1 })).rejects.toThrow("HTTP 403");
		expect(calls.length).toBe(1); // POST is never blindly retried
	});

	test("gives up after max retries with a bounded error", async () => {
		const { fetch, calls } = fakeFetch([jsonResponse(500, {})]);
		const client = createGitHubClient("t", {
			fetch,
			sleep: noSleep,
			maxRetries: 2,
		});
		await expect(client.get("/x")).rejects.toThrow("GitHub request failed");
		expect(calls.length).toBe(3); // initial + 2 retries
	});

	test("caps every retry sleep at 60s despite a huge configured base backoff", async () => {
		const slept: number[] = [];
		const sleep = async (ms: number) => {
			slept.push(ms);
		};
		// A 5xx (retryable) then success, with an absurd base backoff. The retry sleep
		// must be clamped to the 60s ceiling, not the configured multi-hour value.
		const { fetch } = fakeFetch([jsonResponse(503, {}), jsonResponse(200, { ok: true })]);
		const client = createGitHubClient("t", {
			fetch,
			sleep,
			backoffMs: 24 * 60 * 60_000,
		});
		await client.get<{ ok: boolean }>("/x");
		expect(slept.length).toBe(1);
		expect(slept[0]).toBeLessThanOrEqual(60_000);
	});

	test("caps a network-error retry sleep at 60s despite a huge base backoff", async () => {
		const slept: number[] = [];
		const sleep = async (ms: number) => {
			slept.push(ms);
		};
		// First call is a hard network failure (no Response), then success on retry.
		let i = 0;
		const fetch: FetchLike = async () => {
			i++;
			if (i === 1) {
				throw new Error("boom");
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		};
		const client = createGitHubClient("t", { fetch, sleep, backoffMs: 10 * 60 * 60_000 });
		await client.get<{ ok: boolean }>("/x");
		expect(slept.length).toBe(1);
		expect(slept[0]).toBeLessThanOrEqual(60_000);
	});

	test("does not leak the token in errors", async () => {
		const { fetch } = fakeFetch([jsonResponse(404, {})]);
		const client = createGitHubClient("super-secret-token", {
			fetch,
			sleep: noSleep,
			maxRetries: 0,
		});
		let message = "";
		try {
			await client.get("/x");
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).not.toContain("super-secret-token");
	});
});

describe("GitHubClient.paginate", () => {
	test("follows next links and concatenates pages", async () => {
		const page1 = jsonResponse(200, [{ n: 1 }, { n: 2 }], {
			link: '<https://api.github.com/next?page=2>; rel="next"',
		});
		const page2 = jsonResponse(200, [{ n: 3 }]);
		const { fetch, calls } = fakeFetch([page1, page2]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const all = await client.paginate<{ n: number }>("/repos/o/r/issues");
		expect(all.map((x) => x.n)).toEqual([1, 2, 3]);
		expect(calls.length).toBe(2);
	});

	test("respects the maxPages cap", async () => {
		const looping = jsonResponse(200, [{ n: 1 }], {
			link: '<https://api.github.com/next>; rel="next"',
		});
		const { fetch, calls } = fakeFetch([looping]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		await client.paginate<{ n: number }>("/x", 3);
		expect(calls.length).toBe(3);
	});
});

/**
 * #66: opening a DRAFT change proposal is the first code-bearing write in this
 * codebase, so the tests below are mostly about what must NOT happen — no
 * duplicate proposal, no non-draft, no create on unproven absence.
 */
describe("GitHubClient.openChangeProposal", () => {
	const proposal = {
		headBranch: "rw/issue-42",
		baseBranch: "main",
		title: "Implement #42",
		body: "A verified change.",
		itemNumber: 42,
		draft: true,
	};

	test("opens a NATIVE draft and reports it as native", async () => {
		// GitHub supports `draft` on the create payload, unlike Forgejo — so the
		// not-ready guarantee is enforced by the forge, not by a title convention.
		const { fetch, calls } = fakeFetch([
			jsonResponse(200, []),
			jsonResponse(201, { number: 7, html_url: "https://github.com/o/r/pull/7" }),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const out = await client.openChangeProposal?.("o/r", proposal);

		expect(out?.status).toBe("opened");
		if (out?.status === "opened") {
			expect(out.number).toBe(7);
			expect(out.draftMode).toBe("native");
		}
		// The dedupe query must scope `head` as `owner:branch`; a bare branch name
		// silently matches nothing, which would read as absent and open a duplicate.
		expect(calls[0]).toContain(`head=${encodeURIComponent("o:rw/issue-42")}`);
		expect(calls[1]).toContain("/repos/o/r/pulls");
	});

	test("DEDUPES against an existing proposal instead of opening a second one", async () => {
		const { fetch, calls } = fakeFetch([
			jsonResponse(200, [{ number: 3, html_url: "https://github.com/o/r/pull/3" }]),
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const out = await client.openChangeProposal?.("o/r", proposal);

		expect(out?.status).toBe("deduped");
		if (out?.status === "deduped") expect(out.number).toBe(3);
		// Exactly one call: the create must never be attempted.
		expect(calls.length).toBe(1);
	});

	test("FAILS rather than creating when absence is unproven", async () => {
		// A dedupe error is not absence. Failing costs a retry; guessing costs a
		// duplicate pull request, which is the one outcome that cannot be undone
		// quietly.
		const { fetch, calls } = fakeFetch([jsonResponse(500, { message: "boom" })]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep, maxRetries: 0 });
		const out = await client.openChangeProposal?.("o/r", proposal);

		expect(out?.status).toBe("failed");
		expect(calls.length).toBe(1);
	});

	test("FAILS when the dedupe list is malformed", async () => {
		const { fetch } = fakeFetch([jsonResponse(200, { not: "an array" })]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const out = await client.openChangeProposal?.("o/r", proposal);

		expect(out?.status).toBe("failed");
		if (out?.status === "failed") expect(out.reason).toContain("malformed");
	});

	test("FAILS when a create returns no usable number", async () => {
		// A 2xx without a number cannot be recorded or deduped later, so a
		// re-publish would open a second proposal. Refuse the opaque success.
		const { fetch } = fakeFetch([jsonResponse(200, []), jsonResponse(201, { html_url: "u" })]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const out = await client.openChangeProposal?.("o/r", proposal);

		expect(out?.status).toBe("failed");
	});

	test("sends draft:true and never a merge or ready-for-review write", async () => {
		const bodies: string[] = [];
		const fetch: FetchLike = async (url, init) => {
			bodies.push(String(init?.body ?? ""));
			return new Response(JSON.stringify(url.includes("?") ? [] : { number: 9 }), { status: 201 });
		};
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		await client.openChangeProposal?.("o/r", proposal);

		const created = bodies.at(-1) ?? "";
		expect(JSON.parse(created).draft).toBe(true);
		// No code path may merge or flip ready-for-review.
		expect(created).not.toContain("/merge");
		expect(created).not.toContain("ready_for_review");
	});

	test("rejects a repository that is not owner/name", async () => {
		const { fetch, calls } = fakeFetch([jsonResponse(200, [])]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const out = await client.openChangeProposal?.("", proposal);

		expect(out?.status).toBe("failed");
		expect(calls.length).toBe(0);
	});
});
