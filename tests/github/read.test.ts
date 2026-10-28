import { describe, expect, test } from "bun:test";
import { createGitHubClient, type FetchLike } from "../../src/github/client";
import { readChangedIssues } from "../../src/github/read";

/** Route fake responses by URL substring so reads are order-independent. */
function routedFetch(
	routes: Array<{ match: string; body: unknown; headers?: Record<string, string> }>,
): {
	fetch: FetchLike;
	calls: string[];
} {
	const calls: string[] = [];
	const fetch: FetchLike = async (url) => {
		calls.push(url);
		const route = routes.find((r) => url.includes(r.match));
		if (!route) {
			return new Response(JSON.stringify([]), { status: 200 });
		}
		return new Response(JSON.stringify(route.body), {
			status: 200,
			headers: route.headers ?? {},
		});
	};
	return { fetch, calls };
}

const noSleep = async () => {};
const NOW = "2026-07-19T18:00:00Z";

describe("readChangedIssues", () => {
	test("normalizes issues and advances the cursor to the newest updated_at", async () => {
		const { fetch } = routedFetch([
			{
				match: "/issues",
				body: [
					{
						number: 1,
						state: "open",
						title: "First",
						updated_at: "2026-07-19T10:00:00Z",
						labels: [{ name: "bug" }, "docs"],
					},
					{
						number: 2,
						state: "closed",
						title: "Second",
						updated_at: "2026-07-19T12:00:00Z",
						labels: [],
					},
				],
			},
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const result = await readChangedIssues(client, "rodaddy/x", null, NOW);

		expect(result.items.length).toBe(2);
		expect(result.items[0]).toMatchObject({
			kind: "issue",
			number: 1,
			state: "open",
			title: "First",
			headSha: null,
			labels: ["bug", "docs"],
		});
		expect(result.nextCursor).toBe("2026-07-19T12:00:00Z");
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
						updated_at: "2026-07-19T11:00:00Z",
						labels: [],
						pull_request: { url: "https://api.github.com/…/pulls/7" },
					},
				],
			},
			{ match: "/pulls/7", body: { head: { sha: "abc123" } } },
		]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const result = await readChangedIssues(client, "rodaddy/x", null, NOW);

		expect(result.items[0]).toMatchObject({ kind: "pull", number: 7, headSha: "abc123" });
	});

	test("keeps the prior cursor when nothing changed", async () => {
		const { fetch } = routedFetch([{ match: "/issues", body: [] }]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const prior = "2026-07-19T09:00:00Z";
		const result = await readChangedIssues(client, "rodaddy/x", prior, NOW);

		expect(result.items).toEqual([]);
		expect(result.nextCursor).toBe(prior);
	});

	test("anchors the cursor at now on a first-ever empty read", async () => {
		const { fetch } = routedFetch([{ match: "/issues", body: [] }]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		const result = await readChangedIssues(client, "rodaddy/x", null, NOW);

		expect(result.nextCursor).toBe(NOW);
	});

	test("passes the since watermark when a cursor is present", async () => {
		const { fetch, calls } = routedFetch([{ match: "/issues", body: [] }]);
		const client = createGitHubClient("t", { fetch, sleep: noSleep });
		await readChangedIssues(client, "rodaddy/x", "2026-07-19T09:00:00Z", NOW);

		const issuesCall = calls.find((c) => c.includes("/issues"));
		expect(issuesCall).toContain("since=");
	});
});
