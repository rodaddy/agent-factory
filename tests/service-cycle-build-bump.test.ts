/**
 * The build-bump BUILD pass is wired into the reconcile cycle.
 *
 * `runBuildBumpBuild` existing and being correct proves nothing about the daemon
 * running it — a pass nothing calls is dead code that every unit test passes. This
 * drives the REAL `createReconcileCycle` closure over a real scratch database with
 * a fake Jobs client, and asserts the cycle both REACHES the build pass and reaches
 * it in the contracted position: after the intake step, before dispatch.
 *
 * The ordering half is asserted from a single call log shared by the kube fake and
 * the transport fake, so moving the step below `dispatchPendingJobs` goes red on the
 * ORDER rather than on a count that a re-ordered cycle would still satisfy.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../src/config/schema";
import { buildBumpCandidates, githubItems, jobs, repositories } from "../src/db/schema";
import type { ForgeRegistry } from "../src/forge/registry";
import type { GitHubPublisher } from "../src/github/publish";
import type { KubeJob, KubeJobsClient, KubeResult } from "../src/imagebuild/kube";
import type { BodyLandingStager } from "../src/prepush/stage";
import type { ProposalPassDeps } from "../src/results/proposal-pass";
import type { ResultReconciler } from "../src/results/reconcile";
import type { RunnerTransport } from "../src/runner/transport";
import { createReconcileCycle, type ReconcileCycleDeps } from "../src/service-cycle";
import { withTestDb } from "./db/helpers";

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

const REPO = "rodaddy/widget";
const IMAGE = "widget";
const TAG = "v1.2.3";
const SHA = "a".repeat(40);

/**
 * A config with NO managed repositories and NO `build_bump` block, so the sweep
 * and the intake step are both no-ops. This test asserts the BUILD step is
 * reached; seeding the candidate directly keeps intake's forge reads out of it.
 */
function config(repositories: WatcherConfig["repositories"] = []): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories,
		job_templates: [{ id: "pr-review", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
	} as WatcherConfig;
}

/** The one managed repository the dispatch-ordering test's seeded job belongs to. */
const DISPATCH_REPO = {
	name: "rodaddy/x",
	provider: "github",
	checks: "standard",
	gate_selection: "full",
} as WatcherConfig["repositories"][number];

/** Seed one dispatchable pending `pr-review` job, the shape dispatch-pass tests use. */
async function seedPendingJob(db: Db): Promise<void> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", checks: "standard" })
		.returning();
	if (!repo) throw new Error("seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "pull", number: 42, state: "open", headSha: "abc123" })
		.returning();
	await db.insert(jobs).values({
		repositoryId: repo.id,
		itemId: item?.id,
		sha: "abc123",
		jobType: "pr-review",
		status: "pending",
	});
}

/** A Jobs client that records its calls and reports an empty adoption list. */
function fakeKube(log: string[]): KubeJobsClient {
	const job = (name: string): KubeJob =>
		({ metadata: { name, namespace: "image-builds" }, status: {} }) as unknown as KubeJob;
	return {
		async listJobs(): Promise<KubeResult<KubeJob[]>> {
			log.push("kube.listJobs");
			return { ok: true, job: [] } as unknown as KubeResult<KubeJob[]>;
		},
		async createJob(): Promise<KubeResult<KubeJob>> {
			log.push("kube.createJob");
			return { ok: true, job: job("build-widget-abc") } as unknown as KubeResult<KubeJob>;
		},
		async getJob(): Promise<KubeResult<KubeJob>> {
			log.push("kube.getJob");
			return { ok: false, status: 404, reason: "not found" } as unknown as KubeResult<KubeJob>;
		},
	};
}

/**
 * A transport whose only job here is to mark WHEN dispatch ran. `dispatchPendingJobs`
 * reaches it only if there is a pending job; with none, the marker comes from the
 * cycle's own ordering instead — so the log below records dispatch through a
 * `needed()` probe the dispatch pass makes unconditionally.
 */
function fakeTransport(log: string[]): RunnerTransport {
	return {
		async needed() {
			log.push("dispatch.needed");
			return null;
		},
		async run() {
			throw new Error("unexpected run");
		},
		async done() {
			throw new Error("unexpected done");
		},
		async list() {
			return [];
		},
	} as unknown as RunnerTransport;
}

function deps(db: Db, kube: KubeJobsClient | null, log: string[]): ReconcileCycleDeps {
	return {
		db,
		config: config(),
		registry: {} as ForgeRegistry,
		transport: fakeTransport(log),
		publisher: { run: async () => [] } as unknown as GitHubPublisher,
		resultReconciler: { run: async () => {} } as unknown as ResultReconciler,
		proposalDeps: {} as ProposalPassDeps,
		bodyLandingStager: {} as BodyLandingStager,
		kboardClient: null,
		shadow: true,
		infraGateSelector: (() => []) as unknown as ReconcileCycleDeps["infraGateSelector"],
		clientFor: async () => null,
		kubeJobs: kube,
		// The bump seam is off by default here; the step-9 test below supplies a
		// recording one so the ORDER relative to the build step is assertable.
		buildBump: { bump: null, scriptPath: "", workdirRoot: "" },
		onError: (e) => {
			throw e;
		},
	};
}

describe("the reconcile cycle runs the build-bump build pass", () => {
	test("THE IMPORTANT ONE: a pending candidate is started by one cycle", async () => {
		await withTestDb(async (db) => {
			await db
				.insert(buildBumpCandidates)
				.values({ repository: REPO, image: IMAGE, tag: TAG, sha: SHA });
			const log: string[] = [];
			const cycle = createReconcileCycle(deps(db, fakeKube(log), log));

			await cycle.run();

			// The pass adopts-then-creates, so both calls prove it ran on this row.
			expect(log).toContain("kube.listJobs");
			expect(log).toContain("kube.createJob");
			const [row] = await db
				.select()
				.from(buildBumpCandidates)
				.where(eq(buildBumpCandidates.repository, REPO));
			expect(row?.status).toBe("building");
			expect(row?.buildJobName).toBe("build-widget-abc");
		});
	});

	test("the build step runs BEFORE dispatch, not after it", async () => {
		await withTestDb(async (db) => {
			await db
				.insert(buildBumpCandidates)
				.values({ repository: REPO, image: IMAGE, tag: TAG, sha: SHA });
			await seedPendingJob(db);
			const log: string[] = [];
			const cycle = createReconcileCycle(
				// A config carrying the seeded job's repository, so `dispatchPendingJobs`
				// finds it managed and REACHES the transport — without a due dispatchable
				// job the transport is never touched and this assertion is vacuous.
				{ ...deps(db, fakeKube(log), log), config: config([DISPATCH_REPO]) },
			);

			await cycle.run();

			const create = log.indexOf("kube.createJob");
			const dispatch = log.indexOf("dispatch.needed");
			// Both markers must be PRESENT: a vacuous ordering assertion is the trap
			// this pair exists to close.
			expect(create).toBeGreaterThanOrEqual(0);
			expect(dispatch).toBeGreaterThanOrEqual(0);
			// A cycle with the step moved after `dispatchPendingJobs` satisfies every
			// count assertion above and fails only here.
			expect(create).toBeLessThan(dispatch);
		});
	});

	test("the bump step runs IMMEDIATELY AFTER the build step", async () => {
		await withTestDb(async (db) => {
			// `built` already, so the bump pass has work on the very first cycle while
			// the build pass drives a second, pending candidate.
			await db
				.insert(buildBumpCandidates)
				.values({ repository: REPO, image: IMAGE, tag: TAG, sha: SHA, status: "built" });
			await db
				.insert(buildBumpCandidates)
				.values({ repository: REPO, image: IMAGE, tag: "v9.9.9", sha: SHA, status: "pending" });
			const log: string[] = [];
			const cfg = config([
				{
					name: REPO,
					provider: "forgejo",
					checks: "static-only",
					gate_selection: "full",
					build_bump: {
						environments: [{ name: "live", app_dirs: ["landing"] }],
						tag_pattern: "v*",
					},
				} as unknown as WatcherConfig["repositories"][number],
			]);
			const base = deps(db, fakeKube(log), log);
			const cycle = createReconcileCycle({
				...base,
				config: cfg,
				// Intake reads the forge; no client means the repository is skipped, so
				// this test exercises the build and bump steps only.
				buildBump: {
					bump: async () => {
						log.push("bump.invoke");
						return { kind: "refused", reason: "ALREADY_AT_TAG" };
					},
					scriptPath: "/nonexistent/open-bump-pr.sh",
					workdirRoot: "/nonexistent/work",
				},
			});

			await cycle.run();

			const build = log.indexOf("kube.createJob");
			const bump = log.indexOf("bump.invoke");
			expect(build).toBeGreaterThanOrEqual(0);
			expect(bump).toBeGreaterThanOrEqual(0);
			// A cycle with step 9 moved above step 8 fails only here.
			expect(build).toBeLessThan(bump);
		});
	});

	test("a null kube client leaves the row untouched rather than throwing", async () => {
		await withTestDb(async (db) => {
			await db
				.insert(buildBumpCandidates)
				.values({ repository: REPO, image: IMAGE, tag: TAG, sha: SHA });
			const log: string[] = [];

			await createReconcileCycle(deps(db, null, log)).run();

			const [row] = await db
				.select()
				.from(buildBumpCandidates)
				.where(eq(buildBumpCandidates.repository, REPO));
			expect(row?.status).toBe("pending");
		});
	});
});
