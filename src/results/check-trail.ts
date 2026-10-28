/**
 * @module results/check-trail
 * @description The check-trail policy for the implement lane. A runner
 *   reports an overall `status` AND a per-check trail; this module decides
 *   whether that pair is COHERENT and COMPLETE enough to be acted on, before any
 *   expensive verification work begins.
 *
 *   The runner never judges its own output. Three independent rules, each of
 *   which fails closed:
 *
 *   1. **Contradiction = rejection.** A result claiming `status: passed` while
 *      its own `checks[]` carries a `fail` is incoherent. One of the two is
 *      wrong and there is no safe way to pick which, so the result is refused
 *      rather than resolved in the runner's favour.
 *   2. **Required-check manifest.** The implement lane requires `secrets` and
 *      `test` to be PRESENT in the trail. A missing entry is its own named
 *      rejection: absence is never equal to passing. This is trap #84 encoded at
 *      a data boundary — a gate that never ran looks identical to a gate that
 *      passed unless someone insists on seeing the entry.
 *   3. **Degraded = rejection UNLESS allowed by name.** A required check that
 *      `skip`s or `error`s proved nothing. It is refused unless it matches an
 *      explicit {@link ALLOWANCES} entry, which is reviewed source carrying a
 *      name, a reason, and the condition under which it is deleted. Every
 *      allowance USE is logged by name, so a hole that is being tolerated is
 *      visible in the operator's log rather than silent.
 *
 *   The module is a PURE decision — it performs no I/O, reads no share, and
 *   mutates nothing — so the policy can be exhaustively unit-tested without a
 *   database, a runner, or a git repository.
 *
 * @outputs
 *   - `reconcileCheckTrail` -- the verdict for one result's check trail
 *   - `CheckTrailVerdict` / `DegradedCheck` -- the verdict shapes
 *   - `REQUIRED_CHECKS` -- the implement lane's required-check manifest
 *   - `ALLOWANCES` -- the reviewed, named degradation allowances
 *   - `CHECK_TRAIL_REASONS` -- the fixed log/rejection reason codes
 *
 * @dependencies
 *   - ./schema -- the bounded result and check shapes being reconciled
 */
import { traced } from "../log";
import { IMPLEMENT_JOB_TYPE, type ResultCheck, type RunnerResult } from "./schema";

/**
 * The checks the implement lane requires to be PRESENT in a result's trail.
 *
 * Presence, not outcome: a `skip` still satisfies presence and is then judged by
 * the degradation rule below. What this manifest refuses is a trail that never
 * mentions the check at all, because "the secret scan found nothing" and "the
 * secret scan never ran" are indistinguishable to a reader of the overall status
 * and only one of them is safe.
 */
export const REQUIRED_CHECKS = ["secrets", "test"] as const;

/** Verb templates whose current deterministic body renders additions only. */
export const RENDERABLE_VERB_JOB_TYPES = ["newroute", "newapp", "newdb"] as const;

/** A check status that proves nothing about the code either way. */
const DEGRADED_STATUSES = ["skip", "error"] as const;

/** True when a status means the check did not actually reach a verdict. */
function isDegraded(status: ResultCheck["status"]): boolean {
	return (DEGRADED_STATUSES as readonly string[]).includes(status);
}

/**
 * One reviewed exception to the degradation rule.
 *
 * An allowance is DELIBERATELY verbose. It is the only way a hole in the
 * verification trail is tolerated, so it carries the reason it exists and the
 * condition under which it is deleted — otherwise an allowance added for one
 * sprint's broken environment quietly becomes permanent policy, and the trail
 * goes back to proving nothing while still looking green.
 */
export interface CheckAllowance {
	/** Stable identifier, logged on every use and rendered into the proposal. */
	readonly name: string;
	/** Templates this allowance covers. Exact ids, never a lane-wide wildcard. */
	readonly jobTypes: readonly string[];
	/** The check name this allowance covers. Exact match, never a prefix. */
	readonly check: string;
	/** The degraded statuses it permits for that check. Never `fail`. */
	readonly statuses: readonly ResultCheck["status"][];
	/** Why the degradation is currently unavoidable. */
	readonly reason: string;
	/** What must become true for this allowance to be DELETED. */
	readonly removeWhen: string;
}

/**
 * The complete allowance list. Adding one is a reviewed source change, which is
 * the point: a runner cannot grant itself an exemption, and every exemption is
 * readable in one place with its own expiry condition.
 */
export const ALLOWANCES: readonly CheckAllowance[] = [
	{
		name: "secrets-gitleaks-absent",
		jobTypes: [IMPLEMENT_JOB_TYPE],
		check: "secrets",
		statuses: ["skip"],
		reason: "gitleaks is not installed in the golden runner image, so the scan cannot run",
		removeWhen:
			"rtech-infra ships gitleaks in the golden runner image (#81); this repo never blocks on that build",
	},
	{
		name: "test-environment",
		jobTypes: [IMPLEMENT_JOB_TYPE],
		check: "test",
		statuses: ["error"],
		reason:
			"the runner sandbox lacks the Postgres instance and mounts the suite needs, so the run errors on the environment rather than the code",
		removeWhen: "the runner sandbox provides the test environment and the suite runs to a verdict",
	},
	{
		name: "verb-secrets-not-run",
		jobTypes: RENDERABLE_VERB_JOB_TYPES,
		check: "secrets",
		statuses: ["skip"],
		reason: "the deterministic verb body renders a catalog change but runs no secret scanner",
		removeWhen: "the reviewed verb body runs a real secret scan and reports its verdict",
	},
	{
		name: "verb-test-not-run",
		jobTypes: RENDERABLE_VERB_JOB_TYPES,
		check: "test",
		statuses: ["skip"],
		reason:
			"the deterministic verb body renders a catalog change but runs no repository test suite",
		removeWhen: "the reviewed verb body runs the applicable test suite and reports its verdict",
	},
] as const;

/** Fixed reason codes. Author-controlled: no runner text is ever interpolated. */
export const CHECK_TRAIL_REASONS = {
	contradiction: "change.verify.status_contradicts_checks",
	missing: "change.verify.required_check_missing",
	refused: "change.verify.check_degraded_refused",
	allowed: "change.verify.check_degraded_allowed",
} as const;

/** One required check that did not reach a verdict but is allowed by name. */
export interface DegradedCheck {
	/** The check name, from the required manifest — never runner-chosen text. */
	check: string;
	/** The degraded status the runner reported. */
	status: ResultCheck["status"];
	/** The allowance that permits it. */
	allowance: string;
}

/**
 * The verdict for one result's check trail. Only `ok` may proceed; `degraded`
 * is non-empty exactly when an allowance was used, and the caller logs each by
 * name.
 */
export type CheckTrailVerdict =
	| { status: "ok"; degraded: DegradedCheck[] }
	| { status: "rejected"; reason: string; detail: string };

/**
 * The first matching allowance for a degraded check, or null when none applies.
 *
 * Matched on the EXACT check name and the exact reported status. A `fail` can
 * never match, because no allowance lists it: an allowance excuses a check that
 * could not run, never a check that ran and found a problem.
 */
function allowanceFor(
	jobType: string,
	check: string,
	status: ResultCheck["status"],
): CheckAllowance | null {
	return (
		ALLOWANCES.find(
			(allowance) =>
				allowance.jobTypes.includes(jobType) &&
				allowance.check === check &&
				allowance.statuses.includes(status),
		) ?? null
	);
}

/**
 * Rule 1 — coherence. A result whose overall status claims success while its own
 * trail carries a failing check is contradicting itself, and the contradiction
 * is refused rather than resolved.
 *
 * Deliberately checked for `passed` only. A `failed`/`error`/`skipped` result
 * carrying a `fail` check agrees with itself; it simply is not a success, and it
 * never reaches the change path anyway.
 */
function findContradiction(result: RunnerResult): CheckTrailVerdict | null {
	if (result.status !== "passed") {
		return null;
	}
	const failed = result.checks.filter((check) => check.status === "fail");
	if (failed.length === 0) {
		return null;
	}
	return {
		status: "rejected",
		reason: CHECK_TRAIL_REASONS.contradiction,
		// A COUNT, never the runner's own check names: the reason string is an
		// operator-visible field and this is precisely the case where the runner's
		// output is already known to be untrustworthy.
		detail: `result claims passed while ${failed.length} of its own checks report fail`,
	};
}

/**
 * Rules 2 and 3 over one required check: it must be present, and if it did not
 * reach a verdict it must match an allowance by name.
 *
 * Returns the rejection, the allowance use to log, or null when the check simply
 * passed.
 */
function judgeRequiredCheck(
	jobType: string,
	name: string,
	checks: readonly ResultCheck[],
): { rejection: CheckTrailVerdict } | { degraded: DegradedCheck } | null {
	// Rule 2 — presence. Absence is never equal to passing.
	const entry = checks.find((check) => check.name === name);
	if (entry === undefined) {
		return {
			rejection: {
				status: "rejected",
				reason: CHECK_TRAIL_REASONS.missing,
				detail: `required check '${name}' is absent from the trail`,
			},
		};
	}

	// A `fail` on a required check is refused here too. Rule 1 only catches it
	// when the overall status claims `passed`; a required check that ran and
	// failed is not a proposable change regardless of what the header says.
	if (entry.status === "fail") {
		return {
			rejection: {
				status: "rejected",
				reason: CHECK_TRAIL_REASONS.refused,
				detail: `required check '${name}' reports fail`,
			},
		};
	}

	if (!isDegraded(entry.status)) {
		return null;
	}

	// Rule 3 — degraded is refused unless this template has a reviewed allowance.
	const allowance = allowanceFor(jobType, name, entry.status);
	if (allowance === null) {
		return {
			rejection: {
				status: "rejected",
				reason: CHECK_TRAIL_REASONS.refused,
				detail: `required check '${name}' reported '${entry.status}' with no matching allowance`,
			},
		};
	}
	return { degraded: { check: name, status: entry.status, allowance: allowance.name } };
}

/**
 * The allowance uses present in a bare check trail, for DISPLAY only.
 *
 * Used by the proposal pass, which holds the persisted trail but not the
 * verdict, to flag the same rows the gate tolerated. It re-derives from the same
 * {@link ALLOWANCES} constant rather than reading a persisted verdict, so an
 * allowance edited in source is reflected in the body and the flags shown can
 * never drift from the rules currently in force.
 *
 * This is NOT a second gate: it makes no accept/reject decision and is only
 * reached for a change that already passed {@link reconcileCheckTrail}.
 *
 * RESOLVED BY JOB TYPE, exactly as the gate resolves it. An allowance is scoped
 * to the templates it names, and the same (check, status) pair means different
 * things on different templates: `secrets`/`skip` is `secrets-gitleaks-absent`
 * ("gitleaks is not installed in the golden runner image") on the implement
 * lane, but `verb-secrets-not-run` ("the deterministic verb body renders a
 * catalog change but runs no secret scanner") on a verb. A job-type-BLIND
 * lookup returned whichever entry sat first in {@link ALLOWANCES}, so a verb
 * result rendered the implement lane's gitleaks sentence into the operator's
 * proposal body — a reason that names a tool the verb body never invokes. The
 * display path must therefore agree with the gate by construction, not by the
 * coincidence that a given pair happens to be unique across templates.
 *
 * @param checks - the persisted per-check trail
 * @param jobType - the job type of the result the trail came from, read from
 *   the same trusted job row the rest of the proposal pass uses — never from
 *   runner-supplied text
 * @returns one entry per required check that was degraded and allowed by name
 */
export const degradedFromTrail = traced(
	"results.degradedFromTrail",
	function degradedFromTrail(checks: readonly ResultCheck[], jobType: string): DegradedCheck[] {
		const degraded: DegradedCheck[] = [];
		for (const name of REQUIRED_CHECKS) {
			const entry = checks.find((check) => check.name === name);
			if (entry === undefined || !isDegraded(entry.status)) {
				continue;
			}
			const allowance = allowanceFor(jobType, name, entry.status);
			if (allowance !== null) {
				degraded.push({ check: name, status: entry.status, allowance: allowance.name });
			}
		}
		return degraded;
	},
);

/**
 * Decide whether one result's check trail is coherent and complete enough for
 * the change path.
 *
 * @param result - the schema-validated runner result
 * @returns `ok` (with any allowance uses the caller must log by name) or a
 *   `rejected` verdict carrying a fixed author-controlled reason code
 */
export const reconcileCheckTrail = traced(
	"results.reconcileCheckTrail",
	function reconcileCheckTrail(result: RunnerResult): CheckTrailVerdict {
		const contradiction = findContradiction(result);
		if (contradiction !== null) {
			return contradiction;
		}

		const degraded: DegradedCheck[] = [];
		for (const name of REQUIRED_CHECKS) {
			const judgement = judgeRequiredCheck(result.job_type, name, result.checks);
			if (judgement === null) {
				continue;
			}
			if ("rejection" in judgement) {
				return judgement.rejection;
			}
			degraded.push(judgement.degraded);
		}

		return { status: "ok", degraded };
	},
);
