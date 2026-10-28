/**
 * The default Forgejo adapter behind `scripts/land.ts`, driven through a fetch
 * fake (PR #690 review round 2 P2): the path each operation addresses, the
 * payload it sends, the credential header it carries, and how each response
 * is mapped or refused. The sequence tests inject a fake forge and never reach
 * this code, so this file is the only proof the adapter talks to the API the
 * way the sequence assumes.
 *
 * The fake answers ONLY the request it was scripted for and throws on anything
 * else (scripts/done-means/README.md rule 7), so an adapter that hit a second,
 * unexpected endpoint fails loudly rather than passing on a default.
 */

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../../src/forgejo/client";
import { approvedApiUrl, forgejoLandForge } from "../../scripts/land-forge";

const API = "https://forge.example.internal/api/v1";
const TOKEN = "forge-token-SENTINEL";
const SLUG = "rodaddy/software-factory";

interface Seen {
	url: string;
	method: string;
	authorization: string | null;
	body: unknown;
}

/** One scripted answer plus the request the adapter made to get it. */
function scripted(status: number, body: unknown): { fetch: FetchLike; seen: Seen[] } {
	const seen: Seen[] = [];
	const fetch: FetchLike = async (url, init) => {
		if (seen.length > 0) throw new Error(`land-forge test fake: second request ${url}`);
		seen.push({
			url,
			method: init?.method ?? "GET",
			authorization: new Headers(init?.headers).get("authorization"),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, seen };
}

describe("approvedApiUrl", () => {
	// The API URL is where the token goes: it must be
	// HTTPS and on the clone base's host, or the push and the PR address
	// different forges and the credential may travel in the clear.
	const BASE = "https://forge.example.internal";

	test("unset, the API URL is derived from the clone base", () => {
		expect(approvedApiUrl(BASE, undefined)).toEqual({ ok: true, url: `${BASE}/api/v1` });
	});

	test("an explicit HTTPS URL on the clone base's host is accepted, trailing slash trimmed", () => {
		expect(approvedApiUrl(BASE, "https://forge.example.internal/api/v1/")).toEqual({
			ok: true,
			url: "https://forge.example.internal/api/v1",
		});
	});

	test.each([
		["plain http", "http://forge.example.internal/api/v1"],
		["another host", "https://evil.example/api/v1"],
		["a different port", "https://forge.example.internal:8443/api/v1"],
		["not a URL", "api/v1"],
		["embedded credentials", "https://u:p@forge.example.internal/api/v1"],
	])("%s is refused with the reason and without the value's secrets", (_name, url) => {
		const result = approvedApiUrl(BASE, url);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("FORGEJO_API_URL");
			expect(result.error).not.toContain("u:p@");
		}
	});

	test("a clone base that is not HTTPS refuses too", () => {
		expect(approvedApiUrl("http://forge.example.internal", undefined).ok).toBe(false);
	});
});

describe("forgejoLandForge", () => {
	test("refuses to build a client on a non-HTTPS API URL", () => {
		expect(() => forgejoLandForge(TOKEN, "http://forge.example.internal/api/v1")).toThrow("HTTPS");
	});

	test("getDefaultBranch reads GET /repos/{owner}/{name} with the token header", async () => {
		const { fetch, seen } = scripted(200, { default_branch: "master" });
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		expect(await forge.getDefaultBranch(SLUG)).toBe("master");
		expect(seen[0]?.url).toBe(`${API}/repos/rodaddy/software-factory`);
		expect(seen[0]?.method).toBe("GET");
		expect(seen[0]?.authorization).toBe(`token ${TOKEN}`);
	});

	test("getDefaultBranch refuses a body without a default branch", async () => {
		const { fetch } = scripted(200, { default_branch: "" });
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		await expect(forge.getDefaultBranch(SLUG)).rejects.toThrow("no default branch");
	});

	test("createPullRequest POSTs the four fields to /pulls and maps number and html_url", async () => {
		const { fetch, seen } = scripted(201, {
			number: 42,
			html_url: "https://forge.example.internal/rodaddy/software-factory/pulls/42",
		});
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		const created = await forge.createPullRequest(SLUG, {
			head: "feat/x",
			base: "main",
			title: "feat: x",
			body: "body\n",
		});
		expect(created).toEqual({
			number: 42,
			url: "https://forge.example.internal/rodaddy/software-factory/pulls/42",
		});
		expect(seen[0]?.url).toBe(`${API}/repos/rodaddy/software-factory/pulls`);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.body).toEqual({
			head: "feat/x",
			base: "main",
			title: "feat: x",
			body: "body\n",
		});
		expect(seen[0]?.authorization).toBe(`token ${TOKEN}`);
	});

	test("createPullRequest refuses a missing number and a non-https link", async () => {
		const noNumber = forgejoLandForge(TOKEN, API, {
			fetch: scripted(201, { html_url: "https://x/pulls/1" }).fetch,
		});
		await expect(
			noNumber.createPullRequest(SLUG, { head: "h", base: "main", title: "t", body: "" }),
		).rejects.toThrow("no pull-request number");
		const httpLink = forgejoLandForge(TOKEN, API, {
			fetch: scripted(201, { number: 7, html_url: "http://x/pulls/7" }).fetch,
		});
		await expect(
			httpLink.createPullRequest(SLUG, { head: "h", base: "main", title: "t", body: "" }),
		).rejects.toThrow("no pull-request URL");
	});

	test("a valid slug with dots and dashes reaches every endpoint unchanged", async () => {
		const { fetch, seen } = scripted(200, { merged: false, merge_commit_sha: null });
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		await forge.getPullRequestMergeState("ro-daddy/soft.ware_factory", 7);
		expect(seen[0]?.url).toBe(`${API}/repos/ro-daddy/soft.ware_factory/pulls/7`);
	});

	// Every operation, including the two that hand the slug to the client
	// rather than building the path here, refuses a slug
	// that is not exactly owner/name BEFORE any request leaves the process.
	const OPERATIONS: [string, (slug: string) => Promise<unknown>][] = [
		["getDefaultBranch", (s) => forgeFor(s).getDefaultBranch(s)],
		[
			"createPullRequest",
			(s) => forgeFor(s).createPullRequest(s, { head: "h", base: "main", title: "t", body: "" }),
		],
		["mergePullRequest", (s) => forgeFor(s).mergePullRequest(s, 1)],
		["getPullRequestMergeState", (s) => forgeFor(s).getPullRequestMergeState(s, 1)],
		["getIssueState", (s) => forgeFor(s).getIssueState(s, 1)],
	];
	const MALFORMED = [
		"./name",
		"owner/.",
		"-owner/name",
		"owner/name-",
		"owner/na me",
		"owner/name/extra",
		"owner",
		"../name",
		"owner/..",
		"/name",
		"",
	];
	let requests = 0;
	const refusing: FetchLike = async (url) => {
		requests += 1;
		throw new Error(`land-forge test fake: a malformed slug reached fetch: ${url}`);
	};
	const forgeFor = (_slug: string) => forgejoLandForge(TOKEN, API, { fetch: refusing });
	for (const [name, op] of OPERATIONS) {
		test(`${name} refuses every malformed slug before any request`, async () => {
			for (const slug of MALFORMED) {
				await expect(op(slug)).rejects.toThrow("repository slug");
			}
			expect(requests).toBe(0);
		});
	}

	test("mergePullRequest POSTs a squash merge and maps the sha", async () => {
		const { fetch, seen } = scripted(200, { sha: "feed0000" });
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		expect(await forge.mergePullRequest(SLUG, 42)).toEqual({ merged: true, sha: "feed0000" });
		expect(seen[0]?.url).toBe(`${API}/repos/rodaddy/software-factory/pulls/42/merge`);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.body).toEqual({ Do: "squash", delete_branch_after_merge: true });
		expect(seen[0]?.authorization).toBe(`token ${TOKEN}`);
	});

	test("mergePullRequest maps a 405 to a not-mergeable refusal, not a throw", async () => {
		const { fetch } = scripted(405, { message: "not mergeable" });
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		expect(await forge.mergePullRequest(SLUG, 42)).toEqual({
			merged: false,
			reason: "not-mergeable",
		});
	});

	test("getPullRequestMergeState reads GET /pulls/{n} and shape-checks both fields", async () => {
		const { fetch, seen } = scripted(200, { merged: true, merge_commit_sha: "feed0000" });
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		expect(await forge.getPullRequestMergeState(SLUG, 42)).toMatchObject({
			merged: true,
			mergeCommitSha: "feed0000",
		});
		expect(seen[0]?.url).toBe(`${API}/repos/rodaddy/software-factory/pulls/42`);
		expect(seen[0]?.method).toBe("GET");
		const lying = forgejoLandForge(TOKEN, API, {
			fetch: scripted(200, { merged: "true", merge_commit_sha: "" }).fetch,
		});
		expect(await lying.getPullRequestMergeState(SLUG, 42)).toMatchObject({
			merged: false,
			mergeCommitSha: null,
		});
	});

	test("getIssueState reads GET /issues/{n} and maps a non-string state to empty", async () => {
		const { fetch, seen } = scripted(200, { state: "closed" });
		const forge = forgejoLandForge(TOKEN, API, { fetch });
		expect(await forge.getIssueState(SLUG, 415)).toEqual({ state: "closed" });
		expect(seen[0]?.url).toBe(`${API}/repos/rodaddy/software-factory/issues/415`);
		expect(seen[0]?.method).toBe("GET");
		expect(seen[0]?.authorization).toBe(`token ${TOKEN}`);
		const odd = forgejoLandForge(TOKEN, API, { fetch: scripted(200, { state: 3 }).fetch });
		expect(await odd.getIssueState(SLUG, 415)).toEqual({ state: "" });
	});
});
