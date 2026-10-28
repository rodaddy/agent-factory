/**
 * @module observability/postings-absence-alert
 * @description sf#605 (605d), sf#901: the absence-of-postings alert, over a
 *   ROLLING window. A lane that has a dispatch older than
 *   `postings_absence_minutes` (default 30) with NO posting on any of its jobs
 *   dispatched since then raises one `[monitoring-critical]` issue through the
 *   existing critical-alert egress. That is the 2026-08-18 outage shape: jobs
 *   dispatched, nobody heard back -- and it can start mid-life, so a lane that
 *   posted once at boot and then went silent still alerts.
 *
 *   THE POSTING READ IS `readLaneTallies` (doctor/deploy-verdicts), not a second
 *   query: the alert and `doctor deploy-verdicts` must agree on what a posting
 *   is. A posting there is a published, non-shadow verdict; `job_attempts.status`
 *   is never read as success (AGENTS.md trap). This module only lists dispatch
 *   TIMES, then asks `readLaneTallies(since = a dispatch)` whether anything
 *   dispatched from there on has posted. Postings-since is monotone in the
 *   dispatch, so the oldest unposted dispatch is a binary search.
 *
 *   A lane whose oldest unposted dispatch is inside the window does not alert:
 *   nothing is late yet. The scan looks back 24 h from now, so a restart does not reset it.
 *
 *   The dedupe identity is `postings-absence:<lane>` and nothing else; the cause
 *   (oldest unposted dispatch, job count) is body text. It never closes an
 *   issue: the operator does. Closing it marks the incident handled: this class
 *   dedupes against OPEN issues only (critical-alert), so the next
 *   absence opens a fresh issue.
 *
 * @outputs
 *   - `postingsAbsenceAlertClass` -- the per-lane dedupe identity
 *   - `absentLanes` -- the rolling-window decision over the watcher db
 *   - `runPostingsAbsenceAlert` -- decide and raise one alert per lane
 *   - `runCycleAlerts` -- the reconcile-cycle alert step: build-bump, then this
 *
 * @dependencies
 *   - ../doctor/deploy-verdicts -- `readLaneTallies`, the ONE posting query
 *   - ./build-bump-alert -- the build-bump alert this step runs first
 *   - ./critical-alert -- the ONE `[monitoring-critical]` egress
 */
import { and, eq, gte, inArray, min } from "drizzle-orm";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { forgeRuns, jobAttempts, jobs } from "../db/schema";
import { type LaneTally, readLaneTallies } from "../doctor/deploy-verdicts";
import { WORKFLOW_CONTEXT } from "../forge/settle-runs";
import { traced } from "../log";
import { runBuildBumpAlerts } from "./build-bump-alert";
import { type CriticalAlertTarget, raiseCriticalAlert } from "./critical-alert";

// Re-exported so `service-cycle` names one module for the alert step (see
// `runCycleAlerts`).
export type { CriticalAlertTarget };

/** Default window when `postings_absence_minutes` is absent. */
const DEFAULT_ABSENCE_MINUTES = 30;

/**
 * How far back the scan reads dispatches, from the database, so a watcher
 * restart does not reset it. Not longer than the 24 h window `selectDueRuns`
 * settles (forge/settle-runs): an older forge_runs row stays `dispatched`
 * forever and would alert forever.
 */
const LOOKBACK_MS = 24 * 60 * 60_000;

/** One lane that has earned an alert. */
export interface AbsentLane {
	lane: string;
	dispatched: number;
	oldestAt: Date;
}

/** The dedupe identity for one lane's absence alert. */
export const postingsAbsenceAlertClass = traced(
	"observability.postingsAbsenceAlertClass",
	function postingsAbsenceAlertClass(lane: string): string {
		return `postings-absence:${lane}`;
	},
);

/** Every lane's dispatch times (ms epoch) since `since`, keyed as `readLaneTallies` keys them. */
async function readDispatchTimes(db: WatcherDb, since: Date): Promise<Map<string, number[]>> {
	const out = new Map<string, number[]>();
	const add = (lane: string, at: Date) => out.set(lane, [...(out.get(lane) ?? []), at.getTime()]);
	const jobRows = await db
		.select({ lane: jobs.jobType, at: min(jobAttempts.startedAt) })
		.from(jobs)
		.innerJoin(jobAttempts, eq(jobAttempts.jobId, jobs.id))
		.where(gte(jobAttempts.startedAt, since))
		.groupBy(jobs.id);
	for (const r of jobRows) add(r.lane, r.at ?? since);
	const runs = await db
		.select({ lane: forgeRuns.workflow, at: forgeRuns.dispatchedAt })
		.from(forgeRuns)
		.where(
			and(
				gte(forgeRuns.dispatchedAt, since),
				// Only workflows settleForgeRuns settles; the rest stay `dispatched` forever.
				inArray(forgeRuns.workflow, Object.keys(WORKFLOW_CONTEXT)),
			),
		);
	for (const r of runs) add(r.lane, r.at);
	return out;
}

/** A posting is any verdict (ok, failed) or an audit's completed-with-nothing. */
function hasPosted(t: LaneTally | undefined): boolean {
	return t !== undefined && t.ok + t.failed + t.nothing > 0;
}

/** `readLaneTallies` memoised per `since` for one pass. */
type TallyReader = (since: number) => Promise<Map<string, LaneTally>>;

/**
 * The lane's OLDEST dispatch at or before `cutoff` with no posting on any job
 * dispatched from it on, or null when the latest such dispatch has a posting
 * after it. Binary search: postings-since only shrinks as the dispatch moves later.
 */
async function oldestUnposted(
	lane: string,
	times: number[],
	cutoff: number,
	read: TallyReader,
): Promise<AbsentLane | null> {
	const late = times.filter((t) => t <= cutoff).sort((a, b) => a - b);
	const quiet = async (i: number) => !hasPosted((await read(late[i] ?? 0)).get(lane));
	if (late.length === 0 || !(await quiet(late.length - 1))) return null;
	let lo = 0;
	let hi = late.length - 1;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (await quiet(mid)) hi = mid;
		else lo = mid + 1;
	}
	const since = late[lo] ?? 0;
	const tally = (await read(since)).get(lane);
	return { lane, dispatched: tally?.dispatched ?? 0, oldestAt: new Date(since) };
}

/**
 * Lanes with a dispatch at or before `cutoff` and no posting since it, scanning
 * dispatches back to `since` (now minus the 24 h lookback). Sorted by lane name.
 */
export const absentLanes = traced(
	"observability.absentLanes",
	async function absentLanes(db: WatcherDb, since: Date, cutoff: Date): Promise<AbsentLane[]> {
		const memo = new Map<number, Promise<Map<string, LaneTally>>>();
		const read: TallyReader = (at) => {
			const hit = memo.get(at) ?? readLaneTallies(db, new Date(at));
			memo.set(at, hit);
			return hit;
		};
		const times = await readDispatchTimes(db, since);
		const out: AbsentLane[] = [];
		for (const lane of [...times.keys()].sort()) {
			const found = await oldestUnposted(lane, times.get(lane) ?? [], cutoff.getTime(), read);
			if (found !== null) out.push(found);
		}
		return out;
	},
);

/** Test seam: the current time. */
export interface AbsenceClock {
	now: Date;
}

/**
 * Raise one `[monitoring-critical]` alert per lane with a dispatch past the
 * window and no posting since it. Never throws past the egress; a db error
 * rejects and the cycle's `.catch(onError)` reports it.
 */
export const runPostingsAbsenceAlert = traced(
	"observability.runPostingsAbsenceAlert",
	async function runPostingsAbsenceAlert(
		db: WatcherDb,
		target: CriticalAlertTarget | undefined,
		config: WatcherConfig,
		clock: AbsenceClock = { now: new Date() },
	): Promise<void> {
		const minutes = config.postings_absence_minutes ?? DEFAULT_ABSENCE_MINUTES;
		const cutoff = new Date(clock.now.getTime() - minutes * 60_000);
		const since = new Date(clock.now.getTime() - LOOKBACK_MS);
		for (const lane of await absentLanes(db, since, cutoff)) {
			await raiseCriticalAlert(target, {
				alertClass: postingsAbsenceAlertClass(lane.lane),
				cause:
					`lane ${lane.lane}: ${lane.dispatched} job(s) dispatched since ` +
					`${lane.oldestAt.toISOString()} (the oldest unposted dispatch), ` +
					`0 postings after ${minutes} minutes`,
			});
		}
	},
	// The target carries a credential-resolving closure.
	{ redact: { args: [1] } },
);

/**
 * The reconcile-cycle alert step: the build-bump alerts, then the postings-absence
 * alert beside them. Each is isolated: a rejection reaches `onError` and the
 * next still runs. One entry point so `service-cycle` stays inside its
 * `lint:size` bound.
 */
export const runCycleAlerts = traced(
	"observability.runCycleAlerts",
	async function runCycleAlerts(
		db: WatcherDb,
		target: CriticalAlertTarget | undefined,
		config: WatcherConfig,
		onError: (error: unknown) => void,
	): Promise<void> {
		await runBuildBumpAlerts(db, target, config).catch(onError);
		await runPostingsAbsenceAlert(db, target, config).catch(onError);
	},
	// The target carries a credential-resolving closure.
	{ redact: { args: [1] } },
);
