/**
 * The implement lane's missing link. `pushVerifiedBranch` and
 * `openChangeProposal` were both built, tested, and defended in isolation — and
 * NOTHING called them, so an accepted change was ingested, the job was marked
 * completed, and no branch or proposal ever appeared. Two independent review
 * lanes found that on PR #83.
 *
 * These pin the chain rather than the pieces: a verified change becomes a pushed
 * branch and THEN a queued proposal, in that order; a push that fails queues
 * nothing (a plan whose branch does not exist would have the publisher open a PR
 * against a missing ref); and nothing a runner returns can decide what is pushed
 * or where.
 *
 * PROVEN TO FAIL. `runProposalPass` was mutated to call `queueProposal` BEFORE
 * `pushVerifiedBranch` instead of after it — the exact regression these tests
 * exist to stop. Two went red: "the ordering holds" saw `["queue", "push"]`, and
 * "a FAILED push queues no proposal" queued a plan for a push that exited 1.
 * Restored, 9 pass.
 */
import { describe, expect, test } from "bun:test";
import type { ForgeClient } from "../../src/forge/boundary";
import { proposalBranchFor } from "../../src/github/publication";
import type { GitRunner } from "../../src/results/branch-publisher";
import { runProposalPass } from "../../src/results/proposal-pass";
import { IMPLEMENT_TEMPLATE_ID } from "../../src/templates/registry";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

/** A scripted git that records every invocation, keyed on the subcommand. */
function git(overrides: Record<string, { exitCode?: number }> = {}): GitRunner & {
	calls: string[][];
} {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args) => {
			calls.push([...args]);
			const sub = args[0] ?? "";
			return {
				exitCode: overrides[sub]?.exitCode ?? 0,
				stdout: sub === "rev-parse" ? `${HEAD}\n` : "",
				stderr: "",
			};
		},
	};
}

/**
 * A forge client that only ever answers the default-branch read.
 * `resolveBaseBranch` issues `client.get('/repos/<owner>/<repo>')` and reads
 * `data.default_branch`, so that is the exact shape faked here.
 */
function client(defaultBranch: string | null = "main"): ForgeClient {
	return {
		get: async () => ({ data: defaultBranch === null ? {} : { default_branch: defaultBranch } }),
	} as unknown as ForgeClient;
}

function config(proposalBase?: string) {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: "rodaddy/x",
				provider: "github" as const,
				checks: "standard" as const,
				gate_selection: "full" as const,
				...(proposalBase === undefined ? {} : { proposal_base_branch: proposalBase }),
			},
		],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
	};
}

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		jobId: 1,
		attemptId: 1,
		// The DISPATCH identity's own rows — what a follow-up job is keyed
		// on. Distinct from `repository` below, which is the CHANGE identity.
		repositoryId: 7,
		itemId: 99,
		repository: "rodaddy/x",
		itemNumber: 42,
		jobType: IMPLEMENT_TEMPLATE_ID,
		dispatchedBaseSha: BASE,
		snapshotPath: "/watcher/snapshots/job-1.bundle",
		renderedArtifact: "apiVersion: v1\nkind: ConfigMap\nmetadata: { name: clean }",
		...overrides,
	};
}

function deps(over: Record<string, unknown> = {}) {
	const queued: { headBranch: string; baseBranch: string; jobId: number }[] = [];
	const runner = (over.git as ReturnType<typeof git>) ?? git();
	const harness = {
		queued,
		runner,
		deps: {
			db: {} as never,
			clientFor: async () => client(),
			config: config(),
			git: runner,
			remoteFor: () => "https://github.com/rodaddy/x.git",
			credentialFor: async () => "s3cret-token",
			scratchRepoFor: () => "/watcher/scratch/x",
			ensureScratchRepo: async () => true,
			loadCandidates: async () => [candidate()],
			railsManifestPath: "/repository/rtech-infra/scripts/done-means/factory-rails.yml",
			evaluateRails: async () => ({
				examined: ["cnpg-implies-backup"],
				violated: [],
				hold: false,
				report: "not-encoded: none",
				stale: false,
				notEncoded: [],
			}),
			queueProposal: async (
				c: { jobId: number; itemNumber: number; jobType: string },
				baseBranch: string,
			): Promise<boolean> => {
				// Mirror the production queuer: the head branch is re-derived from the
				// trusted item number and job type, never accepted as a passed-in string.
				const headBranch = proposalBranchFor(c.itemNumber, c.jobType);
				if (headBranch === null) return false;
				queued.push({ jobId: c.jobId, headBranch, baseBranch });
				return true;
			},
			...over,
		},
	};
	return harness;
}

describe("runProposalPass", () => {
	test("a verified change becomes a pushed branch AND a queued proposal", async () => {
		const h = deps();
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ candidates: 1, published: 1, refused: 0, pushFailed: 0 });
		// The branch is pushed...
		const push = h.runner.calls.find((c) => c[0] === "push");
		expect(push).toBeDefined();
		expect(push?.join(" ")).toContain("refs/heads/rw/issue-42");
		// ...and only then is the proposal queued, against that exact branch.
		expect(h.queued).toEqual([{ jobId: 1, headBranch: "rw/issue-42", baseBranch: "main" }]);
	});

	test("a verb candidate pushes and queues the same verb branch", async () => {
		const h = deps({ loadCandidates: async () => [candidate({ jobType: "newapp" })] });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ candidates: 1, published: 1, refused: 0, pushFailed: 0 });
		const push = h.runner.calls.find((c) => c[0] === "push");
		expect(push?.join(" ")).toContain("refs/heads/verb/newapp-42");
		expect(h.queued).toEqual([{ jobId: 1, headBranch: "verb/newapp-42", baseBranch: "main" }]);
	});

	test("a FAILED push queues no proposal: a plan without a branch opens a PR against nothing", async () => {
		const h = deps({ git: git({ push: { exitCode: 1 } }) });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ published: 0, pushFailed: 1 });
		expect(h.queued).toEqual([]);
	});

	test("the ordering holds: rails run before push and queue", async () => {
		const order: string[] = [];
		const runner: GitRunner & { calls: string[][] } = {
			calls: [],
			run: async (args) => {
				const sub = args[0] ?? "";
				if (sub === "push") order.push("push");
				runner.calls.push([...args]);
				return { exitCode: 0, stdout: sub === "rev-parse" ? `${HEAD}\n` : "", stderr: "" };
			},
		};
		const h = deps({
			git: runner,
			evaluateRails: async () => {
				order.push("rails");
				return {
					examined: ["cnpg-implies-backup"],
					violated: [],
					hold: false,
					report: "not-encoded: none",
					stale: false,
					notEncoded: [],
				};
			},
			queueProposal: async (): Promise<boolean> => {
				order.push("queue");
				return true;
			},
		});
		await runProposalPass(h.deps as never);

		expect(order).toEqual(["rails", "push", "queue"]);
	});

	test("a named rail violation holds before any push or proposal", async () => {
		const reports: string[] = [];
		const h = deps({
			evaluateRails: async () => {
				const report = "rails-violation: cnpg-implies-backup; not-encoded: live-only";
				reports.push(report);
				return {
					examined: ["cnpg-implies-backup"],
					violated: ["cnpg-implies-backup"],
					hold: true,
					report,
					stale: false,
					notEncoded: ["live-only"],
				};
			},
		});

		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ refused: 1, published: 0 });
		expect(reports).toEqual(["rails-violation: cnpg-implies-backup; not-encoded: live-only"]);
		expect(h.runner.calls.find((call) => call[0] === "push")).toBeUndefined();
		expect(h.queued).toEqual([]);
	});

	test("an unresolvable base branch refuses BEFORE any push", async () => {
		const h = deps({ clientFor: async () => client(null) });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ refused: 1, published: 0 });
		expect(h.runner.calls.find((c) => c[0] === "push")).toBeUndefined();
		expect(h.queued).toEqual([]);
	});

	test("a configured proposal_base_branch wins over the forge default", async () => {
		const h = deps({ config: config("develop") });
		await runProposalPass(h.deps as never);

		expect(h.queued[0]?.baseBranch).toBe("develop");
	});

	test("no push remote refuses before any push", async () => {
		const h = deps({ remoteFor: () => null });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ refused: 1, published: 0 });
		expect(h.runner.calls.find((c) => c[0] === "push")).toBeUndefined();
	});

	test("no usable forge client refuses before any push", async () => {
		// A provider whose token is absent must not fall through to some other forge's
		// client: the base branch would be read from the wrong repository.
		const h = deps({ clientFor: async () => null });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ refused: 1, published: 0 });
		expect(h.runner.calls.find((c) => c[0] === "push")).toBeUndefined();
		expect(h.queued).toEqual([]);
	});

	test("no push credential refuses rather than attempting an unauthenticated push", async () => {
		const h = deps({ credentialFor: async () => null });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ refused: 1, published: 0 });
		expect(h.runner.calls.find((c) => c[0] === "push")).toBeUndefined();
		expect(h.queued).toEqual([]);
	});

	test("a push whose plan does NOT persist is a failure, not a publication", async () => {
		// The infinite-re-push bug, found by the Sol antagonist lane on PR #86. The
		// queuer used to return void, so `buildProposalPlan` returning null (e.g. a
		// configured base equal to the head branch) pushed the branch, wrote NO
		// posting, and counted it published. The loader selects on the ABSENCE of a
		// posting, so the job stayed eligible and the pass re-pushed it every cycle,
		// forever.
		const h = deps({ queueProposal: async () => false });
		const summary = await runProposalPass(h.deps as never);

		// The push DID happen — this is the state that must not read as success.
		expect(h.runner.calls.some((c) => c[0] === "push")).toBe(true);
		expect(summary.published).toBe(0);
		expect(summary.pushFailed).toBe(1);
	});

	test("an unpreparable scratch repository refuses before any push", async () => {
		// Every git invocation in the push runs inside this directory. Without it the
		// push fails as a SPAWN error, which reads as an operational fault rather than
		// the missing-workspace it is — the e2e run is what surfaced this.
		const h = deps({ ensureScratchRepo: async () => false });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ refused: 1, published: 0 });
		expect(h.runner.calls.find((c) => c[0] === "push")).toBeUndefined();
		expect(h.queued).toEqual([]);
	});

	test("an item number that yields no branch refuses before any push", async () => {
		const h = deps({ loadCandidates: async () => [candidate({ itemNumber: -1 })] });
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ refused: 1, published: 0 });
		expect(h.runner.calls.find((c) => c[0] === "push")).toBeUndefined();
	});

	test("one candidate's failure does not abort the pass", async () => {
		let call = 0;
		const h = deps({
			loadCandidates: async () => [
				candidate({ jobId: 1, itemNumber: 42 }),
				candidate({ jobId: 2, itemNumber: 43 }),
			],
			queueProposal: async (c: { jobId: number; itemNumber: number }, baseBranch: string) => {
				call++;
				if (c.jobId === 1) throw new Error("transient");
				h.queued.push({
					jobId: c.jobId,
					headBranch: `rw/issue-${c.itemNumber}`,
					baseBranch,
				});
				return true;
			},
		});
		const summary = await runProposalPass(h.deps as never);

		expect(call).toBe(2);
		expect(summary.published).toBe(1);
		expect(h.queued).toEqual([{ jobId: 2, headBranch: "rw/issue-43", baseBranch: "main" }]);
	});

	test("a throwing error sink never aborts the pass", async () => {
		const h = deps({
			queueProposal: async () => {
				throw new Error("boom");
			},
			onError: () => {
				throw new Error("faulty sink");
			},
		});
		const summary = await runProposalPass(h.deps as never);
		expect(summary.pushFailed).toBe(1);
	});
});

/**
 * sf#173 — validate the PROPOSAL, not the base.
 *
 * A proposed bundle is verified for provenance and scope by `verifyChangeBundle`
 * and is then pushed and proposed without ever being compiled or tested. The
 * receipt gate protects OUR pushes; nothing validated the RUNNER'S. These pin
 * the seam: a published candidate enqueues exactly one validation job at the
 * PUSHED HEAD, a second pass over the same candidate enqueues none, and a
 * failure to enqueue never moves a counter.
 *
 * PROVEN TO FAIL. Each of the four was run against a mutated `proposal-pass.ts`:
 * transcripts are in the PR body.
 */
describe("runProposalPass validation enqueue", () => {
	/** Record every (candidate, headSha) the pass hands the enqueuer. */
	function recorder(result: boolean | (() => never) = true) {
		const seen: { jobId: number; repositoryId: number; itemId: number | null; sha: string }[] = [];
		return {
			seen,
			enqueueValidation: async (
				c: { jobId: number; repositoryId: number; itemId: number | null },
				headSha: string,
			) => {
				seen.push({
					jobId: c.jobId,
					repositoryId: c.repositoryId,
					itemId: c.itemId,
					sha: headSha,
				});
				if (typeof result === "function") result();
				return result;
			},
		};
	}

	test("a pushed AND queued candidate enqueues exactly one validation at the pushed head", async () => {
		const rec = recorder();
		const h = deps({
			loadCandidates: async () => [candidate({ repositoryId: 7, itemId: 99 })],
			enqueueValidation: rec.enqueueValidation,
		});
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ candidates: 1, published: 1, pushFailed: 0 });
		// EXACTLY one, keyed to the job's OWN repository/item rows and to the sha
		// the push actually landed — never the dispatched base.
		expect(rec.seen).toEqual([{ jobId: 1, repositoryId: 7, itemId: 99, sha: HEAD }]);
		expect(rec.seen[0]?.sha).not.toBe(BASE);
	});

	test("a candidate whose proposal plan did NOT persist enqueues no validation", async () => {
		// The ordering property. `queueProposal` false means the branch is pushed but
		// no proposal points at it, and that candidate is still eligible next cycle —
		// filing validation work against a head no proposal names is wrong.
		const rec = recorder();
		const h = deps({ queueProposal: async () => false, enqueueValidation: rec.enqueueValidation });
		const summary = await runProposalPass(h.deps as never);

		expect(h.runner.calls.some((c) => c[0] === "push")).toBe(true);
		expect(summary.pushFailed).toBe(1);
		expect(rec.seen).toEqual([]);
	});

	test("a FAILED push enqueues no validation", async () => {
		const rec = recorder();
		const h = deps({
			git: git({ push: { exitCode: 1 } }),
			enqueueValidation: rec.enqueueValidation,
		});
		const summary = await runProposalPass(h.deps as never);

		expect(summary.pushFailed).toBe(1);
		expect(rec.seen).toEqual([]);
	});

	test("a rejected enqueue (dedup) leaves the pass summary unchanged", async () => {
		// What a SECOND pass over the same candidate at the same head sees: the
		// (repo, item, sha, job_type) unique key already holds a row, so
		// `createPendingJob` writes nothing and reports false. The publication still
		// counts — the branch is on the forge either way.
		const rec = recorder(false);
		const h = deps({ enqueueValidation: rec.enqueueValidation });
		const summary = await runProposalPass(h.deps as never);

		expect(rec.seen).toHaveLength(1);
		expect(summary).toMatchObject({ candidates: 1, published: 1, refused: 0, pushFailed: 0 });
		expect(h.queued).toEqual([{ jobId: 1, headBranch: "rw/issue-42", baseBranch: "main" }]);
	});

	test("a THROWING enqueue leaves the pass summary unchanged and does not abort", async () => {
		const rec = recorder(() => {
			throw new Error("db down");
		});
		const h = deps({
			loadCandidates: async () => [
				candidate({ jobId: 1, itemNumber: 42 }),
				candidate({ jobId: 2, itemNumber: 43 }),
			],
			enqueueValidation: rec.enqueueValidation,
		});
		const summary = await runProposalPass(h.deps as never);

		// Both candidates published: the push happened and the plan persisted for
		// each, and a validation gap rolls nothing back.
		expect(rec.seen).toHaveLength(2);
		expect(summary).toMatchObject({ candidates: 2, published: 2, refused: 0, pushFailed: 0 });
	});

	test("an ABSENT enqueueValidation dep is a no-op: the pass is unchanged", async () => {
		const h = deps();
		const summary = await runProposalPass(h.deps as never);

		expect(summary).toMatchObject({ candidates: 1, published: 1, refused: 0, pushFailed: 0 });
		expect(h.queued).toEqual([{ jobId: 1, headBranch: "rw/issue-42", baseBranch: "main" }]);
	});
});
