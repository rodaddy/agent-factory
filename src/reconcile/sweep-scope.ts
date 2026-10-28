/**
 * @module reconcile/sweep-scope
 * @description The state ONE sweep owns and its two dispatching lanes must share.
 *
 *   `now` was already threaded (so the verb lane's due-row driver uses
 *   the cycle clock); `passVmids` joined it for sf#299 because the same-pass
 *   vmid de-dup only works if the verb lane and `dispatchPendingJobs` consult
 *   the SAME ledger — the live collision was BETWEEN those two
 *   lanes, not inside either one. `passBudget` joins for sf#445 for the same
 *   reason: `MAX_DISPATCH_PER_PASS` bounds the whole pass only if both lanes
 *   spend from ONE counter.
 *
 *   A scope is created by `runSweepPhase` per cycle and NEVER stored on
 *   `ReconcileCycleDeps`: deps is composed once and outlives every sweep, and a
 *   ledger that outlived its pass would refuse boxes the fleet freed hours ago
 *   or withhold dispatch slots the fleet has long since given back.
 *
 * @outputs
 *   - `SweepScope` -- the per-sweep state both dispatching lanes read
 *   - `createSweepScope` -- a fresh scope, or one built around shared ledgers
 *
 * @dependencies
 *   - ../runner/pass-vmids -- the same-pass vmid ledger
 *   - ../runner/pass-budget -- the same-pass dispatch budget
 *   - ./dispatch-pass -- the one resolver of the operator's per-pass cap
 */
import { traced } from "../log";
import { createPassBudget, type PassBudget } from "../runner/pass-budget";
import { createPassVmids, type PassVmids } from "../runner/pass-vmids";
import { resolveDispatchCap } from "./dispatch-pass";

/** What one sweep shares between the verb lane and the generic dispatch pass. */
export interface SweepScope {
	now: Date;
	/**
	 * The operator's cap, resolved ONCE by `resolveDispatchCap` (PR #680 review
	 * P1): the budget was created from it and the generic pass shortlists by it.
	 */
	maxDispatchPerPass: number;
	/** The sweep's same-pass vmid ledger, consulted by both lanes. */
	passVmids: PassVmids;
	/** The sweep's shared dispatch slots, spent by both lanes. */
	passBudget: PassBudget;
}

/**
 * A scope for one sweep.
 *
 * Ledgers are OPTIONAL so a direct caller driving one lane alone (a test, or
 * `runVerbControlSurfacePass` exported for the sf#300 claim) still de-dups and
 * caps within its own dispatches; only `runSweepPhase` supplies the cross-lane
 * pair, because only it owns both lanes.
 *
 * @param deps - the per-pass cap, resolved by the generic pass's own rule
 * @param now - the cycle clock
 * @param shared - ledgers already created by the owning sweep, if any
 */
export const createSweepScope = traced(
	"reconcile.createSweepScope",
	function createSweepScope(
		deps: { maxDispatchPerPass?: number },
		now: Date,
		shared: Partial<Pick<SweepScope, "passVmids" | "passBudget">> = {},
	): SweepScope {
		const maxDispatchPerPass = resolveDispatchCap(deps.maxDispatchPerPass);
		return {
			now,
			maxDispatchPerPass,
			passVmids: shared.passVmids ?? createPassVmids(),
			passBudget: shared.passBudget ?? createPassBudget(maxDispatchPerPass),
		};
	},
);
