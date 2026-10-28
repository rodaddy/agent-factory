/**
 * Infra-class requeue regressions (RULED by the owner 2026-08-01). A terminal
 * `failed` job burns its (repo, item, sha, jobType) key forever: `createPendingJob`
 * deduplicates with `onConflictDoNothing`, so no sweep can re-queue that head after a
 * transient INFRA-class failure (expired credential, turn cap, box death before a valid
 * result landed). `requeueInfraFailedJobs` revives such a job to `pending` — but ONLY
 * when both:
 *
 *   (a) its failure is INFRA-class — the agent/harness never produced a VALID result.
 *       The result store records this STRUCTURALLY: an invalid/missing/unparseable/
 *       schema-invalid/ingest-rejected outcome finishes the owning attempt `failed`,
 *       while a VALID ingested result whose status is `failed` (a genuine review
 *       verdict) finishes the owning attempt `completed`. So a terminal-`failed` job is
 *       infra-class IFF none of its attempts reached `completed`.
 *   (b) fewer than INFRA_REQUEUE_BUDGET requeues have happened, derived from durable
 *       `job_attempts` rows (attemptCount = requeues + 1).
 *
 * These pin BOTH directions (a burned key CAN retry under the ruled condition and CANNOT
 * outside it — verdict-class or budget-exhausted), the #85 ownership reset (a revived job
 * has no owner), and the #91 seam (a revived job cannot become a candidate-loader row).
 *
 * The class gate and the budget gate are each written so a MUTATION reds a specific test:
 * treat every failure as infra (drop the completed-attempt check) reds the verdict-class
 * test; break the budget (raise/remove the cap) reds the exhaustion test.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, jobAttempts, jobs, repositories } from "../../src/db/schema";
import {
	INFRA_REQUEUE_BACKOFF_MINUTES,
	INFRA_REQUEUE_BUDGET,
	MAX_INFRA_REQUEUE_PER_PASS,
	requeueInfraFailedJobs,
} from "../../src/reconcile/dispatch-pass";
import { createCandidateLoader } from "../../src/results/proposal-pass";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { DbResultStore, IDENTITY_REJECTED_TERMINAL_REASON } from "../../src/results/store";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const NOW = new Date("2026-08-01T12:00:00.000Z");
const AT = new Date("2026-08-01T11:00:00.000Z");

let itemSeq = 0;

/** Seed a repo + a RUNNING job with a joined open-PR item and one owning attempt. */
async function seedRunningJob(
	db: TestDb,
	runnerJobId: string,
	opts: { sha?: string; itemNumber?: number } = {},
): Promise<{ jobId: number; attemptId: number }> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x" })
		.onConflictDoNothing()
		.returning();
	const repoId =
		repo?.id ??
		(
			await db
				.select({ id: repositories.id })
				.from(repositories)
				.where(eq(repositories.fullName, "rodaddy/x"))
		)[0]?.id;
	if (repoId === undefined) throw new Error("seed failed");
	itemSeq += 1;
	const sha = opts.sha ?? "deadbeef";
	const itemNumber = opts.itemNumber ?? itemSeq;
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repoId, kind: "pull", number: itemNumber, state: "open", headSha: sha })
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repoId,
			itemId: item?.id,
			sha,
			jobType: "pr-review",
			status: "running",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	const [attempt] = await db
		.insert(jobAttempts)
		.values({ jobId: job.id, runnerJobId, runnerVmid: 9001, status: "submitted" })
		.returning({ id: jobAttempts.id });
	if (!attempt) throw new Error("seed failed");
	// Mirror real dispatch: the attempt OWNS the running job, so the store's
	// ownership guard terminates it.
	await db.update(jobs).set({ activeAttemptId: attempt.id }).where(eq(jobs.id, job.id));
	return { jobId: job.id, attemptId: attempt.id };
}

/**
 * Drive the REAL result store to leave a terminal-`failed` job whose failure is
 * INFRA-class (an invalid ingest — no valid result). This exercises the exact persisted
 * state the classifier keys on, rather than hand-seeding statuses.
 */
async function terminalInfraFail(db: TestDb, runnerJobId: string): Promise<void> {
	const store = new DbResultStore(db, () => AT);
	await store.persist({
		jobRunnerId: runnerJobId,
		hostname: "host1",
		status: "invalid",
		reason: "runner agent failed before producing a result: agent-runtime-error",
	});
}

/** A valid result whose overall status is a genuine `failed` review verdict. */
function verdictFailedResult(itemNumber: number, sha: string): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: "pr-review",
		item_number: itemNumber,
		sha,
		status: "failed",
		checks: [],
		findings: [],
		output_path: "runners/jobs/rw/host/agent.log",
	};
}

describe("requeueInfraFailedJobs", () => {
	test("INFRA-class terminal fail under budget IS revived to pending (clears owner, sets backoff)", async () => {
		await withTestDb(async (db) => {
			const { jobId } = await seedRunningJob(db, "rw-infra-1");
			await terminalInfraFail(db, "rw-infra-1");

			// Precondition: the store left the job terminal `failed` with a `failed` attempt.
			const [before] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(before?.status).toBe("failed");
			expect(before?.terminalReason).toBeNull();
			const [att] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
			expect(att?.status).toBe("failed");

			const summary = await requeueInfraFailedJobs(db, NOW);
			expect(summary.requeued).toBe(1);

			const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(after?.status).toBe("pending");
			// #85: a pending job has no owner.
			expect(after?.activeAttemptId).toBeNull();
			// Bounded backoff, in the future so it does not re-dispatch on the very next sweep.
			expect(after?.nextAttemptAt?.getTime()).toBe(
				NOW.getTime() + INFRA_REQUEUE_BACKOFF_MINUTES * 60_000,
			);
			expect(after?.nextAttemptAt?.getTime()).toBeGreaterThan(NOW.getTime());
		});
	});

	test("DETERMINISTIC ingest rejection (identity invalid) is NEVER revived, even under budget", async () => {
		await withTestDb(async (db) => {
			const { jobId } = await seedRunningJob(db, "rw-identity-1", { itemNumber: 11 });
			// The runner returned a result whose identity does not match the dispatch
			// (the sf#375 shape: no item number). The store rejects it, and a retry would
			// produce the same payload, so the job must terminalize on this first attempt.
			const store = new DbResultStore(db, () => AT);
			const result = verdictFailedResult(11, "deadbeef");
			const decision = await store.persist({
				jobRunnerId: "rw-identity-1",
				hostname: "host1",
				status: "ingested",
				result: { ...result, status: "passed", item_number: undefined as unknown as number },
				outputPath: "runners/jobs/rw/host/agent.log",
			});
			expect(decision?.status).toBe("invalid");

			const [before] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(before?.status).toBe("failed");
			expect(before?.terminalReason).toBe(IDENTITY_REJECTED_TERMINAL_REASON);
			// Its one attempt is under INFRA_REQUEUE_BUDGET and never reached completed,
			// so WITHOUT the terminal reason this row is exactly the infra-class shape.
			const [att] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
			expect(att?.status).toBe("failed");

			const summary = await requeueInfraFailedJobs(db, NOW);
			expect(summary.requeued).toBe(0);
			const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(after?.status).toBe("failed");
		});
	});

	test("VERDICT-class terminal fail (a valid ingested result, status failed) is NEVER revived", async () => {
		await withTestDb(async (db) => {
			const { jobId } = await seedRunningJob(db, "rw-verdict-1", { itemNumber: 7 });
			// A VALID result whose status is `failed`: the store finishes the OWNING attempt
			// `completed` (a valid result was ingested) while the job goes `failed`.
			const store = new DbResultStore(db, () => AT);
			await store.persist({
				jobRunnerId: "rw-verdict-1",
				hostname: "host1",
				status: "ingested",
				result: verdictFailedResult(7, "deadbeef"),
				outputPath: "runners/jobs/rw/host/agent.log",
			});

			const [before] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(before?.status).toBe("failed");
			const [att] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
			// The discriminator: a completed attempt means a valid result was ingested.
			expect(att?.status).toBe("completed");

			const summary = await requeueInfraFailedJobs(db, NOW);
			// A genuine review verdict never requeues. This test REDS if the class gate is
			// broken (treating every terminal failure as infra-class).
			expect(summary.requeued).toBe(0);
			const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(after?.status).toBe("failed");
		});
	});

	test("budget EXHAUSTED: at INFRA_REQUEUE_BUDGET+1 attempts the infra-failed job is NOT revived", async () => {
		await withTestDb(async (db) => {
			const { jobId } = await seedRunningJob(db, "rw-budget-x");
			await terminalInfraFail(db, "rw-budget-x");
			// Simulate the prior requeues: each real dispatch writes one attempt row. One
			// attempt already exists (from seed), so add BUDGET more `failed` attempts to
			// reach BUDGET+1 total = one MORE than the budget allows.
			for (let i = 0; i < INFRA_REQUEUE_BUDGET; i++) {
				await db
					.insert(jobAttempts)
					.values({ jobId, runnerJobId: `rw-budget-x-${i}`, runnerVmid: 9001, status: "failed" });
			}
			const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
			expect(attempts.length).toBe(INFRA_REQUEUE_BUDGET + 1);

			const summary = await requeueInfraFailedJobs(db, NOW);
			// This test REDS if the budget gate is broken (raised/removed).
			expect(summary.requeued).toBe(0);
			const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(after?.status).toBe("failed");
		});
	});

	test("budget BOUNDARY: at exactly INFRA_REQUEUE_BUDGET attempts the job IS still revived", async () => {
		await withTestDb(async (db) => {
			const { jobId } = await seedRunningJob(db, "rw-boundary");
			await terminalInfraFail(db, "rw-boundary");
			// One attempt exists; add BUDGET-1 more `failed` attempts to reach BUDGET total —
			// the last requeue the budget permits (requeues so far = BUDGET-1 < BUDGET).
			for (let i = 0; i < INFRA_REQUEUE_BUDGET - 1; i++) {
				await db
					.insert(jobAttempts)
					.values({ jobId, runnerJobId: `rw-boundary-${i}`, runnerVmid: 9001, status: "failed" });
			}
			const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
			expect(attempts.length).toBe(INFRA_REQUEUE_BUDGET);

			const summary = await requeueInfraFailedJobs(db, NOW);
			expect(summary.requeued).toBe(1);
			const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(after?.status).toBe("pending");
		});
	});

	test("a revived infra-failed job canNOT become a candidate-loader row", async () => {
		await withTestDb(async (db) => {
			const { jobId } = await seedRunningJob(db, "rw-loader");
			await terminalInfraFail(db, "rw-loader");
			await requeueInfraFailedJobs(db, NOW);
			const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(after?.status).toBe("pending");

			// The candidate loader keys on jobs.status=completed + a completed attempt + an
			// accepted posting. A revived job is `pending` with no completed attempt and no
			// accepted posting, so it fabricates no eligibility — the loader returns nothing.
			const loader = createCandidateLoader(
				db,
				(jobRunnerId, hostname) => `runners/jobs/${jobRunnerId}/${hostname}/change.bundle`,
				async () => true,
			);
			const candidates = await loader(50);
			expect(candidates.length).toBe(0);
		});
	});

	test("a NON-terminal job (running) is never revived, however few attempts it has", async () => {
		await withTestDb(async (db) => {
			const { jobId } = await seedRunningJob(db, "rw-live");
			// Still running (no terminal result). The requeue must only ever touch `failed`.
			const summary = await requeueInfraFailedJobs(db, NOW);
			expect(summary.requeued).toBe(0);
			const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(after?.status).toBe("running");
		});
	});

	test("STARVATION: MAX_INFRA_REQUEUE_PER_PASS ineligible low-id fails do not hide a higher-id eligible one", async () => {
		await withTestDb(async (db) => {
			// Seed MAX_INFRA_REQUEUE_PER_PASS permanently-ineligible terminal-`failed` jobs at
			// the LOWEST ids: verdict-class (a valid ingested result, status failed — leaves a
			// `completed` attempt), which can NEVER requeue. If the per-pass cap were applied
			// over an id-ordered scan filtered afterward in JS, these would fill the window and
			// the eligible job below would never be reached.
			for (let i = 0; i < MAX_INFRA_REQUEUE_PER_PASS; i++) {
				const runnerJobId = `rw-starve-verdict-${i}`;
				const itemNumber = 1000 + i;
				await seedRunningJob(db, runnerJobId, { itemNumber });
				const store = new DbResultStore(db, () => AT);
				await store.persist({
					jobRunnerId: runnerJobId,
					hostname: "host1",
					status: "ingested",
					result: verdictFailedResult(itemNumber, "deadbeef"),
					outputPath: "runners/jobs/rw/host/agent.log",
				});
			}

			// ONE eligible infra-class failed job at a HIGHER id (seeded last), attempts all
			// `failed`, count within budget.
			const { jobId: eligibleId } = await seedRunningJob(db, "rw-starve-eligible", {
				itemNumber: 2000,
			});
			await terminalInfraFail(db, "rw-starve-eligible");

			const summary = await requeueInfraFailedJobs(db, NOW);
			// The SQL HAVING makes the window return ELIGIBLE rows only, so the eligible job is
			// reached and revived despite sitting behind 50 lower-id ineligible fails. This test
			// REDS if the eligibility predicates are removed from the query (the eligible job
			// stays `failed`).
			expect(summary.requeued).toBe(1);
			const [after] = await db.select().from(jobs).where(eq(jobs.id, eligibleId));
			expect(after?.status).toBe("pending");
		});
	});

	/**
	 * sf#302 (P2). VERB ROWS ARE NOT THIS SWEEP'S TO REVIVE.
	 *
	 * `selectDuePendingJobs` excludes verb types; this sibling sweep did not, and
	 * the two exclusions have to agree. A verb row the verb lane deliberately left
	 * terminal is `failed` with a NULL `terminalReason` and infra-class attempts —
	 * exactly this sweep's eligibility shape — so the generic infra sweep revived
	 * those rows to `pending` and they dispatched: a sustained loop converged at 7
	 * boxes against the stated 4. `verb-live.ts` does not re-run a terminal tuple
	 * at all, so a revive here manufactures a re-run the owning lane declined.
	 *
	 * The two directions are pinned in ONE test so the filter cannot be satisfied by
	 * simply disabling the sweep: the verb row must be left alone AND the non-verb
	 * infra failure beside it must still be revived.
	 *
	 * MUTATION: delete `notInArray(jobs.jobType, [...VERB_IDS])` from
	 * `requeueInfraFailedJobs`'s `.where()` and the verb assertion REDS
	 * (`summary.requeued` becomes 2 and the verb row flips to `pending`).
	 */
	test("does NOT revive a verb row, while a non-verb infra failure beside it still IS", async () => {
		await withTestDb(async (db) => {
			// A rekeyed historical verb row, in the exact state the verb lane leaves
			// behind: terminal `failed`, no terminal reason, one `failed` attempt.
			const { jobId: verbJobId } = await seedRunningJob(db, "rw-verb-1", { itemNumber: 3000 });
			await db.update(jobs).set({ jobType: "newapp" }).where(eq(jobs.id, verbJobId));
			await terminalInfraFail(db, "rw-verb-1");

			// A normal agent-lane infra failure, which this sweep DOES own.
			const { jobId: reviewJobId } = await seedRunningJob(db, "rw-review-1", {
				itemNumber: 3001,
			});
			await terminalInfraFail(db, "rw-review-1");

			// Precondition: both rows are eligible on every pre-existing predicate, so
			// the ONLY thing that can separate them is the job-type filter.
			const seeded = await db.select().from(jobs).where(eq(jobs.status, "failed"));
			expect(seeded.filter((row) => row.terminalReason === null)).toHaveLength(2);

			const summary = await requeueInfraFailedJobs(db, NOW);

			expect(summary.requeued).toBe(1);
			const [verbAfter] = await db.select().from(jobs).where(eq(jobs.id, verbJobId));
			// THE LOAD-BEARING ASSERTION: the verb row is untouched, so the verb lane's
			// own give-up is the only thing that can ever re-pend it.
			expect(verbAfter?.status).toBe("failed");
			const [reviewAfter] = await db.select().from(jobs).where(eq(jobs.id, reviewJobId));
			expect(reviewAfter?.status).toBe("pending");
		});
	});
});
