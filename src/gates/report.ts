/**
 * @module gates/report
 * @description The shared gate-report accumulator: the CODIFIED form of this
 *   repo's gate-honesty rules. A gate built on `GateReport` structurally
 *   cannot return a bare boolean, cannot early-return on its first failure
 *   without visibly skipping the rest, and cannot record a pass without saying
 *   what it verified.
 *
 *   WHY THIS IS A TYPE AND NOT A DOC. Trap #84 is that a gate which never ran
 *   looks exactly like a gate that passed — `core.hooksPath` pointing at a
 *   missing directory runs no hook and says nothing. A boolean `true` carries no
 *   evidence, so the two states are indistinguishable from the outside. This
 *   type makes the note MANDATORY on every check, passing or failing, so a green
 *   report is a list of what was actually looked at. An empty report is
 *   therefore not a pass-with-no-problems; it is a gate that checked nothing,
 *   and `checkedNothing` says so out loud.
 *
 *   A check therefore has THREE states, not two. With only
 *   pass/fail there is nowhere to record "I could not perform this check", so
 *   the unperformed one gets written down as a pass — which is trap #84 back
 *   inside the type built to prevent it. `skip` is that third state: it never
 *   contributes to `passed`, so a report of only skips is as unpassing as an
 *   empty one.
 *
 *   Adapted from `disler/super-simple-software-factory`'s `GateReport`
 *   (`.claude/skills/sssf/cookbooks/update_modules.md`, MIT — Copyright (c) 2026
 *   IndyDevDan). Bent to this repo: notes are REQUIRED rather than encouraged
 *   (the source allows a bare `check(item, ok)`), the accumulator is immutable-
 *   by-convention through a builder that returns itself, and violations are
 *   derived rather than raised because this repo's boundaries return
 *   discriminated results and never throw for an expected fault.
 *
 * @outputs
 *   - `GateReport` -- the accumulator: `check(item, ok, note)`, `skip(item, note)`,
 *     derived verdict
 *   - `GateCheck` -- one recorded check: item, ok, state, note
 *   - `GateCheckState` -- `"pass" | "fail" | "skipped"`
 *
 * @dependencies
 *   - (none) -- deliberately dependency-free so any boundary can gate with it
 */

/**
 * The outcome of one recorded check. THREE states, not two: a
 * gate whose vocabulary is only pass/fail has nowhere to put "I could not
 * perform this check", so an unperformed check gets recorded as a pass and the
 * report claims evidence it does not have. That is trap #84 reappearing INSIDE
 * the type built to prevent it — the reference consumer was recording
 * `forge_identity: ok:true, "not supplied"`, a green tick on a check that never
 * ran.
 *
 * `skipped` can never contribute to passing. It is not a soft pass; it is the
 * absence of evidence, rendered distinctly so an operator reads it as one.
 */
export type GateCheckState = "pass" | "fail" | "skipped";

/**
 * One recorded check. The `note` is the evidence and is REQUIRED on every
 * outcome: on a failure it is the reason the caller reports, on a pass it is
 * what distinguishes "verified this" from "never looked", and on a skip it is
 * why the check could not be performed.
 */
export interface GateCheck {
	/** What was checked — a stable item name, never interpolated user content. */
	readonly item: string;
	/**
	 * Whether the item was VERIFIED to satisfy the gate. Derived from `state` and
	 * kept so existing consumers read the same field; `skipped` is `false` here
	 * because an unperformed check has verified nothing. Never set independently
	 * of `state` — a check whose two outcome fields can disagree is the defect
	 * this type exists to prevent.
	 */
	readonly ok: boolean;
	/** The three-state outcome: verified, failed, or not performed. */
	readonly state: GateCheckState;
	/** The evidence: what was verified, what was wrong, or why nothing ran. */
	readonly note: string;
}

/**
 * Accumulate one check per item a gate looks at, then derive the verdict. Any
 * failed check is a violation; no failed checks plus at least one PASSING check
 * is a pass. An item the gate could not perform is recorded with `skip`, which
 * is neither. A gate returns this instead of a boolean so the record of what it
 * verified travels with the answer.
 *
 * Usage is one line per item, chained:
 *
 * ```ts
 * const report = new GateReport()
 *   .check("sha", receipt.sha === head, `receipt sha ${receipt.sha === head ? "matches" : "differs from"} HEAD`)
 *   .check("status", receipt.status === "passed", `status is ${receipt.status}`);
 * if (!report.passed) return { ok: false, error: report.violations[0] };
 * ```
 *
 * Every item is checked even after one fails — no early return — so the caller
 * sees the full picture in one pass rather than one problem per round trip.
 */
export class GateReport {
	private readonly recorded: GateCheck[] = [];

	/**
	 * Record one check and return this report, so checks chain. A note is
	 * required by the signature: there is no overload that lets a passing check
	 * be recorded without saying what it verified.
	 *
	 * @param item - the stable item name being checked
	 * @param ok - whether the item satisfied the gate
	 * @param note - the evidence (what was verified, or what was wrong)
	 */
	check(item: string, ok: boolean, note: string): this {
		// Frozen on the way in: a recorded check is evidence, and evidence a caller
		// can edit after the fact is not evidence. `readonly` is erased at runtime,
		// so the freeze is what actually holds.
		this.recorded.push(Object.freeze({ item, ok, state: ok ? "pass" : "fail", note } as const));
		return this;
	}

	/**
	 * Record that an item could NOT be checked, and return this report so skips
	 * chain like checks. A skip is not a pass and not a failure: it does not
	 * appear in `violations` (nothing was found wrong) and it can never satisfy
	 * `passed` (nothing was verified either).
	 *
	 * Use this wherever the honest answer is "the input needed to perform this
	 * check was unavailable" — the case that was previously recorded as a passing
	 * check with an apologetic note, which is an unperformed check wearing a green
	 * tick.
	 *
	 * @param item - the stable item name that could not be checked
	 * @param note - why the check could not be performed
	 */
	skip(item: string, note: string): this {
		this.recorded.push(Object.freeze({ item, ok: false, state: "skipped", note } as const));
		return this;
	}

	/**
	 * Every recorded check, in the order they were run. A COPY: `readonly` is a
	 * compile-time claim only, and the array this getter used to hand back was the
	 * accumulator itself — pushing or splicing through it flipped `passed` on a
	 * report that had already been assembled. This type's whole job is trap-#84
	 * honesty, so its record must not be rewritable from outside.
	 */
	get checks(): readonly GateCheck[] {
		return [...this.recorded];
	}

	/**
	 * The derived violations: the note of every FAILED check, in check order.
	 * Derived, never accumulated separately — a violation list that can disagree
	 * with the check list is the defect this type exists to prevent.
	 */
	get violations(): readonly string[] {
		return this.recorded.filter((c) => c.state === "fail").map((c) => c.note);
	}

	/**
	 * The notes of every SKIPPED item, in check order. Surfaced separately from
	 * violations because they are a different operator problem: a violation says
	 * something is wrong, a skip says something is unknown.
	 */
	get skipped(): readonly string[] {
		return this.recorded.filter((c) => c.state === "skipped").map((c) => c.note);
	}

	/**
	 * True only when at least one check actually PASSED and none failed. An EMPTY
	 * report is deliberately not a pass: a gate that recorded nothing looked at
	 * nothing, which is trap #84's silently-absent gate wearing a green coat. A
	 * report of only SKIPS is the same thing with more paperwork — it has a list
	 * of items and zero evidence about any of them — so it does not pass either.
	 * Skips can never contribute to passing; they only fail to
	 * prevent it.
	 */
	get passed(): boolean {
		return (
			this.recorded.some((c) => c.state === "pass") &&
			this.recorded.every((c) => c.state !== "fail")
		);
	}

	/**
	 * True when the gate ran but recorded no checks at all. Callers surface this
	 * distinctly from a failure: "nothing was verified" and "something was wrong"
	 * are different operator problems with different fixes.
	 */
	get checkedNothing(): boolean {
		return this.recorded.length === 0;
	}
}
