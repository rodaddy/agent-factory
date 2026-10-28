/**
 * @module github/eligibility
 * @description The single shared predicate for whether an item-level GitHub
 *   publication (a label transition or a comment) is still valid to write, given
 *   the item's *current* observed state and the job's target SHA. It is applied
 *   twice — once while queuing plans (`publish-plan`) and again while publishing
 *   them (`publish`) — because the item can change between those two points, and a
 *   stale or closed target must never receive a label or comment.
 *
 *   The rule, by item kind:
 *   - open issue: eligible (issues have no head SHA to drift).
 *   - open pull request: eligible only when the item's current `head_sha` equals
 *     the job's target `sha`; a force-push or new commit makes the queued result
 *     stale for the item's live head.
 *   - anything closed/merged, or an item that no longer exists: not eligible.
 *
 *   Checks are exempt: they bind to an exact immutable commit SHA, not the item's
 *   moving head, so their validity is enforced by the SHA match, not this rule.
 *
 * @outputs
 *   - `ItemEligibilityInput` -- the current item facts this predicate needs
 *   - `itemIneligibilityReason` -- why a write is not valid, or `null`
 *   - `isItemEligible` -- true when an item-level write is still valid
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";

/** The current, authoritative facts about the target item and the job SHA. */
export interface ItemEligibilityInput {
	/** `issue` or `pull`; anything else is treated as ineligible. */
	kind: string | null;
	/** The item's current observed state (`open`, `closed`, `merged`, ...). */
	state: string | null;
	/** The item's current head commit SHA (pull requests only). */
	headSha: string | null;
	/** The job's target commit SHA (empty for shaless jobs). */
	jobSha: string;
}

/**
 * Why an item-level write is NOT valid, or `null` when it is.
 *
 * - `closed`: the item is not open (closed, merged, or in an unknown state).
 * - `stale-head`: an open PR whose live head is no longer the job's target SHA.
 * - `unknown-kind`: an open item that is neither an issue nor a pull request.
 *
 * The reason exists so the queue-time gate can SAY why it declined: before this,
 * a correctly suppressed publication and a broken one produced the same silence
 * (zero postings rows for a completed job) and cost a real investigation to tell
 * apart. The predicate `isItemEligible` is unchanged; it is this function's
 * null test.
 */
export type ItemIneligibilityReason = "closed" | "stale-head" | "unknown-kind";

export const itemIneligibilityReason = traced(
	"github.itemIneligibilityReason",
	function itemIneligibilityReason(input: ItemEligibilityInput): ItemIneligibilityReason | null {
		if (input.state !== "open") {
			return "closed";
		}
		if (input.kind === "issue") {
			return null;
		}
		if (input.kind === "pull") {
			// The open PR's live head must still be the commit this job examined.
			return input.headSha !== null && input.headSha === input.jobSha ? null : "stale-head";
		}
		return "unknown-kind";
	},
);

/**
 * True when an item-level label/comment write is still valid for the item's live
 * state. A closed/merged item, an unknown item, or an open PR whose head has moved
 * off the job's target SHA is not eligible.
 */
export const isItemEligible = traced(
	"github.isItemEligible",
	function isItemEligible(input: ItemEligibilityInput): boolean {
		return itemIneligibilityReason(input) === null;
	},
);
