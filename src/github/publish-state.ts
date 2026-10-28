/**
 * @module github/publish-state
 * @description The terminal/retryable state transitions for one locked posting
 *   row. Split out of `github/publish.ts` as the "write the row's fate" region:
 *   the success write, the bounded-backoff retry, and the no-further-attempts
 *   terminal failure.
 *
 *   Every transition here is written through the CALLER'S transaction — the one
 *   already holding the `FOR UPDATE` row lock — so the state update commits
 *   atomically with the lock's release and with any shadow-ledger row. The row is
 *   already lock-held by the time these run, which is why none of them carries an
 *   ownership guard. The publisher's clamped clock and retry bounds are passed in
 *   explicitly rather than read off the instance, so the arithmetic is unchanged
 *   and testable at the same boundary.
 *
 *   The shadow-ledger write lives here for the same reason: in shadow mode it
 *   STANDS IN for the GitHub write, so it must commit atomically with the row's
 *   terminal state through this same transaction.
 *
 * @outputs
 *   - `PublishClock` -- the publisher's injected clock + clamped retry bounds
 *   - `markPosted` -- terminal success/dedupe write + counters
 *   - `recordUnhandled` -- attempt bump, bounded-backoff retry, or spent-budget failure
 *   - `markTerminalFailure` -- immediate terminal failure, no attempt consumed
 *   - `recordShadow` -- the idempotent intended-write ledger row
 *
 * @dependencies
 *   - ../db/schema -- the github_postings and shadow_publications tables
 *   - ../log -- the one logger, for the traced() wrapper
 *   - ./publish-types -- the pass counters, row shape, and backoff ceiling
 */
import { eq } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { githubPostings, shadowPublications } from "../db/schema";
import { traced } from "../log";
import { redactSecrets } from "../results/ingest";
import type { PublicationPlan } from "./publication";
import { UNPUBLISHABLE } from "./publish-decode";
import { MAX_POSTING_BACKOFF_MS, type PublishRow, type PublishSummary } from "./publish-types";
import type { ResolvedTarget } from "./publish-writers";

/** The transaction handle passed to a `db.transaction` callback. */
type WatcherTx = Parameters<Parameters<WatcherDb["transaction"]>[0]>[0];

/**
 * The publisher's injected clock and already-clamped retry bounds. Passed rather
 * than read off the instance so the transitions stay pure functions of the row
 * and the bounds the constructor computed.
 */
export interface PublishClock {
	now: () => Date;
	maxAttempts: number;
	backoffMs: number;
	shadow: boolean;
}

/**
 * Write the terminal `posted` state for a successful (or deduped) row through
 * the caller's transaction and update the pass counters.
 */
/** Arguments for {@link markPosted}. */
export type MarkPostedArgs = {
	tx: WatcherTx;
	clock: PublishClock;
	row: PublishRow;
	outcome: { status: "posted" | "deduped"; externalRef?: string };
	summary: PublishSummary;
};

export const markPosted = traced(
	"github.markPosted",
	async function markPosted({ tx, clock, row, outcome, summary }: MarkPostedArgs): Promise<void> {
		await tx
			.update(githubPostings)
			.set({
				status: "posted",
				externalRef: outcome.externalRef ?? null,
				attempts: row.attempts + 1,
				nextAttemptAt: null,
				lastError: null,
				postedAt: clock.now(),
				updatedAt: clock.now(),
			})
			.where(eq(githubPostings.id, row.id));
		if (outcome.status === "deduped") summary.deduped++;
		else summary.posted++;
		// In shadow mode a non-failed outcome means this row's intended write was
		// recorded to the ledger (never POSTed). Track the touched job so the
		// one-shot compare report can be scoped to exactly this pass's writes.
		if (clock.shadow && !summary.shadowJobIds.includes(row.jobId)) {
			summary.shadowJobIds.push(row.jobId);
		}
	},
);

/**
 * Record a failed attempt through the caller's transaction: bump the attempt
 * count and either schedule a bounded-backoff retry (leaving the row `pending`)
 * or move it to `failed` once the budget is spent. The row is already lock-held
 * by the transaction, so no ownership guard is needed.
 */
/** Arguments for {@link recordUnhandled}. */
export type RecordUnhandledArgs = {
	tx: WatcherTx;
	clock: PublishClock;
	id: number;
	attempts: number;
	summary: PublishSummary;
	reason?: string;
};

export const recordUnhandled = traced(
	"github.recordUnhandled",
	async function recordUnhandled({
		tx,
		clock,
		id,
		attempts,
		summary,
		reason = UNPUBLISHABLE,
	}: RecordUnhandledArgs): Promise<void> {
		const next = attempts + 1;
		const bounded = redactSecrets(reason).slice(0, 300);
		if (next >= clock.maxAttempts) {
			await tx
				.update(githubPostings)
				.set({
					status: "failed",
					attempts: next,
					lastError: bounded,
					updatedAt: clock.now(),
				})
				.where(eq(githubPostings.id, id));
			summary.failed++;
			return;
		}
		// Grow the backoff with the attempt count, then clamp to the hard ceiling so
		// no retry is ever scheduled more than MAX_POSTING_BACKOFF_MS in the future.
		const delay = Math.min(clock.backoffMs * next, MAX_POSTING_BACKOFF_MS);
		const nextAttemptAt = new Date(clock.now().getTime() + delay);
		await tx
			.update(githubPostings)
			.set({
				status: "pending",
				attempts: next,
				nextAttemptAt,
				lastError: bounded,
				updatedAt: clock.now(),
			})
			.where(eq(githubPostings.id, id));
		summary.retryable++;
	},
);

/**
 * Mark a row terminally failed without consuming further attempts, through the
 * caller's transaction. The row is already lock-held, so no ownership guard.
 *
 * The reason is redacted and bounded exactly as `recordUnhandled` does it. Its
 * original callers all passed fixed in-repo literals, but sf#599 routes a
 * provider-derived failure reason here (a proven-terminal 404), so the same
 * treatment the retryable path always applied now covers both.
 */
export const markTerminalFailure = traced(
	"github.markTerminalFailure",
	async function markTerminalFailure(
		tx: WatcherTx,
		clock: PublishClock,
		id: number,
		reason: string,
	): Promise<void> {
		await tx
			.update(githubPostings)
			.set({
				status: "failed",
				lastError: redactSecrets(reason).slice(0, 300),
				updatedAt: clock.now(),
			})
			.where(eq(githubPostings.id, id));
	},
	// Arg 3 is a bare positional string carrying a PROVIDER-DERIVED failure
	// reason (sf#599 routes a forge 404 body here). `summarize()` masks on object
	// keys only, so a bare remote-response string would be logged verbatim.
	{ redact: { args: [3] } },
);

/**
 * Record one intended write into the shadow ledger through the caller's
 * transaction, INSTEAD of calling GitHub. Idempotent on
 * (posting, wouldAction): a re-run for an already-recorded posting/wouldAction
 * converges onto the existing row rather than appending a duplicate. (Each
 * posting is one plan/one `action`, and a label add and its removes are
 * distinct postings, so this never collapses the add/remove distinction the
 * `action` column carries.) Returns the shadow outcome the real
 * path would have produced (`posted` for a would-create, `deduped` for a
 * would-update) so the terminal state update matches the non-shadow lifecycle.
 */
/** Arguments for {@link recordShadow}. */
export type RecordShadowArgs = {
	tx: WatcherTx;
	clock: PublishClock;
	row: PublishRow;
	plan: PublicationPlan;
	target: ResolvedTarget;
	wouldAction: "created" | "deduped";
};

export const recordShadow = traced(
	"github.recordShadow",
	async function recordShadow({
		tx,
		clock,
		row,
		plan,
		target,
		wouldAction,
	}: RecordShadowArgs): Promise<{ status: "posted" | "deduped"; externalRef?: string }> {
		await tx
			.insert(shadowPublications)
			.values({
				postingId: row.id,
				jobId: row.jobId,
				kind: plan.kind,
				// The load-bearing add/remove distinction for labels (both `create` a
				// ledger row); checks/comments record their natural upsert action.
				action: plan.action,
				repository: target.repository,
				// Record BOTH the trusted item number and SHA whenever the resolved
				// target knows them, so a PR's check row and its label/comment rows share
				// one report group instead of splitting on a null itemNumber vs null sha.
				// An audit issue plan targets no source item/commit — it opens a NEW issue
				// on the repository — so both are null and it groups by repository alone.
				itemNumber:
					plan.kind === "check"
						? target.itemNumber
						: plan.kind === "issue"
							? null
							: plan.itemNumber,
				sha: plan.kind === "check" ? plan.sha : target.sha === "" ? null : target.sha,
				wouldAction,
				target: plan.target,
				dedupeKey: row.dedupeKey,
				conclusion: plan.kind === "check" ? plan.conclusion : null,
				createdAt: clock.now(),
			})
			.onConflictDoNothing({
				target: [shadowPublications.postingId, shadowPublications.wouldAction],
			});
		// A would-create maps to `posted`, a would-update to `deduped`, mirroring the
		// real remote outcomes so the row's terminal state is identical in shadow mode.
		return wouldAction === "created" ? { status: "posted" } : { status: "deduped" };
	},
);
