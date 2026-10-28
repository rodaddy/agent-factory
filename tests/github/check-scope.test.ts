/**
 * The published verdict NAMES ITS SCOPE.
 *
 * `software-factory passed — Job \`infra-static\` passed.` is truthful about the
 * lane and misleading about the repository. On rtech-infra PR #1453 that gap let
 * two real regressions through under a green: the watcher suite was not in the
 * lane, so the lane was never asked, and nothing in the verdict said so.
 *
 * These tests pin the clause the fix adds, and — more importantly — pin the
 * EMPTY case, which is where this class of fix usually reintroduces the bug it
 * was meant to remove.
 */
import { describe, expect, test } from "bun:test";
import { buildPublicationPlans, type JobIdentity } from "../../src/github/publication";
import { renderCheckScope } from "../../src/github/publication-text";
import { RESULT_VERSION, type ResultCheck, type RunnerResult } from "../../src/results/schema";

const identity: JobIdentity = {
	jobId: 42,
	repository: "rtech/rtech-infra",
	itemNumber: 1453,
	sha: "069968c5deadbeef",
	jobType: "infra-static",
};

function result(checks: ResultCheck[], overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rtech/rtech-infra",
		job_type: "infra-static",
		item_number: 1453,
		sha: "069968c5deadbeef",
		status: "passed",
		checks,
		findings: [],
		...overrides,
	};
}

function checkSummary(r: RunnerResult): string {
	const plan = buildPublicationPlans(identity, r).find((p) => p.kind === "check");
	if (plan === undefined || plan.kind !== "check") {
		throw new Error("no check plan was built");
	}
	return plan.summary;
}

describe("renderCheckScope — the scope clause", () => {
	test("names the checks that actually answered", () => {
		expect(
			renderCheckScope([
				{ name: "ansible-lint", status: "pass" },
				{ name: "yamllint", status: "pass" },
			]),
		).toBe("covered: ansible-lint, yamllint");
	});

	/**
	 * THE REGRESSION THIS FIX IS MOST LIKELY TO REINTRODUCE. A scope renderer that
	 * returns "" on an empty trail hands the caller back the exact unqualified
	 * verdict #1460 is about, and every test above still passes. The empty trail
	 * must SAY it is empty (the absent-input-PASS family, rtech-infra #1607).
	 */
	test("an EMPTY trail says scope is unknown, never nothing", () => {
		const clause = renderCheckScope([]);
		expect(clause).not.toBe("");
		expect(clause).toBe("no check trail reported, scope unknown");
	});

	test("caps the list and counts the remainder, so the count is never wrong", () => {
		const many: ResultCheck[] = Array.from({ length: 9 }, (_, i) => ({
			name: `gate-${i}`,
			status: "pass",
		}));
		expect(renderCheckScope(many)).toBe(
			"covered: gate-0, gate-1, gate-2, gate-3, gate-4, gate-5, +3 more",
		);
	});

	/**
	 * The primary consumer is a forge STATUS DESCRIPTION, which is plain text.
	 * Markdown escaping would be published literally there, so a name that
	 * sanitizes must come back with no backslashes in it.
	 */
	test("hostile runner text is inert and carries no markdown escapes", () => {
		const clause = renderCheckScope([{ name: "[x](http://evil) `hi` @operator", status: "pass" }]);
		expect(clause).not.toContain("\\");
		expect(clause).not.toContain("](");
		expect(clause).not.toContain("`");
		expect(clause).not.toContain("@operator");
	});

	/**
	 * REGRESSION, caught in review on PR #717. The first cut sliced to the cap and
	 * filtered afterwards, so six unnameable checks followed by a real one reported
	 * "7 unnamed check(s)" and hid `shellcheck` entirely — a scope clause
	 * concealing scope, which is the exact defect this whole change exists to fix.
	 * The trail is sanitized in full BEFORE the cap is applied.
	 */
	test("a valid name later in the trail is never hidden by unnameable ones before it", () => {
		const checks: ResultCheck[] = [
			{ name: "@@@", status: "pass" },
			{ name: "###", status: "pass" },
			{ name: "!!!", status: "pass" },
			{ name: "***", status: "pass" },
			{ name: "???", status: "pass" },
			{ name: "%%%", status: "pass" },
			{ name: "shellcheck", status: "pass" },
		];
		expect(renderCheckScope(checks)).toBe("covered: shellcheck, +6 more");
	});

	test("no spurious remainder when the named checks exactly fill the cap", () => {
		const six: ResultCheck[] = Array.from({ length: 6 }, (_, i) => ({
			name: `g${i}`,
			status: "pass",
		}));
		expect(renderCheckScope(six)).toBe("covered: g0, g1, g2, g3, g4, g5");
	});

	test("a name that sanitizes to nothing is counted, not silently dropped", () => {
		expect(
			renderCheckScope([
				{ name: "@@@", status: "pass" },
				{ name: "shellcheck", status: "pass" },
			]),
		).toBe("covered: shellcheck, +1 more");
		expect(
			renderCheckScope([
				{ name: "@@@", status: "pass" },
				{ name: "###", status: "pass" },
			]),
		).toBe("covered: 2 unnamed check(s)");
	});
});

describe("the published check summary carries the scope", () => {
	test("a passing lane no longer publishes an unqualified verdict", () => {
		const summary = checkSummary(
			result([
				{ name: "ansible-lint", status: "pass" },
				{ name: "shellcheck", status: "pass" },
			]),
		);
		expect(summary).toContain("covered: ansible-lint, shellcheck");
		// The exact string the issue quoted must no longer be publishable.
		expect(summary).not.toBe("Job `infra-static` passed.");
	});

	test("an empty trail publishes the unknown-scope clause rather than a bare pass", () => {
		const summary = checkSummary(result([]));
		expect(summary).toContain("scope unknown");
		expect(summary).not.toBe("Job `infra-static` passed.");
	});

	/**
	 * The scope clause is about BREADTH, not outcome: a failing lane is just as
	 * misread when the reader cannot tell what it looked at.
	 */
	test("a failing lane names its scope too", () => {
		const summary = checkSummary(
			result([{ name: "ansible-lint", status: "fail" }], { status: "failed" }),
		);
		expect(summary).toContain("covered: ansible-lint");
	});
});
