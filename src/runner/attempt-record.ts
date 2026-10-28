/**
 * @module runner/attempt-record
 * @description Write the `job_attempts` row for a dispatch that FAILED before it
 *   ever ran, so the row tells the truth about what was placed.
 *
 *   Two live receipts from 2026-08-02 forced this boundary to exist:
 *
 *   - Attempt 158 was `failed` with `runner_vmid` NULL and `finished_at` NULL,
 *     while TWO boxes carried its runner job id for ~6 hours. The `runner_needed`
 *     verb timed out client-side and completed server-side; the response that
 *     would have named the box never arrived. No automated cleanup path could
 *     reach those boxes, because none of them had a vmid to act on.
 *   - The refusal side has the same shape reached differently: a capacity refusal
 *     can carry a PARTIAL PLACEMENT and a surplus allocation places extra boxes.
 *     Both are reaped best-effort, and `reap` returns `reap-failed` without
 *     throwing — so a surviving box existed only in a log line, named by no row.
 *
 *   THE RULE THIS MODULE ENCODES: persist the placement whenever the allocator
 *   NAMED one, and say so honestly when it did not. A vmid that never arrived
 *   cannot be invented — naming one sends an operator to reap a box that may
 *   belong to another job — so the row instead carries
 *   {@link UNKNOWN_PLACEMENT_SUMMARY}, which tells the operator to go run the
 *   fleet list. Strays reconcile on the BOX's own job id, never on an attempt's
 *   vmid.
 *
 *   Every TERMINAL row written here is terminal on write (`failed` +
 *   `finished_at`): a `failed` attempt must never sit with a null finish time
 *   pretending to be in flight, which is what let operator queries and the
 *   submitted-age reconciliation disagree about whether attempt 158 was live.
 *
 *   sf#179 EXTENDS the rule EARLIER IN TIME. Every write above ran only after
 *   `transport.needed()` had answered, so for the ~60s the verb takes, the
 *   `runner_job_id` the fleet stamps on the box it places existed only in memory.
 *   A watcher restart or crash inside that window left a placed box no row could
 *   name — the same unattributed-box harm #149 fixed, reached through the one door
 *   it left open. `recordAllocationIntent` writes that identity BEFORE the call;
 *   every path out then reconciles that one row (upserting on the partial unique
 *   `runner_job_id` index) rather than inserting beside it, and an answered
 *   placement-free refusal retires it so the no-row-without-a-box invariant holds.
 *
 * @outputs
 *   - `recordAllocationIntent` -- the pre-verb identity row
 *   - `retireAllocationIntent` -- drop an intent row a clean refusal disproved
 *   - `recordSubmittedAttempt` -- adopt this dispatch's row with the placed vmid
 *   - `recordFailedAttempt` -- terminal attempt row for a dispatch that failed
 *   - `recordRefusedPlacement` -- persist a placement an abandoned allocation named
 *   - `reapAndRequeue` -- reap what a refusal placed, record it, release the job
 *   - `UNKNOWN_PLACEMENT_SUMMARY` -- the honest wording when no vmid ever arrived
 *   - `ALLOCATING_ATTEMPT_STATUS` -- the non-terminal in-flight-allocation status
 *
 * @dependencies
 *   - ../db/schema -- job_attempts
 *   - ../log -- the named warn a recorded placement emits, and `traced`
 *   - ./dispatch -- the shared summary bound and the reap outcome vocabulary
 */
import { and, eq, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { jobAttempts, jobs } from "../db/schema";
import { errorMessage, log, traced } from "../log";
import type { AttemptLevel } from "../reconcile/attempt-level";
import {
	addMinutes,
	bound,
	type DispatchableJob,
	type DispatchOutcome,
	type ReapOutcome,
	reap,
	releaseJob,
} from "./dispatch";
import { RunnerAllocationUnknownError, type RunnerTransport } from "./transport";

/**
 * The wording a failed attempt carries when the allocation's outcome is UNKNOWN
 * and therefore no vmid exists to persist.
 *
 * Attempt 158 was `failed` with `runner_vmid` NULL while TWO boxes carried its
 * runner job id for ~6 hours: the verb timed out client-side, completed
 * server-side, and the response that would have named the box never arrived. The
 * fix CANNOT invent that vmid — `_DOCS/runner-contract.md` is explicit that a
 * timed-out `runner_needed` returns none. What it can do is stop the row reading
 * like an ordinary failure, so an operator seeing it knows to go run the fleet
 * list rather than assuming nothing was placed.
 *
 * Deliberately names no vmid, for the same reason {@link STRANDED_BOX_HINT}
 * does: inventing one sends an operator to reap a box that may belong to another
 * job. Reconcile on the BOX's own job id, never on an attempt's vmid.
 */
export const UNKNOWN_PLACEMENT_SUMMARY =
	"outcome unknown -- box may be running unattributed; check runner_list by this attempt's runner job id";

/**
 * The INTENT row's status: this dispatch is inside `runner_needed` right now.
 *
 * Deliberately outside `TERMINAL_ATTEMPT_STATUSES`, so a row stranded here by a
 * crash is swept by the orphan reconciliation #149 already built rather than
 * needing a reconciliation of its own.
 */
export const ALLOCATING_ATTEMPT_STATUS = "allocating";

/**
 * The predicate `job_attempts_runner_job_id_key` is declared with.
 *
 * A PARTIAL unique index only matches an `ON CONFLICT` whose inference clause
 * repeats its WHERE. Omitting it does not degrade to a plain insert — Postgres
 * refuses the statement outright with `42P10 there is no unique or exclusion
 * constraint matching the ON CONFLICT specification`, which is the
 * verify-the-mechanism trap exactly: the upsert reads correctly and never runs.
 * Shared so the three call sites cannot drift out of agreement with the schema.
 */
export const RUNNER_JOB_ID_CONFLICT_TARGET = sql`${jobAttempts.runnerJobId} IS NOT NULL`;

/** The intent row written before the allocation verb fires. */
type RecordAllocationIntentArgs = {
	db: WatcherDb;
	jobId: number;
	runnerJobId: string;
	/** The attempt's dispatch-time log level; the column default is `info`. */
	level?: AttemptLevel;
};

/**
 * WRITE THE ATTRIBUTION BEFORE THE VERB CAN LOSE IT.
 *
 * #149 made every attribution write honest, but all of them ran AFTER
 * `transport.needed()` answered. The `runner_job_id` — the tag the fleet stamps
 * on the box it places — was minted in memory and lived nowhere durable while the
 * verb was in flight. `runner_needed` is the one verb that routinely runs ~60s
 * and, per `_DOCS/runner-contract.md`, generally COMPLETES server-side when it
 * times out client-side. A watcher restart, crash, or deploy inside that window
 * therefore left a placed box carrying an id no row had ever recorded:
 * `releaseReclaimedBox` reads `job_attempts` and found nothing, so the box was
 * nameable by neither the watcher nor an operator reading `runner_list`.
 *
 * Carries NO VMID, because none exists yet. That is the honest state and the same
 * rule {@link UNKNOWN_PLACEMENT_SUMMARY} encodes: a vmid that has not arrived is
 * never invented, since naming one sends an operator to reap a box that may
 * belong to another job. What the row DOES establish is the identity every
 * downstream reconciliation keys on.
 *
 * Returns the row's id so the caller can reconcile THIS row on every path out,
 * rather than inserting a second one the partial unique index would reject.
 */
export const recordAllocationIntent = traced(
	"runner.recordAllocationIntent",
	async function recordAllocationIntent({
		db,
		jobId,
		runnerJobId,
		level,
	}: RecordAllocationIntentArgs): Promise<{ id: number } | undefined> {
		const [row] = await db
			.insert(jobAttempts)
			.values({
				jobId,
				runnerJobId,
				status: ALLOCATING_ATTEMPT_STATUS,
				...(level ? { level } : {}),
			})
			.returning({ id: jobAttempts.id });
		return row;
	},
);

/**
 * ADOPT this dispatch's row as `submitted`, carrying the placed vmid.
 *
 * Upserts rather than inserts because the intent row already occupies the partial
 * unique index on `runner_job_id`, which admits exactly one row per dispatch — a
 * blind insert would throw and lose the placement. Keyed on that index, the same
 * single row results whether or not an intent write preceded it, so every caller
 * that writes no intent (prepush, compat, doctor) is unaffected.
 *
 * Returns undefined when the write persisted nothing, which the caller treats as
 * a failure to record and reaps the box on.
 */
export const recordSubmittedAttempt = traced(
	"runner.recordSubmittedAttempt",
	async function recordSubmittedAttempt(args: {
		db: WatcherDb;
		jobId: number;
		runnerJobId: string;
		vmid: number;
	}): Promise<{ id: number } | undefined> {
		const { db, jobId, runnerJobId, vmid } = args;
		const [row] = await db
			.insert(jobAttempts)
			.values({ jobId, runnerJobId, runnerVmid: vmid, status: "submitted" })
			.onConflictDoUpdate({
				target: jobAttempts.runnerJobId,
				targetWhere: RUNNER_JOB_ID_CONFLICT_TARGET,
				set: { runnerVmid: vmid, status: "submitted" },
			})
			.returning({ id: jobAttempts.id });
		return row;
	},
);

/**
 * Retire an intent row the verb ANSWERED with a clean refusal.
 *
 * A refusal that placed nothing proves no box exists to name, so its intent row
 * has no attribution left to carry. Deleting it preserves the #149 invariant that
 * a placement-free refusal writes no attempt row at all — a row per capacity
 * refusal would bury the rows that carry a real stranded box, which is the exact
 * signal-dilution that fix existed to prevent.
 *
 * Scoped to the row id AND the intent status: a row that has already moved on is
 * another path's to finish, never this one's to delete.
 */
export const retireAllocationIntent = traced(
	"runner.retireAllocationIntent",
	async function retireAllocationIntent(db: WatcherDb, attemptId: number): Promise<void> {
		await db
			.delete(jobAttempts)
			.where(and(eq(jobAttempts.id, attemptId), eq(jobAttempts.status, ALLOCATING_ATTEMPT_STATUS)));
	},
);

/** Record a failed attempt without losing the pending job. */
type RecordFailedAttemptArgs = {
	db: WatcherDb;
	jobId: number;
	runnerJobId: string;
	vmid: number | null;
	reason: string;
	/** The write's own clock — what lands in `finished_at`. */
	now: Date;
	/**
	 * True when the allocation's outcome is UNKNOWN, so no vmid could ever have
	 * been returned to persist. Prefixes the summary with
	 * {@link UNKNOWN_PLACEMENT_SUMMARY}. False for a verb that ran and genuinely
	 * failed, which placed nothing and leaves nothing to find — printing the hint
	 * there trains operators to skip it (the same reasoning as `prepush/dispatch`'s
	 * `unattributable`).
	 */
	placementUnknown?: boolean;
};

/**
 * Record a failed attempt without losing the pending job.
 *
 * The row is TERMINAL when written: `finished_at` is set alongside `failed`, so a
 * `failed` attempt never sits with a null finish time pretending to be in flight
 * (#149 — attempt 158 was `failed` with `finished_at` NULL, which is what let the
 * submitted-age reconciliation and every operator query disagree about whether it
 * was live).
 *
 * When the placement is unknown the summary leads with the unknown-placement
 * wording, then the underlying reason. Both are bounded together, so the
 * operator-facing sentence survives the cap even when the transport's message is
 * long.
 */
export const recordFailedAttempt = traced(
	"runner.recordFailedAttempt",
	async function recordFailedAttempt({
		db,
		jobId,
		runnerJobId,
		vmid,
		reason,
		now,
		placementUnknown = false,
	}: RecordFailedAttemptArgs): Promise<void> {
		const summary = bound(placementUnknown ? `${UNKNOWN_PLACEMENT_SUMMARY} -- ${reason}` : reason);
		// RECONCILE the intent row this dispatch already wrote rather than
		// inserting beside it: the partial unique index on `runner_job_id` admits
		// exactly one row per dispatch, so a blind insert would throw here and lose the
		// terminal outcome entirely. Keyed on that index, this is the same single row
		// whether or not an intent write preceded it — which keeps every pre-sf#179
		// caller (prepush, compat, doctor) working unchanged.
		await db
			.insert(jobAttempts)
			.values({
				jobId,
				runnerJobId,
				runnerVmid: vmid,
				status: "failed",
				finishedAt: now,
				failureSummary: summary,
			})
			.onConflictDoUpdate({
				target: jobAttempts.runnerJobId,
				targetWhere: RUNNER_JOB_ID_CONFLICT_TARGET,
				set: { runnerVmid: vmid, status: "failed", finishedAt: now, failureSummary: summary },
			});
	},
);

/** One refused-but-placed allocation, as the attempt row records it. */
type RecordRefusedPlacementArgs = {
	db: WatcherDb;
	jobId: number;
	runnerJobId: string;
	boxes: readonly { vmid: number }[];
	reaped: readonly ReapOutcome[];
	reason: string;
	now: Date;
	/**
	 * The intent row this dispatch wrote before the verb, when it wrote
	 * one. Retired here on a placement-free refusal: the verb ANSWERED, so no box
	 * exists to name and the row has no attribution left to carry.
	 */
	intentAttemptId?: number;
};

/**
 * PERSIST A PLACEMENT THE ALLOCATOR DID NAME, even though the allocation was
 * abandoned.
 *
 * A capacity refusal can be a PARTIAL PLACEMENT, and a surplus allocation places
 * more boxes than were asked for. Both reap best-effort — and `reap` returns
 * `reap-failed` or `skipped-unproven-ownership` without throwing, so a box can
 * survive. Before this, that box existed in a log line and nowhere else: no
 * attempt row named its vmid, so the claim-scoped reaper and every operator query
 * keyed on `job_attempts` were blind to it. That is exactly how attempt 158's
 * boxes ran unattributed for ~6 hours, reached here from the refusal side.
 *
 * Writes NOTHING when the verb placed nothing: a clean refusal has no placement
 * to record, and a row per empty refusal would bury the ones that matter. Any
 * intent row is RETIRED on that path, for the same reason — the pre-verb
 * row exists to name a box a lost response might have left, and an answered
 * refusal proves there is none.
 *
 * The row is terminal on write (`failed` + `finished_at`), carries the FIRST
 * placed vmid, and names the full placed set with each box's reap outcome in the
 * bounded summary. One row, because this dispatch minted one `runner_job_id` and
 * the partial unique index on it admits exactly one.
 */
export const recordRefusedPlacement = traced(
	"runner.recordRefusedPlacement",
	async function recordRefusedPlacement({
		db,
		jobId,
		runnerJobId,
		boxes,
		reaped,
		reason,
		now,
		intentAttemptId,
	}: RecordRefusedPlacementArgs): Promise<void> {
		const first = boxes[0];
		if (!first) {
			// The verb answered and placed nothing, so the pre-verb intent row
			// has no box left to name. Retiring it preserves this function's own
			// invariant that a placement-free refusal writes no attempt row at all.
			if (intentAttemptId !== undefined) {
				await retireAllocationIntent(db, intentAttemptId);
			}
			return;
		}
		const placed = boxes
			.map((box, i) => `${box.vmid}:${reaped[i] ?? "reap-not-attempted"}`)
			.join(" ");
		log("warn", "dispatch.refused_placement_recorded", {
			reason:
				"allocation abandoned after placing boxes; recording the placement so it stays nameable",
			job_id: jobId,
			runner_job_id: runnerJobId,
			placed,
		});
		const summary = bound(`${reason} -- placed and abandoned: ${placed}`);
		// Same upsert reasoning as `recordFailedAttempt`: reconcile this
		// dispatch's one row, keyed on the unique `runner_job_id`.
		await db
			.insert(jobAttempts)
			.values({
				jobId,
				runnerJobId,
				runnerVmid: first.vmid,
				status: "failed",
				finishedAt: now,
				failureSummary: summary,
			})
			.onConflictDoUpdate({
				target: jobAttempts.runnerJobId,
				targetWhere: RUNNER_JOB_ID_CONFLICT_TARGET,
				set: {
					runnerVmid: first.vmid,
					status: "failed",
					finishedAt: now,
					failureSummary: summary,
				},
			});
	},
);

/**
 * Reap anything the verb powered on, then requeue with a bounded backoff.
 *
 * A box the verb DID name is a placement this dispatch KNOWS about, so it is
 * persisted on a failed attempt row rather than existing only in a log
 * line. The reap is best-effort and can return `reap-failed`; without a row naming
 * the vmid, a box that survives its reap is reachable by no automated cleanup path
 * at all — attempt 158's shape reached from the refusal side instead of the
 * timeout side.
 *
 * ONE row per dispatch, because `job_attempts_runner_job_id_key` is unique on
 * `runner_job_id` and this dispatch minted exactly one. It carries the FIRST
 * placed vmid (the one a `vmid`-keyed query can act on) and names the whole placed
 * set plus each reap outcome in the bounded summary, so a surplus allocation loses
 * nothing. A refusal that placed NOTHING writes no row at all: there is no
 * placement to record and no box to find, and the pre-verb intent row is
 * retired for the same reason.
 *
 * Lives HERE rather than in `dispatch.ts` for the reason the rest of this module
 * does: it is an attempt-recording decision (which row a refusal leaves behind),
 * and `dispatch.ts` is at its 500-line ceiling.
 */
export const reapAndRequeue = traced(
	"runner.reapAndRequeue",
	async function reapAndRequeue(args: {
		db: WatcherDb;
		transport: RunnerTransport;
		job: DispatchableJob;
		runnerJobId: string;
		boxes: readonly { vmid: number }[];
		reason: string;
		retryMinutes: number;
		now: Date;
		intentArg: { intentAttemptId?: number };
	}): Promise<{ status: "refused"; outcome: DispatchOutcome }> {
		const { db, transport, job, runnerJobId, boxes, reason, retryMinutes, now, intentArg } = args;
		const reaped: ReapOutcome[] = [];
		for (const box of boxes) {
			reaped.push(await reap(db, transport, box.vmid));
		}
		await recordRefusedPlacement({
			db,
			jobId: job.id,
			runnerJobId,
			boxes,
			reaped,
			reason,
			now,
			...intentArg,
		});
		await releaseJob(db, job.id, addMinutes(now, retryMinutes), { now });
		return {
			status: "refused",
			outcome: {
				status: "queued",
				retryAfterMinutes: retryMinutes,
				reason,
				// A refusal that placed nothing spent no slot; a PARTIAL placement did,
				// reaped or not.
				...(boxes.length === 0 ? { provenNoBox: true as const } : {}),
			},
		};
	},
);

/** A `transport.needed` that THREW, as the attempt row and the job release record it. */
type RecordAllocationThrowArgs = {
	db: WatcherDb;
	jobId: number;
	runnerJobId: string;
	err: unknown;
	retryMinutes: number;
	now: Date;
};

/**
 * Record an allocation that THREW, then release the job with a bounded backoff.
 *
 * THE VMID GENUINELY NEVER ARRIVED HERE, and that is the whole point. A
 * transport fault returns no box at all (`_DOCS/runner-contract.md`: a
 * `runner_needed` that times out client-side generally COMPLETES server-side, and
 * the response that would have carried the vmid never comes). So this path cannot
 * persist a placement and must not invent one — naming a vmid would send an
 * operator to reap a box that may belong to another job.
 *
 * What it CAN do is stop the row reading like an ordinary failure. Attempt 158 was
 * `failed` with `runner_vmid` NULL while two boxes carried its runner job id for
 * ~6 hours, and nothing in the row said "go look". An UNKNOWN outcome now carries
 * {@link UNKNOWN_PLACEMENT_SUMMARY} and a named warn; a verb that ran and plainly
 * FAILED placed nothing and keeps the ordinary reason, because printing the hint
 * every time trains operators to skip it (the same reasoning as
 * `prepush/dispatch`'s `unattributable`).
 *
 * Extracted from `acquireRunnerBox` to keep it under the function ceiling.
 */
export const recordAllocationThrow = traced(
	"runner.recordAllocationThrow",
	async function recordAllocationThrow({
		db,
		jobId,
		runnerJobId,
		err,
		retryMinutes,
		now,
	}: RecordAllocationThrowArgs): Promise<{ status: "refused"; outcome: DispatchOutcome }> {
		const reason = err instanceof Error ? err.message : "allocation error";
		const placementUnknown = err instanceof RunnerAllocationUnknownError;
		await recordFailedAttempt({
			db,
			jobId,
			runnerJobId,
			vmid: null,
			reason,
			now,
			placementUnknown,
		});
		if (placementUnknown) {
			log("warn", "dispatch.placement_unknown", {
				reason: UNKNOWN_PLACEMENT_SUMMARY,
				job_id: jobId,
				runner_job_id: runnerJobId,
				cause: errorMessage(err),
			});
		}
		// Back off before retrying so a persistent allocation failure does not churn the
		// pool every pass.
		await releaseJob(db, jobId, addMinutes(now, retryMinutes), { now });
		return { status: "refused", outcome: { status: "error", reason } };
	},
);

/**
 * The attempt-owned `running` transition: mark the job running only while THIS
 * attempt still owns it, guarded by `activeAttemptId` so a stale attempt
 * cannot resurrect its claim over a newer re-run.
 */
export const markJobRunning = traced(
	"runner.markJobRunning",
	async function markJobRunning(
		db: WatcherDb,
		jobId: number,
		attemptId: number,
		now: Date,
	): Promise<void> {
		await db
			.update(jobs)
			.set({ status: "running", updatedAt: now })
			.where(and(eq(jobs.id, jobId), eq(jobs.activeAttemptId, attemptId)));
	},
);
