import { describe, expect, test } from "bun:test";
import {
	ALL_RESULT_LABELS,
	buildPublicationPlans,
	CAPS,
	CHECK_NAME,
	CHECK_TARGET,
	COMMENT_TARGET,
	type JobIdentity,
	RESULT_LABELS,
} from "../../src/github/publication";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";

const identity: JobIdentity = {
	jobId: 42,
	repository: "rodaddy/x",
	itemNumber: 7,
	sha: "deadbeefcafe",
	jobType: "pr-review",
};

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: "pr-review",
		item_number: 7,
		sha: "deadbeefcafe",
		status: "passed",
		checks: [],
		findings: [],
		...overrides,
	};
}

/**
 * The state each runner status resolves to for a `none-required` lane.
 * Spelled out, not derived: the VALUES come from the constants module so a #253
 * rename is free, but WHICH member each status picks is stated here so a change
 * in that mapping fails this test instead of being absorbed by it.
 */
const EXPECTED_LABEL: Record<RunnerResult["status"], string> = {
	passed: RESULT_LABELS.passed,
	skipped: RESULT_LABELS.skipped,
	failed: RESULT_LABELS.hold,
	error: RESULT_LABELS.hold,
};

describe("buildPublicationPlans — fixed label mapping only", () => {
	test("emits exactly one add (mapped to status) and removes for every other label", () => {
		for (const status of ["passed", "failed", "error", "skipped"] as const) {
			const plans = buildPublicationPlans(identity, result({ status }));
			const labels = plans.filter((p) => p.kind === "label");
			const adds = labels.filter((p) => p.action === "add");
			const removes = labels.filter((p) => p.action === "remove");
			expect(adds.length).toBe(1);
			// The expected label is SPELLED per status rather than recomputed through
			// `stateForOutcome`, which would just re-run the implementation and pass
			// however it changed. `failed`/`error` resolve to HOLD now: a job
			// that did not succeed holds for a human instead of resting red.
			// `pr-review` is a `none-required` lane, so its receipt is satisfied and
			// `passed`/`skipped` keep their own states.
			expect(adds[0]?.kind === "label" && adds[0].label).toBe(EXPECTED_LABEL[status]);
			// Every other allowlisted label is removed.
			expect(removes.length).toBe(ALL_RESULT_LABELS.length - 1);
			// No label outside the fixed allowlist is ever produced.
			for (const l of labels) {
				expect(ALL_RESULT_LABELS).toContain(l.kind === "label" ? l.label : "");
			}
		}
	});

	test("labels always target the trusted item number, never a runner-chosen one", () => {
		// Runner claims a different item; the plan still uses the trusted identity.
		const plans = buildPublicationPlans(identity, result({ item_number: 9999 }));
		for (const p of plans) {
			if (p.kind === "label" || p.kind === "comment") {
				expect(p.itemNumber).toBe(7);
			}
		}
	});
});

describe("buildPublicationPlans — unknown status rejected", () => {
	test("an unmapped status produces no plans (rejected before any operation)", () => {
		// Force an out-of-band status past the type system, as a corrupt/hostile row would.
		const bad = result({ status: "sneaky" as unknown as RunnerResult["status"] });
		expect(buildPublicationPlans(identity, bad)).toEqual([]);
	});
});

describe("buildPublicationPlans — exact-SHA check", () => {
	test("check binds to the trusted SHA and fixed name, never a runner SHA/name", () => {
		const plans = buildPublicationPlans(identity, result({ sha: "0000000badbad" }));
		const check = plans.find((p) => p.kind === "check");
		expect(check?.kind).toBe("check");
		if (check?.kind !== "check") throw new Error("no check");
		expect(check.sha).toBe("deadbeefcafe"); // trusted, not the runner's 0000000badbad
		expect(check.name).toBe(CHECK_NAME);
		expect(check.target).toBe(CHECK_TARGET);
	});

	test("check conclusion is derived only from the validated status", () => {
		const map = {
			passed: "success",
			failed: "failure",
			error: "failure",
			skipped: "neutral",
		} as const;
		for (const [status, conclusion] of Object.entries(map)) {
			const plans = buildPublicationPlans(
				identity,
				result({ status: status as RunnerResult["status"] }),
			);
			const check = plans.find((p) => p.kind === "check");
			if (check?.kind !== "check") throw new Error("no check");
			expect(check.conclusion).toBe(conclusion);
		}
	});
});

describe("buildPublicationPlans — itemless / shaless jobs", () => {
	test("itemless job produces no label or comment writes", () => {
		const itemless: JobIdentity = { ...identity, itemNumber: null };
		const { item_number: _n, ...r } = result();
		const plans = buildPublicationPlans(itemless, r as RunnerResult);
		expect(plans.some((p) => p.kind === "label")).toBe(false);
		expect(plans.some((p) => p.kind === "comment")).toBe(false);
		// A SHA is present, so a check is still allowed.
		expect(plans.some((p) => p.kind === "check")).toBe(true);
	});

	test("shaless job produces no check", () => {
		const shaless: JobIdentity = { ...identity, sha: "" };
		const { sha: _s, ...r } = result();
		const plans = buildPublicationPlans(shaless, r as RunnerResult);
		expect(plans.some((p) => p.kind === "check")).toBe(false);
		// Item present, so labels/comment still allowed.
		expect(plans.some((p) => p.kind === "label")).toBe(true);
		expect(plans.some((p) => p.kind === "comment")).toBe(true);
	});

	test("itemless and shaless job produces nothing", () => {
		const none: JobIdentity = { ...identity, itemNumber: null, sha: "" };
		const { item_number: _n, sha: _s, ...r } = result();
		expect(buildPublicationPlans(none, r as RunnerResult)).toEqual([]);
	});
});

describe("buildPublicationPlans — issue-triage label filter", () => {
	const triageIdentity: JobIdentity = { ...identity, jobType: "issue-triage" };
	const ALLOWLIST = ["type: bug", "priority: high"];

	function triageResult(triage: RunnerResult["triage"]): RunnerResult {
		return result({ job_type: "issue-triage", status: "passed", triage });
	}

	test("an ALLOWLISTED chosen label yields exactly one add label plan for it", () => {
		const plans = buildPublicationPlans(
			triageIdentity,
			triageResult({ labels: ["type: bug"] }),
			true,
			ALLOWLIST,
		);
		const adds = plans.filter(
			(p) => p.kind === "label" && p.action === "add" && p.label === "type: bug",
		);
		expect(adds.length).toBe(1);
		expect(adds[0]?.kind === "label" && adds[0].itemNumber).toBe(7);
	});

	test("a NON-allowlisted chosen label yields NO label plan and a request block in the comment", () => {
		const plans = buildPublicationPlans(
			triageIdentity,
			triageResult({ labels: ["wontfix"] }),
			true,
			ALLOWLIST,
		);
		// No add plan carries the non-allowlisted name.
		const addNames = plans
			.filter((p) => p.kind === "label" && p.action === "add")
			.map((p) => (p.kind === "label" ? p.label : ""));
		expect(addNames).not.toContain("wontfix");
		// The comment demotes it into the request block.
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain("Requested labels");
		expect(comment.body).toContain("wontfix");
	});

	test("an explicit request renders into the comment and creates NO label plan", () => {
		const plans = buildPublicationPlans(
			triageIdentity,
			triageResult({ requests: [{ name: "needs-triage-vocab", reason: "no fit exists" }] }),
			true,
			ALLOWLIST,
		);
		const addNames = plans
			.filter((p) => p.kind === "label" && p.action === "add")
			.map((p) => (p.kind === "label" ? p.label : ""));
		expect(addNames).not.toContain("needs-triage-vocab");
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain("Requested labels");
		// The name is markdown-escaped on the way in (defence-in-depth); its core
		// text survives even if the hyphens are backslash-escaped.
		expect(comment.body).toContain("needs");
		expect(comment.body).toContain("triage");
		expect(comment.body).toContain("vocab");
		expect(comment.body).toContain("no fit exists");
	});

	test("mixed labels: only the allowlisted one is applied; the rest demote to requests", () => {
		const plans = buildPublicationPlans(
			triageIdentity,
			triageResult({ labels: ["type: bug", "type: chore", "priority: high"] }),
			true,
			ALLOWLIST,
		);
		const addNames = plans
			.filter((p) => p.kind === "label" && p.action === "add")
			.map((p) => (p.kind === "label" ? p.label : ""));
		expect(addNames).toContain("type: bug");
		expect(addNames).toContain("priority: high");
		expect(addNames).not.toContain("type: chore");
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain("type: chore");
	});

	test("an empty allowlist applies nothing; every chosen label demotes to a request", () => {
		const plans = buildPublicationPlans(
			triageIdentity,
			triageResult({ labels: ["type: bug"] }),
			true,
			[],
		);
		const addNames = plans
			.filter((p) => p.kind === "label" && p.action === "add")
			.map((p) => (p.kind === "label" ? p.label : ""));
		expect(addNames).not.toContain("type: bug");
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain("Requested labels");
		expect(comment.body).toContain("type: bug");
	});

	test("the allowlist filter does NOT apply to a non-triage lane", () => {
		// The same result shape on a pr-review identity: no chosen-label add plans,
		// no request block — the triage path is gated on the trusted job type.
		const plans = buildPublicationPlans(identity, result({ status: "passed" }), true, ALLOWLIST);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).not.toContain("Requested labels");
	});

	test("a runner-chosen label cannot inject markup through the request block", () => {
		const plans = buildPublicationPlans(
			triageIdentity,
			triageResult({ requests: [{ name: "# evil [x](http://e.invalid) @rodaddy" }] }),
			true,
			ALLOWLIST,
		);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).not.toContain("[x](http://e.invalid)");
		expect(comment.body).not.toContain("@rodaddy");
	});

	test("the label heading states INTENT, not a completed application", () => {
		// The comment is written at PLAN time; label application is a SEPARATE posting
		// that can fail (it did — #124). So the comment must not claim the labels were
		// "Applied" — it states that the watcher WILL apply the selected labels.
		const plans = buildPublicationPlans(
			triageIdentity,
			triageResult({ labels: ["type: bug"] }),
			true,
			ALLOWLIST,
		);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		// No past-tense completion claim at plan time.
		expect(comment.body).not.toContain("Applied labels:");
		expect(comment.body).not.toMatch(/\bApplied\b/);
		// The intent wording IS present, and it still lists the selected label.
		expect(comment.body).toContain("the watcher applies these");
		expect(comment.body).toContain("type: bug");
	});
});

describe("buildPublicationPlans — redaction and hard bounds", () => {
	test("comment body redacts secret-shaped finding text and carries the marker", () => {
		const plans = buildPublicationPlans(
			identity,
			result({
				status: "failed",
				findings: [
					{ severity: "high", title: "leaked ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", detail: "x" },
				],
			}),
		);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
		expect(comment.body).toContain("REDACTED");
		expect(comment.body).toContain(`<!-- ${comment.dedupeKey} -->`);
		expect(comment.target).toBe(COMMENT_TARGET);
	});

	test("runner finding text cannot inject Markdown, HTML, links, or mentions", () => {
		const plans = buildPublicationPlans(
			identity,
			result({
				status: "failed",
				findings: [
					{
						severity: "high",
						title: "# heading [click](https://evil.invalid) @rodaddy <details>",
						location: "x.ts\n- injected",
					},
				],
			}),
		);
		const comment = plans.find((p) => p.kind === "comment");
		const check = plans.find((p) => p.kind === "check");
		if (comment?.kind !== "comment" || check?.kind !== "check") throw new Error("no output");
		for (const text of [comment.body, check.summary]) {
			expect(text).not.toContain("\n# heading");
			expect(text).not.toContain("[click](https://evil.invalid)");
			expect(text).not.toContain("@rodaddy");
			expect(text).not.toContain("<details>");
			expect(text).not.toContain("\n- injected");
			expect(text).toContain("\\# heading");
			expect(text).toContain("@​rodaddy");
		}
	});

	test("comment body is hard-capped even with an oversized finding", () => {
		const huge = "A".repeat(50_000);
		const plans = buildPublicationPlans(
			identity,
			result({ status: "failed", findings: [{ severity: "low", title: huge }] }),
		);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body.length).toBeLessThanOrEqual(CAPS.commentBody);
	});

	test("check title and summary are hard-capped", () => {
		const huge = "B".repeat(50_000);
		const plans = buildPublicationPlans(
			identity,
			result({ status: "failed", findings: [{ severity: "low", title: huge }] }),
		);
		const check = plans.find((p) => p.kind === "check");
		if (check?.kind !== "check") throw new Error("no check");
		expect(check.title.length).toBeLessThanOrEqual(CAPS.checkTitle);
		expect(check.summary.length).toBeLessThanOrEqual(CAPS.checkSummary);
	});

	test("finding count is capped and truncation is disclosed", () => {
		const findings = Array.from({ length: CAPS.findings + 5 }, (_, i) => ({
			severity: "info" as const,
			title: `finding ${i}`,
		}));
		const plans = buildPublicationPlans(identity, result({ status: "failed", findings }));
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain("more finding(s) omitted");
	});
});

describe("buildPublicationPlans — exact reviewed SHA in the comment", () => {
	// The exact-SHA line lets anyone direct-match the reviewed commit against the PR
	// head. Its source is the TRUSTED, DB-derived identity.sha (never runner content).
	const REVIEWED_LINE = "Reviewed at: `deadbeefcafe`";

	test("a pr-review comment renders the exact reviewed SHA from the trusted identity", () => {
		// The runner claims a different SHA; the comment still carries the trusted one.
		const plans = buildPublicationPlans(identity, result({ sha: "0000000badbad" }));
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain(REVIEWED_LINE);
		// The line reflects the trusted identity.sha, not the runner-claimed SHA.
		expect(comment.body).not.toContain("0000000badbad");
	});

	test("a triage comment renders the exact reviewed SHA too", () => {
		const triageIdentity: JobIdentity = { ...identity, jobType: "issue-triage" };
		const plans = buildPublicationPlans(
			triageIdentity,
			result({ job_type: "issue-triage", status: "passed", triage: { labels: [] } }),
			true,
			[],
		);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain(REVIEWED_LINE);
	});

	test("a sha-less identity OMITS the reviewed-SHA line entirely", () => {
		const shaless: JobIdentity = { ...identity, sha: "" };
		const { sha: _s, ...r } = result();
		const plans = buildPublicationPlans(shaless, r as RunnerResult);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).not.toContain("Reviewed at:");
	});

	test("the reviewed-SHA line leaves the dedupe key and body structure unchanged", () => {
		const plans = buildPublicationPlans(identity, result());
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		// Dedupe key and its hidden marker are unchanged by the new author line.
		expect(comment.dedupeKey).toBe("software-factory:comment:job-42");
		expect(comment.body).toContain(`<!-- ${comment.dedupeKey} -->`);
		expect(comment.body).toContain("### software-factory: passed");
	});
});

describe("buildPublicationPlans — the run reference is IDS ONLY", () => {
	/**
	 * A stand-in for the internal Langfuse host. The controller ruled on
	 * 2026-08-16 that a forge comment carries `job N, attempt M` and NEVER a trace
	 * URL, because the host is LAN/tailnet-internal and a comment is
	 * outward-facing. This string is what a leak would look like.
	 */
	const LANGFUSE_HOST = "langfuse.example.internal";
	const traced: JobIdentity = { ...identity, attemptId: 455 };

	test("a pr-review comment names the run as job/attempt ids", () => {
		const plans = buildPublicationPlans(traced, result());
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain("Run: job 42, attempt 455");
	});

	test("a triage comment names the run too — both builders, one receipt", () => {
		const plans = buildPublicationPlans(
			{ ...traced, jobType: "issue-triage" },
			result({ job_type: "issue-triage", status: "passed", triage: { labels: [] } }),
			true,
			[],
		);
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).toContain("Run: job 42, attempt 455");
	});

	test("THE IMPORTANT ONE: the Langfuse host NEVER appears in a rendered comment", () => {
		// The whole reason the reference is ids-only. A runner controls none of these
		// fields, so this asserts what the FACTORY writes: even with the host present
		// in runner-supplied text it must not become part of the run reference, and
		// the reference itself must never introduce it.
		for (const built of [
			buildPublicationPlans(traced, result()),
			buildPublicationPlans(
				{ ...traced, jobType: "issue-triage" },
				result({ job_type: "issue-triage", status: "passed", triage: { labels: [] } }),
				true,
				[],
			),
		]) {
			const comment = built.find((p) => p.kind === "comment");
			if (comment?.kind !== "comment") throw new Error("no comment");
			expect(comment.body).not.toContain(LANGFUSE_HOST);
			expect(comment.body).not.toContain("http://");
			expect(comment.body).not.toContain("https://");
			// And no trace id either: `attempt-455-<host>` names an internal host by
			// construction, which is exactly what the ruling keeps off the comment.
			expect(comment.body).not.toContain("attempt-455-");
		}
	});

	test("an identity with NO attempt omits the line rather than inventing an attempt", () => {
		// Guards the assertions above from passing for the wrong reason: a hardcoded
		// line would render `attempt undefined` on every non-result call site, and
		// send an operator looking for a row that was never written.
		const plans = buildPublicationPlans(identity, result());
		const comment = plans.find((p) => p.kind === "comment");
		if (comment?.kind !== "comment") throw new Error("no comment");
		expect(comment.body).not.toContain("Run: job");
		expect(comment.body).not.toContain("undefined");
	});

	test("the run reference leaves the dedupe key unchanged", () => {
		// The comment is deduplicated on (job, kind, target); a line inside the body
		// must not move the key, or every traced job would post a SECOND comment.
		const withAttempt = buildPublicationPlans(traced, result()).find((p) => p.kind === "comment");
		const without = buildPublicationPlans(identity, result()).find((p) => p.kind === "comment");
		if (withAttempt?.kind !== "comment" || without?.kind !== "comment") {
			throw new Error("no comment");
		}
		expect(withAttempt.dedupeKey).toBe(without.dedupeKey);
		expect(withAttempt.target).toBe(COMMENT_TARGET);
	});
});

/**
 * The agent signature line. Every
 * factory-authored forge body opens with one identical attribution line so a
 * reader of any factory artifact can name the author, the model, the seat, and
 * the posting date without leaving the item.
 *
 * PLACEMENT: the hidden dedupe marker stays line 1 and the signature is line 2 —
 * the first VISIBLE line. The dedupe matcher is a position-independent substring
 * scan (`src/github/publish-dedupe.ts:157`, `c.body.includes(marker)`), so the
 * marker does not require line 1; it keeps it because moving an invisible
 * HTML comment buys nothing and every live comment already carries it there.
 *
 * MODEL: the literal `unattested`. `job_attempts.observed_model` is not in any
 * builder's scope and sf#369 explicitly forbids inventing a join to reach it, so
 * the line states honestly that no model was attested rather than naming one.
 */
describe("agent signature line", () => {
	const SIG_PREFIX =
		"**agent:** rodaddy-watcher · model unattested · seat software-factory watcher (CT101) · ";

	test("the result comment opens with marker then signature", () => {
		const plans = buildPublicationPlans(identity, result());
		const comment = plans.find((p) => p.kind === "comment");
		const lines = (comment as { body: string }).body.split("\n");
		expect(lines[0]).toBe("<!-- software-factory:comment:job-42 -->");
		expect(lines[1]?.startsWith(SIG_PREFIX)).toBe(true);
		// The date is a real UTC calendar date, not a placeholder.
		expect(lines[1]?.slice(SIG_PREFIX.length)).toMatch(/^\d{4}-\d{2}-\d{2} UTC$/);
	});

	test("the signature sits BEFORE the first content heading", () => {
		const plans = buildPublicationPlans(identity, result());
		const body = (plans.find((p) => p.kind === "comment") as { body: string }).body;
		const sigAt = body.indexOf("**agent:** rodaddy-watcher");
		const headingAt = body.indexOf("### software-factory:");
		expect(sigAt).toBeGreaterThan(-1);
		expect(headingAt).toBeGreaterThan(-1);
		expect(sigAt).toBeLessThan(headingAt);
	});

	test("the marker is still substring-findable so dedupe cannot break", () => {
		const plans = buildPublicationPlans(identity, result());
		const body = (plans.find((p) => p.kind === "comment") as { body: string }).body;
		expect(body.includes("<!-- software-factory:comment:job-42 -->")).toBe(true);
	});
});
