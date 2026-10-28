/**
 * @module reconcile/dispatch-pass
 * @description Dispatch the pending jobs a reconciliation pass queued. After
 *   `runPass` records changed items and creates idempotent pending jobs (it does
 *   no dispatch itself), this bounded step selects the due pending jobs, resolves
 *   each one's allowlisted template, and hands it to `dispatchJob` — which claims
 *   the row atomically (pending -> dispatching) so a job already running or
 *   claimed by a concurrent pass is never dispatched twice.
 *
 *   Isolation: one job's dispatch failure is caught and recorded on that job's
 *   outcome without aborting the batch, and it never touches a reconciliation
 *   cursor — cursors are advanced only by `runPass`, before dispatch runs, so a
 *   failed or unposted dispatch cannot advance a cursor past its work. A job type
 *   with no allowlisted template (or absent from the config's `job_templates`) is
 *   skipped, never dispatched.
 *
 *   Every due job is ALSO re-gated against the CURRENT config's managed-repository
 *   allowlist at dispatch time: a stale pending job for a repository the operator
 *   removed from `config/repos.yml` is skipped (left pending, no cursor touched),
 *   never dispatched to a runner. Both the repo and the template allowlist are
 *   re-read from the live config on every pass, so removing either revokes future
 *   dispatch of already-queued work.
 *
 *   A skipped-but-still-pending job (de-scoped repo or de-allowlisted template) is
 *   also DEFERRED by a bounded CADENCE-RELATIVE skip-backoff ({@link skipDeferMinutes},
 *   a multiple of `poll_interval_minutes` with a floor) — the same
 *   `{status:"pending", nextAttemptAt}` release the capacity path uses, guarded on the
 *   still-pending status. It stays pending (so re-adding the repo/template revives it
 *   after the window), but it no longer re-enters the id-ordered shortlist at the front
 *   on every pass. The window must robustly EXCEED the poll cadence, not equal it: a
 *   window equal to the poll interval re-arms the whole deferred batch on the next sweep
 *   and reopens the starvation, so >`maxPerPass` stale low-id skips would keep starving
 *   newer due jobs.
 *
 * @outputs
 *   - `dispatchPendingJobs` -- claim + dispatch the due pending jobs, bounded
 *   - `DispatchPassSummary` -- per-batch counters, safe to log
 *
 * @dependencies
 *   - drizzle-orm -- the bounded due-pending selection join
 *   - ../db/schema -- jobs / github_items / repositories
 *   - ../runner/dispatch -- the atomic claim + submit
 *   - ../runner/transport -- the injectable runner-box verb contract
 *   - ../config/schema -- the allowlisted job-template mapping
 *   - ../templates/registry -- the fixed template allowlist gate
 */
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { JobTemplateConfig, WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { jobAttempts, jobs } from "../db/schema";
import { parseProvider } from "../forge/provider";
import { isItemEligible } from "../github/eligibility";
import { persistTerminalCheck } from "../github/publication-terminal";
import { VERB_IDS } from "../jobs/verb-dispatch";
import { errorMessage, log, traced, withLogFields } from "../log";
import type { BodyLandingStager } from "../prepush/stage";
import { addMinutes, type DispatchableJob, dispatchJob, releaseJob } from "../runner/dispatch";
import { createPassBudget, type PassBudget, settleReservation } from "../runner/pass-budget";
import { createPassVmids, type PassVmids } from "../runner/pass-vmids";
import type { RunnerTransport } from "../runner/transport";
import { isKnownTemplate, TRIAGE_TEMPLATE_ID } from "../templates/registry";

// The stale-job reclaim moved to `./reclaim` when the #210 ceiling budget pushed this
// file past its size ceiling. Re-exported here so every existing importer and test
// keeps its current import path — the split is a file boundary, not an API change.
export { type ReclaimSummary, reclaimStaleJobs } from "./reclaim";

import {
	MAX_DISPATCH_PER_PASS,
	parseMaxDispatchPerPass,
	resolveDispatchCap,
} from "./dispatch-caps";
import {
	type DuePendingJob,
	MAX_SHORTLIST_PAGES,
	selectDuePendingJobs,
} from "./dispatch-shortlist";

/**
 * Resolve the allowlisted template for a job. The template must be one of the
 * fixed registry ids (so an unregistered type can never be dispatched) AND named
 * in the config's `job_templates` allowlist. Returns null when either gate fails.
 */
function resolveTemplate(config: WatcherConfig, jobType: string): JobTemplateConfig | null {
	if (!isKnownTemplate(jobType)) {
		return null;
	}
	return config.job_templates.find((t) => t.id === jobType) ?? null;
}

/**
 * The cap and its two resolvers moved to `./dispatch-caps` so this
 * module keeps headroom under the `lint:size` bound. Re-exported so
 * `src/service.ts` and `./sweep-scope` are unaffected.
 */
export { MAX_DISPATCH_PER_PASS, parseMaxDispatchPerPass, resolveDispatchCap };

/**
 * The per-key requeue budget for an infra-class terminal failure. A job that
 * terminal-failed for an INFRA-CLASS reason (the agent/harness never produced a valid
 * result) may be revived to `pending` this many times before the sweep stops trying —
 * a persistent fault must not churn boxes every sweep forever. The count is derived
 * from durable `job_attempts` rows (one per real dispatch), never a new column: a job
 * on its Nth requeue has N+1 attempt rows, so "fewer than {@link INFRA_REQUEUE_BUDGET}
 * requeues so far" is `attemptCount <= INFRA_REQUEUE_BUDGET`. Ruled by the owner 2026-08-01.
 */
export const INFRA_REQUEUE_BUDGET = 3;

/**
 * Bounded backoff (minutes) before a requeued infra-failed job is due again. A
 * revived job returns to `pending` with this `nextAttemptAt` so a still-broken lane
 * does not re-dispatch on the very next sweep; a small floor-scaled window is enough to
 * space the retries out without stranding a genuinely-transient fault (a refreshed
 * credential, a lifted turn cap) for long.
 */
export const INFRA_REQUEUE_BACKOFF_MINUTES = 15;

/** Cap on infra-failed jobs revived per sweep, mirroring {@link MAX_RECLAIM_PER_PASS}. */
export const MAX_INFRA_REQUEUE_PER_PASS = 50;

/**
 * The attempt status that marks a VALID ingested result. The result store finishes
 * the owning attempt `completed` exactly when a valid result was ingested — whether it
 * passed or carried a genuine `failed` review verdict. A terminal-`failed` job with any
 * attempt in this status is therefore VERDICT-class and must NOT requeue; a terminal-
 * `failed` job with NONE is INFRA-class (the agent/harness never produced a valid result).
 * This single named constant IS the classification contract: it keys on factory-side
 * persisted state, not on the free-text failure prose that #93/#94 may evolve.
 */
export const INFRA_CLASS_MARKER_STATUS = "completed" as const;

/**
 * Age (minutes) past which a job stuck in `dispatching` is treated as stranded by a
 * crash between the atomic claim and the `running`/release write and re-pended.
 * A normal claim -> running transition takes one dispatch call, so a small bounded
 * threshold comfortably above that (15m) never races an in-flight dispatch: a row that
 * legitimately advanced to `running` is skipped by the status guard, and one still in
 * `dispatching` this long could only be a crashed claim. See {@link reclaimStaleJobs}.
 */
export const DISPATCHING_STALE_MINUTES = 15;

/**
 * Age (minutes) past which a job still in `running` — whose runner box died before any
 * result artifact landed (a landed result would have terminated it out of `running`) —
 * is re-pended for a fresh attempt. A bounded ceiling comfortably ABOVE the
 * longest legitimate runner job so it never reclaims live in-flight work; only a runner
 * that will never land a result stays `running` this long. See {@link reclaimStaleJobs}.
 */
export const RUNNING_MAX_MINUTES = 60;

/**
 * The per-job budget for CEILING RECLAIMS — a `running` job re-pended past
 * {@link RUNNING_MAX_MINUTES} having landed no result.
 *
 * Job 1547 (`pr-review`, target #198) cycled this ceiling for hours: allocate a box,
 * hold it to 60 minutes, produce nothing, get reclaimed, re-pend, repeat — ~40
 * attempts, one box per cycle, no terminal outcome and no path to one. The re-pend
 * was UNBOUNDED because each of the two bounded paths assumed the other held the
 * line: the reclaim re-pends on the reasoning that "this service has NO attempt
 * budget", while the #95 budget that DOES exist selects on `jobs.status = 'failed'`
 * — a status the reclaim never writes. So a job that could never succeed also could
 * never stop, and because a looping job looks exactly like a working one, nothing
 * went red. That is #84's silently-absent gate in scheduling clothes.
 *
 * The bound is stated HERE, on the reclaim, because the reclaim is what re-enters
 * `running`; bounding it anywhere downstream would only make the loop quieter.
 * Counted the same way #95 counts, from durable `job_attempts` rows rather than a
 * new column: a job on its Nth ceiling reclaim carries N+1 attempt rows, so "fewer
 * than this many reclaims so far" is `attemptCount <= CEILING_RECLAIM_BUDGET`.
 *
 * Deliberately EQUAL to {@link INFRA_REQUEUE_BUDGET}: both answer the same question
 * — how many times may a lane that produced no valid result be retried before the
 * factory stops spending boxes on it — and two different answers would be a
 * distinction with no operator meaning. They are separate constants because they
 * bound separate transitions and a future ruling may move one alone.
 *
 * THE EQUALITY IS ALSO LOAD-BEARING, which is why a test pins it. Terminalizing a
 * ceiling-exhausted job as `failed` hands it straight to {@link
 * requeueInfraFailedJobs}, and it is INFRA-class by that sweep's own predicate (no
 * attempt ever reached `completed` — a job that never produced a result cannot
 * have). What keeps the requeue from simply restarting this loop through a second
 * door is its `attemptCount <= INFRA_REQUEUE_BUDGET` bar: an exhausted job is by
 * construction past CEILING_RECLAIM_BUDGET, so while the two are equal it can never
 * qualify. Raising INFRA_REQUEUE_BUDGET above this one would silently reopen #210 —
 * the give-up would stick for one sweep and then be revived — so if a future ruling
 * does move them apart, that revival must be barred explicitly rather than by
 * arithmetic coincidence.
 */
export const CEILING_RECLAIM_BUDGET = INFRA_REQUEUE_BUDGET;

/**
 * Cap on rows the reclaimer re-pends per status per cycle, so one pass stays bounded
 * however many rows a long outage stranded (mirrors {@link MAX_DISPATCH_PER_PASS}). A
 * remaining backlog is simply reclaimed on the next cycle; nothing is lost.
 */
export const MAX_RECLAIM_PER_PASS = 50;

/**
 * Cap on attempts inspected per reclaimed job when releasing stranded box claims.
 * A job accumulates one attempt per dispatch, and any of them may still hold a
 * box; bounding the scan keeps the reclaim cheap while covering every realistic
 * retry depth. See {@link reclaimStaleJobs}.
 */
export const MAX_RECLAIM_ATTEMPTS_PER_JOB = 20;

/**
 * Small absolute floor (minutes) for the skip-backoff, so even a tiny operator poll
 * interval still yields a meaningful defer. See {@link skipDeferMinutes}.
 */
export const SKIP_DEFER_FLOOR_MINUTES = 15;

/**
 * Multiple of the poll cadence the skip-backoff spans. The window MUST robustly
 * exceed the poll interval, not merely equal it: a fixed 15-minute defer at the
 * default `poll_interval_minutes: 15` re-arms every deferred low-id skip on the VERY
 * NEXT real sweep (its `nextAttemptAt = t+15` is `<= now` at the `t+15` sweep), so a
 * batch of >`maxPerPass` de-scoped/de-allowlisted skips re-saturates the id-ordered
 * shortlist on every sweep and starvation never actually closes. Spanning the
 * defer over `MULTIPLE` poll intervals means a deferred batch contends on only 1 of
 * every `MULTIPLE` sweeps; the other `MULTIPLE - 1` sweeps have shortlist room, so a
 * newer higher-id job is guaranteed to dispatch within a bounded number of sweeps.
 * Four keeps revive latency acceptable (an operator re-adding a de-scoped repo is not
 * latency-critical) while leaving 3-in-4 sweeps free for forward progress.
 */
export const SKIP_DEFER_POLL_MULTIPLE = 4;

/**
 * The bounded skip-backoff (minutes) applied when a due pending job is skipped because
 * its repo was de-scoped or its template de-allowlisted. Without a defer the job
 * stays pending-and-due and re-enters the id-ordered shortlist at the front on every
 * pass; once more than `maxPerPass` such stale low-id skips accumulate they consume the
 * whole shortlist and starve newer due jobs.
 *
 * The window is CADENCE-RELATIVE — a multiple of the operator's `poll_interval_minutes`
 * with an absolute floor — so it robustly EXCEEDS the poll cadence rather than equalling
 * it. A fixed window equal to the poll interval re-arms the whole deferred batch on the
 * very next sweep and reopens the starvation; a `MULTIPLE`-of-cadence window makes the
 * batch contend on only 1-in-`MULTIPLE` sweeps, leaving the rest free for newer jobs.
 * The job stays status=pending throughout, so re-adding the repo/template still revives
 * it once the window passes (revive-on-re-add preserved). Pure function of config + the
 * injected `now`; no wall-clock read.
 */
export const skipDeferMinutes = traced(
	"reconcile.skipDeferMinutes",
	function skipDeferMinutes(config: WatcherConfig): number {
		return Math.max(
			SKIP_DEFER_FLOOR_MINUTES,
			config.poll_interval_minutes * SKIP_DEFER_POLL_MULTIPLE,
		);
	},
);

/** Per-batch outcome. Safe to log as-is (no secrets, no unbounded text). */
export interface DispatchPassSummary {
	/** Due pending jobs the selection returned. */
	selected: number;
	/** Jobs actually dispatched to a runner. */
	dispatched: number;
	/** Jobs the transport queued (capacity refused); left pending with backoff. */
	queued: number;
	/** Jobs skipped (already claimed, or no allowlisted template). */
	skipped: number;
	/** Jobs that errored during dispatch; recorded and left pending, not aborted. */
	errored: number;
}

/**
 * The resolved fixed static-gate selection an `infra-static` job dispatches with.
 * Booleans only — which fixed gates apply — never a command or path —
 * plus, when the selector read it, the IMMUTABLE PR base SHA the body's verdict
 * is relative to. Absent, the body renders the absolute verdict.
 */
export interface ResolvedGateSelection {
	ansible: boolean;
	workflows: boolean;
	scripts: boolean;
	config: boolean;
	fullEscalation: boolean;
	baseSha?: string;
}

/**
 * The injected async seam that resolves an `infra-static` job's fixed static-gate
 * selection. The service wires it to the read-only GitHub client + the repo's
 * configured `gate_selection` (see src/infra/select); a caller that omits it (or
 * for any non-`infra-static` job) dispatches with a full escalation — the
 * fail-closed default that never narrows the static checks without a trusted
 * decision. It must never throw into the batch: a failure inside it is caught and
 * degraded to a full escalation, never a dropped job.
 */
export type InfraGateSelector = (job: {
	repository: string;
	itemNumber: number | null;
	/** The bound item's kind (`pull` / `issue`); only a pull has a base to read. */
	itemKind: string | null;
	sha: string;
}) => Promise<ResolvedGateSelection>;

/** The fail-closed full-escalation selection used when no selector resolves. */
const FULL_ESCALATION: ResolvedGateSelection = {
	ansible: true,
	workflows: true,
	scripts: true,
	config: true,
	fullEscalation: true,
};

export interface DispatchPassOptions {
	/** Max jobs to dispatch this pass. */
	maxPerPass?: number;
	/**
	 * Resolve an `infra-static` job's fixed static-gate selection. Omitted =>
	 * every static-only job dispatches with a full escalation (all fixed gates).
	 */
	infraGateSelector?: InfraGateSelector;
	/**
	 * The body-only landing seam the DEDICATED infra-static exact-SHA lane
	 * uses to land its digest-bound `job.md`. Passed straight through to
	 * `dispatchJob`; required only for `infra-static` (a missing stager fails that
	 * job closed — skipped, left pending). Every other job type ignores it.
	 */
	bodyLandingStager?: BodyLandingStager;
	/** Bounded retry delay (minutes) passed through to a capacity refusal. */
	retryMinutes?: number;
	/** Clock seam for the next-attempt timestamp. */
	now?: Date;
	/**
	 * The vmids the SWEEP has already handed to a dispatch.
	 *
	 * Accepted rather than only created here because the verb lane dispatches from
	 * its OWN call site earlier in the same sweep, and the live collision
	 * was between a verb job and one of this pass's — so the
	 * ledger has to span both, and only the sweep owns that scope. Omitted, this
	 * pass still creates its own, so calling it directly de-dups WITHIN the batch;
	 * a fresh ledger per call is a fresh ledger per pass either way, which is the
	 * whole contract.
	 */
	passVmids?: PassVmids;
	/**
	 * The dispatch slots the SWEEP has left this pass, shared with the verb
	 * lane that dispatched before this pass. The shortlist limit is the smaller of
	 * `maxPerPass` and the budget's remainder, and every shortlisted row spends a
	 * slot. Omitted, `maxPerPass` alone bounds this pass — the pre-sf#445 shape a
	 * direct caller keeps.
	 */
	passBudget?: PassBudget;
	/** Error sink for a per-job dispatch failure (bounded message). */
	onError?: (error: unknown) => void;
}

/**
 * Invoke the caller's error sink without ever letting it abort the batch. A
 * monitoring/logging sink is untrusted here: if it throws, that throw must not
 * escape the per-job loop and take down dispatch + result reconciliation +
 * publication for the whole cycle. Swallow any exception it raises.
 */
function reportError(onError: DispatchPassOptions["onError"], error: unknown): void {
	try {
		onError?.(error);
	} catch (sinkErr) {
		// A faulty sink must not break per-job isolation. Nothing safe to do with a
		// logging-sink failure except drop it — debug, because the dispatch failure the
		// sink was handed is the operator-visible one.
		log("debug", "dispatch.sink_failed", { cause: errorMessage(sinkErr) });
	}
}

/**
 * Defer a skipped-but-still-pending job by the bounded cadence-relative skip-backoff.
 * Reuses `releaseJob`'s exact `{status:"pending", nextAttemptAt}` update shape,
 * so the job stays pending (revive-on-re-add preserved) but stops re-entering the
 * immediate shortlist every pass. Guarded on `expectedStatus:"pending"`: a skip-defer
 * only ever touches a still-pending row, so it can never clobber a row another path
 * just transitioned out of pending. Best-effort: a defer-write failure is isolated to
 * this job (reported, never re-thrown) so one row can never abort the batch — mirroring
 * the per-job dispatch isolation. The job remains skipped/counted either way.
 */
async function deferSkippedJob(
	db: WatcherDb,
	jobId: number,
	defer: { deferMinutes: number; now: Date },
	onError: DispatchPassOptions["onError"],
): Promise<void> {
	try {
		await releaseJob(db, jobId, addMinutes(defer.now, defer.deferMinutes), {
			now: defer.now,
			expectedStatus: "pending",
		});
	} catch (err) {
		reportError(onError, err);
	}
}

/** Per-sweep outcome for the infra-class requeue. Safe to log (no secrets). */
export interface RequeueSummary {
	/** Terminal-`failed` jobs revived to `pending` this sweep (infra-class, under budget). */
	requeued: number;
}

/**
 * Revive terminal-`failed` jobs whose failure was INFRA-CLASS — the agent/harness never
 * produced a valid result — back to `pending` for a bounded number of retries.
 *
 * Run as ONE bounded step at the TOP of a reconcile cycle (alongside {@link
 * reclaimStaleJobs}, before the dispatch pass), so the SAME cycle's dispatch pass
 * re-claims what this releases. Disjoint from the reclaimer: the reclaimer re-pends
 * IN-FLIGHT rows stranded by a crash/dead box (`dispatching`/`running`); this revives
 * TERMINAL `failed` rows whose recorded outcome proves no valid result was ever ingested.
 *
 * CLASSIFICATION KEYS ON FACTORY-SIDE PERSISTED STATE, never on re-reading runner content
 * and never on the free-text failure prose (which #93/#94 may evolve). The result store
 * (`src/results/store.ts`) records the discriminator STRUCTURALLY: an INFRA-class failure
 * (invalid/missing/unparseable/schema-invalid/ingest-rejected — no valid result) finishes
 * the owning attempt as `status='failed'`; a VERDICT-class failure (a VALID ingested result
 * whose status is `failed`) finishes the owning attempt as `status='completed'` (its
 * `failureSummary` is null) while the job goes `failed`. A terminal-`failed` job is
 * requeueable infra-class only when `terminal_reason` is NULL AND none of its attempts
 * reached `status='completed'`. A genuine review verdict left a completed attempt; a
 * watcher-terminalized row carries a reason. Neither requeues.
 *
 * BUDGET IS DERIVED FROM DURABLE ATTEMPT ROWS, not a new column. Each real dispatch writes
 * exactly one `job_attempts` row, so a job on its Nth requeue carries N+1 attempts; "fewer
 * than {@link INFRA_REQUEUE_BUDGET} requeues so far" is `attemptCount <= INFRA_REQUEUE_BUDGET`.
 * A job that has exhausted the budget is left terminal `failed` (an operator can still
 * re-run it by re-labelling / a new push).
 *
 * BOTH eligibility predicates are enforced in the SQL (a `HAVING` on the grouped attempt
 * aggregates), so the per-pass cap ({@link MAX_INFRA_REQUEUE_PER_PASS}) applies to ELIGIBLE
 * rows only — the select returns exclusively infra-class, under-budget terminal-`failed`
 * jobs. This is load-bearing: permanently-ineligible failed rows (every verdict-class
 * failure, every budget-exhausted job) accumulate forever, and filtering after a capped
 * id-ordered scan would let the lowest {@link MAX_INFRA_REQUEUE_PER_PASS} ids fill with rows
 * that can never qualify, starving the window so newer infra-class failures are never
 * reached while every sweep still runs green. Because the SQL is now the gate, the
 * two JS-side guards below are a BACKSTOP against query drift, not the eligibility check.
 *
 * The revive REUSES `releaseJob`'s exact reset (clears `activeAttemptId` per #85 — a
 * pending job has no owner — and sets a bounded `nextAttemptAt` backoff), STATUS-GUARDED on
 * `"failed"`: a row another path moved off `failed` since the select is left untouched. It
 * cannot fabricate candidate-loader eligibility: the loader keys on `jobs.status =
 * completed` + a `completed` attempt + an `accepted` posting, and this only ever writes
 * `status='pending'` and touches no attempt or posting row. Per-row failures are isolated
 * through `onError` and never abort the sweep. Pure function of `now`; no wall-clock read.
 *
 * VERB ROWS ARE EXCLUDED. `selectDuePendingJobs` already excludes verb
 * types, but this SIBLING sweep did not, and the two exclusions have to agree: a
 * verb row the verb lane deliberately left terminal is terminal-`failed` with a
 * NULL `terminalReason` and infra-class attempts, which is exactly this sweep's
 * eligibility shape. Without the exclusion such a row is revived to `pending`
 * here and then dispatched — a re-run this generic sweep is not entitled to
 * decide. Measured before the fix: a sustained loop converged at 7 boxes against
 * the stated 4.
 *
 * `src/jobs/verb-live.ts` owns the verb lane end to end and does NOT re-run a
 * terminal tuple at all: it reports the real terminal status and stops. This
 * sweep must not manufacture the re-run the owning lane declined to perform.
 *
 * @param db - watcher database
 * @param now - clock seam for the re-pend backoff time
 * @param opts - error sink for an isolated per-row revive failure
 */
/**
 * The eligible-row window this sweep may revive.
 *
 * Terminal-`failed` jobs with no watcher terminal reason, id-ordered and capped,
 * each carrying the two durable aggregates the ruling needs: total attempt rows
 * (the retry ledger for the budget) and whether ANY attempt reached `completed`
 * (a valid result was ingested — the verdict-class marker that bars requeue).
 * Both are counted from `job_attempts` alone; no new table, no re-read of runner
 * content.
 *
 * BOTH eligibility predicates live in the SQL HAVING so `.limit()` caps ELIGIBLE
 * rows only. Without it the id-ordered cap selects the first
 * MAX_INFRA_REQUEUE_PER_PASS terminal-`failed` rows and filters
 * verdict-class/budget-exhausted afterward in JS: permanently-ineligible failed
 * jobs accumulate forever, and once MAX_INFRA_REQUEUE_PER_PASS of them occupy the
 * lowest ids the scan window contains only rows that can never qualify — newer
 * infra-class failures are never reached and the requeue goes silently dead while
 * every sweep still runs green. Filtering in HAVING makes the window return
 * only infra-class, under-budget rows, so the cap cannot be starved by
 * ineligible ones.
 */
function selectRequeueCandidates(db: WatcherDb) {
	return db
		.select({
			id: jobs.id,
			attemptCount: sql<number>`count(${jobAttempts.id})`,
			completedAttempts: sql<number>`count(${jobAttempts.id}) filter (where ${jobAttempts.status} = ${INFRA_CLASS_MARKER_STATUS})`,
		})
		.from(jobs)
		.leftJoin(jobAttempts, eq(jobAttempts.jobId, jobs.id))
		.where(
			and(
				eq(jobs.status, "failed"),
				isNull(jobs.terminalReason),
				// VERB ROWS ARE NOT THIS SWEEP'S TO REVIVE — see the
				// `requeueInfraFailedJobs` docblock for the measurement and the reasoning.
				notInArray(jobs.jobType, [...VERB_IDS]),
			),
		)
		.groupBy(jobs.id)
		.having(
			and(
				// VERDICT-CLASS bar: NO attempt reached `completed` (no valid result ingested).
				sql`count(${jobAttempts.id}) filter (where ${jobAttempts.status} = ${INFRA_CLASS_MARKER_STATUS}) = 0`,
				// BUDGET bar: fewer than INFRA_REQUEUE_BUDGET requeues so far (attemptCount = requeues + 1).
				sql`count(${jobAttempts.id}) <= ${INFRA_REQUEUE_BUDGET}`,
			),
		)
		.orderBy(asc(jobs.id))
		.limit(MAX_INFRA_REQUEUE_PER_PASS);
}

export const requeueInfraFailedJobs = traced(
	"reconcile.requeueInfraFailedJobs",
	async function requeueInfraFailedJobs(
		db: WatcherDb,
		now: Date,
		opts: { onError?: (error: unknown) => void } = {},
	): Promise<RequeueSummary> {
		const summary: RequeueSummary = { requeued: 0 };
		const candidates = await selectRequeueCandidates(db);

		for (const row of candidates) {
			// Bun.sql returns aggregate counts as strings; coerce before comparing so the
			// budget check is numeric, not lexicographic.
			const attemptCount = Number(row.attemptCount);
			const completedAttempts = Number(row.completedAttempts);

			// BACKSTOP (defense in depth): the SQL HAVING above is the gate — the select
			// already returns only infra-class, under-budget rows. These two guards remain
			// only to catch a query drift (a HAVING clause edited out of sync with these
			// constants); in normal operation neither continue is reached.
			//
			// VERDICT-CLASS bar: a valid result was ingested (some attempt completed).
			if (completedAttempts > 0) {
				continue;
			}
			// BUDGET: fewer than INFRA_REQUEUE_BUDGET requeues have happened. attemptCount is
			// requeues+1, so allow while attemptCount <= INFRA_REQUEUE_BUDGET.
			if (attemptCount > INFRA_REQUEUE_BUDGET) {
				continue;
			}

			try {
				// Guarded on `failed` so a row another path moved off `failed` since the
				// select is not clobbered; reuses releaseJob's activeAttemptId-clearing reset.
				const revived = await releaseJob(
					db,
					row.id,
					addMinutes(now, INFRA_REQUEUE_BACKOFF_MINUTES),
					{
						now,
						expectedStatus: "failed",
					},
				);
				if (revived) {
					summary.requeued++;
					log("info", "requeue.infra_failed", { job_id: row.id, attempts: attemptCount });
				}
			} catch (err) {
				reportError(opts.onError, err);
			}
		}

		return summary;
	},
);

/**
 * Dispatch the due pending jobs, bounded and idempotent.
 *
 * Selection is due-`pending` only (a `nextAttemptAt` in the future is deferred),
 * ordered by id and capped, so the batch is bounded. Each job's atomic claim in
 * `dispatchJob` (pending -> dispatching, guarded by the current status) makes the
 * loop safe to run concurrently with another pass and idempotent against a job
 * already running/dispatched: the loser is `skipped`, never re-dispatched. A job
 * whose type has no allowlisted template is skipped without allocating a runner.
 *
 * @param db - watcher database
 * @param transport - runner-box verb contract
 * @param config - loaded watcher configuration (owns the template allowlist)
 * @param opts - bounds, retry delay, clock, and error sink
 */
export const dispatchPendingJobs = traced(
	"reconcile.dispatchPendingJobs",
	async function dispatchPendingJobs(
		db: WatcherDb,
		transport: RunnerTransport,
		config: WatcherConfig,
		opts: DispatchPassOptions = {},
	): Promise<DispatchPassSummary> {
		const now = opts.now ?? new Date();
		const maxPerPass = resolveDispatchCap(opts.maxPerPass);
		// Cadence-relative skip-backoff: robustly exceeds the poll interval so a batch of
		// deferred low-id skips contends on only 1-in-N sweeps and can no longer starve
		// newer due jobs. Pure function of config + `now`.
		const deferMinutes = skipDeferMinutes(config);
		// SAME-PASS VMID DE-DUP. One ledger for the whole batch, shared with the
		// sweep's verb lane when the sweep supplies one.
		const passVmids = opts.passVmids ?? createPassVmids();
		// ONE budget either way: the sweep's shared one, or a private one of the whole
		// cap for a standalone pass, so the paging below has a single "slots left".
		const passBudget = opts.passBudget ?? createPassBudget(maxPerPass);

		// The CURRENT managed-repository allowlist, re-read from config every pass. A
		// pending job whose repo is no longer here (operator removed it from
		// config/repos.yml) must not dispatch, even though it was queued when managed.
		const managedRepos = new Set(config.repositories.map((r) => `${r.provider}\u0000${r.name}`));

		const summary: DispatchPassSummary = {
			selected: 0,
			dispatched: 0,
			queued: 0,
			skipped: 0,
			errored: 0,
		};
		const page: ShortlistPage = {
			db,
			transport,
			config,
			opts: { ...opts, now, passVmids, passBudget },
			prepare: { managedRepos, deferMinutes, now, ...gateAndSink(opts) },
			summary,
			seen: [],
		};

		// PAGED REFILL. A cap-sized page at a time, excluding the
		// rows already seen, until the slots are spent, the due rows run out, or the
		// page bound is hit; a row the preparer skips is thereby replaced by the next
		// due row instead of consuming one of the pass's slots.
		for (let pages = 0; pages < MAX_SHORTLIST_PAGES; pages++) {
			if (budgetSpent(passBudget, maxPerPass, pages)) break;
			const due = await selectDuePendingJobs(db, now, maxPerPass, page.seen);
			summary.selected += due.length;
			const outcome = await dispatchShortlistPage(due, page);
			if (outcome === "exhausted" || due.length < maxPerPass) break;
		}
		return summary;
	},
);

/** The per-pass context one shortlist page is prepared and dispatched under. */
interface ShortlistPage {
	db: WatcherDb;
	transport: RunnerTransport;
	config: WatcherConfig;
	opts: DispatchPassOptions & { now: Date; passVmids: PassVmids; passBudget: PassBudget };
	prepare: PrepareContext;
	summary: DispatchPassSummary;
	/** Ids every page of this pass has read, excluded from the next page. */
	seen: number[];
}

/** The optional preparer inputs, spread only when the caller supplied them. */
function gateAndSink(opts: DispatchPassOptions): Partial<PrepareContext> {
	return {
		...(opts.infraGateSelector ? { infraGateSelector: opts.infraGateSelector } : {}),
		...(opts.onError ? { onError: opts.onError } : {}),
	};
}

/**
 * True once the budget has no slot left. LOGGED when that is already so before
 * the first page (the sweep's verb lane spent every slot), because a
 * pass that selects nothing is otherwise byte-for-byte what an idle watcher
 * looks like; a budget spent mid-pass was logged where the slot was refused.
 */
function budgetSpent(budget: PassBudget, maxPerPass: number, pages: number): boolean {
	if (budget.remaining() > 0) return false;
	if (pages === 0) {
		log("info", "dispatch.pass_budget_exhausted", {
			reason: "the sweep's verb lane spent every slot; generic rows wait for the next pass",
			max_per_pass: maxPerPass,
			budget_max: budget.max,
		});
	}
	return true;
}

/**
 * Prepare and dispatch one page of the shortlist. Returns `exhausted` when the
 * budget refused a slot mid-page (the rest of the page stays pending and due),
 * else `drained` once every row was prepared.
 */
async function dispatchShortlistPage(
	due: readonly DuePendingJob[],
	page: ShortlistPage,
): Promise<"exhausted" | "drained"> {
	const { db, transport, config, opts, summary } = page;
	for (const row of due) {
		page.seen.push(row.id);
		const job = { job_id: row.id };
		const prepared = await withLogFields(job, () =>
			prepareDispatchableJob(db, config, row, page.prepare),
		);
		if (prepared === null) {
			// Skipped, and already deferred with bounded backoff by the preparer.
			summary.skipped++;
			continue;
		}
		// RESERVE the sweep's slot here, the last gate before a box; the rows after
		// this one stay pending and due when none is left.
		if (!opts.passBudget.take()) {
			log("info", "dispatch.pass_budget_exhausted", { max_per_pass: opts.passBudget.max });
			return "exhausted";
		}
		await withLogFields(job, () =>
			dispatchOnePreparedJob(db, transport, prepared, { opts, summary, jobId: row.id }),
		);
	}
	return "drained";
}

/** A prepared job plus the allowlisted template it dispatches through. */
interface PreparedDispatch {
	job: DispatchableJob;
	template: NonNullable<ReturnType<typeof resolveTemplate>>;
}

/** The per-pass context one row is re-gated against. */
interface PrepareContext {
	managedRepos: ReadonlySet<string>;
	deferMinutes: number;
	now: Date;
	infraGateSelector?: InfraGateSelector;
	onError?: (error: unknown) => void;
}

/**
 * NAME THE TEMPLATE REFUSAL.
 *
 * This defer used to log NOTHING, so a job whose template was not allowlisted was
 * re-deferred every cycle in total silence: a journal census over a whole live
 * window carried 30 kboard lines and not one word about the stranded job, which
 * was findable only by querying the `jobs` table by hand (2026-08-02, job 715).
 * That is trap #84 one layer up — a PRESENT, REFUSING gate is indistinguishable
 * from a passing one unless it says so. The defer BEHAVIOUR is unchanged; this
 * only makes it visible.
 *
 * Bounded fields only: two identifiers and the job type, which is a registry id
 * or an operator-config string, never repository content.
 */
function logTemplateRefusal(row: DuePendingJob): void {
	log("warn", "dispatch.template_not_allowlisted", {
		reason: "job type resolves to no allowlisted template; deferring, not dispatching",
		job_id: row.id,
		repository: row.repository,
		template_id: row.jobType,
	});
}

/**
 * NAME THE UNMANAGED-REPOSITORY REFUSAL.
 *
 * The sibling of `logTemplateRefusal` above, and silent for exactly the same
 * reason until now: #144 gave the template branch a name and left this one
 * without, so a job whose repository the operator de-scoped defers every cycle
 * without a word. Same trap #84 shape — a present, refusing gate must not look
 * like a passing one. The defer BEHAVIOUR is unchanged; this only makes it
 * visible.
 *
 * `provider` is the RAW stored string, not a parsed `Provider`: this branch is
 * reached precisely when the value may be unparseable, so it is logged as the
 * untrusted input it is. `log()` bounds every context value, which is why
 * `logTemplateRefusal` calls no `bounded()` either.
 */
function logUnmanagedRepoRefusal(row: DuePendingJob): void {
	log("warn", "dispatch.repo_not_managed", {
		reason: "repository is not in the managed allowlist; deferring, not dispatching",
		job_id: row.id,
		repository: row.repository,
		provider: row.provider,
	});
}

/**
 * NAME THE ITEM-ELIGIBILITY REFUSAL.
 *
 * The third sibling of the two refusals above, and it must be as visible as they
 * are for the same trap #84 reason. Bounded fields only: two identifiers, the item
 * number, and the item's own state string — watcher-observed forge metadata, never
 * repository content. `log()` bounds every context value.
 */
function logItemEligibilityRefusal(row: DuePendingJob): void {
	log("warn", "dispatch.item_not_eligible", {
		reason: "item is closed or its head moved off the job SHA; deferring, not dispatching",
		job_id: row.id,
		repository: row.repository,
		item_number: row.itemNumber,
		item_state: row.itemState,
	});
}

/**
 * The bounded terminal reason a dispatch-time reap writes. Deliberately
 * the SAME sentence the result-time path records for the same condition,
 * so an operator reading `terminal_reason` sees one string for "the item went away
 * under this job", not two spellings of it — with the clause that says WHICH side
 * closed the row, because only the dispatch side proves no box was ever spent.
 */
export const ITEM_REAPED_TERMINAL_REASON =
	"terminal: item is no longer eligible (closed, or head moved off the job SHA); " +
	"dispatch-time eligibility gap, sf#429";

/**
 * NAME THE REAP.
 *
 * Distinct msg from `dispatch.item_not_eligible` because the OUTCOME is distinct:
 * that line means "deferred, will be reconsidered", this one means "this row is
 * over". An operator grepping for one must never match the other. Bounded fields
 * only, the same four the refusal logs.
 */
function logItemReaped(row: DuePendingJob): void {
	log("warn", "dispatch.item_reaped", {
		reason: "item is closed; terminalizing, not deferring",
		job_id: row.id,
		repository: row.repository,
		item_number: row.itemNumber,
		item_state: row.itemState,
	});
}

/**
 * TERMINALIZE a due row whose item is CLOSED, instead of deferring it.
 *
 * A closed item is not recoverable by waiting, which is what separates it from the
 * other two refusals (de-scoped repository, de-allowlisted template) where the
 * operator can restore the condition and the deferred row should revive. Reopening
 * an item fires an `issues` webhook that queues a NEW job, so this row's only
 * remaining futures are zombie or duplicate — and as a zombie it re-armed every
 * `skipDeferMinutes()` and re-took the id-ordered shortlist slot forever. Observed
 * live 2026-08-30: 41 such rows (ids 7855–9007) starving a fresh implement-lane job
 * at `MAX_DISPATCH_PER_PASS=3`.
 *
 * Guarded on `status = "pending"` so this cannot stomp a row a concurrent pass
 * claimed between the shortlist read and here — the same guard shape
 * `deferSkippedJob` relies on. `nextAttemptAt` is cleared, not pushed out: a
 * terminal row must never re-arm.
 *
 * @returns `null`, always, so a caller reads `return await reapIneligibleJob(...)`.
 */
async function reapIneligibleJob(
	db: WatcherDb,
	row: DuePendingJob,
	ctx: PrepareContext,
): Promise<null> {
	try {
		const reaped = await db.transaction(async (tx) => {
			const updated = await tx
				.update(jobs)
				.set({
					status: "failed",
					terminalReason: ITEM_REAPED_TERMINAL_REASON,
					nextAttemptAt: null,
					updatedAt: ctx.now,
				})
				.where(and(eq(jobs.id, row.id), eq(jobs.status, "pending")))
				.returning({ id: jobs.id });
			if (updated.length !== 1) {
				return false;
			}

			// The guarded transition and its durable notice share one commit boundary.
			// A missing SHA intentionally produces no check; the terminal row and its
			// existing bounded warning remain the only record for that job.
			await persistTerminalCheck(
				tx,
				{ jobId: row.id, sha: row.sha },
				ITEM_REAPED_TERMINAL_REASON,
				ctx.now,
			);
			return true;
		});
		// Log only after the guarded update and notice enqueue have committed. A lost
		// race or a failed transaction must not claim a reap.
		if (reaped) logItemReaped(row);
	} catch (err) {
		reportError(ctx.onError, err);
	}
	return null;
}

/**
 * Log a named refusal and DEFER the row with bounded skip-backoff — the one shape
 * every skip branch in `prepareDispatchableJob` shares. Extracted when the sf#429
 * item-eligibility gate made it the third identical copy; the behaviour of each
 * branch is unchanged, only the duplication is gone.
 *
 * @returns `null`, always, so a caller reads `return await refuseAndDefer(...)`.
 */
async function refuseAndDefer(
	db: WatcherDb,
	row: DuePendingJob,
	ctx: PrepareContext,
	logRefusal: (row: DuePendingJob) => void,
): Promise<null> {
	logRefusal(row);
	await deferSkippedJob(db, row.id, { deferMinutes: ctx.deferMinutes, now: ctx.now }, ctx.onError);
	return null;
}

/**
 * Re-gate one due row against the CURRENT config and build its dispatchable job.
 *
 * Returns `null` when the row must NOT dispatch: an unparseable provider, a
 * repository the operator removed from the managed allowlist since the job was
 * queued, a job type with no allowlisted template, or an item that is no longer
 * eligible — closed, or a PR whose head moved off this job's SHA. None of
 * those is a runner
 * fault, so none errors the job — each DEFERS the row with bounded skip-backoff so
 * it drops out of the immediate shortlist instead of re-entering at the front every
 * pass and starving newer jobs. The row stays `pending`, so re-adding the
 * repository or re-allowlisting the template revives it after the window.
 *
 * ONE EXCEPTION: a CLOSED item is not a recoverable condition, so that row
 * is TERMINALIZED here rather than deferred. See {@link reapIneligibleJob}. A
 * head-moved refusal on an item that is still OPEN keeps the defer.
 *
 * @returns the prepared job and its template, or `null` when the row was skipped
 */
async function prepareDispatchableJob(
	db: WatcherDb,
	config: WatcherConfig,
	row: DuePendingJob,
	ctx: PrepareContext,
): Promise<PreparedDispatch | null> {
	const provider = parseProvider(row.provider);
	if (provider === null || !ctx.managedRepos.has(`${provider}\u0000${row.repository}`)) {
		return await refuseAndDefer(db, row, ctx, logUnmanagedRepoRefusal);
	}

	const template = resolveTemplate(config, row.jobType);
	if (template === null) {
		return await refuseAndDefer(db, row, ctx, logTemplateRefusal);
	}

	// GATE ON THE ITEM'S LIVE STATE. `isItemEligible` used to be enforced
	// only at RESULT time, so a job for a closed item — or for a PR whose head had
	// moved off this job's pinned SHA — still allocated a runner box, ran, and then
	// failed ingest with "runner result identity is invalid". Checking it HERE spends
	// no box on a result that can never be published. A job bound to no item
	// (repo-scoped lanes) has no item state to gate on and is not gated.
	if (
		row.itemNumber !== null &&
		!isItemEligible({
			kind: row.itemKind,
			state: row.itemState,
			headSha: row.itemHeadSha,
			jobSha: row.sha,
		})
	) {
		// TWO OUTCOMES, NOT ONE. A CLOSED item is terminal — waiting cannot
		// make it eligible again, and a deferred row re-arms forever and starves the
		// id-ordered shortlist. A head that moved on an item still OPEN is genuinely
		// recoverable (a force-push race can settle back), so that keeps the defer.
		if (row.itemState !== "open") {
			return await reapIneligibleJob(db, row, ctx);
		}
		return await refuseAndDefer(db, row, ctx, logItemEligibilityRefusal);
	}

	// The issue-triage vocabulary for THIS repository, resolved from the live
	// config on the provider-qualified identity — the same key the managed allowlist
	// above uses. Only the issue-triage body reads it; every other job type leaves it
	// undefined and ignores it.
	const repoConfig =
		row.jobType === TRIAGE_TEMPLATE_ID
			? config.repositories.find((r) => r.provider === provider && r.name === row.repository)
			: undefined;

	return {
		template,
		job: {
			id: row.id,
			sha: row.sha,
			jobType: row.jobType,
			repository: row.repository,
			provider,
			itemNumber: row.itemNumber ?? undefined,
			staticOnly: row.checks === "static-only",
			gateSelection: await resolveInfraGateSelection(row, ctx.infraGateSelector, ctx.onError),
			triageLabels: repoConfig?.triage_labels,
			// The prior terminal attempt's reason. Normalized null -> undefined
			// so a job with no prior failure carries NO field at all, which is what
			// keeps a first-attempt render byte-identical to today's: the builder
			// supplies tier-2 extras only when this is present and non-empty.
			previousFailure: row.previousFailure ?? undefined,
		},
	};
}

/**
 * Resolve the fixed static-gate selection for an infra-static job. ANY fault in the
 * injected selector degrades to a FULL escalation — a widened, never a narrowed,
 * static check set — so one job's read failure can never skip a gate. Every other
 * job type resolves `undefined` and ignores gate selection entirely.
 */
async function resolveInfraGateSelection(
	row: DuePendingJob,
	selector: InfraGateSelector | undefined,
	onError?: (error: unknown) => void,
): Promise<ResolvedGateSelection | undefined> {
	if (row.jobType !== "infra-static") {
		return undefined;
	}
	if (!selector) {
		return FULL_ESCALATION;
	}
	try {
		return await selector({
			repository: row.repository,
			itemNumber: row.itemNumber,
			itemKind: row.itemKind,
			// Bind gate selection to the job's exact pinned SHA, not the PR's current
			// head: the selector verifies the head matches this SHA and fails closed to a
			// full escalation otherwise (exact-SHA binding).
			sha: row.sha,
		});
	} catch (err) {
		reportError(onError, err);
		return FULL_ESCALATION;
	}
}

/**
 * NAME THE ALLOCATION REFUSAL.
 *
 * The `"queued"` outcome carries a `reason` and used to DISCARD it: with the
 * template correctly allowlisted, job 715 reached `transport.needed()`, the 90xx
 * pool was exhausted by stray boxes, allocation was refused, and the job was
 * released +15 minutes in total silence (live, 2026-08-02). Recovering that took
 * a five-hop forensic investigation — DB timestamp archaeology, journal
 * correlation, fleet listing — to learn what this one line says. The `"error"`
 * arm beside it always reported; this one did not, so a refusing allocator and a
 * dead dispatcher looked identical (trap #84).
 *
 * `reason` originates in transport code — `allocation.reason`, or one of two
 * fixed strings (`"unexpected box count"`, `"no box returned"`) — and never in
 * repository content. It is logged through `log()`, which bounds every context
 * value regardless, exactly as `logTemplateRefusal` relies on.
 *
 * Extracted as a helper rather than inlined so `dispatchOnePreparedJob` stays
 * under the 50-line function ceiling.
 */
function logAllocationRefusal(
	prepared: PreparedDispatch,
	outcome: { retryAfterMinutes: number; reason: string },
): void {
	log("warn", "dispatch.allocation_refused", {
		reason: outcome.reason,
		job_id: prepared.job.id,
		repository: prepared.job.repository,
		template_id: prepared.job.jobType,
		retry_after_minutes: outcome.retryAfterMinutes,
	});
}

/**
 * Dispatch one prepared job and fold its outcome into the pass summary. One job's
 * failure is ISOLATED: it never aborts the batch and never advances a cursor
 * (cursors are owned by `runPass`, which already ran).
 */
async function dispatchOnePreparedJob(
	db: WatcherDb,
	transport: RunnerTransport,
	prepared: PreparedDispatch,
	ctx: {
		opts: DispatchPassOptions & { now: Date; passVmids: PassVmids };
		summary: DispatchPassSummary;
		jobId: number;
	},
): Promise<void> {
	const { opts, summary, jobId } = ctx;
	try {
		const outcome = await dispatchJob({
			db,
			transport,
			job: prepared.job,
			template: prepared.template,
			retryMinutes: opts.retryMinutes,
			now: opts.now,
			bodyLandingStager: opts.bodyLandingStager,
			passVmids: opts.passVmids,
		});
		// The slot reserved by the caller is refunded only on PROOF of no box;
		// a throw below keeps it, because a thrown dispatch
		// cannot prove the box is not running.
		settleReservation(opts.passBudget, outcome);
		switch (outcome.status) {
			case "dispatched":
				summary.dispatched++;
				break;
			case "queued":
				summary.queued++;
				logAllocationRefusal(prepared, outcome);
				break;
			case "skipped":
				summary.skipped++;
				break;
			case "error":
				// `dispatchJob` already released the job to pending with backoff and
				// recorded the failed attempt. One job's error must not abort the batch.
				summary.errored++;
				reportError(opts.onError, new Error(`dispatch failed for job ${jobId}: ${outcome.reason}`));
				break;
		}
	} catch (err) {
		// Defence-in-depth: `dispatchJob` handles its own failures, but an unexpected
		// throw here is isolated to this job and never aborts the batch or advances a
		// cursor (cursors are owned by runPass, which ran first).
		summary.errored++;
		reportError(opts.onError, err);
	}
}
