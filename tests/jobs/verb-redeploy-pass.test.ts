/**
 * @module tests/jobs/verb-redeploy-pass
 * @description sf#305 — an operator re-run of an ALREADY-TERMINAL verb tuple,
 *   driven end to end through the real `runVerbControlSurfacePass`.
 *
 *   THE DEFECT THESE TESTS PIN. A verb's dedup tuple is
 *   `(repositoryId, itemId, manifest.sha256, verb)`. Once a row on that tuple goes
 *   terminal, `origin/main` returned a bounded skip and stopped — correct for a
 *   re-observation, and wrong for an operator who fixed the cause and wants the
 *   deploy re-run. PR #302 spent four review rounds proving that no reset inferred
 *   from ambient state works (`_DOCS/decisions-ledger.md` L-014..L-017); the
 *   settled answer is a DISTINCT one-shot label the watcher consumes.
 *
 *   THE ORDER IS THE SAFETY PROPERTY. The label is removed from the forge BEFORE
 *   anything dispatches. A crash between the two loses at most one re-run; the
 *   reverse order leaves the label standing and re-runs every sweep, which is the
 *   #210 box-churn failure the owner ruled on 2026-08-01. `records the removal call
 *   BEFORE the runner allocation` is the receipt for that ordering, and it is a
 *   single interleaved log so it cannot pass by asserting two independent facts.
 *
 *   MUTATION PROOF — see `scripts/done-means/transcripts/verb-redeploy-305.mutations.txt`
 *   for the RED transcripts. Each mutation is applied alone:
 *     M1 drop the consume  — remove the `consumeRedeployForRepo` await from
 *        `runVerbRepoPass`. Expect: label survives on the forge, no dispatch.
 *     M2 drop the reset semantics — make `dedupSha` ignore `args.redeploy`.
 *        Expect: the terminal tuple still bars the run, so no dispatch happens.
 *     M3 dispatch-before-consume — move the consume after the pass.
 *        Expect: the ordering receipt goes RED.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { forgeRuns, githubItems, jobs, repositories } from "../../src/db/schema";
import type { ForgeResponse } from "../../src/forge/boundary";
import { VERB_CHANGE_BASE_REPOSITORY } from "../../src/jobs/verb-base";
import type { BodyLandingStager } from "../../src/prepush/stage";
import { dispatchPendingJobs } from "../../src/reconcile/dispatch-pass";
import type { ObservedOpenIssue } from "../../src/reconcile/pass";
import { createPassBudget } from "../../src/runner/pass-budget";
import { createPassVmids } from "../../src/runner/pass-vmids";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import {
	type ReconcileCycleDeps,
	runSweepPhase,
	runVerbControlSurfacePass,
} from "../../src/service-cycle";
import { withTestDb } from "../db/helpers";
import { testTmpBase } from "../support/test-temp";

const REPO_NAME = "rodaddy/x";
const ITEM_NUMBER = 795;
const K3S_HEAD = "c".repeat(40);
const K3S_BRANCH_PATH = "/repos/rtech/k3s-deploy/branches/main";
const TARGET_REMOTE = "https://forge.example.internal/rtech/k3s-deploy.git";
const LABEL_PATH = `/repos/${REPO_NAME}/issues/${ITEM_NUMBER}/labels/redeploy%3Ahello`;
const COMMENT_PATH = `/repos/${REPO_NAME}/issues/${ITEM_NUMBER}/comments`;
const NOW = new Date("2026-08-16T06:00:00.000Z");

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const MANIFEST_CONTENT = "rails:\n  - id: safe\n";
const MANIFEST_SHA = createHash("sha256").update(MANIFEST_CONTENT).digest("hex");

async function manifestFixture(): Promise<string> {
	const base = join(testTmpBase(), "_scratch");
	await mkdir(base, { recursive: true });
	const dir = await mkdtemp(join(base, "verb-redeploy-manifest-"));
	const path = join(dir, "rails.yml");
	await writeFile(path, MANIFEST_CONTENT);
	return path;
}

function config(manifestPath: string): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: REPO_NAME,
				provider: "github",
				checks: "standard",
				gate_selection: "full",
				verb_dispatch: true,
			},
		],
		job_templates: [{ id: "newapp", runner_size: "small", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
		railsManifestPath: manifestPath,
		verbEnginePath: "/mnt/share/checkouts/rtech-infra",
		verbK3sCheckoutPath: "/mnt/share/checkouts/k3s-deploy",
	};
}

/**
 * The forge fake. `trace` is ONE interleaved log across reads, writes and runner
 * allocations, which is what makes the ordering receipt a real receipt: two
 * separate counters can both be satisfied in either order.
 */
function forge(
	trace: string[],
	overrides: { removeFails?: boolean; openIssueLabels?: string[] } = {},
) {
	const get = async <T>(path: string): Promise<ForgeResponse<T>> => {
		trace.push(`get:${path}`);
		if (path.includes("/tags")) {
			return { status: 200, data: [] as T, link: null, rateRemaining: null };
		}
		if (path === K3S_BRANCH_PATH) {
			return {
				status: 200,
				data: { commit: { id: K3S_HEAD } } as T,
				link: null,
				rateRemaining: null,
			};
		}
		throw new Error(`unscripted forge read: ${path}`);
	};
	const write = async <T>(method: string, path: string): Promise<ForgeResponse<T>> => {
		trace.push(`${method}:${path}`);
		if (method === "DELETE" && overrides.removeFails === true) {
			throw new Error("forge refused the label removal");
		}
		return { status: 200, data: {} as T, link: null, rateRemaining: null };
	};
	// The sweep's issue listing (`readChangedIssues`): one open issue with the
	// labels the test scripted, or nothing.
	const paginate = async <T>(path: string): Promise<T[]> => {
		trace.push(`paginate:${path}`);
		if (!path.includes("/issues") || overrides.openIssueLabels === undefined) return [];
		return [
			{
				number: ITEM_NUMBER,
				state: "open",
				title: "hello",
				updated_at: NOW.toISOString(),
				labels: overrides.openIssueLabels.map((name) => ({ name })),
			} as T,
		];
	};
	return { get, write, paginate };
}

function transport(trace: string[]): RunnerTransport & {
	runs: RunnerRunParams[];
	allocations: number;
} {
	const runs: RunnerRunParams[] = [];
	let allocations = 0;
	return {
		startBandMember: async () => {
			throw new Error("not implemented");
		},
		stopBandMember: async () => {
			throw new Error("not implemented");
		},
		listBand: async () => {
			throw new Error("not implemented");
		},
		runs,
		get allocations() {
			return allocations;
		},
		needed: async (): Promise<RunnerAllocation> => {
			allocations++;
			trace.push("runner:needed");
			return { ok: true, boxes: [{ vmid: 9001, size: "small" }] };
		},
		run: async (params) => {
			trace.push("runner:run");
			runs.push(params);
		},
		list: async () => [],
		done: async () => {},
	};
}

function landingStager(): BodyLandingStager {
	return {
		land: async (jobId) => {
			const runnerJobBodyPath = `/mnt/share/runners/jobs/${jobId}/input/job.md`;
			return { jobBodyPath: `/share${runnerJobBodyPath}`, runnerJobBodyPath };
		},
	};
}

interface Harness {
	deps: ReconcileCycleDeps;
	runner: ReturnType<typeof transport>;
	trace: string[];
	errors: unknown[];
}

async function harness(
	overrides: { removeFails?: boolean; openIssueLabels?: string[] } = {},
): Promise<Harness> {
	const manifestPath = await manifestFixture();
	const trace: string[] = [];
	const runner = transport(trace);
	const client = forge(trace, overrides);
	const errors: unknown[] = [];
	const unreached = (name: string) => () => {
		throw new Error(`verb pass must not reach ${name}`);
	};
	const deps = {
		config: config(manifestPath),
		transport: runner,
		bodyLandingStager: landingStager(),
		proposalDeps: {
			remoteFor: (repository: string) =>
				repository === VERB_CHANGE_BASE_REPOSITORY ? TARGET_REMOTE : null,
		},
		registry: { clientFor: async () => ({ ok: true, client }) },
		clientFor: async (repository: string) => (repository === REPO_NAME ? client : null),
		publisher: { run: unreached("publisher") },
		resultReconciler: { run: unreached("resultReconciler") },
		kboardClient: null,
		shadow: false,
		infraGateSelector: unreached("infraGateSelector"),
		onError: (error: unknown) => errors.push(error),
	} as unknown as ReconcileCycleDeps;
	return { deps, runner, trace, errors };
}

async function seedItem(db: TestDb): Promise<{ repositoryId: number; itemId: number }> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: REPO_NAME, provider: "github", checks: "standard" })
		.returning();
	if (repo === undefined) throw new Error("repository seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "issue", number: ITEM_NUMBER, state: "open" })
		.returning();
	if (item === undefined) throw new Error("item seed failed");
	return { repositoryId: repo.id, itemId: item.id };
}

/** Seed the TERMINAL row that occupies this manifest's tuple and bars a re-run. */
async function seedTerminalVerb(
	db: TestDb,
	ids: { repositoryId: number; itemId: number },
	status = "failed",
): Promise<number> {
	const [row] = await db
		.insert(jobs)
		.values({
			repositoryId: ids.repositoryId,
			itemId: ids.itemId,
			sha: MANIFEST_SHA,
			jobType: "newapp",
			status,
			changeBaseRepository: VERB_CHANGE_BASE_REPOSITORY,
			changeBaseSha: K3S_HEAD,
		})
		.returning({ id: jobs.id });
	if (row === undefined) throw new Error("job seed failed");
	return row.id;
}

/** The observed issue the sweep hands the verb pass, with the labels under test. */
function observed(
	ids: { repositoryId: number; itemId: number },
	labels: string[],
): ObservedOpenIssue {
	return {
		repo: {
			name: REPO_NAME,
			provider: "github",
			checks: "standard",
			gate_selection: "full",
			verb_dispatch: true,
		},
		repositoryId: ids.repositoryId,
		itemId: ids.itemId,
		item: {
			kind: "issue",
			number: ITEM_NUMBER,
			state: "open",
			title: "",
			headSha: null,
			updatedAt: "",
			labels,
		},
	} as ObservedOpenIssue;
}

describe("runVerbControlSurfacePass — redeploy:<app> on a terminal tuple", () => {
	test("consumes the label on the forge and then dispatches a FRESH run", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			const terminalId = await seedTerminalVerb(db, ids);
			const h = await harness();

			await runVerbControlSurfacePass(
				{ ...h.deps, db },
				[observed(ids, ["deploy:hello", "redeploy:hello"])],
				NOW,
			);

			expect(h.errors).toEqual([]);
			// The label is GONE from the forge.
			expect(h.trace).toContain(`DELETE:${LABEL_PATH}`);
			// And a real run happened.
			expect(h.runner.allocations).toBe(1);
			expect(h.runner.runs).toHaveLength(1);
			expect(h.runner.runs[0]?.runtime).toBe("script");

			const rows = await db.select().from(jobs);
			expect(rows).toHaveLength(2);
			// The TERMINAL row is untouched — same sha, same status. `jobs.sha` is the
			// identity anchor a late result is verified against, and rekeying it is the
			// round-10 P2 corruption this design dissolves by construction.
			const terminal = rows.find((r) => r.id === terminalId);
			expect(terminal?.sha).toBe(MANIFEST_SHA);
			expect(terminal?.status).toBe("failed");
			// The FRESH row took its own point in the key space and is running.
			const fresh = rows.find((r) => r.id !== terminalId);
			expect(fresh?.status).toBe("running");
			expect(fresh?.sha).not.toBe(MANIFEST_SHA);
			expect(fresh?.sha).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	test("records the removal call BEFORE the runner allocation", async () => {
		// THE ORDERING RECEIPT. One interleaved trace, so this cannot be satisfied by
		// two independent assertions that happen to both hold.
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedTerminalVerb(db, ids);
			const h = await harness();

			await runVerbControlSurfacePass(
				{ ...h.deps, db },
				[observed(ids, ["deploy:hello", "redeploy:hello"])],
				NOW,
			);

			const removedAt = h.trace.indexOf(`DELETE:${LABEL_PATH}`);
			const allocatedAt = h.trace.indexOf("runner:needed");
			expect(removedAt).toBeGreaterThanOrEqual(0);
			expect(allocatedAt).toBeGreaterThanOrEqual(0);
			expect(removedAt).toBeLessThan(allocatedAt);
		});
	});

	test("posts the consumption receipt comment", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedTerminalVerb(db, ids);
			const h = await harness();

			await runVerbControlSurfacePass(
				{ ...h.deps, db },
				[observed(ids, ["deploy:hello", "redeploy:hello"])],
				NOW,
			);

			expect(h.trace).toContain(`POST:${COMMENT_PATH}`);
		});
	});

	test("WITHOUT the label a terminal tuple still honestly skips — no re-run", async () => {
		// The standing ruling: the terminal-tuple skip stays for rows without the
		// label. This is the negative control that makes the test above mean anything.
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedTerminalVerb(db, ids);
			const h = await harness();

			await runVerbControlSurfacePass({ ...h.deps, db }, [observed(ids, ["deploy:hello"])], NOW);

			expect(h.errors).toEqual([]);
			expect(h.runner.allocations).toBe(0);
			expect(await db.select().from(jobs)).toHaveLength(1);
			expect(h.trace.some((entry) => entry.startsWith("DELETE:"))).toBe(false);
		});
	});

	test("a FAILED label removal is not a consumption: nothing dispatches", async () => {
		// Consume-before-dispatch only helps if a failed consume also stops the run.
		// Otherwise a forge that refuses the write produces a re-run whose signal is
		// still armed, and the next sweep runs it again.
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedTerminalVerb(db, ids);
			const h = await harness({ removeFails: true });

			await runVerbControlSurfacePass(
				{ ...h.deps, db },
				[observed(ids, ["deploy:hello", "redeploy:hello"])],
				NOW,
			);

			expect(h.trace).toContain(`DELETE:${LABEL_PATH}`);
			expect(h.runner.allocations).toBe(0);
			expect(await db.select().from(jobs)).toHaveLength(1);
		});
	});

	test("a redeploy naming an app with NO verb row is consumed as a logged no-op", async () => {
		// `redeploy:hello` with no `deploy:hello` resolves to no verb, so there is
		// nothing to re-run. The label is still consumed — a one-shot label that is
		// never consumed is not one-shot, and it would be re-read every sweep forever.
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			const h = await harness();

			await runVerbControlSurfacePass({ ...h.deps, db }, [observed(ids, ["redeploy:hello"])], NOW);

			expect(h.errors).toEqual([]);
			expect(h.trace).toContain(`DELETE:${LABEL_PATH}`);
			expect(h.runner.allocations).toBe(0);
			expect(await db.select().from(jobs)).toHaveLength(0);
		});
	});

	test("the app suffix must MATCH the verb's parameter", async () => {
		// `redeploy:other` must not re-run `deploy:hello`. Without the app match the
		// label would re-run whatever verb the item happened to resolve to.
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedTerminalVerb(db, ids);
			const h = await harness();

			await runVerbControlSurfacePass(
				{ ...h.deps, db },
				[observed(ids, ["deploy:hello", "redeploy:other"])],
				NOW,
			);

			// The mismatched signal is still CONSUMED (it is one-shot regardless)...
			expect(
				h.trace.some(
					(e) => e === `DELETE:/repos/${REPO_NAME}/issues/${ITEM_NUMBER}/labels/redeploy%3Aother`,
				),
			).toBe(true);
			// ...but it re-runs nothing, because it named a different app.
			expect(h.runner.allocations).toBe(0);
			expect(await db.select().from(jobs)).toHaveLength(1);
		});
	});

	test("a LIVE job blocks the re-run rather than terminalizing queued work", async () => {
		// `recoverPendingVerb` matches on (repository, item, verb) regardless of sha,
		// so a healthy pending row would read as SUPERSEDED against the run sha and be
		// terminalized to make way for the re-run — destroying work nobody cancelled.
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			const pendingId = await seedTerminalVerb(db, ids, "pending");
			const h = await harness();

			await runVerbControlSurfacePass(
				{ ...h.deps, db },
				[observed(ids, ["deploy:hello", "redeploy:hello"])],
				NOW,
			);

			const rows = await db.select().from(jobs);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(pendingId);
			expect(rows[0]?.status).toBe("pending");
			expect(rows[0]?.sha).toBe(MANIFEST_SHA);
			expect(h.runner.allocations).toBe(0);
		});
	});
});

/** A transport that hands out a DISTINCT vmid per allocation, so the same-pass
 * vmid ledger cannot be what bounds the pass in the budget test below. */
function distinctBoxes(): RunnerTransport & { runs: RunnerRunParams[] } {
	const runs: RunnerRunParams[] = [];
	let allocations = 0;
	return {
		startBandMember: async () => {
			throw new Error("not implemented");
		},
		stopBandMember: async () => {
			throw new Error("not implemented");
		},
		listBand: async () => {
			throw new Error("not implemented");
		},
		runs,
		needed: async (): Promise<RunnerAllocation> => {
			allocations++;
			return { ok: true, boxes: [{ vmid: 9000 + allocations, size: "small" }] };
		},
		run: async (params) => {
			runs.push(params);
		},
		list: async () => [],
		done: async () => {},
	};
}

describe("the per-pass dispatch cap spans the verb lane and the generic pass", () => {
	test("cap 2: one verb dispatch leaves exactly one slot for the generic pass", async () => {
		await withTestDb(async (db) => {
			const h = await harness();
			const ids = await seedItem(db);
			for (const sha of ["generic-1", "generic-2"]) {
				await db.insert(jobs).values({
					repositoryId: ids.repositoryId,
					sha,
					jobType: "pr-review",
					status: "pending",
				});
			}
			const transport = distinctBoxes();
			const config: WatcherConfig = {
				...h.deps.config,
				job_templates: [
					...h.deps.config.job_templates,
					{ id: "pr-review", runner_size: "medium", return_mode: "patch" },
				],
			};
			const deps = { ...h.deps, db, config, transport };
			const passVmids = createPassVmids();
			const passBudget = createPassBudget(2);

			await runVerbControlSurfacePass(deps, [observed(ids, ["deploy:hello"])], NOW, {
				passVmids,
				passBudget,
			});
			expect(transport.runs).toHaveLength(1);
			expect(passBudget.remaining()).toBe(1);

			const generic = await dispatchPendingJobs(db, transport, config, {
				now: NOW,
				maxPerPass: 2,
				passVmids,
				passBudget,
				bodyLandingStager: deps.bodyLandingStager,
			});
			// Shortlisted the cap, dispatched the one slot the verb lane left.
			expect(generic.selected).toBe(2);
			expect(generic.dispatched).toBe(1);
			expect(transport.runs).toHaveLength(2);
			expect(h.errors).toEqual([]);
		});
	});
});

describe("runSweepPhase resolves the cap ONCE for both lanes", () => {
	test("cap 0 is the generic pass's floor of one for the whole sweep, not a closed verb budget", async () => {
		await withTestDb(async (db) => {
			const { deps, runner } = await harness({ openIssueLabels: ["deploy:hello"] });
			const cycleDeps = deps as ReconcileCycleDeps & { maxDispatchPerPass?: number };
			cycleDeps.db = db;
			cycleDeps.maxDispatchPerPass = 0;
			cycleDeps.config.job_templates.push({
				id: "pr-review",
				runner_size: "small",
				return_mode: "patch",
			});
			const { repositoryId } = await seedItem(db);
			await db.insert(jobs).values({
				repositoryId,
				sha: "generic-0",
				jobType: "pr-review",
				status: "pending",
			});

			await runSweepPhase(cycleDeps, NOW);

			// Exactly ONE box: the verb lane spent the sweep's single resolved slot,
			// and the generic pass had nothing left. Two parsings would have closed
			// the verb budget at zero and let the generic pass place one anyway.
			expect(runner.runs).toHaveLength(1);
			const [verbRow] = await db.select().from(jobs).where(eq(jobs.jobType, "newapp"));
			expect(verbRow?.status).toBe("running");
			const generic = await db.select().from(jobs).where(eq(jobs.jobType, "pr-review"));
			expect(generic.map((row) => row.status)).toEqual(["pending"]);
		});
	});
});

describe("runSweepPhase wires ONE scope through both lanes under the configured cap", () => {
	test("cap 2: the sweep's verb dispatch plus its generic pass place exactly two boxes", async () => {
		await withTestDb(async (db) => {
			// The forge reports one open issue carrying the verb label, so the sweep's
			// OWN item read (not a hand-built observed set) drives the verb lane.
			const { deps, errors } = await harness({ openIssueLabels: ["deploy:hello"] });
			const cycleDeps = deps as ReconcileCycleDeps & { maxDispatchPerPass?: number };
			cycleDeps.db = db;
			cycleDeps.maxDispatchPerPass = 2;
			// Distinct vmids per allocation, so the same-pass vmid ledger is
			// not what bounds the pass here; only the budget is.
			const runner = distinctBoxes();
			cycleDeps.transport = runner;
			cycleDeps.config.job_templates.push({
				id: "pr-review",
				runner_size: "small",
				return_mode: "patch",
			});
			const { repositoryId } = await seedItem(db);
			// Three generic rows are due; without the shared budget the generic pass
			// would place two of them on top of the verb's box (3 > cap).
			for (let i = 0; i < 3; i++) {
				await db.insert(jobs).values({
					repositoryId,
					sha: `generic-${i}`,
					jobType: "pr-review",
					status: "pending",
				});
			}

			await runSweepPhase(cycleDeps, NOW);

			expect(runner.runs).toHaveLength(2);
			const [verbRow] = await db.select().from(jobs).where(eq(jobs.jobType, "newapp"));
			expect(verbRow?.status).toBe("running");
			const generic = await db.select().from(jobs).where(eq(jobs.jobType, "pr-review"));
			expect(generic.filter((row) => row.status === "running")).toHaveLength(1);
			expect(generic.filter((row) => row.status === "pending")).toHaveLength(2);
			// The other sweep steps (build-bump, runner scale) are isolated by their own
			// try/catch; none of them may have swallowed a dispatch error.
			expect(errors.filter((e) => String(e).includes("dispatch"))).toEqual([]);
		});
	});
});

describe("runVerbControlSurfacePass — verb_runtime: actions is wired (sweep-F, PR 902)", () => {
	test("dispatches verb.yml once through the wired dispatcher and records it; no box", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			const h = await harness();
			const actions = observed(ids, ["deploy:hello"]);
			actions.repo = { ...actions.repo, verb_runtime: "actions" };
			const deps = {
				...h.deps,
				db,
				config: {
					...h.deps.config,
					repositories: h.deps.config.repositories.map((r) => ({
						...r,
						verb_runtime: "actions" as const,
					})),
				},
			};

			await runVerbControlSurfacePass(deps, [actions], NOW);
			// A re-observation must not dispatch again (forge_runs dedup).
			await runVerbControlSurfacePass(deps, [actions], NOW);

			expect(h.errors).toEqual([]);
			const dispatches = h.trace.filter((t) =>
				t.endsWith("/actions/workflows/verb.yml/dispatches"),
			);
			expect(dispatches).toHaveLength(1);
			expect(h.runner.allocations).toBe(0);
			const runs = await db.select().from(forgeRuns);
			expect(runs).toHaveLength(1);
			expect(runs[0]?.workflow).toBe("verb.yml");
			expect(runs[0]?.targetSha).toBe(K3S_HEAD);
		});
	});
});
