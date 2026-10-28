/**
 * @module tests/forgejo/client
 * @description Hermetic tests for the bounded Forgejo client. They assert the
 *   FORGEJO wire contract (token auth, never GitHub Bearer / GitHub headers), the
 *   X-Total-Count fail-closed `getPage` and count-derived page traversal,
 *   and the commit-status dedupe: an existing context is `deduped`, a proven-absent
 *   context is `posted`, and a truncated/malformed status scan fails closed.
 */
import { describe, expect, test } from "bun:test";
import { createForgejoClient, type FetchLike } from "../../src/forgejo/client";

const noSleep = async () => {};
const DEPLOYED_API_URL = "https://forge.example.internal/api/v1";

/** A single fake response with optional headers. */
function ok(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("ForgejoClient transport", () => {
	test("uses Forgejo token auth and no GitHub headers", async () => {
		let seen: Headers | undefined;
		const fetch: FetchLike = async (_url, init) => {
			seen = new Headers(init?.headers);
			return ok({ ok: true });
		};
		const client = createForgejoClient("forge-tok", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		await client.get("/user");

		expect(seen?.get("authorization")).toBe("token forge-tok");
		expect(seen?.get("accept")).toBe("application/json");
		// Must NOT carry any GitHub-specific header.
		expect(seen?.get("x-github-api-version")).toBeNull();
		expect(seen?.get("accept")).not.toContain("vnd.github");
	});

	test("targets the validated Forgejo API base supplied by composition", async () => {
		let url = "";
		const fetch: FetchLike = async (u) => {
			url = u;
			return ok([]);
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		await client.get("/repos/rodaddy/x/issues");
		expect(url).toBe("https://forge.example.internal/api/v1/repos/rodaddy/x/issues");
	});

	test("names a 422 'label does not exist' with a fixed suffix, never echoing the body", async () => {
		const reply = (message: string) => async () =>
			new Response(JSON.stringify({ message, url: "secret-ish m2c_body_text" }), {
				status: 422,
			});
		const absent = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch: reply("label does not exist"),
			sleep: noSleep,
		});
		await expect(absent.write("DELETE", "/repos/o/r/issues/1/labels/x")).rejects.toThrow(
			/^Forgejo request failed: HTTP 422: label does not exist$/,
		);
		const other = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch: reply("validation failed"),
			sleep: noSleep,
		});
		await expect(other.write("DELETE", "/repos/o/r/issues/1/labels/x")).rejects.toThrow(
			/^Forgejo request failed: HTTP 422$/,
		);
	});
});

describe("ForgejoClient.getPage X-Total-Count fail-closed", () => {
	test("a complete page reports next=null", async () => {
		const fetch: FetchLike = async () => ok([1, 2, 3], { "x-total-count": "3" });
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const page = await client.getPage<number[]>("/items?limit=50&page=1");
		expect(page.next).toBeNull();
		expect(page.body).toEqual([1, 2, 3]);
	});

	test("derives page 2 from page, limit, and X-Total-Count without Link", async () => {
		const fetch: FetchLike = async () => ok([1, 2], { "x-total-count": "3" });
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const page = await client.getPage<number[]>("/items?limit=2&page=1");
		expect(page.next).toBe("https://forge.example.internal/api/v1/items?limit=2&page=2");
	});

	test("traverses 51 items across Forgejo's 50-item cap", async () => {
		const calls: string[] = [];
		const fetch: FetchLike = async (url) => {
			calls.push(url);
			const page = new URL(url).searchParams.get("page");
			return page === "2"
				? ok([51], { "x-total-count": "51" })
				: ok(
						Array.from({ length: 50 }, (_, index) => index + 1),
						{
							"x-total-count": "51",
						},
					);
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const items = await client.paginate<number>("/items?limit=50&page=1");
		expect(items).toHaveLength(51);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("page=2");
	});

	test("missing X-Total-Count fails closed", async () => {
		const fetch: FetchLike = async () => ok([1, 2]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		await expect(client.getPage<number[]>("/items?limit=50&page=1")).rejects.toThrow(
			/X-Total-Count/,
		);
	});

	test("invalid X-Total-Count fails closed", async () => {
		const fetch: FetchLike = async () => ok([1], { "x-total-count": "nope" });
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		await expect(client.getPage<number[]>("/items?limit=50&page=1")).rejects.toThrow(
			/X-Total-Count/,
		);
	});

	test("a count mismatch on a later empty page fails closed", async () => {
		const fetch: FetchLike = async () => ok([], { "x-total-count": "51" });
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		await expect(client.getPage<number[]>("/items?limit=50&page=2")).rejects.toThrow(/mismatch/);
	});
});

describe("ForgejoClient.postCommitCheck", () => {
	const check = {
		sha: "abc123",
		context: "software-factory/pr-review",
		conclusion: "success" as const,
		title: "PR review",
		summary: "all good",
		dedupeKey: "software-factory/pr-review",
	};

	test("posts a new status when the context is proven absent", async () => {
		const calls: Array<{ method: string; url: string; body?: string }> = [];
		const fetch: FetchLike = async (url, init) => {
			const method = init?.method ?? "GET";
			calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
			if (method === "GET" && url.includes("/statuses")) {
				// dedupe scan: empty, complete
				return ok([], { "x-total-count": "0" });
			}
			return ok({ id: 1 });
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await client.postCommitCheck("rodaddy/x", check);
		expect(result.status).toBe("posted");
		// A POST to the statuses endpoint was made after the dedupe read proved absence.
		expect(calls.some((c) => c.method === "POST" && c.url.includes("/statuses/abc123"))).toBe(true);
		const posted = calls.find((c) => c.method === "POST");
		const body = JSON.parse(posted?.body ?? "{}") as { context?: string };
		expect(body.context).toMatch(/^software-factory\/pr-review\/[a-f0-9]{16}$/);
		expect(body.context?.length).toBeLessThanOrEqual(255);
	});

	test("a crash retry reads only and a different dedupe key gets a distinct context", async () => {
		const calls: Array<{ method: string; body?: string }> = [];
		const statuses: string[] = [];
		const fetch: FetchLike = async (url, init) => {
			const method = init?.method ?? "GET";
			const body = typeof init?.body === "string" ? init.body : undefined;
			calls.push({ method, body });
			if (method === "GET" && url.includes("/commits/") && url.includes("/statuses")) {
				return ok(
					statuses.map((context) => ({ context, state: "success" })),
					{ "x-total-count": String(statuses.length) },
				);
			}
			const context = (JSON.parse(body ?? "{}") as { context?: string }).context;
			if (context) statuses.push(context);
			return ok({ id: 1 });
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const first = await client.postCommitCheck("rodaddy/x", check);
		expect(first.status).toBe("posted");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

		calls.length = 0;
		const retry = await client.postCommitCheck("rodaddy/x", check);
		expect(retry).toEqual({ status: "deduped", externalRef: statuses[0] });
		expect(calls.map((call) => call.method)).toEqual(["GET"]);
		const firstContext = statuses[0];
		if (!firstContext) throw new Error("first status context was not captured");
		expect(await client.findCommitCheck("rodaddy/x", check)).toEqual({
			status: "found",
			ref: firstContext,
		});

		calls.length = 0;
		const distinct = await client.postCommitCheck("rodaddy/x", {
			...check,
			dedupeKey: `${check.dedupeKey}:other-job`,
		});
		expect(distinct.status).toBe("posted");
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
		expect(statuses).toHaveLength(2);
		expect(statuses[1]).not.toBe(statuses[0]);
	});

	test("bounds and sanitizes the derived status context", async () => {
		let postedContext = "";
		const fetch: FetchLike = async (url, init) => {
			if ((init?.method ?? "GET") === "GET" && url.includes("/statuses")) {
				return ok([], { "x-total-count": "0" });
			}
			postedContext = (JSON.parse(String(init?.body)) as { context: string }).context;
			return ok({ id: 1 });
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await client.postCommitCheck("rodaddy/x", {
			...check,
			context: `unsafe context?${"x".repeat(400)}🔥`,
			dedupeKey: "job key with spaces/and?unsafe",
		});

		expect(result.status).toBe("posted");
		expect(postedContext.startsWith("software-factory/unsafe-context-")).toBe(true);
		expect(postedContext).toMatch(/^[A-Za-z0-9._/-]+$/);
		expect(postedContext.length).toBeLessThanOrEqual(255);
		expect(postedContext).not.toContain("🔥");
		expect(postedContext).not.toContain("?");
	});

	test("fails closed when the status scan is truncated (count mismatch)", async () => {
		const fetch: FetchLike = async (url) => {
			if (url.includes("/statuses")) {
				// A different context on this page, and the collection is larger than the
				// page with no next link — absence is unprovable.
				return ok([{ context: "other/context" }], { "x-total-count": "50" });
			}
			return ok({ id: 1 });
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await client.postCommitCheck("rodaddy/x", check);
		expect(result.status).toBe("failed");
	});

	test("fails closed on a malformed status entry", async () => {
		const fetch: FetchLike = async (url) => {
			if (url.includes("/statuses")) {
				return ok([{ context: 123 }], { "x-total-count": "1" });
			}
			return ok({ id: 1 });
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await client.postCommitCheck("rodaddy/x", check);
		expect(result.status).toBe("failed");
	});
});

describe("openChangeProposal", () => {
	const proposal = {
		headBranch: "rw/issue-42",
		baseBranch: "main",
		title: "Implement the thing",
		body: "Bounded summary.",
		itemNumber: 42,
		draft: true,
	};

	/** 404 = the only proven "no existing proposal" answer. */
	const notFound = () => new Response("not found", { status: 404 });

	test("opens a proposal and reports wip-marker, not native draft", async () => {
		// Forgejo 16.0.1 has no `draft` field, so the WIP intent must ride in the
		// title and be REPORTED as a convention rather than an enforced block.
		let posted: { url: string; body: unknown } | undefined;
		const fetch: FetchLike = async (url, init) => {
			if (init?.method === "POST") {
				posted = { url, body: JSON.parse(String(init.body)) };
				return ok({ number: 7, html_url: "https://forge.example.internal/x/pulls/7" });
			}
			return notFound();
		};
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.openChangeProposal?.("rodaddy/x", proposal);

		expect(out?.status).toBe("opened");
		if (out?.status === "opened") {
			expect(out.number).toBe(7);
			// A convention marker must never be reported as a native guarantee.
			expect(out.draftMode).toBe("wip-marker");
		}
		expect(posted?.url).toContain("/repos/rodaddy/x/pulls");
		const body = posted?.body as Record<string, unknown>;
		expect(body.head).toBe("rw/issue-42");
		expect(body.base).toBe("main");
		expect(body.title).toBe("WIP: Implement the thing");
	});

	test("dedupes an existing proposal instead of opening a second", async () => {
		let posts = 0;
		const fetch: FetchLike = async (_url, init) => {
			if (init?.method === "POST") {
				posts++;
				return ok({ number: 99 });
			}
			return ok({ number: 7, html_url: "https://forge.example.internal/x/pulls/7" });
		};
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.openChangeProposal?.("rodaddy/x", proposal);

		expect(out?.status).toBe("deduped");
		if (out?.status === "deduped") {
			expect(out.number).toBe(7);
		}
		expect(posts).toBe(0); // never created a duplicate
	});

	test("a failed dedupe read never licenses a create", async () => {
		// Absence must be PROVEN. A 500 on the dedupe read leaves it unproven, so
		// creating would risk a second proposal for the same branch.
		let posts = 0;
		const fetch: FetchLike = async (_url, init) => {
			if (init?.method === "POST") {
				posts++;
				return ok({ number: 99 });
			}
			return new Response("boom", { status: 500 });
		};
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.openChangeProposal?.("rodaddy/x", proposal);

		expect(out?.status).toBe("failed");
		expect(posts).toBe(0);
	});

	test("a create that returns no usable number is a failure, not a silent success", async () => {
		const fetch: FetchLike = async (_url, init) =>
			init?.method === "POST" ? ok({ ok: true }) : notFound();
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.openChangeProposal?.("rodaddy/x", proposal);

		expect(out?.status).toBe("failed");
	});
});

describe("ForgejoClient.mergePullRequest", () => {
	test("posts the squash merge to the exact pull merge endpoint", async () => {
		let posted: { url: string; method: string; body: unknown } | undefined;
		const fetch: FetchLike = async (url, init) => {
			posted = { url, method: String(init?.method), body: JSON.parse(String(init?.body)) };
			return ok({ sha: "deadbeefcafe" });
		};
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.mergePullRequest("o/r", 7);

		expect(posted?.method).toBe("POST");
		expect(posted?.url).toBe("https://forge.example.internal/api/v1/repos/o/r/pulls/7/merge");
		const body = posted?.body as Record<string, unknown>;
		expect(body.Do).toBe("squash");
		expect(body.delete_branch_after_merge).toBe(true);
		// Optional message fields are sent ONLY when the caller supplies them.
		expect("MergeTitleField" in body).toBe(false);
		expect("MergeMessageField" in body).toBe(false);
		expect(out.merged).toBe(true);
		if (out.merged) {
			expect(out.sha).toBe("deadbeefcafe");
		}
	});

	test("passes caller-supplied strategy, branch flag, and message fields", async () => {
		let body: Record<string, unknown> = {};
		const fetch: FetchLike = async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return ok({ sha: "f00d" });
		};
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		await client.mergePullRequest("o/r", 7, {
			method: "rebase",
			deleteBranchAfterMerge: false,
			title: "Land it",
			message: "because",
		});

		expect(body.Do).toBe("rebase");
		expect(body.delete_branch_after_merge).toBe(false);
		expect(body.MergeTitleField).toBe("Land it");
		expect(body.MergeMessageField).toBe("because");
	});

	test("a 405 maps to not-mergeable and never throws", async () => {
		const fetch: FetchLike = async () => new Response("not mergeable", { status: 405 });
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.mergePullRequest("o/r", 7);

		expect(out.merged).toBe(false);
		if (!out.merged) {
			expect(out.reason).toBe("not-mergeable");
			expect(out.status).toBe(405);
		}
	});

	test("a 409 maps to conflict and never throws", async () => {
		const fetch: FetchLike = async () => new Response("conflict", { status: 409 });
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.mergePullRequest("o/r", 7);

		expect(out.merged).toBe(false);
		if (!out.merged) {
			expect(out.reason).toBe("conflict");
			expect(out.status).toBe(409);
		}
	});

	test("any other failure maps to error, not to a merged claim", async () => {
		const fetch: FetchLike = async () => new Response("boom", { status: 403 });
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.mergePullRequest("o/r", 7);

		expect(out.merged).toBe(false);
		if (!out.merged) {
			expect(out.reason).toBe("error");
			expect(out.status).toBe(403);
		}
	});

	test("a 200 without a usable sha is an error, not a silent success", async () => {
		const fetch: FetchLike = async () => ok({ ok: true });
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const out = await client.mergePullRequest("o/r", 7);

		expect(out.merged).toBe(false);
		if (!out.merged) {
			expect(out.reason).toBe("error");
		}
	});
});

describe("ForgejoClient.getPullRequestMergeState", () => {
	test("reads merged and merge_commit_sha from GET /pulls/{n}", async () => {
		let url = "";
		const fetch: FetchLike = async (u) => {
			url = u;
			return ok({ number: 7, merged: true, merge_commit_sha: "abc0123" });
		};
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const state = await client.getPullRequestMergeState("o/r", 7);

		expect(url).toBe("https://forge.example.internal/api/v1/repos/o/r/pulls/7");
		expect(state.merged).toBe(true);
		expect(state.mergeCommitSha).toBe("abc0123");
	});

	test("an unmerged pull reports merged=false and a null sha", async () => {
		const fetch: FetchLike = async () => ok({ number: 7, merged: false, merge_commit_sha: null });
		const client = createForgejoClient("t", {
			baseUrl: DEPLOYED_API_URL,
			fetch,
			sleep: noSleep,
		});
		const state = await client.getPullRequestMergeState("o/r", 7);

		expect(state.merged).toBe(false);
		expect(state.mergeCommitSha).toBeNull();
	});

	test("an open pull reports state open and a null mergedAt", async () => {
		const fetch: FetchLike = async () =>
			ok({ number: 7, state: "open", merged: false, merged_at: null });
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const state = await client.getPullRequestMergeState("o/r", 7);

		expect(state.state).toBe("open");
		expect(state.merged).toBe(false);
		expect(state.mergedAt).toBeNull();
	});

	test("a merged pull reports state closed and the forge merge time", async () => {
		const fetch: FetchLike = async () =>
			ok({
				number: 7,
				state: "closed",
				merged: true,
				merge_commit_sha: "abc0123",
				merged_at: "2026-09-29T10:00:00Z",
			});
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const state = await client.getPullRequestMergeState("o/r", 7);

		expect(state.state).toBe("closed");
		expect(state.merged).toBe(true);
		expect(state.mergedAt).toBe("2026-09-29T10:00:00Z");
	});

	test("a malformed state and merged_at both read as null", async () => {
		const fetch: FetchLike = async () => ok({ number: 7, state: 7, merged_at: "nope" });
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const state = await client.getPullRequestMergeState("o/r", 7);

		expect(state.state).toBeNull();
		expect(state.mergedAt).toBeNull();
	});
});
