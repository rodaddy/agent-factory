/**
 * @module reconcile/attempt-lifecycle
 * @description Keep `job_attempts` rows telling the truth about whether they are
 *   still in flight.
 *
 *   An attempt row is the factory's only durable record of what a dispatch did:
 *   which box it placed, whether it finished, and why it did not. Two live leaks
 *   on 2026-08-02 proved the row could outlive the fact it described.
 *
 *   1. **Reclaim left the attempt behind.** After the running-ceiling reclaim
 *      re-pended job 733 at 04:06:50, attempt 179 stayed `submitted` / vmid 9001 /
 *      `finished_at` NULL — while box 9001 was ALREADY running attempt 180 of a
 *      different job. The DB claimed one box for two attempts, and any tooling
 *      keying stray detection on `submitted` + vmid would have reaped a LIVE box.
 *   2. **Nothing ever reconciled a stranded attempt.** An attempt whose job moved
 *      on by some other path had no bound of its own and stayed `submitted`
 *      forever.
 *
 *   Both are fixed here, at the boundary that owns attempt-row state, and BOTH ARE
 *   DB HYGIENE ONLY. No fleet verb is called and no box is reaped: an attempt's
 *   vmid may name a box that now belongs to someone else (179's vmid 9001 did), so
 *   the vmid is left untouched as the row's only durable name. The incident's own
 *   rule stands — strays reconcile on the BOX's job id, never on an attempt's vmid.
 *   The box side belongs to `releaseReclaimedBox` and the fleet list.
 *
 *   Every write is bounded, status-guarded on the attempt still being NON-TERMINAL
 *   (so a legitimately-finishing attempt is never clobbered — including the
 *   `completed` marker the #95 infra-requeue classification depends on), and
 *   announced with a named warn.
 *
 * @outputs
 *   - `terminalizeAttemptsOfReclaimedJob` -- finish the attempts a re-pend abandons
 *   - `terminalizeOrphanedAttempts` -- finish attempts their job can no longer finish
 *   - `TERMINAL_ATTEMPT_STATUSES` / `SUBMITTED_MAX_MINUTES` -- the shared bounds
 *
 * @dependencies
 *   - drizzle-orm -- the status-guarded attempt writes
 *   - ../db/schema -- job_attempts / jobs
 *   - ../log -- the named warn each correcting write emits
 */
import { and, asc, eq, inArray, isNull, lt, ne, notInArray, or } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { jobAttempts, jobs } from "../db/schema";
import { log, traced } from "../log";
import { addMinutes } from "../runner/dispatch";

/**
 * The attempt statuses that are TERMINAL. An attempt outside this set is still in
 * flight and may legitimately be finishing right now, so every write in this module
 * is guarded on the row still being outside it — a legitimately-finishing attempt is
 * never clobbered.
 */
export const TERMINAL_ATTEMPT_STATUSES = ["completed", "failed"] as const;

/**
 * Age (minutes) past which an attempt still in a non-terminal status is a candidate
 * for the orphan reconciliation.
 *
 * Deliberately EQUAL to `RUNNING_MAX_MINUTES`, the dispatch pass's own running
 * ceiling: an attempt cannot be older than its job's running ceiling and still be
 * legitimately in flight, since the job reclaim takes the job away at exactly that
 * age. The value is stated here rather than imported to keep this module free of an
 * import cycle with `dispatch-pass` (which imports this one), and
 * `tests/reconcile/attempt-lifecycle.test.ts` asserts the two equal so the
 * duplication can never drift into a disagreement about what "too old to be live"
 * means.
 */
export const SUBMITTED_MAX_MINUTES = 60;

/** Cap on orphaned attempt rows terminalized per sweep. Mirrors the reclaim's own cap. */
export const MAX_ORPHAN_ATTEMPTS_PER_PASS = 50;

/**
 * The bounded summary written on an attempt the JOB reclaim abandoned.
 * Attempt 179's row would have carried this.
 */
export const RECLAIMED_ATTEMPT_SUMMARY =
	"reclaimed: runner exceeded the running ceiling with no result; the job was re-pended for a fresh attempt";

/**
 * The bounded summary written on an attempt whose JOB can no longer finish it.
 * Distinct from {@link RECLAIMED_ATTEMPT_SUMMARY} so the two causes stay
 * separable in the row: this one was not abandoned by THIS sweep's reclaim, it was
 * left behind by an earlier path and found stranded.
 */
export const ORPHANED_ATTEMPT_SUMMARY =
	"orphaned: no longer the owning attempt of its job and past the submitted-age ceiling; terminalized by reconciliation, box not touched";

/**
 * The bounded summary written on the last in-flight attempt of a job STOPPED for
 * exhausting the ceiling-reclaim budget.
 *
 * Distinct from {@link RECLAIMED_ATTEMPT_SUMMARY} because the two describe opposite
 * outcomes for the job that owned the attempt: that one was re-pended for a fresh
 * try, this one is over. Job 1547 wrote the re-pend summary ~40 times, and every
 * copy of it truthfully said the job would be retried — which is precisely why
 * nothing looked wrong. The give-up needs to read differently from the retry.
 */
export const CEILING_EXHAUSTED_ATTEMPT_SUMMARY =
	"reclaimed: runner exceeded the running ceiling with no result; the job exhausted its ceiling-reclaim budget and was terminal-failed, NOT re-pended";

/** An isolated per-write failure sink, so one bad row never aborts a reclaim cycle. */
export type AttemptLifecycleOpts = { onError?: (error: unknown) => void };

/**
 * Invoke the caller's error sink without ever letting it abort the cycle. Mirrors
 * the dispatch pass's own `reportError`: a monitoring sink is untrusted, and a
 * throw from it must not take down the reclaim.
 */
function reportError(onError: AttemptLifecycleOpts["onError"], error: unknown): void {
	try {
		onError?.(error);
	} catch {
		// Nothing safe to do with a logging-sink failure; the write failure it was
		// handed is the operator-visible one and was already reported to it.
	}
}

/**
 * TERMINALIZE THE ATTEMPTS A RE-PEND ABANDONS (behaviour 1).
 *
 * Re-pending a job takes it away from whichever attempt held it, but the attempt
 * ROW was previously left exactly as it was — `submitted`, carrying a vmid, with a
 * null `finished_at`. That is attempt 179: the row kept claiming to be in flight on
 * a box that had already moved on to someone else's work.
 *
 * STATUS-GUARDED on the attempt being NON-TERMINAL, for the same reason every other
 * write in this codebase is guarded: an attempt that reached `completed` or `failed`
 * between the re-pend and this write finished legitimately, and overwriting it would
 * destroy a real result's record — including the `completed` marker the #95
 * infra-requeue classification keys on. The guard makes this write unable to touch it.
 *
 * The vmid is left UNTOUCHED and no box is contacted. This is DB hygiene: it makes
 * the row stop claiming to be in flight, nothing more.
 *
 * Best-effort and non-throwing, for the same reason the box release is: a job that
 * has been re-pended must not be un-re-pended because a bookkeeping write failed.
 *
 * @param db - watcher database
 * @param jobId - the job whose in-flight attempt rows are being finished
 * @param now - the write's own clock; what lands in `finished_at`
 * @param opts - isolated error sink for a failed write
 * @returns how many attempt rows this call actually terminalized
 */
export const terminalizeAttemptsOfReclaimedJob = traced(
	"reconcile.terminalizeAttemptsOfReclaimedJob",
	async function terminalizeAttemptsOfReclaimedJob(
		db: WatcherDb,
		jobId: number,
		now: Date,
		opts: AttemptLifecycleOpts = {},
	): Promise<number> {
		return finishAbandonedAttempts(db, jobId, now, { ...opts, summary: RECLAIMED_ATTEMPT_SUMMARY });
	},
);

/**
 * TERMINALIZE THE ATTEMPTS A CEILING-BUDGET GIVE-UP ABANDONS.
 *
 * The same write as {@link terminalizeAttemptsOfReclaimedJob} — same non-terminal
 * guard, same clock, same best-effort contract — carrying
 * {@link CEILING_EXHAUSTED_ATTEMPT_SUMMARY} instead, because the job it belonged to
 * was STOPPED rather than re-pended. Sharing the summary would have made a give-up
 * indistinguishable in the row from the forty retries that preceded it.
 *
 * @param db - watcher database
 * @param jobId - the job whose in-flight attempt rows are being finished
 * @param now - the write's own clock; what lands in `finished_at`
 * @param opts - isolated error sink for a failed write
 * @returns how many attempt rows this call actually terminalized
 */
export const terminalizeAttemptsOfCeilingExhaustedJob = traced(
	"reconcile.terminalizeAttemptsOfCeilingExhaustedJob",
	async function terminalizeAttemptsOfCeilingExhaustedJob(
		db: WatcherDb,
		jobId: number,
		now: Date,
		opts: AttemptLifecycleOpts = {},
	): Promise<number> {
		return finishAbandonedAttempts(db, jobId, now, {
			...opts,
			summary: CEILING_EXHAUSTED_ATTEMPT_SUMMARY,
		});
	},
);

/**
 * The one write both abandonment paths share: finish every still-in-flight attempt
 * of `jobId` as `failed` with `summary`, guarded on the row being NON-TERMINAL.
 *
 * The guard is the load-bearing part and is why the two callers share an
 * implementation rather than each holding a copy: an attempt that reached
 * `completed` or `failed` between the job write and this one finished legitimately,
 * and overwriting it would destroy a real result's record — including the
 * `completed` marker the #95 infra-requeue classification keys on.
 */
async function finishAbandonedAttempts(
	db: WatcherDb,
	jobId: number,
	now: Date,
	{ summary, ...opts }: AttemptLifecycleOpts & { summary: string },
): Promise<number> {
	try {
		const terminalized = await db
			.update(jobAttempts)
			.set({ status: "failed", failureSummary: summary, finishedAt: now })
			.where(
				and(
					eq(jobAttempts.jobId, jobId),
					notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
				),
			)
			.returning({ id: jobAttempts.id });
		if (terminalized.length > 0) {
			log("warn", "reclaim.attempt_terminalized", {
				reason: summary,
				job_id: jobId,
				attempts: terminalized.length,
			});
		}
		return terminalized.length;
	} catch (err) {
		reportError(opts.onError, err);
		return 0;
	}
}

/**
 * TERMINALIZE ATTEMPTS THEIR JOB CAN NO LONGER FINISH (behaviour 3).
 *
 * {@link terminalizeAttemptsOfReclaimedJob} finishes what THIS sweep abandons. This
 * catches what an EARLIER path left behind — including every attempt stranded before
 * this fix existed, and any future path that re-pends or terminates a job without
 * going through the reclaim. Without it those rows stay `submitted` with a vmid and a
 * null `finished_at` forever, which is the state that let the DB claim one box for
 * two attempts.
 *
 * ELIGIBILITY is deliberately narrow, and every clause is load-bearing:
 *
 *  - the attempt is NON-TERMINAL (a finished attempt is not ours to rewrite), and
 *  - it started before the {@link SUBMITTED_MAX_MINUTES} ceiling (younger than that
 *    it may be legitimately in flight — the same bound the job reclaim uses, so the
 *    two can never disagree), and
 *  - its job is NOT in a state that can still finish it: `active_attempt_id` is NULL
 *    or points at a DIFFERENT attempt. A job still OWNING this attempt is left alone
 *    whatever its status, because the result store's ownership-guarded terminal
 *    write may still be about to land.
 *
 * The predicates live in the SQL so `.limit()` caps ELIGIBLE rows only. Filtering
 * after a capped id-ordered scan is what let permanently-ineligible rows starve the
 * window in #95, and this scan is over a table that only grows — the lowest ids would
 * fill with already-terminal attempts and newer orphans would never be reached while
 * every sweep still ran green.
 *
 * NO FLEET INTERACTION, BY DESIGN. A vmid on one of these rows may name a box that is
 * now running someone else's job (attempt 179's vmid 9001 did), so this touches no
 * box, releases no claim, and reaps nothing.
 *
 * @param db - watcher database
 * @param now - the write's own clock and the age cutoff's origin
 * @param opts - isolated error sink for a failed read or write
 * @returns how many orphaned attempt rows were terminalized
 */
export const terminalizeOrphanedAttempts = traced(
	"reconcile.terminalizeOrphanedAttempts",
	async function terminalizeOrphanedAttempts(
		db: WatcherDb,
		now: Date,
		opts: AttemptLifecycleOpts = {},
	): Promise<number> {
		try {
			const orphans = await selectOrphanedAttempts(db, addMinutes(now, -SUBMITTED_MAX_MINUTES));
			if (orphans.length === 0) {
				return 0;
			}
			// Re-guarded on non-terminal at the WRITE, not just at the select: an attempt
			// that finished between the two must keep its own outcome.
			const terminalized = await db
				.update(jobAttempts)
				.set({ status: "failed", failureSummary: ORPHANED_ATTEMPT_SUMMARY, finishedAt: now })
				.where(
					and(
						inArray(jobAttempts.id, orphans),
						notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
					),
				)
				.returning({ id: jobAttempts.id });
			if (terminalized.length > 0) {
				log("warn", "reclaim.orphan_attempts_terminalized", {
					reason:
						"attempts past the submitted-age ceiling whose job can no longer finish them; DB hygiene only, no box was touched",
					attempts: terminalized.length,
				});
			}
			return terminalized.length;
		} catch (err) {
			reportError(opts.onError, err);
			return 0;
		}
	},
);

/**
 * Select the ids of orphaned attempts, bounded and id-ordered. Extracted so
 * {@link terminalizeOrphanedAttempts} stays under the function ceiling; the three
 * eligibility predicates and their rationale are documented on that function.
 */
async function selectOrphanedAttempts(db: WatcherDb, cutoff: Date): Promise<number[]> {
	const rows = await db
		.select({ id: jobAttempts.id })
		.from(jobAttempts)
		.innerJoin(jobs, eq(jobs.id, jobAttempts.jobId))
		.where(
			and(
				notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
				lt(jobAttempts.startedAt, cutoff),
				or(isNull(jobs.activeAttemptId), ne(jobs.activeAttemptId, jobAttempts.id)),
			),
		)
		.orderBy(asc(jobAttempts.id))
		.limit(MAX_ORPHAN_ATTEMPTS_PER_PASS);
	return rows.map((row) => row.id);
}
