/**
 * @module github/publish-plan
 * @description Durable persistence of bounded GitHub publication plans. Given a
 *   *trusted* job identity (resolved from the authoritative jobs ->
 *   repositories / github_items join) and an already-validated, redacted
 *   `RunnerResult`, it derives approved operations via the fixed publication
 *   registry and upserts one `github_postings` row per (job, kind, target).
 *
 *   Plans are persisted *before* any external write, and — critically — this
 *   runs inside the same transaction that accepts the result, so there is no
 *   crash window in which the result is accepted but the publication work is
 *   lost. The stored payload is already bounded/redacted, so restart recovery
 *   retries from durable state without ever re-reading raw runner output.
 *
 *   Idempotency: the (job, kind, target) unique key means re-deriving a plan for
 *   the same result converges onto the existing row. An already-`posted` row is
 *   never reset to `pending`, so a re-ingest cannot cause a duplicate GitHub
 *   write.
 *
 * @outputs
 *   - `persistPublicationPlans` -- upsert plans within a caller transaction
 *   - `persistPublicationPlan` -- upsert ONE post-hoc plan (the pushed proposal)
 *   - `PublicationPlanTx` -- the transaction seam this needs
 *
 * @dependencies
 *   - ./publication -- the fixed registry that produces approved plans
 *   - ../db/schema -- the github_postings table
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { and, eq } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { githubPostings } from "../db/schema";
import { traced } from "../log";
import type { RunnerResult } from "../results/schema";
import { buildPublicationPlans, type JobIdentity, type PublicationPlan } from "./publication";

/**
 * The transaction seam. The result store hands its Drizzle transaction here so
 * plan creation shares the result's commit boundary (no lost-work window). The
 * full db type also satisfies this (autocommit) for standalone use.
 */
export type PublicationPlanTx = WatcherDb | Parameters<Parameters<WatcherDb["transaction"]>[0]>[0];

/**
 * Derive and persist the approved publication plans for one accepted result.
 * Must be called inside the transaction that accepts the result.
 *
 * A plan that already exists (same job/kind/target) is refreshed only while it
 * is still `pending` — a `posted`/`failed` row is left untouched so a re-ingest
 * cannot re-arm an already-published (or exhausted) write.
 *
 * `itemEligible` (default true) gates the item-level label/comment plans: when
 * the target item is closed or its PR head has already moved off the job's SHA,
 * only the exact-SHA check plan is queued. Publish-time re-checks the same rule.
 *
 * @returns the number of plan rows created or refreshed.
 */
/**
 * Arguments for {@link persistPublicationPlans}. `itemEligible` and
 * `triageAllowlist` default to the permissive values the positional signature
 * carried, so a caller that omits them is unchanged.
 */
export type PersistPublicationPlansArgs = {
	tx: PublicationPlanTx;
	identity: JobIdentity;
	result: RunnerResult;
	now: Date;
	itemEligible?: boolean;
	triageAllowlist?: readonly string[];
};

export const persistPublicationPlans = traced(
	"github.persistPublicationPlans",
	async function persistPublicationPlans({
		tx,
		identity,
		result,
		now,
		itemEligible = true,
		triageAllowlist = [],
	}: PersistPublicationPlansArgs): Promise<number> {
		const plans: PublicationPlan[] = buildPublicationPlans(
			identity,
			result,
			itemEligible,
			triageAllowlist,
		);

		let written = 0;
		for (const plan of plans) {
			await upsertPendingPlan(tx, identity.jobId, plan, now);
			written++;
		}

		return written;
	},
);

/**
 * Upsert one plan on its `(job, kind, target)` idempotency key. Refreshes only a
 * PENDING row — a row that already reached `posted`/`failed` is never re-armed,
 * so a re-ingest cannot resurrect a write that already happened or was exhausted.
 */
async function upsertPendingPlan(
	tx: PublicationPlanTx,
	jobId: number,
	plan: PublicationPlan,
	now: Date,
): Promise<void> {
	const { payload, dedupeKey } = serializePlan(plan);

	// Look up an existing plan for this (job, kind, target).
	const [existing] = await tx
		.select({ id: githubPostings.id })
		.from(githubPostings)
		.where(
			and(
				eq(githubPostings.jobId, jobId),
				eq(githubPostings.kind, plan.kind),
				eq(githubPostings.target, plan.target),
			),
		)
		.limit(1);

	if (existing) {
		// Refresh only pending rows; never re-arm a posted/failed row.
		await tx
			.update(githubPostings)
			.set({ action: plan.action, payload, dedupeKey, updatedAt: now })
			.where(and(eq(githubPostings.id, existing.id), eq(githubPostings.status, "pending")));
		return;
	}

	await tx
		.insert(githubPostings)
		.values({
			jobId,
			kind: plan.kind,
			action: plan.action,
			target: plan.target,
			status: "pending",
			payload,
			dedupeKey,
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({
			target: [githubPostings.jobId, githubPostings.kind, githubPostings.target],
		});
}

/**
 * Persist ONE already-built plan for a job, outside the ingest transaction.
 *
 * The proposal plan cannot be built during ingest: it may only exist once
 * the branch has actually been pushed, and pushing is network I/O that must not
 * happen under the result store's `FOR UPDATE` lock. So the proposal pass builds
 * it after a successful push and persists it here.
 *
 * Shares the `(job, kind, target)` idempotency of the ingest path: a repeated
 * proposal pass converges onto the existing row instead of queuing a second
 * plan, and a row that already reached `posted`/`failed` is never re-armed.
 *
 * @returns true when a row was inserted or a pending row refreshed.
 */
export const persistPublicationPlan = traced(
	"github.persistPublicationPlan",
	async function persistPublicationPlan(
		tx: PublicationPlanTx,
		jobId: number,
		plan: PublicationPlan,
		now: Date,
	): Promise<boolean> {
		const { payload, dedupeKey } = serializePlan(plan);

		const [existing] = await tx
			.select({ id: githubPostings.id })
			.from(githubPostings)
			.where(
				and(
					eq(githubPostings.jobId, jobId),
					eq(githubPostings.kind, plan.kind),
					eq(githubPostings.target, plan.target),
				),
			)
			.limit(1);

		if (existing) {
			// Refresh only while still pending; never re-arm a posted/failed row. A
			// proposal that was already opened must not be queued a second time.
			const refreshed = await tx
				.update(githubPostings)
				.set({ action: plan.action, payload, dedupeKey, updatedAt: now })
				.where(and(eq(githubPostings.id, existing.id), eq(githubPostings.status, "pending")))
				.returning({ id: githubPostings.id });
			return refreshed.length > 0;
		}

		const inserted = await tx
			.insert(githubPostings)
			.values({
				jobId,
				kind: plan.kind,
				action: plan.action,
				target: plan.target,
				status: "pending",
				payload,
				dedupeKey,
				attempts: 0,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing({
				target: [githubPostings.jobId, githubPostings.kind, githubPostings.target],
			})
			.returning({ id: githubPostings.id });
		return inserted.length > 0;
	},
);

/** Serialize a plan's bounded payload and pull out its dedupe key. */
function serializePlan(plan: PublicationPlan): {
	payload: string;
	dedupeKey: string;
} {
	const dedupeKey = "dedupeKey" in plan ? plan.dedupeKey : plan.target;
	return { payload: JSON.stringify(plan), dedupeKey };
}
