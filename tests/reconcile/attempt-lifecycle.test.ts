/**
 * Attempt lifecycle leaks. Three live receipts from 2026-08-02 drive these:
 *
 *  1. Attempt 158 was `failed` with `runner_vmid` NULL and `finished_at` NULL while
 *     TWO boxes carried its runner job id for ~6 hours — the watcher marked the
 *     attempt failed without ever persisting a placement, so the claim-scoped
 *     reaper had no vmid to act on.
 *  2. Attempt 179 stayed `submitted` / vmid 9001 / `finished_at` NULL after the
 *     RUNNING_MAX_MINUTES reclaim re-pended job 733 — while box 9001 was ALREADY
 *     running attempt 180 of a different job. The DB claimed one box for two
 *     attempts, and stray tooling keying on `submitted` + vmid would have reaped a
 *     LIVE box.
 *  3. Nothing bounded a stuck `submitted` attempt, so one whose job had moved on by
 *     any other path stayed in flight forever.
 *
 * These pin: the reclaim terminalizes the attempts it abandons; a legitimately
 * finishing attempt is never clobbered by either write; an orphan past the
 * submitted ceiling is terminalized while a young one and an OWNED one are left
 * alone; and NO box is ever touched by the orphan pass.
 *
 * MUTATION-PROVED (each assertion watched go red before being trusted):
 *  - dropped the `terminalizeAttemptsOfReclaimedJob` call from `rependStale` ->
 *    "reclaim terminalizes the attempt it abandons" fails (status stays submitted).
 *  - removed the `notInArray(status, TERMINAL)` guard from
 *    `terminalizeAttemptsOfReclaimedJob` -> "a completed attempt is never clobbered"
 *    fails (summary overwritten, `completed` lost).
 *  - flipped the orphan predicate `ne(activeAttemptId, id)` to `eq` -> "an attempt
 *    its job still OWNS is left alone" fails (the owned row is terminalized).
 *  - removed `lt(startedAt, cutoff)` -> "a YOUNG non-terminal attempt is untouched"
 *    fails (the fresh row is terminalized).
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, jobAttempts, jobs, repositories, runnerBoxes } from "../../src/db/schema";
import {
	ORPHANED_ATTEMPT_SUMMARY,
	RECLAIMED_ATTEMPT_SUMMARY,
	SUBMITTED_MAX_MINUTES,
	terminalizeOrphanedAttempts,
} from "../../src/reconcile/attempt-lifecycle";
import { RUNNING_MAX_MINUTES, reclaimStaleJobs } from "../../src/reconcile/dispatch-pass";
import { RUNNER_BOXES } from "../../src/runner/bands";
import type { RunnerAllocation, RunnerTransport } from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const NOW = new Date("2026-08-02T04:06:50.000Z");

/** A timestamp `minutes` before NOW. */
function ago(minutes: number): Date {
	return new Date(NOW.getTime() - minutes * 60_000);
}

/** A transport that RECORDS every reap, so "no box was touched" is an assertion. */
function reapRecordingTransport(): RunnerTransport & { doneVmids: number[] } {
	const doneVmids: number[] = [];
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
		doneVmids,
		needed: async (): Promise<RunnerAllocation> => ({ ok: false, refused: true, reason: "n/a" }),
		run: async () => {},
		list: async () => [],
		done: async (vmid: number) => {
			doneVmids.push(vmid);
		},
	};
}

/** Find-or-create the single managed repo so multi-seed tests reuse it. */
async function ensureRepo(db: TestDb): Promise<number> {
	const [existing] = await db
		.select({ id: repositories.id })
		.from(repositories)
		.where(eq(repositories.fullName, "rodaddy/x"));
	if (existing) return existing.id;
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", checks: "standard" })
		.returning();
	if (!repo) throw new Error("seed failed");
	return repo.id;
}

let itemSeq = 0;

/** Seed one job (with a joined open-PR item) in a given status and updatedAt. */
async function seedJob(db: TestDb, opts: { status: string; updatedAt: Date }): Promise<number> {
	const repoId = await ensureRepo(db);
	itemSeq += 1;
	const [item] = await db
		.insert(githubItems)
		.values({
			repositoryId: repoId,
			kind: "pull",
			number: itemSeq,
			state: "open",
			headSha: "abc123",
		})
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repoId,
			itemId: item?.id,
			sha: "abc123",
			jobType: "pr-review",
			status: opts.status,
			updatedAt: opts.updatedAt,
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return job.id;
}

/** Seed one attempt row and return its id. */
async function seedAttempt(
	db: TestDb,
	opts: {
		jobId: number;
		runnerJobId: string;
		vmid: number | null;
		status: string;
		startedAt: Date;
	},
): Promise<number> {
	const [attempt] = await db
		.insert(jobAttempts)
		.values({
			jobId: opts.jobId,
			runnerJobId: opts.runnerJobId,
			runnerVmid: opts.vmid,
			status: opts.status,
			startedAt: opts.startedAt,
		})
		.returning({ id: jobAttempts.id });
	if (!attempt) throw new Error("seed failed");
	return attempt.id;
}

/** Seed the stated box inventory; the migration creates the table empty. */
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

describe("#149 the two age ceilings cannot drift apart", () => {
	test("SUBMITTED_MAX_MINUTES equals the job reclaim's RUNNING_MAX_MINUTES", () => {
		// `attempt-lifecycle` states its ceiling literally rather than importing it,
		// to stay free of an import cycle with `dispatch-pass`. That duplication is
		// only safe while something asserts the two agree: if the job reclaim's
		// ceiling moved and this one did not, an attempt could be terminalized as an
		// orphan while its job was still legitimately running, or stay in flight long
		// after its job was taken away.
		expect(SUBMITTED_MAX_MINUTES).toBe(RUNNING_MAX_MINUTES);
	});
});

describe("#149 behaviour 1: reclaim terminalizes the attempt it abandons", () => {
	test("attempt 179's exact shape: a re-pended `running` job leaves NO attempt in `submitted`", async () => {
		await withTestDb(async (db) => {
			// Job 733 at the running ceiling, its attempt still `submitted` on box 9001.
			// Before this fix the reclaim re-pended the job and left the attempt exactly
			// like this — so the DB claimed 9001 for an attempt that was already dead,
			// while a live attempt ran on it.
			const jobId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES + 5),
			});
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-733",
				vmid: 9001,
				status: "submitted",
				startedAt: ago(RUNNING_MAX_MINUTES + 5),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary.runningRepended).toBe(1);
			expect(summary.attemptsTerminalized).toBe(1);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.status).toBe("failed");
			expect(attempt?.finishedAt).toEqual(NOW);
			expect(attempt?.failureSummary).toBe(RECLAIMED_ATTEMPT_SUMMARY);
			// The vmid is the row's only durable name and is NOT erased: the box side
			// reconciles on the BOX's own job id, never on the attempt's vmid.
			expect(attempt?.runnerVmid).toBe(9001);
		});
	});

	test("the `dispatching` branch terminalizes too (both branches, one implementation)", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJob(db, { status: "dispatching", updatedAt: ago(30) });
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-crashed",
				vmid: 9002,
				status: "submitted",
				startedAt: ago(30),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary.dispatchingRepended).toBe(1);
			expect(summary.attemptsTerminalized).toBe(1);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.status).toBe("failed");
		});
	});

	test("a legitimately COMPLETED attempt is never clobbered (status guard)", async () => {
		await withTestDb(async (db) => {
			// The race the guard defends: the attempt finished `completed` (a valid
			// result was ingested) before the reclaim's write landed. Overwriting it
			// would destroy the marker the #95 infra-requeue classification keys on and
			// would silently turn a verdict-class failure into an infra-class one.
			const jobId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES + 5),
			});
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-done",
				vmid: 9003,
				status: "completed",
				startedAt: ago(RUNNING_MAX_MINUTES + 5),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary.attemptsTerminalized).toBe(0);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.status).toBe("completed");
			expect(attempt?.failureSummary).toBeNull();
		});
	});

	test("a LOST job-status guard terminalizes nothing (no re-pend, no attempt write)", async () => {
		await withTestDb(async (db) => {
			// Selected as stale `running`, but the result store terminated it to
			// `completed` before the guarded release ran. Nothing was re-pended, so
			// nothing may be marked abandoned either.
			const jobId = await seedJob(db, {
				status: "completed",
				updatedAt: ago(RUNNING_MAX_MINUTES + 30),
			});
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-live",
				vmid: 9004,
				status: "submitted",
				// Young enough that the ORPHAN pass cannot claim it either, isolating
				// this assertion to the reclaim branch.
				startedAt: ago(1),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary.runningRepended).toBe(0);
			expect(summary.attemptsTerminalized).toBe(0);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.status).toBe("submitted");
			expect(attempt?.finishedAt).toBeNull();
		});
	});
});

describe("#149 behaviour 3: submitted-age reconciliation of orphaned attempts", () => {
	test("an attempt past the ceiling whose job has a DIFFERENT active attempt is terminalized", async () => {
		await withTestDb(async (db) => {
			// The stranded shape: the job moved on to a newer attempt, and the old row
			// kept claiming to be in flight with a vmid that now names someone else's box.
			const jobId = await seedJob(db, { status: "running", updatedAt: ago(1) });
			const stale = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-stranded",
				vmid: 9001,
				status: "submitted",
				startedAt: ago(SUBMITTED_MAX_MINUTES + 10),
			});
			const live = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-live",
				vmid: 9002,
				status: "submitted",
				startedAt: ago(1),
			});
			await db.update(jobs).set({ activeAttemptId: live }).where(eq(jobs.id, jobId));

			const terminalized = await terminalizeOrphanedAttempts(db, NOW);
			expect(terminalized).toBe(1);

			const [orphan] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, stale));
			expect(orphan?.status).toBe("failed");
			expect(orphan?.failureSummary).toBe(ORPHANED_ATTEMPT_SUMMARY);
			expect(orphan?.finishedAt).toEqual(NOW);

			// The job's CURRENT attempt is untouched — it is young and owned.
			const [current] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, live));
			expect(current?.status).toBe("submitted");
		});
	});

	test("an attempt its job still OWNS is left alone, however old", async () => {
		await withTestDb(async (db) => {
			// The result store's ownership-guarded terminal write may still be about to
			// land for this attempt. Terminalizing it would race that write and could
			// turn a real ingested result into a fabricated infra failure.
			const jobId = await seedJob(db, { status: "running", updatedAt: ago(1) });
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-owned",
				vmid: 9005,
				status: "submitted",
				startedAt: ago(SUBMITTED_MAX_MINUTES + 120),
			});
			await db.update(jobs).set({ activeAttemptId: attemptId }).where(eq(jobs.id, jobId));

			expect(await terminalizeOrphanedAttempts(db, NOW)).toBe(0);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.status).toBe("submitted");
			expect(attempt?.finishedAt).toBeNull();
		});
	});

	test("a YOUNG unowned attempt is untouched (never reconciles live in-flight work)", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJob(db, { status: "running", updatedAt: ago(1) });
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-young",
				vmid: 9006,
				status: "submitted",
				startedAt: ago(SUBMITTED_MAX_MINUTES - 10),
			});

			expect(await terminalizeOrphanedAttempts(db, NOW)).toBe(0);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.status).toBe("submitted");
		});
	});

	test("an attempt whose job has a NULL active attempt is terminalized", async () => {
		await withTestDb(async (db) => {
			// A re-pended job clears `activeAttemptId`, so an attempt left behind by any
			// path that did not go through the reclaim is caught here.
			const jobId = await seedJob(db, { status: "pending", updatedAt: ago(1) });
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-ownerless",
				vmid: 9007,
				status: "submitted",
				startedAt: ago(SUBMITTED_MAX_MINUTES + 5),
			});

			expect(await terminalizeOrphanedAttempts(db, NOW)).toBe(1);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.status).toBe("failed");
		});
	});

	test("NO box is touched and NO claim is released: this is DB hygiene only", async () => {
		await withTestDb(async (db) => {
			// The operational rule from the incident: an orphan's vmid may name a box
			// that is now running someone else's job (179's 9001 did). Reaping on it
			// would kill live work, so this pass must contact no fleet verb at all.
			await seedBoxes(db);
			const jobId = await seedJob(db, { status: "pending", updatedAt: ago(1) });
			await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-orphan",
				vmid: 9001,
				status: "submitted",
				startedAt: ago(SUBMITTED_MAX_MINUTES + 5),
			});
			// Box 9001 is held by a DIFFERENT, live job — exactly attempt 180's situation.
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-pr-review-715", heldAt: ago(2) })
				.where(eq(runnerBoxes.vmid, 9001));

			const transport = reapRecordingTransport();
			const summary = await reclaimStaleJobs(db, NOW, { transport });
			expect(summary.orphanAttemptsTerminalized).toBe(1);

			// No reap was issued for the orphan's vmid, and the live holder's claim stands.
			expect(transport.doneVmids).not.toContain(9001);
			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			expect(box?.heldByJobId).toBe("rw-pr-review-715");
		});
	});

	test("an already-terminal attempt is not rewritten by the orphan pass", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJob(db, { status: "failed", updatedAt: ago(1) });
			const attemptId = await seedAttempt(db, {
				jobId,
				runnerJobId: "rw-pr-review-terminal",
				vmid: 9008,
				status: "failed",
				startedAt: ago(SUBMITTED_MAX_MINUTES + 60),
			});
			await db
				.update(jobAttempts)
				.set({ failureSummary: "the original reason" })
				.where(eq(jobAttempts.id, attemptId));

			expect(await terminalizeOrphanedAttempts(db, NOW)).toBe(0);

			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.id, attemptId));
			expect(attempt?.failureSummary).toBe("the original reason");
		});
	});
});
