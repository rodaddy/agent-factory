/**
 * @module reconcile/reclaim
 * @description Recover in-flight jobs stranded by a crash or a dead runner box, and
 *   STOP the ones that will never finish.
 *
 *   Split out of `reconcile/dispatch-pass` when the ceiling budget pushed that
 *   file past its size ceiling. The two concerns were already distinct: the dispatch
 *   pass sends work OUT, this reclaims what never came back. They share only the
 *   constants below, which stay in `dispatch-pass` because the ceiling is a property
 *   of dispatch, not of recovery.
 *
 *   Every write here is STATUS-GUARDED and every guard can LOSE: a row may advance
 *   (`dispatching -> running`, `running -> completed/failed` via the result store)
 *   between the select and the update. Only a WON transition releases a box, marks
 *   attempts, or is counted — a legitimately-progressing job is never clobbered.
 *
 *   Two outcomes, and the difference between them is the whole point of #210:
 *   a stale job under its ceiling budget is RE-PENDED for a fresh attempt, and one
 *   that has spent that budget is TERMINAL-FAILED so it can never re-enter `running`.
 *
 * @outputs
 *   - `reclaimStaleJobs` -- the bounded recovery step, run at the top of a cycle
 *   - `ReclaimSummary` -- per-status counters, safe to log
 *   - `surfaceUnconfirmedAllocations` -- NAME the boxes a lost allocation left
 *   - `UnconfirmedAllocation` -- one surfaced candidate, safe to log and render
 *
 * @dependencies
 *   - drizzle-orm -- the bounded, guarded selects and updates
 *   - ../db/schema -- jobs / job_attempts
 *   - ../runner/dispatch -- the guarded release and the claim-scoped reap
 *   - ./attempt-lifecycle -- the attempt-row terminalization both outcomes perform
 *   - ./dispatch-pass -- the shared ceiling/budget constants
 */
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { releaseRunnerBox } from "../db/repos";
import { jobAttempts, jobs } from "../db/schema";
import { errorMessage, log, traced } from "../log";
import { ALLOCATING_ATTEMPT_STATUS } from "../runner/attempt-record";
import { addMinutes, reap, releaseJob } from "../runner/dispatch";
import type { ListedBox, RunnerTransport } from "../runner/transport";
import {
	terminalizeAttemptsOfCeilingExhaustedJob,
	terminalizeAttemptsOfReclaimedJob,
	terminalizeOrphanedAttempts,
} from "./attempt-lifecycle";
import {
	CEILING_RECLAIM_BUDGET,
	DISPATCHING_STALE_MINUTES,
	MAX_RECLAIM_ATTEMPTS_PER_JOB,
	MAX_RECLAIM_PER_PASS,
	RUNNING_MAX_MINUTES,
} from "./dispatch-pass";

/**
 * Wall-clock bound on transport reap time per recovery phase (one
 * {@link rependStale} call), chosen so both phases plus DB work stay under the
 * 15-minute reconcile cadence.
 */
export const RECLAIM_REAP_BUDGET_MS = 5 * 60_000;

/**
 * The bounded reason logged when a job is stopped for exhausting
 * {@link CEILING_RECLAIM_BUDGET}. Names the ceiling explicitly so the
 * operator-visible cause distinguishes "looped the ceiling until the budget ran
 * out" from every other terminal failure — the silence was the defect's real cost.
 *
 * The DURABLE cause lives on the attempt row (`CEILING_EXHAUSTED_ATTEMPT_SUMMARY`),
 * which is what a later investigation reads; this is the live log line for the sweep
 * that made the call.
 */
const CEILING_EXHAUSTED_SUMMARY =
	"terminal: exceeded the running ceiling with no result on every attempt and exhausted the ceiling-reclaim budget; not re-pended";

/**
 * Invoke the caller's error sink without ever letting it abort the cycle. A
 * monitoring sink is untrusted, and a throw from it must not take down the reclaim.
 */
function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
	try {
		onError?.(error);
	} catch {
		// Nothing safe to do with a logging-sink failure; the failure it was handed is
		// the operator-visible one and was already reported to it.
	}
}

/** Per-status counters for one reclaim cycle. Safe to log (no secrets). */
export interface ReclaimSummary {
	/** `dispatching` rows re-pended (crashed mid-claim). */
	dispatchingRepended: number;
	/** `running` rows re-pended (runner died before any result landed). */
	runningRepended: number;
	/** Non-terminal attempt rows terminalized because their job was re-pended. */
	attemptsTerminalized: number;
	/** Non-terminal attempt rows terminalized as orphans of a job that cannot finish them. */
	orphanAttemptsTerminalized: number;
	/**
	 * `running` rows terminalized `failed` for exhausting {@link CEILING_RECLAIM_BUDGET}.
	 * Disjoint from {@link runningRepended}: a job is either re-pended for a
	 * fresh attempt or stopped, never both, so a non-zero count here is the operator's
	 * signal that a lane gave up rather than that it recovered.
	 */
	ceilingExhausted: number;
	/** Stale rows left untouched because this phase's transport reap budget expired. */
	reapBudgetDeferred: number;
	/**
	 * Boxes SURFACED as possibly belonging to an allocation whose response was lost.
	 * Nothing was reaped: this is a count of candidates an operator should
	 * look at, never of actions taken. Zero when no transport was injected.
	 */
	unconfirmedAllocations: number;
}

/**
 * Re-pend stale in-flight jobs stranded by a crash or a dead runner box, run as
 * ONE bounded step at the TOP of a reconcile cycle (before the dispatch pass), so the
 * SAME cycle's dispatch pass immediately re-claims what this releases.
 *
 * Two bounded recoveries, each keyed on the job `updatedAt` age (the last lifecycle
 * write) and capped at {@link MAX_RECLAIM_PER_PASS} rows:
 *
 * (a) A job stuck in `dispatching` past {@link DISPATCHING_STALE_MINUTES} is a claim
 *     (`pending -> dispatching`) whose process crashed before the `running`/release
 *     write (see runner/dispatch's liveness note — this is the #8 recovery that owned
 *     re-pending it, never implemented). Released back to `pending` due NOW so the next
 *     dispatch pass re-claims it.
 *
 * (b) A job still in `running` past {@link RUNNING_MAX_MINUTES} whose runner box died
 *     before landing any result artifact (a landed result terminates the job out of
 *     `running` via the result store, so a still-`running` row past this ceiling has NO
 *     terminal result) is likewise released back to `pending` for a FRESH attempt.
 *
 * Both paths RE-PEND — never a new terminal/lifecycle state — because this service has
 * NO attempt-budget: every failure recovery here (capacity refuse, allocation/submission
 * error) already releases to `pending`, and each real dispatch records exactly one
 * `job_attempts` row. Re-pending records NOTHING; the fresh attempt row is written only
 * when the dispatch pass actually re-dispatches. So the attempt ledger is neither
 * double-counted nor lost — reclaim mirrors the existing release-and-retry model exactly.
 *
 * Every release is STATUS-GUARDED via `releaseJob(expectedStatus)` (the same guard the
 * atomic claim and the #34 skip-defer use): a row that advanced `dispatching -> running`
 * (or `running -> completed/failed`) between the select and the update is NOT reverted,
 * so a legitimately-progressing job is never clobbered. No cursor is advanced, no result
 * row is deleted. Per-row release failures are isolated through `onError` and never abort
 * the reclaim or the cycle. `now` owns every age threshold and write; the reap budget reads only the injected monotonic clock.
 *
 * When a released claim carries a vmid, the reclaimer ALSO reaps that box through
 * the injected `transport` — the same claim-scoped reap dispatch uses.
 * Releasing the claim without powering the LXC off is what left three boxes running
 * orphaned for 1–2.5h on 2026-08-01, starving the validate sandbox: the reclaimer
 * knew the vmid (it logged it) but had no reap step. The reap is best-effort exactly
 * like the box-claim release around it — a reap error is logged and never blocks the
 * re-pend/claim-release. `transport` is optional so a caller only checking the DB
 * re-pend (and the existing tests) still exercises the guarded claim release; the
 * service wires the real transport so the box is actually powered off.
 *
 * @param db - watcher database
 * @param now - clock seam for the age thresholds and the re-pend due time
 * @param opts - error sink for an isolated per-row release failure, the injected
 *   runner transport whose claim-scoped reap powers off a released box, and the
 *   optional monotonic clock seam in milliseconds for the per-phase reap budget
 */
export const reclaimStaleJobs = traced(
	"reconcile.reclaimStaleJobs",
	async function reclaimStaleJobs(
		db: WatcherDb,
		now: Date,
		opts: {
			onError?: (error: unknown) => void;
			transport?: RunnerTransport;
			monotonicNow?: () => number;
		} = {},
	): Promise<ReclaimSummary> {
		const recoveryOpts = {
			...opts,
			monotonicNow: opts.monotonicNow ?? (() => performance.now()),
		};
		const summary: ReclaimSummary = {
			dispatchingRepended: 0,
			runningRepended: 0,
			attemptsTerminalized: 0,
			orphanAttemptsTerminalized: 0,
			ceilingExhausted: 0,
			reapBudgetDeferred: 0,
			unconfirmedAllocations: 0,
		};

		// (a) Stale `dispatching`: a claim whose process crashed before the running/release
		// write. (b) Result-less `running` past the max-age ceiling: the runner box died
		// before any result landed (a landed result would have moved the job out of
		// `running`). Identical recovery, so one parameterized step runs both.
		const dispatching = await rependStale(
			db,
			{ status: "dispatching", staleMinutes: DISPATCHING_STALE_MINUTES },
			now,
			recoveryOpts,
		);
		summary.dispatchingRepended = dispatching.jobs;
		summary.attemptsTerminalized += dispatching.attempts;
		summary.reapBudgetDeferred += dispatching.deferred;

		const running = await rependStale(
			db,
			{ status: "running", staleMinutes: RUNNING_MAX_MINUTES },
			now,
			recoveryOpts,
		);
		summary.runningRepended = running.jobs;
		summary.attemptsTerminalized += running.attempts;
		summary.reapBudgetDeferred += running.deferred;
		summary.ceilingExhausted = running.exhausted;

		// (c) Orphaned attempts: non-terminal rows past the submitted-age ceiling whose
		// JOB can no longer finish them. DB hygiene only — no fleet verbs, no reaps.
		summary.orphanAttemptsTerminalized = await terminalizeOrphanedAttempts(db, now, opts);

		// (d) Unconfirmed allocations: rows whose `runner_needed` never returned a vmid,
		// where a box is probably RUNNING under this attempt's job id. READ-ONLY
		// and SURFACING-ONLY — it names candidates and emits the operator's reap command,
		// and reaps nothing. It needs the transport's read verb, so a caller that injects
		// none simply skips it, exactly as the box reap above degrades without one.
		if (opts.transport) {
			summary.unconfirmedAllocations = (
				await surfaceUnconfirmedAllocations(db, opts.transport, now, opts)
			).length;
		}

		return summary;
	},
);

/**
 * How long an attempt may sit in `allocating` with no vmid before it is treated
 * as an unconfirmed allocation worth surfacing.
 *
 * DELIBERATELY EQUAL to {@link DISPATCHING_STALE_MINUTES}, which already answers
 * the same underlying question — how long a claim may plausibly be mid-dispatch
 * before it can only be a crash — since an `allocating` attempt row IS a
 * `dispatching` job seen from the attempt side. Two independent numbers for one
 * condition would be a distinction with no operator meaning.
 *
 * STATED AS A LITERAL RATHER THAN DERIVED, for the reason
 * `attempt-lifecycle.ts` states `SUBMITTED_MAX_MINUTES` as one: this module and
 * `dispatch-pass` form an import CYCLE, and a top-level `const` initialized from
 * the other module's binding evaluates before that binding exists. Probed here,
 * not assumed — `export const X = DISPATCHING_STALE_MINUTES` threw
 * `ReferenceError: Cannot access 'DISPATCHING_STALE_MINUTES' before
 * initialization` and took the whole CLI down at import time, while `bun run
 * check` stayed green because the cycle is legal TypeScript. The
 * `unconfirmed-allocations` test asserts the two EQUAL, so the duplication
 * cannot drift into a disagreement about what "too old to still be allocating"
 * means.
 *
 * It is ALSO the width of the spawn-time matching window, for the same reason: a
 * box this attempt placed must have been spawned after the attempt started and
 * cannot plausibly be more than one dispatch-staleness later.
 */
export const UNCONFIRMED_ALLOCATION_MINUTES = 15;

/**
 * Cap on unconfirmed-allocation rows inspected per pass, mirroring
 * {@link MAX_RECLAIM_PER_PASS}. A literal for the same import-cycle reason
 * {@link UNCONFIRMED_ALLOCATION_MINUTES} is one, and pinned equal by the same test.
 */
const MAX_UNCONFIRMED_PER_PASS = 50;

/**
 * One box that MIGHT belong to an allocation whose response was lost.
 *
 * Every field is operator-facing and safe to log or render: integers, the
 * watcher's own job id, an ISO timestamp, and a fixed command string. No
 * runner-produced text and no secrets.
 */
export interface UnconfirmedAllocation {
	/** The box the fleet reports, which nothing in the watcher could otherwise name. */
	vmid: number;
	/** The attempt's own runner job id — the identity a box would be stamped with. */
	runnerJobId: string;
	/** The fleet's attribution stamp on the box, or null when it carries none. */
	jobId: string | null;
	/** ISO-8601 start of the attempt whose allocation was never confirmed. */
	startedAt: string;
	/**
	 * True when this candidate was matched by the TIME WINDOW and it was not the
	 * only one. An ambiguous set is surfaced WHOLE and never narrowed: picking one
	 * would send an operator to power off a box that may be another job's.
	 */
	ambiguous: boolean;
	/** The literal command an operator runs to reap this box. Fixed prose plus the integer vmid. */
	reapCommand: string;
}

/**
 * The exact command an operator runs to reap a surfaced box.
 *
 * Built from the vmid the fleet reported, which reaches this function as a
 * PARSED INTEGER rather than as text — so nothing runner-controlled can shape the
 * string. Fixed prose otherwise, because an operator reading a status page should
 * not have to re-derive the verb spelling from memory at the moment they are
 * looking at a possible leak.
 */
function reapCommandFor(vmid: number): string {
	return `mcp2cli runner-boxes runner_done --params '{"vmid": ${vmid}}'`;
}

/**
 * SURFACE — never reap — the boxes an unconfirmed allocation may have left
 * running.
 *
 * THE CONDITION. An attempt in `allocating` with a NULL `runner_vmid`, older than
 * {@link UNCONFIRMED_ALLOCATION_MINUTES}, is a dispatch that entered
 * `runner_needed` and never got a box name back. Per `_DOCS/deployment.md` that
 * verb generally COMPLETES server-side when it times out client-side: a box was
 * very likely placed and stamped with this attempt's `runner_job_id`, and until
 * now nothing in the watcher could name it. The intent row (`recordAllocationIntent`)
 * made the identity durable; this pass is what finally USES it.
 *
 * MATCHING IS JOB-ID-FIRST, and the order is load-bearing rather than a
 * preference. Job ids are single-use per attempt — the verb's own docstring says
 * so — which makes an exact `jobId` hit unambiguous by construction. The
 * spawn-time window is a FALLBACK that runs ONLY for boxes carrying no stamp at
 * all; a box stamped with a DIFFERENT job has already answered the ownership
 * question and is never window-matched into someone else's candidate list.
 *
 * AN AMBIGUOUS SET IS SURFACED WHOLE. Two unstamped boxes inside one window are
 * both reported with `ambiguous: true`. Narrowing to one would be a guess, and
 * the artifact of that guess is a command telling an operator to power off a box
 * — the highest-consequence output this pass produces.
 *
 * NOTHING HERE REAPS, and that is a hard non-goal sitting on top of a
 * standing trap: a timed-out verb probably SUCCEEDED server-side, so automatic
 * action on an inference about a box we could not name is precisely how boxes got
 * leaked. This function calls no `done()`, releases no claim, and writes no row.
 * It reads, logs, and returns.
 *
 * A `list()` FAILURE DEGRADES TO AN EMPTY SURFACING. The fleet read is advisory:
 * losing it means this pass has nothing to say, never that the reconcile cycle
 * should stop. A throw escaping here would take down a cycle that also performs
 * the re-pends and terminalizations everything else depends on.
 *
 * @param db - watcher database
 * @param transport - the runner transport whose read-only `list` names the boxes
 * @param now - clock seam for the age threshold and the matching window
 * @param opts - isolated error sink for a failed read
 * @returns every surfaced candidate, bounded; `[]` when there is nothing to say
 */
export const surfaceUnconfirmedAllocations = traced(
	"reconcile.surfaceUnconfirmedAllocations",
	async function surfaceUnconfirmedAllocations(
		db: WatcherDb,
		transport: RunnerTransport,
		now: Date,
		opts: { onError?: (error: unknown) => void } = {},
	): Promise<UnconfirmedAllocation[]> {
		try {
			const cutoff = addMinutes(now, -UNCONFIRMED_ALLOCATION_MINUTES);
			const rows = await db
				.select({ runnerJobId: jobAttempts.runnerJobId, startedAt: jobAttempts.startedAt })
				.from(jobAttempts)
				.where(
					and(
						eq(jobAttempts.status, ALLOCATING_ATTEMPT_STATUS),
						isNull(jobAttempts.runnerVmid),
						lt(jobAttempts.startedAt, cutoff),
					),
				)
				.orderBy(asc(jobAttempts.id))
				.limit(MAX_UNCONFIRMED_PER_PASS);
			if (rows.length === 0) {
				return [];
			}
			// Read the fleet ONCE for the whole pass. Listing per row would multiply a
			// ~60s verb by the row count on exactly the pass that runs after an outage,
			// which is when this list is longest.
			const boxes = await transport.list();
			const found: UnconfirmedAllocation[] = [];
			for (const row of rows) {
				if (row.runnerJobId === null) {
					// No identity to match on, and inventing one is the harm this whole
					// lineage exists to refuse.
					continue;
				}
				found.push(...matchUnconfirmed(row.runnerJobId, row.startedAt, boxes));
			}
			for (const candidate of found) {
				logUnconfirmed(candidate);
			}
			return found;
		} catch (err) {
			// Includes a `transport.list()` throw. The read is advisory: an unavailable
			// fleet means this pass has nothing to SAY, never that the cycle should stop.
			log("warn", "reclaim.unconfirmed_allocation_scan_failed", {
				reason: "could not read the fleet box list; surfacing nothing this pass",
				cause: errorMessage(err),
			});
			reportError(opts.onError, err);
			return [];
		}
	},
);

/**
 * Match ONE unconfirmed attempt against the fleet list: exact job id first, the
 * spawn-time window only as a fallback for unstamped boxes.
 *
 * Extracted so {@link surfaceUnconfirmedAllocations} stays under the function
 * ceiling; the matching rule and its rationale are documented on that function.
 */
function matchUnconfirmed(
	runnerJobId: string,
	startedAt: Date,
	boxes: readonly ListedBox[],
): UnconfirmedAllocation[] {
	const startedIso = startedAt.toISOString();
	const build = (box: ListedBox, ambiguous: boolean): UnconfirmedAllocation => ({
		vmid: box.vmid,
		runnerJobId,
		jobId: box.jobId,
		startedAt: startedIso,
		ambiguous,
		reapCommand: reapCommandFor(box.vmid),
	});

	// PRIMARY: an exact single-use job id. Unambiguous by construction, so it wins
	// outright and the window is never consulted.
	const exact = boxes.filter((box) => box.jobId === runnerJobId);
	if (exact.length > 0) {
		return exact.map((box) => build(box, false));
	}

	// FALLBACK: unstamped boxes spawned inside [startedAt, startedAt + window]. A
	// box carrying a DIFFERENT job id is excluded here rather than merely
	// out-ranked — it has already answered the ownership question, and sweeping it
	// into a candidate list is how an operator ends up reaping live work.
	const from = startedAt.getTime();
	const to = addMinutes(startedAt, UNCONFIRMED_ALLOCATION_MINUTES).getTime();
	const windowed = boxes.filter((box) => {
		if (box.jobId !== null || box.spawnIso === null) {
			return false;
		}
		const spawned = Date.parse(box.spawnIso);
		return Number.isFinite(spawned) && spawned >= from && spawned <= to;
	});
	// TWO OR MORE means every one of them is surfaced FLAGGED, never narrowed.
	return windowed.map((box) => build(box, windowed.length > 1));
}

/** Emit one bounded, operator-facing line per surfaced candidate. */
function logUnconfirmed(candidate: UnconfirmedAllocation): void {
	log("warn", "reclaim.unconfirmed_allocation_surfaced", {
		reason:
			"an allocation returned no vmid and a box may be RUNNING unattributed; NOT reaped automatically -- operator decides",
		vmid: candidate.vmid,
		runner_job_id: candidate.runnerJobId,
		fleet_job_id: candidate.jobId,
		started_at: candidate.startedAt,
		ambiguous: candidate.ambiguous,
		reap_command: candidate.reapCommand,
	});
}

/** Select the stale rows for one recovery phase in stable id order. */
async function selectStaleReclaimRows(
	db: WatcherDb,
	status: "dispatching" | "running",
	cutoff: Date,
) {
	// The durable attempt ledger travels WITH the candidate row so the budget decision
	// needs no second query per job. Counted exactly as #95 counts: one
	// `job_attempts` row per real dispatch, so attemptCount is reclaims + 1.
	return db
		.select({ id: jobs.id, attemptCount: sql<number>`count(${jobAttempts.id})` })
		.from(jobs)
		.leftJoin(jobAttempts, eq(jobAttempts.jobId, jobs.id))
		.where(and(eq(jobs.status, status), lt(jobs.updatedAt, cutoff)))
		.groupBy(jobs.id)
		.orderBy(asc(jobs.id))
		.limit(MAX_RECLAIM_PER_PASS);
}

/**
 * Log the per-phase budget warning and return untouched rows, or null when the
 * phase may continue.
 */
function deferRowsAfterReapBudget(args: {
	status: "dispatching" | "running";
	startedAt: number;
	monotonicNow: () => number;
	processed: number;
	total: number;
}): number | null {
	if (args.monotonicNow() - args.startedAt < RECLAIM_REAP_BUDGET_MS) return null;
	const deferred = args.total - args.processed;
	log("warn", "reclaim.reap_budget_exhausted", {
		status: args.status,
		budget_ms: RECLAIM_REAP_BUDGET_MS,
		processed: args.processed,
		deferred,
	});
	return deferred;
}

/**
 * Re-pend every job stuck in `status` past `staleMinutes`, releasing its box claim
 * and terminalizing the attempt rows the re-pend abandons.
 *
 * The `dispatching` and `running` recoveries differ ONLY in which status they
 * select and how old is too old, so they share one implementation — which is also
 * what keeps the #149 attempt terminalization from being added to one branch and
 * forgotten on the other.
 *
 * Bounded, id-ordered, and capped at {@link MAX_RECLAIM_PER_PASS}. Every release is
 * STATUS-GUARDED on `status`, and the guard can LOSE: the row may have advanced
 * (`dispatching -> running`, or `running -> completed/failed` via the result store)
 * between the select and the update. Only a WON transition releases a box, marks
 * attempts, or is counted — otherwise a live attempt's claim would be cleared, and
 * a finished attempt's row rewritten, on the strength of a re-pend that never
 * happened. Per-row failures are isolated through `onError` and never abort the
 * reclaim.
 *
 * The reap budget is checked only BETWEEN rows. A released job must not leave part
 * of its boxes held, so the bound is per row; the per-row worst case
 * (attempts × 180 s) is accepted and documented.
 *
 * @returns jobs re-pended, attempt rows terminalized, and stale rows deferred by this step
 */
async function rependStale(
	db: WatcherDb,
	branch: { status: "dispatching" | "running"; staleMinutes: number },
	now: Date,
	opts: {
		onError?: (error: unknown) => void;
		transport?: RunnerTransport;
		monotonicNow?: () => number;
	},
): Promise<{ jobs: number; attempts: number; exhausted: number; deferred: number }> {
	const { status, staleMinutes } = branch;
	const cutoff = addMinutes(now, -staleMinutes);
	const stale = await selectStaleReclaimRows(db, status, cutoff);

	const monotonicNow = opts.monotonicNow ?? (() => performance.now());
	const startedAt = monotonicNow();
	const counts = { jobs: 0, attempts: 0, exhausted: 0, deferred: 0 };
	let processed = 0;
	for (const row of stale) {
		// Check only BETWEEN rows. A released job must not leave part of its boxes
		// held, so the bound is per row; the per-row worst case (attempts × 180 s) is
		// accepted and documented by this phase budget.
		const deferred = deferRowsAfterReapBudget({
			status,
			startedAt,
			monotonicNow,
			processed,
			total: stale.length,
		});
		if (deferred !== null) {
			counts.deferred = deferred;
			break;
		}
		try {
			// THE LOOP BOUND. A `running` job past the ceiling that has already
			// spent its budget is STOPPED here rather than re-pended. Only the `running`
			// branch is bounded: a stale `dispatching` row crashed before its attempt
			// reached `running`, so it holds no box-hours THIS reclaim can bound.
			//
			// It is NOT true that such a row never reached a runner (corrected sf#179).
			// A crash inside `transport.needed()` can leave a box the verb placed
			// server-side, which is exactly why the pre-verb intent row now exists: the
			// row this branch re-pends carries the `runner_job_id` an operator needs to
			// find that box in `runner_list`. Bounding is still the wrong lever for it —
			// the box is surfaced and reaped by identity, never by an attempt budget.
			//
			// Bun.sql returns aggregate counts as strings; coerce so the comparison is
			// numeric, not lexicographic (the #95 trap, same shape).
			if (status === "running" && Number(row.attemptCount) > CEILING_RECLAIM_BUDGET) {
				counts.exhausted += (await terminalizeCeilingExhaustedJob(db, row.id, now, opts)) ? 1 : 0;
				continue;
			}
			// Due NOW so the same cycle's dispatch pass re-claims it promptly.
			if (!(await releaseJob(db, row.id, now, { now, expectedStatus: status }))) {
				continue;
			}
			await releaseReclaimedBox(db, row.id, opts);
			// The job is gone from this attempt; the row must stop claiming to be in
			// flight — attempt 179's exact shape on the `running` branch. Runs
			// only on a WON release, exactly like the box release above.
			counts.attempts += await terminalizeAttemptsOfReclaimedJob(db, row.id, now, opts);
			counts.jobs++;
		} catch (err) {
			reportError(opts.onError, err);
		} finally {
			processed++;
		}
	}
	return counts;
}

/**
 * STOP a job that has looped the running ceiling through its whole budget.
 *
 * The terminal counterpart of the re-pend: same box release and same attempt
 * terminalization, but the job lands in `failed` instead of `pending`. That single
 * status difference is what makes the loop IMPOSSIBLE rather than merely slower —
 * `failed` is not a dispatchable status, so no future pass can pick the row up.
 *
 * STATUS-GUARDED on `running` for the same reason every write here is: the row may
 * have advanced to a genuine terminal state via the result store between the select
 * and this write, and a late result is a real outcome that must not be overwritten
 * by a give-up. A LOST guard means the job finished on its own and nothing is done.
 *
 * `activeAttemptId` is cleared alongside the status so no superseded attempt's late
 * write can match the ownership marker, matching `releaseJob`'s own reset.
 *
 * The box is released and reaped BEFORE the status write, exactly as the re-pend
 * path does it — giving up on the job must never leak the box it was holding, which
 * is the capacity drain #210 was reported for in the first place.
 *
 * @returns whether this call actually terminalized the row (a lost guard returns false)
 */
async function terminalizeCeilingExhaustedJob(
	db: WatcherDb,
	jobId: number,
	now: Date,
	opts: { onError?: (error: unknown) => void; transport?: RunnerTransport },
): Promise<boolean> {
	const stopped = await db
		.update(jobs)
		.set({ status: "failed", activeAttemptId: null, updatedAt: now })
		.where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
		.returning({ id: jobs.id });
	if (stopped.length === 0) return false;
	// Free the box this attempt was holding, then make its row stop claiming to be in
	// flight — the same two steps the re-pend performs, for the same reasons.
	await releaseReclaimedBox(db, jobId, opts);
	await terminalizeAttemptsOfCeilingExhaustedJob(db, jobId, now, opts);
	log("warn", "reclaim.ceiling_budget_exhausted", {
		reason: CEILING_EXHAUSTED_SUMMARY,
		job_id: jobId,
		budget: CEILING_RECLAIM_BUDGET,
	});
	return true;
}

/**
 * Release the runner-box claim belonging to a reclaimed job's attempts AND, when a
 * transport is injected, reap the box so the LXC is actually powered off.
 *
 * Re-pending a crashed job without releasing the claim leaves the box held FOREVER:
 * the claim is taken before `transport.run()` and cleared only by a reap or a landed
 * result, neither of which happens when the watcher dies in between. The job then
 * redispatches onto a different box while the original stays permanently held, and
 * the pool is 25 VMIDs wide (found by the `gpt-5.6-sol@high` SME lane).
 *
 * But clearing the DB claim alone does NOT power the LXC off — it only marks the
 * pool slot free. On 2026-08-01 the reclaimer released three claims (logging each
 * vmid) while the containers kept running for 1–2.5h and starved the validate
 * sandbox. So when a released attempt carries a vmid, reap it through the SAME
 * claim-scoped `reap(vmid, runnerJobId)` dispatch uses: the reap re-does the exact
 * `(vmid, runnerJobId)`-scoped claim release AND powers the box off, and it SKIPS
 * the power-off if the scoped release did not match (the fleet recycled the box to a
 * newer attempt) — the identical do-not-kill-a-live-box guard. This is NOT the
 * timed-out-allocation-with-no-vmid trap: a null-vmid attempt is left exactly
 * as before, unnamed and untouched.
 *
 * Scoped to `(vmid, runnerJobId)` throughout so it can only ever clear/reap the box
 * this attempt made. If the fleet already recycled the box and a newer attempt
 * claimed it, the scoped release matches nothing and the live box is left alone.
 *
 * Without a transport (a caller checking only the DB re-pend, and the existing
 * reclaim tests) it falls back to the DB-only claim release, byte-behaviour
 * identical to before this fix.
 *
 * Best-effort by design: a job that has been re-pended must not be un-re-pended
 * because the bookkeeping write OR the reap failed, so both are caught and this
 * reports and returns rather than throwing into the reclaim loop's own handling.
 * The reap outcome is recorded on the release log line.
 */
async function releaseReclaimedBox(
	db: WatcherDb,
	jobId: number,
	opts: {
		onError?: (error: unknown) => void;
		transport?: RunnerTransport;
		monotonicNow?: () => number;
	},
): Promise<void> {
	try {
		// EVERY attempt of this job, not just the newest. A job that has already been
		// re-pended once can have an older attempt still holding a box on a different
		// vmid; checking only the latest leaves that one allocated forever, which
		// silently consumes a pool that is 25 VMIDs wide. Bounded and id-ordered so
		// the query stays cheap however many attempts a long-lived job accumulated.
		const attempts = await db
			.select({ runnerVmid: jobAttempts.runnerVmid, runnerJobId: jobAttempts.runnerJobId })
			.from(jobAttempts)
			.where(eq(jobAttempts.jobId, jobId))
			.orderBy(desc(jobAttempts.id))
			.limit(MAX_RECLAIM_ATTEMPTS_PER_JOB);
		for (const attempt of attempts) {
			if (attempt.runnerVmid === null || attempt.runnerJobId === null) {
				// No vmid means no box was ever taken. A null runner job id means the
				// claim cannot be proven to be this attempt's, and an UNSCOPED release
				// would be the very bug this function exists to avoid — clearing
				// whatever holds the box now. Leave it: a visibly held box is
				// recoverable, a wrongly freed live one is not.
				continue;
			}
			if (opts.transport) {
				// Reap through dispatch's claim-scoped reap: it releases the
				// `(vmid, runnerJobId)`-scoped claim AND powers the LXC off, skipping the
				// power-off when the scoped release does not match (recycled to a newer
				// attempt) — the same do-not-kill-a-live-box guard dispatch relies on. A
				// reap error is logged inside `reap` and never thrown, so it cannot block
				// the re-pend. Record its outcome on the release line.
				const outcome = await reap(db, opts.transport, attempt.runnerVmid, attempt.runnerJobId);
				log("info", "reclaim.box_released", {
					job_id: jobId,
					vmid: attempt.runnerVmid,
					runner_job_id: attempt.runnerJobId,
					reap: outcome,
				});
				continue;
			}
			// No transport: DB-only claim release, scoped to `(vmid, runnerJobId)`. The
			// box is NOT powered off here (only the service path injects the transport).
			const released = await releaseRunnerBox(db, attempt.runnerVmid, attempt.runnerJobId);
			if (released) {
				log("info", "reclaim.box_released", {
					job_id: jobId,
					vmid: attempt.runnerVmid,
					runner_job_id: attempt.runnerJobId,
					reap: "not-attempted-no-transport",
				});
			}
		}
	} catch (err) {
		reportError(opts.onError, err);
	}
}
