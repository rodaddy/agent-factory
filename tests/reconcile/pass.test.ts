import { describe, expect, test } from "bun:test";
import { jobs } from "../../src/db/schema";
import type { ForgeClient } from "../../src/forge/boundary";
import { ForgeRegistry } from "../../src/forge/registry";
import { createGitHubClient, type FetchLike } from "../../src/github/client";
import { runPass } from "../../src/reconcile/pass";
import { withTestDb } from "../db/helpers";

const NOW = "2026-07-19T18:00:00Z";

/** Fetch fake routing by URL substring, building a fresh Response each call. */
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

const cfg = (checks: "standard" | "static-only", prReview?: boolean) => ({
	poll_interval_minutes: 15,
	repositories: [
		{
			name: "rodaddy/x",
			provider: "github" as const,
			checks,
			gate_selection: "full" as const,
			...(prReview === undefined ? {} : { pr_review: prReview }),
		},
	],
	job_templates: [],
	doorbell_enabled: false,
	shadow_publish: false,
});

describe("runPass", () => {
	test("records items and creates a pending job for an open PR", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [
							{
								number: 7,
								state: "open",
								title: "A PR",
								updated_at: "2026-07-19T11:00:00Z",
								labels: [],
								pull_request: { url: "x" },
							},
						],
					},
					{ match: "/pulls/7", body: { head: { sha: "abc123" } } },
				]),
			});

			const result = await runPass(db, githubRegistry(client), cfg("standard"), { now: NOW });

			expect(result.okCount).toBe(1);
			expect(result.failCount).toBe(0);
			expect(result.repositories[0]?.itemsSeen).toBe(1);
			expect(result.repositories[0]?.jobsCreated).toBe(1);

			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(1);
			expect(rows[0]).toMatchObject({ sha: "abc123", jobType: "pr-review", status: "pending" });
		});
	});

	test("an opted-out repository queues no review job", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [
							{
								number: 8,
								state: "open",
								title: "Native review owns this PR",
								updated_at: "2026-07-19T11:00:00Z",
								labels: [],
								pull_request: { url: "x" },
							},
						],
					},
					{ match: "/pulls/8", body: { head: { sha: "native-review" } } },
				]),
			});

			await runPass(db, githubRegistry(client), cfg("standard", false), { now: NOW });

			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("absent and true pr_review retain the existing review job behavior", async () => {
		const runCase = async (prReview: boolean | undefined, sha: string) => {
			await withTestDb(async (db) => {
				const client = createGitHubClient("t", {
					sleep: async () => {},
					fetch: routedFetch([
						{
							match: "/issues",
							body: [
								{
									number: 10,
									state: "open",
									title: "Existing review behavior",
									updated_at: "2026-07-19T11:00:00Z",
									labels: [],
									pull_request: { url: "x" },
								},
							],
						},
						{ match: "/pulls/10", body: { head: { sha } } },
					]),
				});

				await runPass(db, githubRegistry(client), cfg("standard", prReview), { now: NOW });

				const rows = await db.select().from(jobs);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({ sha, jobType: "pr-review" });
			});
		};

		await runCase(undefined, "existing-review-absent");
		await runCase(true, "existing-review-true");
	});

	test("only a forgejo repo set to pr_review_runtime: actions skips the box pr-review job", async () => {
		const runCase = async (
			checks: "standard" | "static-only",
			prReview: boolean | undefined,
			runtime?: "box" | "actions",
			staticRuntime?: "box" | "actions",
		): Promise<string[]> => {
			let jobTypes: string[] = [];
			await withTestDb(async (db) => {
				const client = createGitHubClient("t", {
					sleep: async () => {},
					fetch: routedFetch([
						{
							match: "/issues",
							body: [
								{
									number: 11,
									state: "open",
									title: "Actions review owns this PR",
									updated_at: "2026-07-19T11:00:00Z",
									labels: [],
									pull_request: { url: "x" },
								},
							],
						},
						{ match: "/pulls/11", body: { head: { sha: "forgejo-actions-review" } } },
					]),
				});
				const base = cfg(checks, prReview);
				const config = {
					...base,
					repositories: base.repositories.map((r) => ({
						...r,
						provider: "forgejo" as const,
						...(runtime === undefined ? {} : { pr_review_runtime: runtime }),
						...(staticRuntime === undefined ? {} : { static_runtime: staticRuntime }),
					})),
				};
				// Forgejo-provider repos resolve the one fake client too.
				const registry = new ForgeRegistry({
					resolveForgejoToken: () => ({ ok: true, token: "t" }),
					createForgejoClient: () => client,
					forgejoDeployment: {
						apiUrl: "https://forge.example.internal/api/v1",
						webUrl: "https://forge.example.internal",
						cloneBase: "https://forge.example.internal",
					},
				});
				const pass = await runPass(db, registry, config, { now: NOW });
				expect(pass.failCount).toBe(0);
				jobTypes = (await db.select().from(jobs)).map((row) => row.jobType);
			});
			return jobTypes;
		};

		// Absent or `box` runtime: the box review stays until 476c flips the repo.
		expect(await runCase("standard", undefined)).toEqual(["pr-review"]);
		expect(await runCase("standard", true, "box")).toEqual(["pr-review"]);
		// `actions`: the webhook-dispatched Actions lane owns review.
		expect(await runCase("standard", undefined, "actions")).toEqual([]);
		expect(await runCase("standard", true, "actions")).toEqual([]);
		// static-only keeps its box infra-static job unless static_runtime is actions.
		expect(await runCase("static-only", undefined)).toEqual(["infra-static"]);
		expect(await runCase("static-only", undefined, undefined, "box")).toEqual(["infra-static"]);
		// sf#827: `static_runtime: actions` means the Actions lane owns the static
		// verdict, so a box job would post a second one.
		expect(await runCase("static-only", undefined, undefined, "actions")).toEqual([]);
	});

	test("opt-out skips standard and static review lanes while another repo remains unchanged", async () => {
		await withTestDb(async (db) => {
			const item = (number: number) => ({
				number,
				state: "open",
				title: `PR ${number}`,
				updated_at: "2026-07-19T11:00:00Z",
				labels: [],
				pull_request: { url: "x" },
			});
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: async (url) => {
					if (url.includes("/repos/rodaddy/skip-standard/issues")) {
						return new Response(JSON.stringify([item(20)]), { status: 200 });
					}
					if (url.includes("/repos/rodaddy/skip-static/issues")) {
						return new Response(JSON.stringify([item(21)]), { status: 200 });
					}
					if (url.includes("/repos/rodaddy/keep/issues")) {
						return new Response(JSON.stringify([item(22)]), { status: 200 });
					}
					if (url.includes("/pulls/20")) {
						return new Response(JSON.stringify({ head: { sha: "skip-standard" } }), {
							status: 200,
						});
					}
					if (url.includes("/pulls/21")) {
						return new Response(JSON.stringify({ head: { sha: "skip-static" } }), { status: 200 });
					}
					if (url.includes("/pulls/22")) {
						return new Response(JSON.stringify({ head: { sha: "keep-review" } }), { status: 200 });
					}
					return new Response("[]", { status: 200 });
				},
			});
			const config = {
				poll_interval_minutes: 15,
				repositories: [
					{
						name: "rodaddy/skip-standard",
						provider: "github" as const,
						checks: "standard" as const,
						gate_selection: "full" as const,
						pr_review: false,
					},
					{
						name: "rodaddy/skip-static",
						provider: "github" as const,
						checks: "static-only" as const,
						gate_selection: "full" as const,
						pr_review: false,
					},
					{
						name: "rodaddy/keep",
						provider: "github" as const,
						checks: "standard" as const,
						gate_selection: "full" as const,
					},
				],
				job_templates: [],
				doorbell_enabled: false,
				shadow_publish: false,
			};

			const result = await runPass(db, githubRegistry(client), config, { now: NOW });

			expect(
				result.repositories.find((repo) => repo.repository === "rodaddy/skip-standard")
					?.jobsCreated,
			).toBe(0);
			expect(
				result.repositories.find((repo) => repo.repository === "rodaddy/skip-static")?.jobsCreated,
			).toBe(0);
			expect(
				result.repositories.find((repo) => repo.repository === "rodaddy/keep")?.jobsCreated,
			).toBe(1);
			const rows = await db.select().from(jobs);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ sha: "keep-review", jobType: "pr-review" });
		});
	});

	test("is idempotent across passes (no duplicate jobs)", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [
							{
								number: 7,
								state: "open",
								title: "A PR",
								updated_at: "2026-07-19T11:00:00Z",
								labels: [],
								pull_request: { url: "x" },
							},
						],
					},
					{ match: "/pulls/7", body: { head: { sha: "abc123" } } },
				]),
			});

			await runPass(db, githubRegistry(client), cfg("standard"), { now: NOW });
			const second = await runPass(db, githubRegistry(client), cfg("standard"), { now: NOW });

			expect(second.repositories[0]?.jobsCreated).toBe(0);
			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(1);
		});
	});

	test("does not create a job for an issue (no head SHA)", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [
							{
								number: 3,
								state: "open",
								title: "An issue",
								updated_at: "2026-07-19T11:00:00Z",
								labels: [],
							},
						],
					},
				]),
			});

			const result = await runPass(db, githubRegistry(client), cfg("standard"), { now: NOW });
			expect(result.repositories[0]?.itemsSeen).toBe(1);
			expect(result.repositories[0]?.jobsCreated).toBe(0);
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("a failing repository does not abort the others", async () => {
		await withTestDb(async (db) => {
			// First repo's issues endpoint 500s (retries exhaust -> repo fails);
			// second repo succeeds with one PR.
			const client = createGitHubClient("t", {
				sleep: async () => {},
				maxRetries: 0,
				fetch: async (url) => {
					if (url.includes("/repos/rodaddy/bad/")) {
						return new Response("{}", { status: 500 });
					}
					if (url.includes("/repos/rodaddy/good/issues")) {
						return new Response(
							JSON.stringify([
								{
									number: 1,
									state: "open",
									title: "PR",
									updated_at: "2026-07-19T11:00:00Z",
									labels: [],
									pull_request: { url: "x" },
								},
							]),
							{ status: 200 },
						);
					}
					if (url.includes("/pulls/1")) {
						return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), {
							status: 200,
						});
					}
					return new Response("[]", { status: 200 });
				},
			});

			const config = {
				poll_interval_minutes: 15,
				repositories: [
					{
						name: "rodaddy/bad",
						provider: "github" as const,
						checks: "standard" as const,
						gate_selection: "full" as const,
					},
					{
						name: "rodaddy/good",
						provider: "github" as const,
						checks: "standard" as const,
						gate_selection: "full" as const,
					},
				],
				job_templates: [],
				doorbell_enabled: false,
				shadow_publish: false,
			};

			const result = await runPass(db, githubRegistry(client), config, { now: NOW });

			expect(result.okCount).toBe(1);
			expect(result.failCount).toBe(1);
			const bad = result.repositories.find((r) => r.repository === "rodaddy/bad");
			const good = result.repositories.find((r) => r.repository === "rodaddy/good");
			expect(bad?.ok).toBe(false);
			expect(bad?.error).toBeDefined();
			expect(good?.ok).toBe(true);
			expect(good?.jobsCreated).toBe(1);
		});
	});

	test("static-only repos queue infra-static jobs", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [
							{
								number: 9,
								state: "open",
								title: "PR",
								updated_at: "2026-07-19T11:00:00Z",
								labels: [],
								pull_request: { url: "x" },
							},
						],
					},
					{ match: "/pulls/9", body: { head: { sha: "cafe" } } },
				]),
			});

			await runPass(db, githubRegistry(client), cfg("static-only"), { now: NOW });
			const rows = await db.select().from(jobs);
			expect(rows[0]?.jobType).toBe("infra-static");
		});
	});
});

/** An open ISSUE (no `pull_request` key), optionally labelled. */
function issueItem(number: number, labels: string[], state = "open") {
	return {
		number,
		state,
		title: `Issue ${number}`,
		updated_at: "2026-07-19T11:00:00Z",
		labels: labels.map((name) => ({ name })),
	};
}

const BASE_SHA = "aa11bb22cc33dd44ee55ff6600112233445566aa";

/** Config with the implement lane opted in via an exact label. */
const implementCfg = (label?: string, baseBranch?: string) => ({
	...cfg("standard"),
	repositories: [
		{
			name: "rodaddy/x",
			provider: "github" as const,
			checks: "standard" as const,
			gate_selection: "full" as const,
			...(label === undefined ? {} : { implement_label: label }),
			...(baseBranch === undefined ? {} : { proposal_base_branch: baseBranch }),
		},
	],
});

describe("implement lane enqueue", () => {
	test("a labelled open issue queues ONE implement job at the resolved base", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(42, ["agent:implement"])] },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			const result = await runPass(db, githubRegistry(client), implementCfg("agent:implement"), {
				now: NOW,
			});

			expect(result.repositories[0]?.jobsCreated).toBe(1);
			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(1);
			expect(rows[0]?.jobType).toBe("implement-issue");
			// The dispatched base is a REAL full sha, never "" -- #65 compares it in full.
			expect(rows[0]?.sha).toBe(BASE_SHA);
		});
	});

	test("an UNLABELLED open issue queues nothing", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(43, ["bug", "priority:p1"])] },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg("agent:implement"), { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("no configured label means the lane is OFF, even for a labelled issue", async () => {
		// The opt-in is per repository. Without it an issue carrying any label at
		// all -- including one that looks like the trigger -- queues no code work.
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(44, ["agent:implement"])] },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg(undefined), { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("label matching is EXACT, not a prefix or substring", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [issueItem(45, ["agent:implement-later", "not-agent:implement"])],
					},
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg("agent:implement"), { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("a CLOSED labelled issue queues nothing", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(46, ["agent:implement"], "closed")] },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg("agent:implement"), { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("a labelled PULL REQUEST never queues implement work", async () => {
		// The lane turns a described task into a change; a PR already carries one.
		// The PR still queues its own review job, which is the point of the check.
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [
							{
								number: 47,
								state: "open",
								title: "A labelled PR",
								updated_at: "2026-07-19T11:00:00Z",
								labels: [{ name: "agent:implement" }],
								pull_request: { url: "x" },
							},
						],
					},
					{ match: "/pulls/47", body: { head: { sha: "abc123" } } },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg("agent:implement"), { now: NOW });
			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(1);
			expect(rows[0]?.jobType).toBe("pr-review");
		});
	});

	test("FAILS CLOSED: an unresolvable base queues nothing rather than a baseless job", async () => {
		// A job with no truthful base is unverifiable by construction (#65 compares
		// the bundle's prerequisite against the dispatched base in full), so
		// queueing one would spend a runner to produce a change that must then be
		// rejected. The pass itself still succeeds -- this is one skipped item.
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(48, ["agent:implement"])] },
					{ match: "/branches/main", body: {}, status: 500 },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			const result = await runPass(db, githubRegistry(client), implementCfg("agent:implement"), {
				now: NOW,
			});
			expect((await db.select().from(jobs)).length).toBe(0);
			expect(result.okCount).toBe(1);
		});
	});

	test("FAILS CLOSED on a truncated base sha, which cannot be compared in full", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(49, ["agent:implement"])] },
					{ match: "/branches/main", body: { commit: { sha: "aa11bb2" } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg("agent:implement"), { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("re-running the pass does not duplicate the job", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(50, ["agent:implement"])] },
					{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			const cfgOnce = implementCfg("agent:implement");
			await runPass(db, githubRegistry(client), cfgOnce, { now: NOW });
			const second = await runPass(db, githubRegistry(client), cfgOnce, { now: NOW });

			expect(second.repositories[0]?.jobsCreated).toBe(0);
			expect((await db.select().from(jobs)).length).toBe(1);
		});
	});

	test("does not re-queue when the BASE BRANCH MOVES under an unchanged issue", async () => {
		// The case the fixed-sha test above cannot see, and the one that actually
		// bites. `jobs` is unique on (repo, item, sha, job_type); this lane's `sha`
		// is the base branch TIP, which moves whenever anything merges. Keyed on
		// that, one unchanged labelled issue queues a fresh code-producing run on
		// every base movement -- and the issue IS re-read every pass, because the
		// cursor is the newest `updated_at` and the forge `since` filter is
		// inclusive. Dedupe is therefore on the ITEM, not the uniqueness key.
		await withTestDb(async (db) => {
			const tips = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
			let branchCalls = 0;
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: (async (url: string) => {
					if (url.includes("/branches/")) {
						const sha = tips[Math.min(branchCalls++, tips.length - 1)];
						return new Response(JSON.stringify({ commit: { sha } }), { status: 200 });
					}
					if (url.includes("/pulls?head=")) {
						return new Response(JSON.stringify([]), { status: 200 }); // sf#570: no open proposal
					}
					if (url.includes("/issues")) {
						return new Response(JSON.stringify([issueItem(52, ["agent:implement"])]), {
							status: 200,
						});
					}
					return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
				}) as typeof fetch,
			});

			const cfgMoving = implementCfg("agent:implement");
			for (let i = 0; i < 3; i++) {
				await runPass(db, githubRegistry(client), cfgMoving, { now: NOW });
			}

			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(1);
			// The FIRST base is kept: the queued work is already bound to it, and
			// re-binding a live job to a moving branch is what the dispatch-time
			// capture exists to prevent.
			expect(rows[0]?.sha).toBe(tips[0]);
		});
	});

	test("after a TERMINAL attempt, re-queues only once the base has actually moved", async () => {
		// Two guards compose here, and the distinction is the point.
		//
		// The live-job check stops re-queueing while an attempt is in flight. Once
		// that attempt is terminal the check no longer bars anything -- but on an
		// UNCHANGED base the uniqueness key (repo, item, sha, type) still matches,
		// so nothing is queued. That is correct: re-running the same issue against
		// the same commit would reproduce the same work.
		//
		// When the base HAS moved, the key differs and a fresh attempt is queued
		// against the new commit, which is genuinely different work.
		await withTestDb(async (db) => {
			let tip = BASE_SHA;
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: (async (url: string) => {
					if (url.includes("/branches/")) {
						return new Response(JSON.stringify({ commit: { sha: tip } }), { status: 200 });
					}
					if (url.includes("/pulls?head=")) {
						return new Response(JSON.stringify([]), { status: 200 }); // sf#570: no open proposal
					}
					if (url.includes("/issues")) {
						return new Response(JSON.stringify([issueItem(53, ["agent:implement"])]), {
							status: 200,
						});
					}
					return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
				}) as typeof fetch,
			});

			const cfgTerm = implementCfg("agent:implement");
			await runPass(db, githubRegistry(client), cfgTerm, { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(1);

			// Terminal, base unchanged -> still nothing new.
			await db.update(jobs).set({ status: "completed" });
			await runPass(db, githubRegistry(client), cfgTerm, { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(1);

			// Terminal, base moved -> a fresh attempt against the new commit.
			tip = "d".repeat(40);
			await runPass(db, githubRegistry(client), cfgTerm, { now: NOW });
			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(2);
			expect(rows.map((r) => r.sha).sort()).toEqual([BASE_SHA, "d".repeat(40)].sort());
		});
	});

	test("the configured proposal_base_branch wins over the forge default", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{ match: "/issues", body: [issueItem(51, ["agent:implement"])] },
					{ match: "/branches/release/1.x", body: { commit: { sha: BASE_SHA } } },
					// Present but must NOT be consulted; a different sha proves which won.
					{ match: "/branches/main", body: { commit: { sha: "b".repeat(40) } } },
					// sf#570: the open-proposal probe reads `/pulls?head=`; answer it BEFORE the repo route swallows it.
					{ match: "/pulls?head=", body: [] },
					{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
				]),
			});

			await runPass(db, githubRegistry(client), implementCfg("agent:implement", "release/1.x"), {
				now: NOW,
			});
			const rows = await db.select().from(jobs);
			expect(rows[0]?.sha).toBe(BASE_SHA);
		});
	});
});

/** Config with the issue-triage lane opted in (or not) for the one repo. */
const triageCfg = (triage?: boolean, runtime?: "box" | "actions") => ({
	...cfg("standard"),
	repositories: [
		{
			name: "rodaddy/x",
			provider: "github" as const,
			checks: "standard" as const,
			gate_selection: "full" as const,
			...(triage === undefined ? {} : { triage }),
			...(runtime === undefined ? {} : { triage_runtime: runtime }),
		},
	],
});

describe("implement_runtime", () => {
	test("implement_runtime: box keeps the box implement job, actions queues none", async () => {
		const runCase = async (runtime: "box" | "actions"): Promise<string[]> => {
			let jobTypes: string[] = [];
			await withTestDb(async (db) => {
				const client = createGitHubClient("t", {
					sleep: async () => {},
					fetch: routedFetch([
						{ match: "/issues", body: [issueItem(46, ["agent:implement"])] },
						{ match: "/branches/main", body: { commit: { sha: BASE_SHA } } },
						{ match: "/pulls?head=", body: [] },
						{ match: "/repos/rodaddy/x", body: { default_branch: "main" } },
					]),
				});
				const base = implementCfg("agent:implement");
				const config = {
					...base,
					repositories: base.repositories.map((r) => ({ ...r, implement_runtime: runtime })),
				};
				await runPass(db, githubRegistry(client), config, { now: NOW });
				jobTypes = (await db.select().from(jobs)).map((row) => row.jobType);
			});
			return jobTypes;
		};
		expect(await runCase("box")).toEqual(["implement-issue"]);
		// `actions`: the webhook-dispatched Actions lane owns the implement lane.
		expect(await runCase("actions")).toEqual([]);
	});
});

describe("issue-triage lane enqueue", () => {
	test("an OPTED-OUT repository queues no triage job for an open issue", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([{ match: "/issues", body: [issueItem(60, [])] }]),
			});

			// triage absent (default off): nothing queued.
			const result = await runPass(db, githubRegistry(client), triageCfg(undefined), { now: NOW });
			expect(result.repositories[0]?.jobsCreated).toBe(0);
			expect((await db.select().from(jobs)).length).toBe(0);

			// triage explicitly false: still nothing queued.
			await runPass(db, githubRegistry(client), triageCfg(false), { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("an OPTED-IN repository queues ONE triage job per open issue, no label needed", async () => {
		await withTestDb(async (db) => {
			// The issue carries no trigger label; triage still queues it, because
			// labelling is what triage DOES.
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([{ match: "/issues", body: [issueItem(61, [])] }]),
			});

			const result = await runPass(db, githubRegistry(client), triageCfg(true), { now: NOW });
			expect(result.repositories[0]?.jobsCreated).toBe(1);
			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(1);
			expect(rows[0]?.jobType).toBe("issue-triage");
			// An issue has no SHA of its own; the triage job's sha is "".
			expect(rows[0]?.sha).toBe("");
		});
	});

	test("triage_runtime: box keeps the box triage job, actions queues none", async () => {
		const runCase = async (runtime: "box" | "actions"): Promise<string[]> => {
			let jobTypes: string[] = [];
			await withTestDb(async (db) => {
				const client = createGitHubClient("t", {
					sleep: async () => {},
					fetch: routedFetch([{ match: "/issues", body: [issueItem(63, [])] }]),
				});
				await runPass(db, githubRegistry(client), triageCfg(true, runtime), { now: NOW });
				jobTypes = (await db.select().from(jobs)).map((row) => row.jobType);
			});
			return jobTypes;
		};
		expect(await runCase("box")).toEqual(["issue-triage"]);
		// `actions`: the webhook-dispatched Actions lane owns triage.
		expect(await runCase("actions")).toEqual([]);
	});

	test("queues EXACTLY once per (issue, sha) — re-running the pass does not duplicate", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([{ match: "/issues", body: [issueItem(62, [])] }]),
			});

			const cfgOn = triageCfg(true);
			await runPass(db, githubRegistry(client), cfgOn, { now: NOW });
			const second = await runPass(db, githubRegistry(client), cfgOn, { now: NOW });

			// The existing dedup key (repo, item, sha="", job_type) bounds it: the
			// second pass re-reads the same issue and conflicts onto the same row.
			expect(second.repositories[0]?.jobsCreated).toBe(0);
			expect((await db.select().from(jobs)).length).toBe(1);
		});
	});

	test("a CLOSED issue queues no triage job", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([{ match: "/issues", body: [issueItem(63, [], "closed")] }]),
			});

			await runPass(db, githubRegistry(client), triageCfg(true), { now: NOW });
			expect((await db.select().from(jobs)).length).toBe(0);
		});
	});

	test("a PULL REQUEST never queues a triage job (it queues its review instead)", async () => {
		await withTestDb(async (db) => {
			const client = createGitHubClient("t", {
				sleep: async () => {},
				fetch: routedFetch([
					{
						match: "/issues",
						body: [
							{
								number: 64,
								state: "open",
								title: "A PR",
								updated_at: "2026-07-19T11:00:00Z",
								labels: [],
								pull_request: { url: "x" },
							},
						],
					},
					{ match: "/pulls/64", body: { head: { sha: "abc123" } } },
				]),
			});

			await runPass(db, githubRegistry(client), triageCfg(true), { now: NOW });
			const rows = await db.select().from(jobs);
			expect(rows.length).toBe(1);
			expect(rows[0]?.jobType).toBe("pr-review");
		});
	});
});
