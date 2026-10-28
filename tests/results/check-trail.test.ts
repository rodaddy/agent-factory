/**
 * @module tests/results/check-trail
 * @description Tests for the implement lane's check-trail policy.
 *
 *   The rule under test exists because a runner grades its own homework: it
 *   reports both the overall status and the per-check trail, and nothing stops
 *   those two from disagreeing. So these are written as the incoherent and
 *   incomplete trails a runner can actually emit — a `passed` header over a
 *   failing check, a trail that never mentions the secret scan at all, and a
 *   degraded check that does not match any reviewed allowance — rather than
 *   happy-path coverage.
 *
 *   The bounds tests cover the OTHER half of the ruling: the trail travels into
 *   a PR body, which makes this the first runner-supplied display text a
 *   proposal has ever carried, so the rendered body is asserted to stay inside
 *   its cap, to redact a secret-looking summary, and to cap a pathological
 *   field rather than letting it eat the table.
 */
import { describe, expect, test } from "bun:test";
import { buildProposalPlan } from "../../src/github/publication";
import { CAPS } from "../../src/github/publication-types";
import {
	ALLOWANCES,
	CHECK_TRAIL_REASONS,
	degradedFromTrail,
	RENDERABLE_VERB_JOB_TYPES,
	REQUIRED_CHECKS,
	reconcileCheckTrail,
} from "../../src/results/check-trail";
import { IMPLEMENT_JOB_TYPE, type ResultCheck, type RunnerResult } from "../../src/results/schema";

/** A trail entry. */
function check(name: string, status: ResultCheck["status"], summary?: string): ResultCheck {
	return summary === undefined ? { name, status } : { name, status, summary };
}

/** A complete all-pass implement result, overridable per test. */
function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		result_version: 2,
		repository: "rodaddy/software-factory",
		job_type: "implement-issue",
		status: "passed",
		checks: [check("secrets", "pass"), check("test", "pass")],
		findings: [],
		...overrides,
	} as RunnerResult;
}

describe("reconcileCheckTrail", () => {
	// Case 1 — CONTRADICTION. A runner claiming success while its own trail
	// reports a failing check is incoherent; there is no safe way to decide which
	// half is lying, so the result is refused rather than resolved in its favour.
	test("rejects a passed result whose own trail reports a failing check", () => {
		const verdict = reconcileCheckTrail(
			result({ checks: [check("secrets", "pass"), check("test", "fail")] }),
		);
		expect(verdict.status).toBe("rejected");
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.contradiction });
	});

	// The contradiction rule must not fire on a result that AGREES with itself.
	// A failed result carrying a failing check is coherent — it is simply not a
	// success, and it never reaches the change path anyway.
	test("does not raise a contradiction when the overall status already says failed", () => {
		const verdict = reconcileCheckTrail(
			result({ status: "failed", checks: [check("secrets", "pass"), check("test", "fail")] }),
		);
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.refused });
	});

	// Case 2 — ABSENCE IS NOT PASSING. A gate that never ran looks exactly
	// like a gate that passed unless somebody insists on seeing the entry.
	test("rejects a trail missing a required check entirely", () => {
		const verdict = reconcileCheckTrail(result({ checks: [check("test", "pass")] }));
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.missing });
		expect(verdict.status === "rejected" && verdict.detail).toContain("secrets");
	});

	test("rejects an entirely empty trail as a missing required check", () => {
		const verdict = reconcileCheckTrail(result({ checks: [] }));
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.missing });
	});

	// Case 3 — a named allowance permits secrets=skip, and the use is reported so
	// the caller can log it by name.
	test("accepts secrets=skip under the gitleaks-absent allowance and reports the use", () => {
		const verdict = reconcileCheckTrail(
			result({ checks: [check("secrets", "skip"), check("test", "pass")] }),
		);
		expect(verdict.status).toBe("ok");
		expect(verdict.status === "ok" && verdict.degraded).toEqual([
			{ check: "secrets", status: "skip", allowance: "secrets-gitleaks-absent" },
		]);
	});

	// Case 4 — the environment-class test error is allowed by its own name.
	test("accepts test=error under the test-environment allowance", () => {
		const verdict = reconcileCheckTrail(
			result({ checks: [check("secrets", "pass"), check("test", "error")] }),
		);
		expect(verdict.status === "ok" && verdict.degraded).toEqual([
			{ check: "test", status: "error", allowance: "test-environment" },
		]);
	});

	test("accepts honest secrets/test skips only for the three rendered verb templates", () => {
		for (const jobType of ["newroute", "newapp", "newdb"]) {
			const verdict = reconcileCheckTrail(
				result({
					job_type: jobType,
					checks: [check("secrets", "skip"), check("test", "skip")],
				}),
			);
			expect(verdict.status).toBe("ok");
			expect(verdict.status === "ok" && verdict.degraded).toEqual([
				{ check: "secrets", status: "skip", allowance: "verb-secrets-not-run" },
				{ check: "test", status: "skip", allowance: "verb-test-not-run" },
			]);
		}
	});

	test("does not leak the verb test-skip allowance into the implement template", () => {
		const verdict = reconcileCheckTrail(
			result({ checks: [check("secrets", "pass"), check("test", "skip")] }),
		);
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.refused });
	});

	// Case 5 — the allowance is per (template, check, STATUS), not per check. `secrets=skip`
	// is allowed because gitleaks is absent; `secrets=error` means the scan tried
	// and broke, which nothing has reviewed, so it is refused.
	test("rejects secrets=error, a status no allowance lists", () => {
		const verdict = reconcileCheckTrail(
			result({ checks: [check("secrets", "error"), check("test", "pass")] }),
		);
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.refused });
	});

	// The mirror of case 5: an allowance must never excuse a check that RAN and
	// found a problem, only one that could not run.
	test("rejects test=fail even though the test check has an allowance", () => {
		const verdict = reconcileCheckTrail(
			result({ status: "failed", checks: [check("secrets", "pass"), check("test", "fail")] }),
		);
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.refused });
	});

	// Case 6 — the clean path. No allowance use, so nothing is logged as a warn.
	test("accepts a clean all-pass trail with no degraded entries", () => {
		const verdict = reconcileCheckTrail(result());
		expect(verdict).toEqual({ status: "ok", degraded: [] });
	});

	// An unrelated failing check still contradicts a `passed` header, even though
	// it is not one of the required ones.
	test("rejects a passed result whose non-required check reports fail", () => {
		const verdict = reconcileCheckTrail(
			result({ checks: [check("secrets", "pass"), check("test", "pass"), check("lint", "fail")] }),
		);
		expect(verdict).toMatchObject({ reason: CHECK_TRAIL_REASONS.contradiction });
	});
});

describe("ALLOWANCES", () => {
	// An allowance is the only way a hole in the trail is tolerated. If one could
	// list `fail`, it would excuse a check that ran and found a real problem.
	test("no allowance permits a fail or a pass status", () => {
		for (const allowance of ALLOWANCES) {
			expect(allowance.statuses).not.toContain("fail");
			expect(allowance.statuses).not.toContain("pass");
		}
	});

	// Each allowance must say what deletes it, or it silently becomes permanent
	// policy and the trail goes back to proving nothing while still looking green.
	test("every allowance carries a name, a reason, and a removal condition", () => {
		for (const allowance of ALLOWANCES) {
			expect(allowance.name.length).toBeGreaterThan(0);
			expect(allowance.reason.length).toBeGreaterThan(0);
			expect(allowance.removeWhen.length).toBeGreaterThan(0);
			expect(allowance.jobTypes.length).toBeGreaterThan(0);
			expect(REQUIRED_CHECKS).toContain(allowance.check as (typeof REQUIRED_CHECKS)[number]);
		}
	});
});

/**
 * The degraded trail each job type can realistically emit.
 *
 * Per TEMPLATE, because the allowances are per template: the implement lane's
 * reviewed holes are `secrets`/`skip` and `test`/`error`, while a deterministic
 * verb body reports both required checks as an honest `skip` (it runs neither a
 * scanner nor a suite). Using one shared trail for both would test a shape no
 * runner emits and would miss the divergence entirely.
 */
const REALISTIC_DEGRADED_TRAIL: Record<string, ResultCheck[]> = {
	[IMPLEMENT_JOB_TYPE]: [check("secrets", "skip"), check("test", "error")],
	newroute: [check("secrets", "skip"), check("test", "skip")],
	newapp: [check("secrets", "skip"), check("test", "skip")],
	newdb: [check("secrets", "skip"), check("test", "skip")],
};

describe("degradedFromTrail", () => {
	// The display path must agree with the gate, or the PR body flags different
	// rows than the ones that were actually tolerated.
	//
	// Run over EVERY renderable job type, not just the implement lane. Pinned to
	// one type this property could not fail on the verb templates at all: the
	// display path resolved allowances blind, so a verb's `secrets`/`skip`
	// matched the implement lane's `secrets-gitleaks-absent` — the first entry in
	// ALLOWANCES with that pair — and the proposal body told the operator
	// "gitleaks is not installed" about a body that runs no gitleaks step.
	test.each([IMPLEMENT_JOB_TYPE, ...RENDERABLE_VERB_JOB_TYPES])(
		"display agrees with the gate verdict for job type %s",
		(jobType) => {
			const checks = REALISTIC_DEGRADED_TRAIL[jobType] ?? [];
			expect(checks.length).toBeGreaterThan(0);
			const verdict = reconcileCheckTrail(result({ job_type: jobType, checks }));
			// The gate must actually TOLERATE this trail, or the property below is
			// satisfied vacuously by two empty lists.
			expect(verdict.status).toBe("ok");
			const gateDegraded = verdict.status === "ok" ? verdict.degraded : [];
			expect(gateDegraded.length).toBe(REQUIRED_CHECKS.length);
			expect(degradedFromTrail(checks, jobType)).toEqual(gateDegraded);
		},
	);

	// FIX A's display half, named explicitly. The agreement property above would
	// also pass if BOTH paths were wrong in the same direction; this clause pins
	// the actual operator-facing allowance a verb result must resolve, so a
	// regression that reintroduced the blind lookup names the wrong allowance here.
	test.each([...RENDERABLE_VERB_JOB_TYPES])(
		"a verb result resolves the verb allowances, never the implement lane's gitleaks reason (%s)",
		(jobType) => {
			const checks = [check("secrets", "skip"), check("test", "skip")];
			expect(degradedFromTrail(checks, jobType)).toEqual([
				{ check: "secrets", status: "skip", allowance: "verb-secrets-not-run" },
				{ check: "test", status: "skip", allowance: "verb-test-not-run" },
			]);
		},
	);

	// The implement lane keeps its own reasons: the same (check, status) pair must
	// NOT start resolving to a verb allowance now that the lookup is scoped.
	test("the implement lane still resolves its own gitleaks allowance", () => {
		const checks = [check("secrets", "skip"), check("test", "error")];
		expect(degradedFromTrail(checks, IMPLEMENT_JOB_TYPE)).toEqual([
			{ check: "secrets", status: "skip", allowance: "secrets-gitleaks-absent" },
			{ check: "test", status: "error", allowance: "test-environment" },
		]);
	});

	// An unknown template has no allowances at all, so nothing is flagged as
	// tolerated. Absence of an allowance is never presented as a tolerated hole.
	test("reports nothing for a job type no allowance covers", () => {
		expect(
			degradedFromTrail([check("secrets", "skip"), check("test", "skip")], "pr-review"),
		).toEqual([]);
	});

	test("reports nothing for a clean trail", () => {
		expect(
			degradedFromTrail([check("secrets", "pass"), check("test", "pass")], IMPLEMENT_JOB_TYPE),
		).toEqual([]);
	});
});

describe("buildProposalPlan check trail", () => {
	// Case 3/4 display half — a tolerated hole must be VISIBLE at merge time,
	// carrying the name of the allowance that permitted it.
	test("flags a degraded-but-allowed check with the allowance name", () => {
		const checks = [check("secrets", "skip"), check("test", "pass")];
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks,
			degraded: degradedFromTrail(checks, IMPLEMENT_JOB_TYPE),
		});
		expect(plan?.body).toContain("secrets-gitleaks-absent");
		expect(plan?.body).toContain("⚠");
		expect(plan?.body).toContain("Runner check trail");
	});

	// Case 6 display half — a clean trail is shown in full and carries no warning.
	test("renders a clean trail with no degraded warning", () => {
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks: [check("secrets", "pass"), check("test", "pass")],
			degraded: [],
		});
		expect(plan?.body).toContain("secrets");
		expect(plan?.body).toContain("test");
		expect(plan?.body).not.toContain("⚠");
	});

	// A result with no trail must not render an empty section, which would read
	// as "there were no problems" rather than "nothing was recorded".
	test("omits the trail section entirely when there are no checks", () => {
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks: [],
			degraded: [],
		});
		expect(plan?.body).not.toContain("Runner check trail");
		expect(plan?.body).toContain("Closes #157");
	});

	// Case 7 — bounds at the MAX SHAPE the schema permits. The section caps its
	// own row count so the outer capText never truncates the table mid-row.
	test("stays within the body cap at the maximum trail the schema allows", () => {
		const checks = Array.from({ length: 100 }, (_, i) =>
			check(`check-${i}`.padEnd(120, "x").slice(0, 120), "pass", "y".repeat(2000)),
		);
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks,
			degraded: [],
		});
		expect(plan).not.toBeNull();
		expect(plan?.body.length).toBeLessThanOrEqual(CAPS.issueBody);
		// The truncation is EXPLICIT, not a silently eaten tail.
		expect(plan?.body).toContain("more check(s) not shown");
		// And the fixed trailer survives, proving the table did not consume the body.
		expect(plan?.body).toContain("Closes #157");
	});

	test("caps an oversized check name and summary rather than letting them fill the body", () => {
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks: [check("secrets", "pass", "z".repeat(2000)), check("test", "pass")],
			degraded: [],
		});
		expect(plan?.body).not.toContain("z".repeat(CAPS.trailSummary + 5));
		expect(plan?.body.length).toBeLessThanOrEqual(CAPS.issueBody);
	});

	// Runner text reaching a PR body for the first time makes redaction load
	// bearing: a check summary is exactly where a leaked token would surface.
	test("redacts a secret-looking check summary", () => {
		const token = `ghp_${"a".repeat(36)}`;
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks: [check("secrets", "pass", `leaked ${token}`), check("test", "pass")],
			degraded: [],
		});
		expect(plan?.body).not.toContain(token);
	});

	// The trail is DISPLAY text; it must never introduce structure into a body
	// whose shape is author-controlled.
	test("renders markdown in a check summary inert", () => {
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks: [
				check("secrets", "pass", "[click](http://evil.test) # heading"),
				check("test", "pass"),
			],
			degraded: [],
		});
		expect(plan?.body).not.toContain("[click](http://evil.test)");
	});
});

/**
 * The agent signature line on the proposal PR body. The proposal body
 * carries NO hidden dedupe marker (proposals dedupe on the branch pair, not a
 * body marker — see `findMarkedComment`/`findMarkedIssue` in
 * `src/github/publish-dedupe.ts`, neither of which reads a proposal body), so
 * the signature is line 1 outright here.
 */
describe("agent signature line on proposal bodies", () => {
	const SIG_PREFIX =
		"**agent:** rodaddy-watcher · model unattested · seat software-factory watcher (CT101) · ";

	test("the proposal body's FIRST line is the signature", () => {
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks: [],
			degraded: [],
		});
		const lines = (plan?.body ?? "").split("\n");
		expect(lines[0]?.startsWith(SIG_PREFIX)).toBe(true);
		expect(lines[0]?.slice(SIG_PREFIX.length)).toMatch(/^\d{4}-\d{2}-\d{2} UTC$/);
	});

	test("the signature precedes the proposal heading", () => {
		const plan = buildProposalPlan(157, "main", "abc1234", {
			jobType: IMPLEMENT_JOB_TYPE,
			checks: [],
			degraded: [],
		});
		// PRESENCE FIRST — see the audit-issue twin: a bare ordering assertion is
		// vacuously green while the signature is missing (-1 < anything).
		const body = plan?.body ?? "";
		expect(body.indexOf("**agent:** rodaddy-watcher")).toBeGreaterThan(-1);
		expect(body.indexOf("**agent:** rodaddy-watcher")).toBeLessThan(
			body.indexOf("### software-factory proposed change"),
		);
	});
});
