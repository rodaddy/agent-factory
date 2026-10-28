/**
 * @module reconcile/dispatch-shortlist
 * @description The due-pending shortlist the generic dispatch pass reads, split
 *   out of `./dispatch-pass` when the paged refill pushed
 *   that file past its size ceiling. A file boundary, not an API change: the
 *   pass is the only caller.
 *
 * @outputs
 *   - `selectDuePendingJobs` -- one cap-sized, due-ordered page of pending rows
 *   - `MAX_SHORTLIST_PAGES` -- the bound on pages one pass may read
 *   - `DuePendingJob` -- the row shape the pass prepares and dispatches
 */
import { and, asc, eq, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { githubItems, jobAttempts, jobs, repositories } from "../db/schema";
import { VERB_IDS } from "../jobs/verb-dispatch";
import { traced } from "../log";

/**
 * How many cap-sized pages one pass may read before it stops with slots unused.
 * A bound, not a target: a pass that skips ten pages of rows is a config defect
 * (every row's template or repository is gone) that the next pass sees again,
 * and an unbounded loop over a table of such rows would hold the sweep open.
 */
export const MAX_SHORTLIST_PAGES = 10;

/** A due pending job joined to the context its fixed template body needs. */
export interface DuePendingJob {
	id: number;
	sha: string;
	jobType: string;
	repository: string;
	provider: string;
	itemNumber: number | null;
	checks: string;
	/**
	 * The `failure_summary` of this job's MOST RECENT terminal attempt, or
	 * null when the job has no terminal attempt or that attempt recorded no
	 * summary. Read here so a REVIVED job (an infra-class requeue, #95, or an
	 * operator re-pend) can be dispatched as a CORRECTION rather than a cold
	 * re-dispatch of the identical body.
	 *
	 * WATCHER-AUTHORED text, not runner output: the writers are `boundReason` in
	 * `src/results/store.ts` and the lifecycle summaries in
	 * `./attempt-lifecycle` — our own classifiers, already bounded where they are
	 * written. It is sanitized and re-capped again at the render boundary.
	 */
	previousFailure: string | null;
	/**
	 * The joined item's kind, current state, and live head SHA, read in the
	 * SAME bounded shortlist query so dispatch is gated on the item's state at the
	 * moment of selection. All three are nullable because the join is a LEFT join: a
	 * repo-scoped job (repo-validate, audit) binds to no item at all.
	 */
	itemKind: string | null;
	itemState: string | null;
	itemHeadSha: string | null;
}

/**
 * Shortlist the due pending jobs. This is only a HINT: `dispatchJob` re-claims each
 * row under a status guard, so a job a concurrent pass claims between this read and
 * the claim is skipped rather than double-dispatched.
 *
 * ORDERED BY DUE TIME, THEN ID. The shortlist used to be id-ordered, and
 * at a small cap that starved fresh work: a job re-armed after an infra-class
 * failure keeps its low id and re-entered the FRONT of every shortlist each time
 * its backoff elapsed, so three such rows could fill every cap-3 pass while a
 * never-attempted job waited (reviewer probe on PR #443: 12 stale rows kept a
 * newer row pending through 10 sweeps). `coalesce(next_attempt_at, created_at)`
 * is the moment a row became due; a re-armed row's moment is its backoff expiry,
 * a fresh row's is its creation, so whichever has WAITED longer goes first and a
 * re-armed row can no longer cut in ahead of work that was already queued when
 * it failed. Id breaks ties only.
 *
 * PAGED. The pass asks for one cap-sized page at a time and
 * passes back the ids it has already seen, so a page of rows the preparer skips
 * is followed by the NEXT due rows rather than ending the pass with slots unused.
 */
export const selectDuePendingJobs = traced(
	"reconcile.selectDuePendingJobs",
	async function selectDuePendingJobs(
		db: WatcherDb,
		now: Date,
		limit: number,
		excludeIds: readonly number[] = [],
	): Promise<DuePendingJob[]> {
		return await db
			.select({
				id: jobs.id,
				sha: jobs.sha,
				jobType: jobs.jobType,
				repository: repositories.fullName,
				provider: repositories.provider,
				itemNumber: githubItems.number,
				// The item facts the dispatch-time eligibility gate needs. Null for
				// a job bound to no item, which the gate leaves untouched.
				itemKind: githubItems.kind,
				itemState: githubItems.state,
				itemHeadSha: githubItems.headSha,
				checks: repositories.checks,
				// The most recent terminal attempt's bounded failure reason, read
				// in the SAME bounded shortlist query rather than as a per-row follow-up:
				// a second read per due job would turn one capped select into an N+1 over
				// the pass, and it would also be a second point in time, so a concurrent
				// attempt finishing between the two reads could pair one job's row with
				// another moment's summary.
				//
				// Ordered by attempt `id` DESC, which is the attempt-creation order for
				// this job, so the value is the LATEST attempt that recorded a reason —
				// not an older one a partially-summarised history might otherwise surface.
				// `failure_summary` is non-null only on a terminal attempt (it is written
				// by the same update that sets the terminal status), so filtering on it
				// selects a terminal attempt without depending on the free-text status
				// column's spelling.
				previousFailure: sql<
					string | null
				>`(select ${jobAttempts.failureSummary} from ${jobAttempts} where ${jobAttempts.jobId} = ${jobs.id} and ${jobAttempts.failureSummary} is not null order by ${jobAttempts.id} desc limit 1)`,
			})
			.from(jobs)
			.innerJoin(repositories, eq(repositories.id, jobs.repositoryId))
			.leftJoin(githubItems, eq(githubItems.id, jobs.itemId))
			.where(
				and(
					eq(jobs.status, "pending"),
					notInArray(jobs.jobType, [...VERB_IDS]),
					or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now)),
					// Rows an earlier page of THIS pass already saw.
					excludeIds.length > 0 ? notInArray(jobs.id, [...excludeIds]) : undefined,
				),
			)
			.orderBy(asc(sql`coalesce(${jobs.nextAttemptAt}, ${jobs.createdAt})`), asc(jobs.id))
			.limit(limit);
	},
);
