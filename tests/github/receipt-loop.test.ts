/**
 * The receipt loop: state flips only on live probe receipts, a failing job
 * HOLDs with a RED report, and the receipt is posted BEFORE the flip.
 *
 * Every assertion here reads its label VALUES from `publication-types` rather
 * than spelling them, because sf#253 defines the wider label/column vocabulary in
 * parallel — a rename there must not touch this file. What IS spelled is the
 * structure: which member each outcome selects, and in what order the plans land.
 *
 * The four clauses map to `scripts/done-means/receipt-loop-254.sh`, which asserts
 * the same properties at the plan-array boundary from outside the test runner.
 */
import { describe, expect, test } from "bun:test";
import {
	buildPublicationPlans,
	type JobIdentity,
	type PublicationPlan,
	RECEIPT_SPECS,
	RESULT_LABELS,
	receiptSatisfied,
	stateForOutcome,
} from "../../src/github/publication";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { JOB_TEMPLATE_IDS } from "../../src/templates/registry";

/** A `command-exit` lane — one that OWES live evidence before it may flip. */
const PROBED_LANE = "repo-validate";
/** A `none-required` lane — a report that mutates nothing live. */
const REPORT_LANE = "pr-review";

function identityFor(jobType: string): JobIdentity {
	return {
		jobId: 42,
		repository: "rodaddy/x",
		itemNumber: 7,
		sha: "deadbeefcafe",
		jobType,
	};
}

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: REPORT_LANE,
		item_number: 7,
		sha: "deadbeefcafe",
		status: "passed",
		checks: [],
		findings: [],
		...overrides,
	};
}

/** The single label ADD in a plan set — the state this outcome flipped to. */
function flippedState(plans: PublicationPlan[]): string | undefined {
	const add = plans.find(
		(p) => p.kind === "label" && p.action === "add" && p.label in invertedLabels,
	);
	return add?.kind === "label" ? add.label : undefined;
}

/** Value -> key over the vocabulary, so assertions never spell a label. */
const invertedLabels: Record<string, string> = Object.fromEntries(
	Object.entries(RESULT_LABELS).map(([k, v]) => [v, k]),
);

describe("#254 clause 1 — every allowlisted job definition carries a receipt spec", () => {
	test("the spec map covers JOB_TEMPLATE_IDS exactly, with no extra keys", () => {
		const specKeys = Object.keys(RECEIPT_SPECS).sort();
		expect(specKeys).toEqual([...JOB_TEMPLATE_IDS].sort());
	});

	test("every spec declares a kind and a non-empty description", () => {
		// A spec whose `describes` is blank renders an empty receipt claim into the
		// comment, which reads as evidence while carrying none.
		for (const id of JOB_TEMPLATE_IDS) {
			const spec = RECEIPT_SPECS[id];
			expect(spec.kind.length).toBeGreaterThan(0);
			expect(spec.describes.trim().length).toBeGreaterThan(0);
		}
	});
});

describe("#254 clause 2 — the receipt precedes the state flip, one transaction", () => {
	test("the comment plan is emitted BEFORE every label plan", () => {
		// The plan array IS the posting order: `publish-plan.ts` inserts one row per
		// plan in array order and `publish.ts` selects ORDER BY id ASC. A flip ahead
		// of its receipt is therefore a real window in which the forge reads done
		// with no evidence posted.
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "failed" }));
		const commentIdx = plans.findIndex((p) => p.kind === "comment");
		const firstLabelIdx = plans.findIndex((p) => p.kind === "label");
		expect(commentIdx).toBeGreaterThanOrEqual(0);
		expect(firstLabelIdx).toBeGreaterThanOrEqual(0);
		expect(commentIdx).toBeLessThan(firstLabelIdx);
	});

	test("the ordering holds on the triage lane too, which builds a different comment", () => {
		const plans = buildPublicationPlans(
			identityFor("issue-triage"),
			result({ job_type: "issue-triage", status: "failed" }),
			true,
			["bug"],
		);
		const commentIdx = plans.findIndex((p) => p.kind === "comment");
		const firstLabelIdx = plans.findIndex((p) => p.kind === "label");
		expect(commentIdx).toBeLessThan(firstLabelIdx);
	});

	test("the receipt comment carries the spec, the verdict, and verbatim check rows", () => {
		const plans = buildPublicationPlans(
			identityFor(PROBED_LANE),
			result({
				job_type: PROBED_LANE,
				status: "passed",
				checks: [{ name: "build", status: "pass", summary: "exit 0" }],
			}),
		);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment plan");
		expect(comment.body).toContain("#### Receipt");
		expect(comment.body).toContain(RECEIPT_SPECS[PROBED_LANE].describes);
		expect(comment.body).toContain("Verbatim check outcomes:");
		// The verbatim exit-code text the runner recorded, bounded by renderCheckTrail.
		expect(comment.body).toContain("exit 0");
	});
});

describe("#254 clause 3 — a failing job HOLDs with a RED report and is never closed", () => {
	test("a failed status flips to HOLD, not to a terminal failed state", () => {
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "failed" }));
		expect(flippedState(plans)).toBe(RESULT_LABELS.hold);
		expect(flippedState(plans)).not.toBe(RESULT_LABELS.failed);
	});

	test("an error status flips to HOLD as well", () => {
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "error" }));
		expect(flippedState(plans)).toBe(RESULT_LABELS.hold);
	});

	test("a probed lane reporting PASSED with no evidence still HOLDs", () => {
		// The hard case, and the one the defect actually wears: the runner says it
		// passed, and produced nothing to show for it. Auth-death results look exactly
		// like this.
		const plans = buildPublicationPlans(
			identityFor(PROBED_LANE),
			result({ job_type: PROBED_LANE, status: "passed", checks: [] }),
		);
		expect(flippedState(plans)).toBe(RESULT_LABELS.hold);
	});

	test("a probed lane reporting PASSED over a FAILING check row HOLDs", () => {
		const plans = buildPublicationPlans(
			identityFor(PROBED_LANE),
			result({
				job_type: PROBED_LANE,
				status: "passed",
				checks: [
					{ name: "build", status: "pass" },
					{ name: "smoke", status: "fail", summary: "exit 1" },
				],
			}),
		);
		expect(flippedState(plans)).toBe(RESULT_LABELS.hold);
	});

	test("the HOLD landing emits no close, no retry, and no destructive plan", () => {
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "failed" }));
		for (const plan of plans) {
			// Whole-set sweep, not just the last plan.
			expect(["label", "comment", "check"]).toContain(plan.kind);
			if (plan.kind === "label") {
				expect(["add", "remove"]).toContain(plan.action);
			}
		}
	});

	test("the held comment opens its escalation with BLOCKED, the cause, and the decision", () => {
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "failed" }));
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment plan");
		expect(comment.body).toContain("**BLOCKED**");
		expect(comment.body).toContain("Decision needed:");
		// It must SAY it did not close or retry — the reader's question on a hold.
		expect(comment.body).toContain("NOT closed and NOT retried");
	});
});

describe("#254 clause 4 — the negative control, and its anti-overmatch twin", () => {
	test("a deliberately-failing job is OBSERVED landing in HOLD", () => {
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "failed" }));
		expect(flippedState(plans)).toBe(RESULT_LABELS.hold);
	});

	test("a PASSING job does NOT land in HOLD — hold-on-everything distinguishes nothing", () => {
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "passed" }));
		expect(flippedState(plans)).toBe(RESULT_LABELS.passed);
		expect(flippedState(plans)).not.toBe(RESULT_LABELS.hold);
	});

	test("a passing probed lane WITH evidence flips to passed, not HOLD", () => {
		const plans = buildPublicationPlans(
			identityFor(PROBED_LANE),
			result({
				job_type: PROBED_LANE,
				status: "passed",
				checks: [{ name: "build", status: "pass" }],
			}),
		);
		expect(flippedState(plans)).toBe(RESULT_LABELS.passed);
	});

	test("a skipped job keeps its own state — it made no claim to verify", () => {
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "skipped" }));
		expect(flippedState(plans)).toBe(RESULT_LABELS.skipped);
	});
});

describe("the receipt verdict is derived from TRUSTED inputs only", () => {
	test("the spec is selected by identity.jobType, never the runner's own job_type", () => {
		// The attack: a probed lane's runner claims to be a `none-required` lane in
		// its result body, hoping to be judged by the lenient spec and receipt itself.
		const spoofed = result({
			job_type: REPORT_LANE, // runner-claimed: none-required
			status: "passed",
			checks: [],
		});
		// Trusted identity says this is the probed lane, which owes evidence.
		expect(receiptSatisfied(identityFor(PROBED_LANE), spoofed)).toBe(false);
		const plans = buildPublicationPlans(identityFor(PROBED_LANE), spoofed);
		expect(flippedState(plans)).toBe(RESULT_LABELS.hold);
	});

	test("an unregistered job type has no spec and can earn no state", () => {
		expect(receiptSatisfied(identityFor("not-a-real-template"), result())).toBe(false);
	});

	test("a runner cannot report `hold` as its own status", () => {
		// `hold` is factory-derived. The admission guard keys on PUBLISHABLE_STATUSES,
		// not on the label vocabulary, so widening the vocabulary did not widen what a
		// runner may claim. (Ingest's z.enum rejects it first; this is the second line.)
		const bogus = { ...result(), status: "hold" } as unknown as RunnerResult;
		expect(buildPublicationPlans(identityFor(REPORT_LANE), bogus)).toEqual([]);
	});
});

describe("stateForOutcome — the derivation itself", () => {
	test("an unsatisfied receipt downgrades a pass to HOLD", () => {
		expect(stateForOutcome("passed", false)).toBe(RESULT_LABELS.hold);
	});

	test("a satisfied receipt never upgrades a failure into a pass", () => {
		expect(stateForOutcome("failed", true)).toBe(RESULT_LABELS.hold);
		expect(stateForOutcome("error", true)).toBe(RESULT_LABELS.hold);
	});

	test("a satisfied receipt on a successful job flips to that job's own state", () => {
		expect(stateForOutcome("passed", true)).toBe(RESULT_LABELS.passed);
		expect(stateForOutcome("skipped", true)).toBe(RESULT_LABELS.skipped);
	});
});

describe("the hold label is releasable", () => {
	test("a later passing run REMOVES a stale hold label", () => {
		// Without `hold` in ALL_RESULT_LABELS the transition set would never remove it,
		// stranding a held card on an item that has since gone green.
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "passed" }));
		const removes = plans.filter((p) => p.kind === "label" && p.action === "remove");
		const removed = removes.map((p) => (p.kind === "label" ? p.label : ""));
		expect(removed).toContain(RESULT_LABELS.hold);
	});
});

describe("sf#613 — the receipt label never says 'Verdict'", () => {
	/**
	 * The `pr-review` lane posts TWO things about one PR, from two runtimes, and
	 * they answer different questions:
	 *
	 *   - `factory/pr-review` (Forgejo Actions) — the reviewer's VERDICT on the
	 *     code. `fix-first` posts a `failure` commit status.
	 *   - this comment (the runner-box lane) — whether the receipt SPEC was
	 *     satisfied, i.e. whether the lane produced the evidence it owes.
	 *
	 * Both can be true at once: a review that finds a P0 is a `fix-first` verdict
	 * in a run whose checks all executed cleanly. Rendered as
	 * `Verdict: **satisfied**`, that reads as approval sitting inches from a
	 * `failure` status, and on 2026-09-04 two sessions read it exactly that way —
	 * one opened a cross-session debugging request about a status that was
	 * correct, the other reported a PR as blocked and had to retract it. The
	 * status writer was never wrong; one word in this comment was.
	 *
	 * Nothing else pins this string, so a rename back would pass silently. That
	 * is what this test is for.
	 */
	function receiptLine(jobType: string, status: RunnerResult["status"]): string {
		const plans = buildPublicationPlans(
			identityFor(jobType),
			result({ job_type: jobType, status }),
		);
		const comment = plans.find((p) => p.kind === "comment");
		const body = comment?.kind === "comment" ? comment.body : "";
		return body.split("\n").find((l) => l.includes("satisfied")) ?? "";
	}

	test("a satisfied receipt is labelled Receipt, not Verdict", () => {
		const line = receiptLine(REPORT_LANE, "passed");
		expect(line).toContain("Receipt: **satisfied**");
		expect(line).not.toContain("Verdict");
	});

	test("an unsatisfied receipt is labelled Receipt, not Verdict", () => {
		const line = receiptLine(PROBED_LANE, "passed");
		expect(line).toContain("NOT satisfied");
		expect(line).not.toContain("Verdict");
	});

	test("no line of a pr-review comment claims a verdict this lane cannot have", () => {
		// The whole comment, not just the receipt line: any future field
		// reintroducing the word next to a review re-creates the collision.
		const plans = buildPublicationPlans(identityFor(REPORT_LANE), result({ status: "passed" }));
		const comment = plans.find((p) => p.kind === "comment");
		const body = comment?.kind === "comment" ? comment.body : "";
		expect(body.length).toBeGreaterThan(0);
		expect(body.toLowerCase()).not.toContain("verdict");
	});
});
