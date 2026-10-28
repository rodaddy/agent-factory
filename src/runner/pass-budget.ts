/**
 * @module runner/pass-budget
 * @description The dispatch slots ONE reconcile pass may still spend.
 *
 *   THE DEFECT THIS CLOSES. `MAX_DISPATCH_PER_PASS` (the owner's 2026-08-28
 *   "three concurrent jobs until the process proves out") was applied as the
 *   LIMIT of the generic due-pending select only. The verb lane dispatches from
 *   its own call site earlier in the same sweep and its due select excludes
 *   nothing on that count, so a burst of `deploy:`/`redeploy:` labels could
 *   place boxes the operator's cap never saw. The cap was a generic-lane bound
 *   read as a whole-pass bound.
 *
 *   ONE COUNTER, SHARED THROUGH THE SWEEP, the same way the same-pass vmid
 *   ledger (`pass-vmids`) is shared: the sweep creates it, hands the SAME
 *   object to the verb lane and then to `dispatchPendingJobs`, and discards it
 *   with the pass. A slot is `take()`n where a box is about to be placed — a
 *   PLACEMENT, never at a shortlist or a pre-check: a slot means a box, so a
 *   row a lane skipped (allowlist, template, claim, same-pass vmid refusal)
 *   spends nothing and the slot stays for the next row.
 *
 *   RESERVE, THEN SETTLE (PR #680 review, rounds 1-3). Both lanes `take()` a
 *   slot immediately before `dispatchJob`, the last gate before a box, and
 *   settle it against the outcome with `settleReservation`: the slot is refunded
 *   ONLY when the outcome proves no box was placed (`provenNoBox`). A placed box
 *   keeps it whatever happened next, and so does a thrown or otherwise ambiguous
 *   dispatch — a runner submission and its row update are separate side effects,
 *   so an error does not prove the box is not running, and a cap that refunded
 *   on faith could be exceeded. The generic pass shortlists the whole cap (not
 *   the remainder) so a row the preparer skips is replaced by the next due row
 *   instead of starving the last slot, and checks the budget before each dispatch.
 *
 *   SCOPE IS ONE PASS, DELIBERATELY, for the reason `pass-vmids` gives: a
 *   counter that outlived its pass would have to know when a box was freed, and
 *   the watcher does not own that fact. Per pass it needs no expiry and no
 *   persistence, and the periodic sweep re-arms it every time.
 *
 * @outputs
 *   - `PassBudget` -- the counter one sweep shares across its dispatching lanes
 *   - `createPassBudget` -- a fresh counter for one pass; `refund()` gives a
 *     reserved slot back when no box was placed
 *   - `settleReservation` -- refund a reserved slot only on proof of no box
 *
 * @dependencies
 *   - ../log -- the shared traced() wrapper on the exported entry points
 */
import { traced } from "../log";

/** The dispatch slots a sweep may still spend, shared by every lane in it. */
export interface PassBudget {
	/** The slots this pass started with (the operator's cap, or a caller's bound). */
	readonly max: number;
	/** Slots not yet taken. Never negative. */
	remaining(): number;
	/**
	 * Spend one slot. `false` when none are left, and the caller must then NOT
	 * place a box; the row stays pending and is due again next pass.
	 */
	take(): boolean;
	/**
	 * Give back a slot a prior `take()` reserved, because the dispatch it was
	 * reserved for placed no box. Never drives the count below zero.
	 */
	refund(): void;
}

/**
 * A fresh budget for one pass.
 *
 * @param max - the slots this pass may spend; a non-finite or negative value is
 *   treated as zero, so a malformed cap fails CLOSED (dispatches nothing) rather
 *   than open
 */
export const createPassBudget = traced(
	"runner.createPassBudget",
	function createPassBudget(max: number): PassBudget {
		const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
		let taken = 0;
		return {
			max: cap,
			remaining: () => cap - taken,
			take: () => {
				if (taken >= cap) return false;
				taken += 1;
				return true;
			},
			refund: () => {
				if (taken > 0) taken -= 1;
			},
		};
	},
);

/**
 * Settle a slot reserved before `dispatchJob` against the outcome it produced.
 * Refunds only when the outcome PROVES no box was placed; a dispatched box, a
 * placed-then-failed one, and an ambiguous outcome all keep the slot.
 *
 * @param budget - the pass budget, or `undefined` when the caller runs unbudgeted
 * @param outcome - the dispatch outcome; `provenNoBox` is the only refund signal
 */
export const settleReservation = traced(
	"runner.settleReservation",
	function settleReservation(
		budget: PassBudget | undefined,
		outcome: { status: string; provenNoBox?: true },
	): void {
		if (budget === undefined || outcome.status === "dispatched") return;
		if (outcome.provenNoBox === true) budget.refund();
	},
);
