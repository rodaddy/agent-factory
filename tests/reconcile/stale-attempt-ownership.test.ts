/**
 * Stale-attempt ownership regression. Job state transitions were guarded by
 * job id and current STATUS, never by which ATTEMPT owns the job — and status is
 * not a sufficient guard once the reclaimer can re-pend a stalled attempt's
 * job and a newer attempt can then claim it. A late write from the stale attempt
 * satisfies a status guard perfectly while acting on a job it no longer owns:
 *
 *   1. A dispatches; job `pending -> running`, owned by A.
 *   2. A stalls past the stale threshold.
 *   3. `reclaimStaleJobs` re-pends the job (clearing the owner) — correct, by design.
 *   4. B claims + dispatches; job `running`, owned by B.
 *   5. A finally returns (fails, or lands a result).
 *
 * These pin that step 5 cannot touch B's live job: a stale release matches zero
 * rows (dispatch's `active_attempt_id`-scoped release), and a stale result neither
 * terminates B's job (store's ownership guard) nor starts a third dispatch. The
 * persisted `jobs.active_attempt_id` marker is the ownership fact all three writes
 * key on, set atomically at dispatch and cleared on every re-pend.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { JobTemplateConfig, WatcherConfig } from "../../src/config/schema";
import { githubItems, jobAttempts, jobs, repositories, runnerBoxes } from "../../src/db/schema";
import {
	DISPATCHING_STALE_MINUTES,
	dispatchPendingJobs,
	reclaimStaleJobs,
} from "../../src/reconcile/dispatch-pass";
import type { PersistedResult } from "../../src/results/ingest";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { DbResultStore } from "../../src/results/store";
import { RUNNER_BOXES } from "../../src/runner/bands";
import { dispatchJob } from "../../src/runner/dispatch";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const template: JobTemplateConfig = {
	id: "pr-review",
	label: "PR review",
	runner_size: "medium",
	return_mode: "patch",
};

function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/x", provider: "github", checks: "standard", gate_selection: "full" },
		],
		job_templates: [{ id: "pr-review", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
	};
}

/** A transport that allocates a specified vmid and records every run. */
function fakeTransport(vmid: number): RunnerTransport & { ran: RunnerRunParams[] } {
	const ran: RunnerRunParams[] = [];
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
		ran,
		needed: async (): Promise<RunnerAllocation> => ({
			ok: true,
			boxes: [{ vmid, size: "medium" }],
		}),
		run: async (p: RunnerRunParams) => {
			ran.push(p);
		},
		list: async () => [],
		done: async () => {},
	};
}

async function seedBoxes(db: TestDb) {
	await db.insert(runnerBoxes).values(
		RUNNER_BOXES.map((box) => ({
			vmid: box.vmid,
			band: box.band,
			mac: box.mac,
			ip: box.ip,
			allocatable: box.allocatable,
		})),
	);
}

/** Seed a repo + open-PR item; return a DispatchableJob for the pending job. */
async function seedPendingJob(db: TestDb) {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "pull", number: 7, state: "open", headSha: "deadbeef" })
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha: "deadbeef",
			jobType: "pr-review",
			status: "pending",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return { ...job, repository: "rodaddy/x", provider: "github" as const, itemNumber: 7 };
}

const passingResult: RunnerResult = {
	result_version: RESULT_VERSION,
	repository: "rodaddy/x",
	job_type: "pr-review",
	item_number: 7,
	sha: "deadbeef",
	status: "passed",
	checks: [],
	findings: [],
	output_path: "runners/jobs/rw/host/agent.log",
};

const NOW = new Date("2026-07-20T12:00:00.000Z");
function ago(minutes: number): Date {
	return new Date(NOW.getTime() - minutes * 60_000);
}

describe("#85 stale-attempt ownership", () => {
	test("full interleaving: A dispatches, is reclaimed, B dispatches, A's result cannot terminate B's job or start a third dispatch", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedPendingJob(db);

			// (1) A dispatches onto 9001. Job -> running, owned by attempt A.
			const outcomeA = await dispatchJob({
				db,
				transport: fakeTransport(9001),
				job,
				template,
				retryMinutes: 15,
				now: ago(60),
			});
			expect(outcomeA.status).toBe("dispatched");
			const [afterA] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(afterA?.status).toBe("running");
			const attemptAId = afterA?.activeAttemptId;
			expect(attemptAId).not.toBeNull();

			// (2)+(3) A stalls; the reclaimer re-pends the stale `running` job. Age it
			// past the running ceiling so the reclaimer picks it up, then reclaim clears
			// ownership so the row is claimable exactly once.
			await db
				.update(jobs)
				.set({ updatedAt: ago(90) })
				.where(eq(jobs.id, job.id));
			const reclaimed = await reclaimStaleJobs(db, NOW);
			expect(reclaimed.runningRepended).toBe(1);
			const [rePended] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(rePended?.status).toBe("pending");
			// The ownership marker is cleared, so B can claim cleanly.
			expect(rePended?.activeAttemptId).toBeNull();

			// (4) B dispatches (a fresh pass) onto 9002. Job -> running, owned by B.
			const tB = fakeTransport(9002);
			const passB = await dispatchPendingJobs(db, tB, config(), { now: NOW });
			expect(passB.dispatched).toBe(1);
			const [afterB] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(afterB?.status).toBe("running");
			const attemptBId = afterB?.activeAttemptId;
			expect(attemptBId).not.toBeNull();
			expect(attemptBId).not.toBe(attemptAId);

			// (5) A's original result finally lands. It must NOT terminate B's live job.
			const store = new DbResultStore(db, () => NOW);
			const recordA: PersistedResult = {
				jobRunnerId: (await attemptRunnerJobId(db, attemptAId ?? 0)) ?? "",
				hostname: "host-a",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			};
			await store.persist(recordA);

			// B's job is untouched: still running, still owned by B.
			const [afterStale] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(afterStale?.status).toBe("running");
			expect(afterStale?.activeAttemptId).toBe(attemptBId ?? -1);

			// And no third dispatch starts: the job is running (not pending), so a pass
			// selects nothing to dispatch.
			const passThird = await dispatchPendingJobs(db, fakeTransport(9003), config(), { now: NOW });
			expect(passThird.dispatched).toBe(0);
		});
	});

	test("reclaim sets the ownership marker so the re-pended job is claimable exactly once", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedPendingJob(db);
			// A owns the job, then it goes stale in `dispatching` (crashed before running).
			await dispatchJob({
				db,
				transport: fakeTransport(9001),
				job,
				template,
				retryMinutes: 15,
				now: ago(60),
			});
			await db
				.update(jobs)
				.set({ status: "dispatching", updatedAt: ago(DISPATCHING_STALE_MINUTES + 30) })
				.where(eq(jobs.id, job.id));

			await reclaimStaleJobs(db, NOW);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending");
			expect(row?.activeAttemptId).toBeNull();

			// Exactly one concurrent claim wins, and it takes ownership.
			const t = fakeTransport(9002);
			const [a, b] = await Promise.all([
				dispatchPendingJobs(db, t, config(), { now: NOW }),
				dispatchPendingJobs(db, t, config(), { now: NOW }),
			]);
			expect(a.dispatched + b.dispatched).toBe(1);
			const [claimed] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(claimed?.status).toBe("running");
			expect(claimed?.activeAttemptId).not.toBeNull();
		});
	});
});

/** Read the runner job id recorded for an attempt id. */
async function attemptRunnerJobId(db: TestDb, attemptId: number): Promise<string | null> {
	const [row] = await db
		.select({ runnerJobId: jobAttempts.runnerJobId })
		.from(jobAttempts)
		.where(eq(jobAttempts.id, attemptId))
		.limit(1);
	return row?.runnerJobId ?? null;
}
