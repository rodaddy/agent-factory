/**
 * sf#570 -- no implement re-dispatch while a proposal PR is open.
 *
 * `enqueueImplementJob` deduped on live JOBS only, so once the watcher's
 * implement job finished and its `rw/issue-<n>` proposal was open, every later
 * pass with no live job queued a NEW implement job for the same labelled issue
 * (live: sf#553 -> PR #569 -> duplicate job 11309). These tests pin the open-
 * proposal gate and the `findOpenProposalForHead` read that answers it.
 */
import { describe, expect, test } from "bun:test";
import { jobs } from "../../src/db/schema";
import type { ForgeClient } from "../../src/forge/boundary";
import { findOpenProposalForHead } from "../../src/forge/read";
import { ForgeRegistry } from "../../src/forge/registry";
import { createGitHubClient, type FetchLike } from "../../src/github/client";
import { runPass } from "../../src/reconcile/pass";
import { withTestDb } from "../db/helpers";

const NOW = "2026-07-19T18:00:00Z";
const BASE_SHA = "aa11bb22cc33dd44ee55ff6600112233445566aa";

/**
 * Fetch fake routing by URL substring, matched IN ORDER. Routes must be
 * SPECIFIC: a bare `/pulls` route would swallow `/pulls?head=`. An unmatched
 * URL answers `[]` with 200, which is why the existing pass tests read as
 * "absent" for free and need no change.
 */
function routedFetch(routes: Array<{ match: string; body: unknown; status?: number }>): FetchLike {
	return async (url) => {
		const route = routes.find((r) => url.includes(r.match));
		const body = route?.body ?? [];
		return new Response(JSON.stringify(body), { status: route?.status ?? 200 });
	};
}

/** A registry that resolves every provider to the one supplied GitHub client. */
function githubRegistry(client: ForgeClient): ForgeRegistry {
	return new ForgeRegistry({
		resolveGitHubToken: async () => ({ ok: true, token: "t" }),
		createGitHubClient: () => client,
	});
}

/** An open ISSUE (no `pull_request` key), carrying the opt-in label. */
function issueItem(number: number, labels: string[], state = "open") {
	return {
		number,
		state,
		title: `Issue ${number}`,
		updated_at: "2026-07-19T11:00:00Z",
		labels: labels.map((name) => ({ name })),
	};
}

const implementCfg = () => ({
	poll_interval_minutes: 15,
	repositories: [
		{
			name: "rodaddy/x",
			provider: "github" as const,
			checks: "standard" as const,
			gate_selection: "full" as const,
			implement_label: "factory-implement",
		},
	],
	job_templates: [],
	doorbell_enabled: false,
	shadow_publish: false,
});

describe("implement lane: open proposal gate", () => {
	test("an OPEN proposal for rw/issue-<n> queues NO implement job", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/pulls?head=",
						body: [{ number: 9, state: "open", head: { ref: "rw/issue-7" } }],
					},
					{ match: "/issues", body: [issueItem(7, ["factory-implement"])] },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			const result = await runPass(db, githubRegistry(client), implementCfg(), { now: NOW });

			expect(result.repositories[0]?.jobsCreated).toBe(0);
			const rows = await db.select().from(jobs);
			expect(rows.filter((r) => r.jobType === "implement-issue").length).toBe(0);
		});
	});

	test("NO open proposal queues exactly one implement job", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/pulls?head=", body: [] },
					{ match: "/issues", body: [issueItem(7, ["factory-implement"])] },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg(), { now: NOW });

			const rows = await db.select().from(jobs);
			expect(rows.filter((r) => r.jobType === "implement-issue").length).toBe(1);
		});
	});
});

/** A minimal ForgeClient stub; only `provider`/`get`/`paginate` are consulted. */
function stubClient(
	parts: Partial<ForgeClient> & { provider: ForgeClient["provider"] },
): ForgeClient {
	return parts as ForgeClient;
}

describe("findOpenProposalForHead", () => {
	test("forgejo: a matching head ref in the open set is 'open'", async () => {
		const client = stubClient({
			provider: "forgejo",
			paginate: (async () => [
				{ head: { ref: "rw/issue-7", repo: { full_name: "rodaddy/x" } }, state: "open" },
			]) as ForgeClient["paginate"],
		});
		expect(await findOpenProposalForHead(client, "rodaddy/x", "rw/issue-7")).toBe("open");
	});

	test("forgejo: no matching head ref is 'absent'", async () => {
		const client = stubClient({
			provider: "forgejo",
			paginate: (async () => [{ head: { ref: "rw/issue-8" } }]) as ForgeClient["paginate"],
		});
		expect(await findOpenProposalForHead(client, "rodaddy/x", "rw/issue-7")).toBe("absent");
	});

	test("forgejo: a matching ref from a FORK is not this repository's proposal", async () => {
		const client = stubClient({
			provider: "forgejo",
			paginate: (async () => [
				{ head: { ref: "rw/issue-7", repo: { full_name: "someone/x" } }, state: "open" },
			]) as ForgeClient["paginate"],
		});
		expect(await findOpenProposalForHead(client, "rodaddy/x", "rw/issue-7")).toBe("absent");
	});

	test("forgejo: a matching ref with NO source-repository metadata is 'unknown'", async () => {
		const client = stubClient({
			provider: "forgejo",
			paginate: (async () => [
				{ head: { ref: "rw/issue-7" }, state: "open" },
			]) as ForgeClient["paginate"],
		});
		expect(await findOpenProposalForHead(client, "rodaddy/x", "rw/issue-7")).toBe("unknown");
	});

	test("forgejo: a throwing read is 'unknown', never 'absent'", async () => {
		const client = stubClient({
			provider: "forgejo",
			paginate: async () => {
				throw new Error("boom");
			},
		});
		expect(await findOpenProposalForHead(client, "rodaddy/x", "rw/issue-7")).toBe("unknown");
	});

	test("github: a non-array body is 'unknown', never 'absent'", async () => {
		const client = stubClient({
			provider: "github",
			get: async () => ({ data: { message: "Not Found" } }) as never,
		});
		expect(await findOpenProposalForHead(client, "rodaddy/x", "rw/issue-7")).toBe("unknown");
	});
});
