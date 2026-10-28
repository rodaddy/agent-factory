/**
 * @module reconcile/build-bump-merge-watch
 * @description Watches opened build-bump PRs on `rtech/k3s-deploy` until they
 *   merge or close, asks Argo for a hard refresh after a merge, and answers
 *   whether the rail is IN FLIGHT (sf#1076 rows 0c/0d).
 *
 *   The in-flight windows bound the 20 s follow-through: a bump PR a human never
 *   merges (a prod bump) cannot hold the watcher in a 20 s loop past an hour
 *   (`FOLLOW_THROUGH_WINDOW_MS`), and a merged bump awaiting its Argo refresh
 *   holds it for at most `ARGO_PENDING_WINDOW_MS`. After the window the
 *   15-minute sweep still runs the merge watch for 24 h (`MERGE_WATCH_WINDOW_MS`).
 */
import { and, asc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { buildBumpBumps, buildBumpCandidates } from "../db/schema";
import type { PullRequestMergeState } from "../forgejo/pull-state";
import { bounded, errorClass, errorMessage, log, traced } from "../log";
import type { ArgoRefresh } from "./argo-refresh";

export const MERGE_WATCH_WINDOW_MS = 24 * 60 * 60_000;
export const FOLLOW_THROUGH_WINDOW_MS = 60 * 60_000;
export const ARGO_PENDING_WINDOW_MS = 10 * 60_000;
export const FOLLOW_THROUGH_DELAY_MS = 20_000;
export const MERGE_WATCH_BATCH = 50;

/** Seams for the merge watch. `readPull` always reads `BUMP_RECEIPT_REPOSITORY`. */
export interface MergeWatchDeps {
	readPull: (pr: number) => Promise<PullRequestMergeState>;
	refreshArgo: ArgoRefresh | null;
	now: () => Date;
}

interface WatchCounts {
	checked: number;
	merged: number;
	closed: number;
	refreshed: number;
}

type WatchRow = { id: number; appDir: string; pr: number | null };

const ago = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

/** Parse the forge's merge time, falling back to `now` when absent or unparseable. */
function mergeTime(mergedAt: string | null, now: Date): Date {
	if (mergedAt === null) return now;
	const t = Date.parse(mergedAt);
	return Number.isNaN(t) ? now : new Date(t);
}

/** Read one bump PR and record a merge or an unmerged close. Returns what happened. */
async function watchOne(
	db: WatcherDb,
	row: WatchRow & { pr: number },
	deps: MergeWatchDeps,
): Promise<"merged" | "closed" | null> {
	const state = await deps.readPull(row.pr);
	const ctx = { bumpId: row.id, appDir: row.appDir, pr: row.pr };
	if (state.merged) {
		await db
			.update(buildBumpBumps)
			.set({ mergedAt: mergeTime(state.mergedAt, deps.now()) })
			.where(and(eq(buildBumpBumps.id, row.id), isNull(buildBumpBumps.mergedAt)));
		log("info", "build_bump.bump_merged", ctx);
		return "merged";
	}
	if (state.state === "closed") {
		await db
			.update(buildBumpBumps)
			.set({ prClosedAt: deps.now() })
			.where(and(eq(buildBumpBumps.id, row.id), isNull(buildBumpBumps.prClosedAt)));
		log("info", "build_bump.bump_closed_unmerged", ctx);
		return "closed";
	}
	return null;
}

/** Poll every opened, unresolved bump settled within the 24 h window. */
async function pollOpened(db: WatcherDb, deps: MergeWatchDeps, counts: WatchCounts): Promise<void> {
	const rows = await db
		.select({ id: buildBumpBumps.id, appDir: buildBumpBumps.appDir, pr: buildBumpBumps.pr })
		.from(buildBumpBumps)
		.where(
			and(
				eq(buildBumpBumps.status, "opened"),
				isNotNull(buildBumpBumps.pr),
				isNull(buildBumpBumps.mergedAt),
				isNull(buildBumpBumps.prClosedAt),
				gte(buildBumpBumps.settledAt, ago(deps.now(), MERGE_WATCH_WINDOW_MS)),
			),
		)
		.orderBy(asc(buildBumpBumps.id))
		.limit(MERGE_WATCH_BATCH);
	for (const row of rows) {
		if (row.pr === null) continue;
		counts.checked += 1;
		try {
			const outcome = await watchOne(db, { ...row, pr: row.pr }, deps);
			if (outcome !== null) counts[outcome] += 1;
		} catch (e) {
			log("warn", "build_bump.merge_watch.read_failed", {
				bumpId: row.id,
				pr: row.pr,
				errorClass: errorClass(e),
			});
		}
	}
}

/** Hard-refresh Argo for every merged, unrefreshed bump within the 24 h window. */
async function refreshMerged(
	db: WatcherDb,
	deps: MergeWatchDeps,
	refresh: ArgoRefresh,
	counts: WatchCounts,
): Promise<void> {
	const rows = await db
		.select({ id: buildBumpBumps.id, appDir: buildBumpBumps.appDir, pr: buildBumpBumps.pr })
		.from(buildBumpBumps)
		.where(
			and(
				isNotNull(buildBumpBumps.mergedAt),
				isNull(buildBumpBumps.argoRefreshedAt),
				gte(buildBumpBumps.mergedAt, ago(deps.now(), MERGE_WATCH_WINDOW_MS)),
			),
		)
		.orderBy(asc(buildBumpBumps.id))
		.limit(MERGE_WATCH_BATCH);
	for (const row of rows) {
		try {
			await refresh(row.appDir);
			await db
				.update(buildBumpBumps)
				.set({ argoRefreshedAt: deps.now() })
				.where(eq(buildBumpBumps.id, row.id));
			counts.refreshed += 1;
			log("info", "build_bump.argo_refreshed", { bumpId: row.id, appDir: row.appDir, pr: row.pr });
		} catch (e) {
			log("warn", "build_bump.argo_refresh_failed", {
				bumpId: row.id,
				appDir: row.appDir,
				errorClass: errorClass(e),
				message: bounded(errorMessage(e)),
			});
		}
	}
}

/** One merge-watch pass: poll opened bump PRs, then refresh Argo for merged ones. */
async function runBumpMergeWatchImpl(db: WatcherDb, deps: MergeWatchDeps): Promise<WatchCounts> {
	const counts: WatchCounts = { checked: 0, merged: 0, closed: 0, refreshed: 0 };
	await pollOpened(db, deps, counts);
	if (deps.refreshArgo !== null) await refreshMerged(db, deps, deps.refreshArgo, counts);
	return counts;
}

/** Whether a build Job started within the follow-through window is still building. */
async function buildingRecently(db: WatcherDb, now: Date): Promise<boolean> {
	const rows = await db
		.select({ one: sql<number>`1` })
		.from(buildBumpCandidates)
		.where(
			and(
				eq(buildBumpCandidates.status, "building"),
				gte(buildBumpCandidates.buildStartedAt, ago(now, FOLLOW_THROUGH_WINDOW_MS)),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** Whether an opened, unresolved bump settled within the follow-through window. */
async function openedRecently(db: WatcherDb, now: Date): Promise<boolean> {
	const rows = await db
		.select({ one: sql<number>`1` })
		.from(buildBumpBumps)
		.where(
			and(
				eq(buildBumpBumps.status, "opened"),
				isNull(buildBumpBumps.mergedAt),
				isNull(buildBumpBumps.prClosedAt),
				gte(buildBumpBumps.settledAt, ago(now, FOLLOW_THROUGH_WINDOW_MS)),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** Whether a bump merged within the Argo-pending window still awaits its refresh. */
async function argoPending(db: WatcherDb, now: Date): Promise<boolean> {
	const rows = await db
		.select({ one: sql<number>`1` })
		.from(buildBumpBumps)
		.where(
			and(
				isNotNull(buildBumpBumps.mergedAt),
				isNull(buildBumpBumps.argoRefreshedAt),
				gte(buildBumpBumps.mergedAt, ago(now, ARGO_PENDING_WINDOW_MS)),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** True while a build, an unmerged bump PR, or (when Argo is configured) a refresh is in flight. */
async function railInFlightImpl(
	db: WatcherDb,
	now: Date,
	argoConfigured: boolean,
): Promise<boolean> {
	if (await buildingRecently(db, now)) return true;
	if (await openedRecently(db, now)) return true;
	return argoConfigured && (await argoPending(db, now));
}

/** `FOLLOW_THROUGH_DELAY_MS` while the rail is in flight, else `null`. */
async function followThroughDelayImpl(
	db: WatcherDb,
	now: Date,
	argoConfigured: boolean,
): Promise<number | null> {
	return (await railInFlight(db, now, argoConfigured)) ? FOLLOW_THROUGH_DELAY_MS : null;
}

export const runBumpMergeWatch = traced("reconcile.runBumpMergeWatch", runBumpMergeWatchImpl, {
	redact: { args: [0, 1] },
});
export const railInFlight = traced("reconcile.railInFlight", railInFlightImpl, {
	redact: { args: [0] },
});
export const followThroughDelay = traced("reconcile.followThroughDelay", followThroughDelayImpl, {
	redact: { args: [0] },
});
