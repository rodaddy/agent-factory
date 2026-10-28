/**
 * @module reconcile/dispatch-caps
 * @description The operator's per-pass dispatch cap, and the ONE rule that
 *   resolves it for every reader.
 *
 *   Split out of `./dispatch-pass`: that module sits fifteen code lines
 *   under the 500-line `lint:size` bound, and wrapping its five exports in
 *   `traced()` costs more than fifteen. These two functions are pure -- a string
 *   env value and a number in, a bounded integer out, no db and no job between
 *   them -- so they are the honest thing to move.
 *
 *   `dispatch-pass.ts` re-exports both plus `MAX_DISPATCH_PER_PASS`, so
 *   `src/service.ts` and `./sweep-scope` are unaffected.
 *
 *   WHY ONE RULE MATTERS: the sweep's shared budget
 *   (`createSweepScope`) and the dispatch pass's own shortlist both bound the
 *   same setting. Two parsings of one value is how a pass gets bounded by a
 *   number the operator never set.
 *
 * @outputs
 *   - `MAX_DISPATCH_PER_PASS` -- the default cap
 *   - `parseMaxDispatchPerPass` -- read and bound the operator's env value
 *   - `resolveDispatchCap` -- bound an already-parsed value, for every reader
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";

/** Default cap on jobs dispatched per pass. */
export const MAX_DISPATCH_PER_PASS = 50;

/**
 * Parse the operator's per-pass dispatch cap, defaulting safely when the
 * value is absent or invalid; under the owner's 2026-08-28 ruling, prove the process at
 * 3 before scaling, and raising the cap is his call.
 */
export const parseMaxDispatchPerPass = traced(
	"reconcile.parseMaxDispatchPerPass",
	function parseMaxDispatchPerPass(env: Record<string, string | undefined>): number {
		const raw = env.MAX_DISPATCH_PER_PASS?.trim();
		if (!raw) return MAX_DISPATCH_PER_PASS;
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return MAX_DISPATCH_PER_PASS;
		return Math.max(1, Math.min(parsed, 5000));
	},
	// The production call site passes `process.env` -- every credential in the
	// watcher's environment, as a bare positional. summarize() masks on object
	// KEYS, and this argument has none of its own to match.
	{ redact: { args: [0] } },
);

/**
 * The operator's per-pass cap, resolved by ONE rule for every reader (PR #680
 * review P1): absent means `MAX_DISPATCH_PER_PASS`, and the value is clamped to
 * [1, 5000]. The sweep's shared budget (`createSweepScope`) and this pass's
 * shortlist both call this, so the two lanes can never be bounded by two
 * different parsings of the same setting.
 */
export const resolveDispatchCap = traced(
	"reconcile.resolveDispatchCap",
	function resolveDispatchCap(raw: number | undefined): number {
		// A NaN is an unparseable setting, so the default rather than a NaN LIMIT; a
		// fraction is floored HERE so the shortlist and `createPassBudget` (which
		// floors) can never disagree by one.
		if (raw === undefined || Number.isNaN(raw)) return MAX_DISPATCH_PER_PASS;
		return Math.max(1, Math.min(Math.floor(raw), 5000));
	},
);
