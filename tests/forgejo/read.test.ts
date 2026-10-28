/**
 * @module tests/forgejo/read
 * @description Hermetic tests for the Forgejo incremental reader. They assert:
 *   normalization of issues and PR head SHAs, the `since` watermark and cursor
 *   advance/anchor semantics (matching the GitHub reader), the `limit=50` page
 *   size, X-Total-Count-bounded multi-page traversal, and the FAIL-CLOSED
 *   behavior — a count mismatch (incomplete collection) and a malformed entry
 *   both THROW so a truncated read never advances the cursor past unseen items.
 */
import { describe, expect, test } from "bun:test";
import { createForgejoClient, type FetchLike } from "../../src/forgejo/client";
import { readChangedForgejoIssues } from "../../src/forgejo/read";

const noSleep = async () => {};
const NOW = "2026-07-23T18:00:00Z";
const DEPLOYED_API_URL = "https://forge.example.internal/api/v1";

/** Route fake responses by URL substring; each returns fresh JSON + headers. */
function routedFetch(
	routes: Array<{ match: string; body: unknown; headers?: Record<string, string> }>,
): { fetch: FetchLike; calls: string[] } {
	const calls: string[] = [];
	const fetch: FetchLike = async (url) => {
		calls.push(url);
		const route = routes.find((r) => url.includes(r.match));
		if (!route) {
			return new Response("[]", { status: 200, headers: { "x-total-count": "0" } });
		}
		return new Response(JSON.stringify(route.body), {
			status: 200,
			headers: route.headers ?? {},
		});
	};
	return { fetch, calls };
}

describe("readChangedForgejoIssues", () => {
	test("normalizes issues and advances the cursor to the newest updated_at", async () => {
		const { fetch } = routedFetch([
			{
				match: "/issues",
				body: [
					{
						number: 1,
						state: "open",
						title: "First",
						updated_at: "2026-07-23T10:00:00Z",
						labels: [{ name: "bug" }, "docs"],
					},
					{
						number: 2,
						state: "closed",
						title: "Second",
						updated_at: "2026-07-23T12:00:00Z",
						labels: [],
					},
				],
				headers: { "x-total-count": "2" },
			},
		]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await readChangedForgejoIssues(client, "rodaddy/x", null, NOW);

		expect(result.items.length).toBe(2);
		expect(result.items[0]).toMatchObject({
			kind: "issue",
			number: 1,
			state: "open",
			title: "First",
			headSha: null,
			labels: ["bug", "docs"],
		});
		expect(result.nextCursor).toBe("2026-07-23T12:00:00Z");
	});

	test("resolves the head SHA for pull requests", async () => {
		const { fetch } = routedFetch([
			{
				match: "/issues",
				body: [
					{
						number: 7,
						state: "open",
						title: "A PR",
						updated_at: "2026-07-23T11:00:00Z",
						labels: [],
						pull_request: { merged: false },
					},
				],
				headers: { "x-total-count": "1" },
			},
			{ match: "/pulls/7", body: { head: { sha: "abc123" } } },
		]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await readChangedForgejoIssues(client, "rodaddy/x", null, NOW);
		expect(result.items[0]).toMatchObject({ kind: "pull", number: 7, headSha: "abc123" });
	});

	test("requests limit=50 and passes the since watermark", async () => {
		const { fetch, calls } = routedFetch([
			{ match: "/issues", body: [], headers: { "x-total-count": "0" } },
		]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		await readChangedForgejoIssues(client, "rodaddy/x", "2026-07-23T09:00:00Z", NOW);
		const issuesCall = calls.find((c) => c.includes("/issues"));
		const query = new URL(issuesCall ?? "").searchParams;
		expect(query.get("state")).toBe("all");
		expect(query.get("sort")).toBe("leastupdate");
		expect(query.get("limit")).toBe("50");
		expect(query.get("page")).toBe("1");
		expect(query.has("since")).toBe(true);
		expect(query.has("direction")).toBe(false);
		expect(query.has("per_page")).toBe(false);
	});

	test("keeps the prior cursor when nothing changed", async () => {
		const { fetch } = routedFetch([
			{ match: "/issues", body: [], headers: { "x-total-count": "0" } },
		]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const prior = "2026-07-23T09:00:00Z";
		const result = await readChangedForgejoIssues(client, "rodaddy/x", prior, NOW);
		expect(result.items).toEqual([]);
		expect(result.nextCursor).toBe(prior);
	});

	test("anchors the cursor at now on a first-ever empty read", async () => {
		const { fetch } = routedFetch([
			{ match: "/issues", body: [], headers: { "x-total-count": "0" } },
		]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await readChangedForgejoIssues(client, "rodaddy/x", null, NOW);
		expect(result.nextCursor).toBe(NOW);
	});

	test("traverses 51 issues without a Link header", async () => {
		const calls: string[] = [];
		const fetch: FetchLike = async (url) => {
			calls.push(url);
			const page = new URL(url).searchParams.get("page");
			const start = page === "2" ? 51 : 1;
			const length = page === "2" ? 1 : 50;
			const body = Array.from({ length }, (_, offset) => ({
				number: start + offset,
				state: "open",
				title: `issue-${start + offset}`,
				updated_at: `2026-07-23T${String((start + offset) % 24).padStart(2, "0")}:00:00Z`,
			}));
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "x-total-count": "51" },
			});
		};
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		const result = await readChangedForgejoIssues(client, "rodaddy/x", null, NOW);
		expect(result.items).toHaveLength(51);
		expect(result.items.at(-1)?.number).toBe(51);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toContain("page=2");
	});

	test("FAILS CLOSED when X-Total-Count is missing", async () => {
		const { fetch } = routedFetch([
			{
				match: "/issues",
				body: [{ number: 1, state: "open", title: "a", updated_at: "2026-07-23T01:00:00Z" }],
			},
		]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		await expect(readChangedForgejoIssues(client, "rodaddy/x", null, NOW)).rejects.toThrow(
			/X-Total-Count/i,
		);
	});

	test("FAILS CLOSED on a malformed issue entry", async () => {
		const { fetch } = routedFetch([
			{
				match: "/issues",
				body: [{ number: "not-a-number", state: "open", title: "a", updated_at: "x" }],
				headers: { "x-total-count": "1" },
			},
		]);
		const client = createForgejoClient("t", { baseUrl: DEPLOYED_API_URL, fetch, sleep: noSleep });
		await expect(readChangedForgejoIssues(client, "rodaddy/x", null, NOW)).rejects.toThrow(
			/invalid shape/i,
		);
	});
});
