/**
 * @module tests/service-event-rail
 * @description The sf#1076 event-rail wiring (rows 0c/0d): the reconcile cycle
 *   runs the bump merge watch, and `startService` hands the scheduler a
 *   `followThrough` that answers 20 s while the build-bump rail is in flight.
 *   DB-backed; `readPull` is a recording fake, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { WatcherConfig } from "../src/config/schema";
import { buildBumpBumps, buildBumpCandidates } from "../src/db/schema";
import type { ForgeRegistry } from "../src/forge/registry";
import type { PullRequestMergeState } from "../src/forgejo/pull-state";
import type { GitHubPublisher } from "../src/github/publish";
import type { BodyLandingStager } from "../src/prepush/stage";
import type { MergeWatchDeps } from "../src/reconcile/build-bump-merge-watch";
import type { PassResult } from "../src/reconcile/pass";
import { Scheduler } from "../src/reconcile/scheduler";
import type { ProposalPassDeps } from "../src/results/proposal-pass";
import type { ResultReconciler } from "../src/results/reconcile";
import type { RunnerTransport } from "../src/runner/transport";
import { startService } from "../src/service";
import { createReconcileCycle, type ReconcileCycleDeps } from "../src/service-cycle";
import { withTestDb } from "./db/helpers";
import { testTmpBase } from "./support/test-temp";

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

const OPEN: PullRequestMergeState = {
	merged: false,
	mergeCommitSha: null,
	state: "open",
	mergedAt: null,
};

function cycleDeps(db: Db, bumpMergeWatch: MergeWatchDeps | null): ReconcileCycleDeps {
	return {
		db,
		config: {
			poll_interval_minutes: 15,
			repositories: [],
			job_templates: [],
			doorbell_enabled: false,
			shadow_publish: false,
		} as WatcherConfig,
		registry: {} as ForgeRegistry,
		transport: {
			needed: async () => null,
			list: async () => [],
		} as unknown as RunnerTransport,
		publisher: { run: async () => [] } as unknown as GitHubPublisher,
		resultReconciler: { run: async () => {} } as unknown as ResultReconciler,
		proposalDeps: {} as ProposalPassDeps,
		bodyLandingStager: {} as BodyLandingStager,
		kboardClient: null,
		shadow: true,
		infraGateSelector: (() => []) as unknown as ReconcileCycleDeps["infraGateSelector"],
		clientFor: async () => null,
		kubeJobs: null,
		buildBump: { bump: null, scriptPath: "", workdirRoot: "" },
		bumpMergeWatch,
		onError: (e) => {
			throw e;
		},
	};
}

async function seedCandidate(db: Db, status: string, buildStartedAt: Date | null) {
	const [row] = await db
		.insert(buildBumpCandidates)
		.values({
			repository: "o/r",
			image: "r",
			tag: "v1.0.0",
			sha: "d".repeat(40),
			status,
			buildStartedAt,
		})
		.returning({ id: buildBumpCandidates.id });
	if (!row) throw new Error("seed insert returned no row");
	return row.id;
}

describe("the reconcile cycle runs the bump merge watch", () => {
	test("an opened bump PR is read by one cycle", async () => {
		await withTestDb(async (db) => {
			const candidateId = await seedCandidate(db, "bumped", null);
			await db
				.insert(buildBumpBumps)
				.values({ candidateId, appDir: "widget", status: "opened", pr: 77, settledAt: new Date() });
			const reads: number[] = [];
			const watch: MergeWatchDeps = {
				readPull: async (pr) => {
					reads.push(pr);
					return OPEN;
				},
				refreshArgo: null,
				now: () => new Date(),
			};
			await createReconcileCycle(cycleDeps(db, watch)).run();
			expect(reads).toEqual([77]);
		});
	});

	test("bumpMergeWatch null skips the step and the cycle completes", async () => {
		await withTestDb(async (db) => {
			const candidateId = await seedCandidate(db, "bumped", null);
			await db
				.insert(buildBumpBumps)
				.values({ candidateId, appDir: "widget", status: "opened", pr: 77, settledAt: new Date() });
			const result = await createReconcileCycle(cycleDeps(db, null)).run();
			expect(result.failCount).toBe(0);
		});
	});
});

describe("startService wires the scheduler follow-through", () => {
	const KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
		"ARGOCD_TOKEN",
	] as const;
	const saved: Record<string, string | undefined> = {};

	afterEach(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	async function captureFollowThrough(
		db: Db,
	): Promise<{ followThrough: unknown; stop: () => Promise<void> }> {
		for (const key of KEYS) saved[key] = process.env[key];
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		for (const key of KEYS.slice(1)) if (key !== "GITHUB_TOKEN") delete process.env[key];
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-event-rail-work");
		const configPath = join(testTmpBase(), `event-rail-${crypto.randomUUID()}.yml`);
		await Bun.write(
			configPath,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"doorbell_enabled: false",
				"",
			].join("\n"),
		);
		let followThrough: unknown;
		const handle = await startService({
			configPath,
			createDb: () => ({ db, client: {} }),
			startStatusServer: (() => ({
				hostname: "127.0.0.1",
				port: 0,
				stop: async () => {},
			})) as never,
			createScheduler: ((opts: ConstructorParameters<typeof Scheduler>[0]) => {
				followThrough = opts.followThrough;
				return new Scheduler({
					...opts,
					run: async (): Promise<PassResult> => ({
						startedAt: new Date().toISOString(),
						durationMs: 0,
						repositories: [],
						okCount: 0,
						failCount: 0,
					}),
					followThrough: undefined,
					setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
					clearInterval: () => {},
				});
			}) as never,
		});
		return { followThrough, stop: handle.stop };
	}

	test("a building candidate started now resolves 20_000", async () => {
		await withTestDb(async (db) => {
			await seedCandidate(db, "building", new Date());
			const { followThrough, stop } = await captureFollowThrough(db);
			try {
				expect(typeof followThrough).toBe("function");
				expect(await (followThrough as () => Promise<number | null>)()).toBe(20_000);
			} finally {
				await stop();
			}
		});
	});

	test("with nothing in flight it resolves null", async () => {
		await withTestDb(async (db) => {
			const { followThrough, stop } = await captureFollowThrough(db);
			try {
				expect(typeof followThrough).toBe("function");
				expect(await (followThrough as () => Promise<number | null>)()).toBeNull();
			} finally {
				await stop();
			}
		});
	});
});
