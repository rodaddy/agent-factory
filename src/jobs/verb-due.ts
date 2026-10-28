/**
 * @module jobs/verb-due
 * @description The CURSOR-INDEPENDENT selector for due pending verb rows.
 *
 *   The verb lane reaches `dispatchVerbLive` only for issues the sweep's INCREMENTAL
 *   cursor re-surfaced (`service-cycle.ts` filters `runPass`'s observed open issues).
 *   Every other lane survives that because its pending row is re-attempted by the
 *   generic dispatcher — but verb rows are deliberately EXCLUDED there
 *   (`dispatch-pass.ts` `notInArray(jobs.jobType, VERB_IDS)`), because a verb job
 *   must be rendered and routed by the verb-only body/runtime path and must never be
 *   dispatched as a prose/agent job. That exclusion is correct and stays; its
 *   consequence is that a pending verb row which is DUE has no re-dispatcher at all
 *   unless the forge cursor happens to re-surface its item.
 *
 *   Live receipt (2026-08-16): SIX manual "nudge" comments were
 *   posted purely to make the cursor re-surface the item so a row that had been due
 *   for minutes would finally re-evaluate. A capacity refusal or a stale-share exit
 *   leaves the row pending, and the operational workaround was a label recycle.
 *
 *   THIS MODULE IS A SELECTOR, NOT A DISPATCHER. It answers which items carry a due
 *   pending verb row; the caller feeds those items through the SAME control-surface
 *   pass and the SAME `dispatchVerbLive` the observed path uses, so there is exactly
 *   one verb dispatch path and every guard on it (`recoverPendingVerb`,
 *   `hasLiveJobForItem`, the terminal-tuple honest skip, the `jobs.sha` identity
 *   anchor, the `nextAttemptAt` backoff) applies unchanged.
 *
 *   NO NEW CHURN. Selection is due-only — a row whose `nextAttemptAt` is in
 *   the future is not returned, the same predicate the generic dispatcher and
 *   `pendingVerbIsDue` already apply — so a row whose dispatch fails takes its normal
 *   backoff and is invisible here until that window passes. The per-pass count is
 *   additionally capped.
 *
 * @outputs
 *   - `DueVerbItem` -- one item carrying a due pending verb row
 *   - `MAX_DUE_VERB_ITEMS_PER_PASS` -- the bounded per-pass cap
 *   - `selectDueVerbItems` -- the cursor-independent due-row selection
 *
 * @dependencies
 *   - drizzle-orm -- the bounded due-pending join
 *   - ../db/schema -- jobs / github_items
 *   - ./verb-dispatch -- the closed verb id allowlist
 */
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { githubItems, jobs, repositories } from "../db/schema";
import { traced } from "../log";
import { VERB_IDS } from "./verb-dispatch";

/**
 * Cap on items re-surfaced per pass. Mirrors `MAX_DISPATCH_PER_PASS`'s reasoning:
 * one pass stays bounded however many rows an outage stranded, and a remaining
 * backlog is picked up on the next cycle. Verb rows are rare — one per (item,
 * manifest) — so this ceiling is not reached in normal operation; it exists so a
 * pathological state cannot make one pass unbounded.
 */
export const MAX_DUE_VERB_ITEMS_PER_PASS = 25;

/** One managed item that currently carries a due pending verb row. */
export interface DueVerbItem {
	/** The `github_items.id` the pending row is bound to. */
	itemId: number;
	/** The `repositories.id` the pending row is bound to. */
	repositoryId: number;
	/** The forge item number, i.e. the issue the verb label sits on. */
	itemNumber: number;
}

/** The provider-qualified repository one selection is scoped to. */
export interface DueVerbRepoRef {
	provider: string;
	name: string;
}

/**
 * Select the items carrying a DUE pending verb row for ONE repository, independent
 * of the sweep cursor.
 *
 * Scoped to a repository by its PROVIDER-QUALIFIED identity, the same key the
 * dispatch pass's managed allowlist uses, so a `github` and a `forgejo` repository
 * of the same name can never be conflated — and so the caller's per-repository verb
 * gate (`repo.verb_dispatch`) applies to exactly the rows it selected.
 *
 * Due is the EXACT predicate the generic dispatcher uses — `nextAttemptAt` null or
 * at/before `now` — so a row inside its backoff window is never returned, and the
 * #210 no-unbounded-churn invariant holds by construction rather than through a
 * second, divergent notion of readiness.
 *
 * The `item_id` join is load-bearing: a verb is dispatched against an ITEM (the
 * issue whose label carries the verb and its parameter), so a row with no item
 * cannot be re-decided by the control surface at all. Such a row is left alone
 * rather than guessed at — the inner join already excludes it, and the explicit
 * `isNotNull` states that as intent rather than leaving it to join semantics.
 *
 * Deduplicated on the item: one item may in principle hold pending rows for more
 * than one verb, the control surface resolves exactly one decision per item, so
 * re-surfacing the item once is sufficient and twice would only repeat identical
 * work.
 *
 * @param db - watcher database
 * @param repo - the provider-qualified repository to scope the selection to
 * @param now - clock seam for the due comparison
 * @param maxItems - bounded per-pass cap
 * @returns the due items, job-id-ordered, at most `maxItems` of them
 */
export const selectDueVerbItems = traced(
	"jobs.selectDueVerbItems",
	async function selectDueVerbItems(
		db: WatcherDb,
		repo: DueVerbRepoRef,
		now: Date,
		maxItems: number = MAX_DUE_VERB_ITEMS_PER_PASS,
	): Promise<DueVerbItem[]> {
		const limit = Math.max(1, Math.min(maxItems, 1000));
		const rows = await db
			.select({
				itemId: jobs.itemId,
				repositoryId: jobs.repositoryId,
				itemNumber: githubItems.number,
			})
			.from(jobs)
			.innerJoin(githubItems, eq(githubItems.id, jobs.itemId))
			.innerJoin(repositories, eq(repositories.id, jobs.repositoryId))
			.where(
				and(
					eq(repositories.provider, repo.provider),
					eq(repositories.fullName, repo.name),
					eq(jobs.status, "pending"),
					inArray(jobs.jobType, [...VERB_IDS]),
					isNotNull(jobs.itemId),
					or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now)),
				),
			)
			.orderBy(asc(jobs.id))
			.limit(limit);

		const byItem = new Map<number, DueVerbItem>();
		for (const row of rows) {
			const { itemId } = row;
			if (itemId === null || byItem.has(itemId)) continue;
			byItem.set(itemId, {
				itemId,
				repositoryId: row.repositoryId,
				itemNumber: row.itemNumber,
			});
		}
		return [...byItem.values()];
	},
	{ redact: { args: [0] } },
);
