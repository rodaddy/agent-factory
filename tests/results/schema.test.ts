/**
 * @module tests/results/schema
 * @description Boundary tests for the versioned runner-result schema. Runner
 *   output is untrusted, so these pin the rules that decide whether a claimed
 *   change is even considered: v1 results must keep parsing unchanged (deployed
 *   runners still emit them), a change block must carry a base to be
 *   verifiable, and it must name exactly one location so the watcher never has
 *   to guess where the change lives.
 */
import { describe, expect, test } from "bun:test";
import { VERB_IDS } from "../../src/jobs/verb-dispatch";
import {
	CHANGE_CAPABLE_JOB_TYPES,
	CHANGE_CAPABLE_VERB_JOB_TYPES,
	IMPLEMENT_JOB_TYPE,
	RESULT_VERSION,
	resultSchema,
	TRIAGE_JOB_TYPE,
} from "../../src/results/schema";
import { CHANGE_BUNDLE_NAME } from "../../src/templates/agent-lane";
import {
	IMPLEMENT_TEMPLATE_ID,
	isKnownTemplate,
	TRIAGE_TEMPLATE_ID,
} from "../../src/templates/registry";

/** A minimal valid report-only result at the given version. */
function base(version: number) {
	return {
		result_version: version,
		repository: "rodaddy/mcp2cli",
		job_type: "implement-issue",
		status: "passed" as const,
	};
}

const CHANGE = {
	base_sha: "cafebabe",
	head_sha: "deadbeef",
	// The pinned bare filename the implement template hands back. A pathed
	// value here would model a claim ingest rejects outright.
	bundle_path: "changes.bundle",
	files_changed: 3,
};

describe("result schema versioning", () => {
	test("v1 results still parse — deployed runners emit them from fixed bodies", () => {
		// Every report-only lane's body hardcodes `result_version: 1`. Rejecting v1
		// would break all of them the moment v2 landed.
		expect(resultSchema.safeParse(base(1)).success).toBe(true);
	});

	test("v2 is the current version and parses", () => {
		expect(RESULT_VERSION).toBe(2);
		expect(resultSchema.safeParse(base(2)).success).toBe(true);
	});

	test("an unsupported version is rejected", () => {
		expect(resultSchema.safeParse(base(3)).success).toBe(false);
		expect(resultSchema.safeParse(base(99)).success).toBe(false);
	});

	test('a quoted "1"/"2" result_version parses — bounded envelope coercion', () => {
		// A runner body that renders the envelope through a shell/JSON template can
		// emit the version as a string. The envelope is self-describing metadata,
		// so exactly "1" and "2" are normalized; nothing else is.
		expect(resultSchema.safeParse({ ...base(1), result_version: "1" }).success).toBe(true);
		expect(resultSchema.safeParse({ ...base(2), result_version: "2" }).success).toBe(true);
	});

	test("any other stringy result_version is still rejected", () => {
		for (const bad of ["3", "one", "", "01", " 1", "2.0", "99"]) {
			expect(resultSchema.safeParse({ ...base(1), result_version: bad }).success).toBe(false);
		}
	});

	test("a report-only result carries no change block", () => {
		const parsed = resultSchema.parse(base(1));
		expect(parsed.change).toBeUndefined();
	});

	test("REJECTS a change block on a v1 result or a report-only job type", () => {
		// A change block is implement-lane-only, and the schema is where that is
		// decided. Without this a `pr-review` result can carry one and be ingested,
		// so a lane the operator never dispatched produces a proposed change.
		const change = { base_sha: "cafebabe", bundle_path: "a.bundle" };
		// v1 never had a change block.
		expect(resultSchema.safeParse({ ...base(1), change }).success).toBe(false);
		// v2, but a report-only lane.
		for (const jobType of ["pr-review", "repo-validate", "issue-triage", "infra-static"]) {
			const result = resultSchema.safeParse({ ...base(2), job_type: jobType, change });
			expect(result.success).toBe(false);
		}
		// The implement lane at v2 is the one accepted combination.
		expect(resultSchema.safeParse({ ...base(2), change }).success).toBe(true);
	});

	test("the schema's implement job type matches the implement template id", () => {
		// The literal is duplicated deliberately (wire contract vs local template
		// list); this is what keeps the two from drifting apart silently.
		expect(IMPLEMENT_JOB_TYPE).toBe(IMPLEMENT_TEMPLATE_ID);
	});
});

describe("result change block", () => {
	test("accepts a well-formed patch-mode change", () => {
		const parsed = resultSchema.parse({ ...base(2), change: CHANGE });
		expect(parsed.change?.base_sha).toBe("cafebabe");
		expect(parsed.change?.bundle_path).toBe(CHANGE_BUNDLE_NAME);
	});

	test("accepts a push-mode change naming a branch", () => {
		const result = resultSchema.safeParse({
			...base(2),
			change: { base_sha: "cafebabe", branch: "rw/issue-42" },
		});
		expect(result.success).toBe(true);
	});

	test("REJECTS a change carrying both bundle_path and branch", () => {
		// Ambiguous about where the change actually lives; the watcher must never
		// have to guess which one to trust.
		const result = resultSchema.safeParse({
			...base(2),
			change: { base_sha: "cafebabe", bundle_path: "a.bundle", branch: "rw/issue-1" },
		});
		expect(result.success).toBe(false);
	});

	test("REJECTS both keys present when one is EMPTY, not just when both are set", () => {
		// A truthiness test reads `bundle_path: ""` as absent -- `Boolean("")` is
		// false -- so the exclusivity check passes while the parsed result still
		// carries both keys. The rule is about which keys are PRESENT.
		for (const change of [
			{ base_sha: "cafebabe", bundle_path: "", branch: "rw/issue-1" },
			{ base_sha: "cafebabe", bundle_path: "a.bundle", branch: "" },
			{ base_sha: "cafebabe", bundle_path: "" },
			{ base_sha: "cafebabe", branch: "" },
		]) {
			expect(resultSchema.safeParse({ ...base(2), change }).success).toBe(false);
		}
	});

	test("REJECTS a change carrying neither bundle_path nor branch", () => {
		const result = resultSchema.safeParse({
			...base(2),
			change: { base_sha: "cafebabe" },
		});
		expect(result.success).toBe(false);
	});

	test("REJECTS a change with no base_sha — it would be unverifiable", () => {
		const result = resultSchema.safeParse({
			...base(2),
			change: { bundle_path: "a.bundle" },
		});
		expect(result.success).toBe(false);
	});

	test("REJECTS a non-hex base_sha", () => {
		const result = resultSchema.safeParse({
			...base(2),
			change: { base_sha: "../../etc/passwd", bundle_path: "a.bundle" },
		});
		expect(result.success).toBe(false);
	});

	test("REJECTS unknown keys inside the change block", () => {
		const result = resultSchema.safeParse({
			...base(2),
			change: { ...CHANGE, run_this: "rm -rf /" },
		});
		expect(result.success).toBe(false);
	});

	test("bounds an oversized bundle_path and files_changed", () => {
		expect(
			resultSchema.safeParse({
				...base(2),
				change: { base_sha: "cafebabe", bundle_path: "x".repeat(1025) },
			}).success,
		).toBe(false);
		expect(
			resultSchema.safeParse({
				...base(2),
				change: { ...CHANGE, files_changed: 10_001 },
			}).success,
		).toBe(false);
	});

	test("a bounded bundle_path is NOT a safe path — confinement is ingest's job", () => {
		// Documents the boundary split: the schema only bounds length, so a
		// traversal path parses here and MUST be rejected at ingest.
		const result = resultSchema.safeParse({
			...base(2),
			change: { base_sha: "cafebabe", bundle_path: "../../../etc/shadow" },
		});
		expect(result.success).toBe(true);
	});
});

/** A minimal valid triage-lane result at the given version. */
function triageBase(version: number) {
	return {
		result_version: version,
		repository: "rodaddy/mcp2cli",
		job_type: "issue-triage",
		status: "passed" as const,
	};
}

describe("result triage block", () => {
	test("accepts a triage block with chosen labels and requests at v1", () => {
		const parsed = resultSchema.parse({
			...triageBase(1),
			triage: {
				labels: ["type: bug"],
				requests: [{ name: "needs-info", reason: "no repro" }],
			},
		});
		expect(parsed.triage?.labels).toEqual(["type: bug"]);
		expect(parsed.triage?.requests?.[0]?.name).toBe("needs-info");
	});

	test("a triage-lane result WITHOUT a triage block still parses (block is optional)", () => {
		const parsed = resultSchema.parse(triageBase(1));
		expect(parsed.triage).toBeUndefined();
	});

	test("REJECTS a triage block on a non-triage job type", () => {
		const triage = { labels: ["type: bug"] };
		for (const jobType of ["pr-review", "implement-issue", "infra-static"]) {
			const result = resultSchema.safeParse({ ...triageBase(2), job_type: jobType, triage });
			expect(result.success).toBe(false);
		}
		// The issue-triage lane is the accepted combination.
		expect(resultSchema.safeParse({ ...triageBase(1), triage }).success).toBe(true);
	});

	test("REJECTS an unknown key inside the triage block", () => {
		const result = resultSchema.safeParse({
			...triageBase(1),
			triage: { labels: ["type: bug"], apply_now: true },
		});
		expect(result.success).toBe(false);
	});

	test("REJECTS an unknown key inside a request entry", () => {
		const result = resultSchema.safeParse({
			...triageBase(1),
			triage: { requests: [{ name: "x", severity: "high" }] },
		});
		expect(result.success).toBe(false);
	});

	test("bounds oversized label counts and lengths", () => {
		expect(
			resultSchema.safeParse({
				...triageBase(1),
				triage: { labels: Array.from({ length: 51 }, () => "x") },
			}).success,
		).toBe(false);
		expect(
			resultSchema.safeParse({
				...triageBase(1),
				triage: { labels: ["x".repeat(51)] },
			}).success,
		).toBe(false);
	});

	test("the schema's triage job type matches the triage template id", () => {
		// The literal is duplicated deliberately (wire contract vs local template
		// list); this is what keeps the two from drifting apart silently.
		expect(TRIAGE_JOB_TYPE).toBe(TRIAGE_TEMPLATE_ID);
	});
});

/**
 * sf#301 widened the change-block refine from `implement-issue` alone to a
 * CLOSED ALLOWLIST that also carries the six deterministic k3s verbs. The
 * property the refine exists to hold is unchanged: a report-only lane must never
 * present itself as a proposal. These tests pin both halves — the allowlist
 * admits what it should, and refuses everything else.
 */
describe("change-capable job types", () => {
	test("the verb list is spelled identically to the dispatcher's allowlist", () => {
		// schema.ts spells these literally because it is the WIRE contract for what a
		// runner may send, and must not shift when the local template list is edited.
		// That is exactly why it needs a pin.
		expect([...CHANGE_CAPABLE_VERB_JOB_TYPES].sort()).toEqual([...VERB_IDS].sort());
		for (const id of CHANGE_CAPABLE_VERB_JOB_TYPES) {
			expect(isKnownTemplate(id)).toBe(true);
		}
		expect(CHANGE_CAPABLE_JOB_TYPES).toContain(IMPLEMENT_JOB_TYPE);
		expect(CHANGE_CAPABLE_JOB_TYPES).toHaveLength(VERB_IDS.length + 1);
	});

	test("a verb result may carry a change block at result_version 2", () => {
		for (const jobType of CHANGE_CAPABLE_VERB_JOB_TYPES) {
			const parsed = resultSchema.safeParse({
				...base(2),
				job_type: jobType,
				change: { base_sha: "a".repeat(40), bundle_path: CHANGE_BUNDLE_NAME },
			});
			expect(parsed.success).toBe(true);
		}
	});

	test("a verb change block is still refused at result_version 1", () => {
		const parsed = resultSchema.safeParse({
			...base(1),
			job_type: "newapp",
			change: { base_sha: "a".repeat(40), bundle_path: CHANGE_BUNDLE_NAME },
		});
		expect(parsed.success).toBe(false);
	});

	test("a report-only lane still may not carry a change block", () => {
		// The whole point of the refine. Widening it to a predicate would have
		// retired this property silently.
		for (const jobType of ["pr-review", "infra-static", "repo-validate", "issue-triage"]) {
			const parsed = resultSchema.safeParse({
				...base(2),
				job_type: jobType,
				change: { base_sha: "a".repeat(40), bundle_path: CHANGE_BUNDLE_NAME },
			});
			expect(parsed.success).toBe(false);
		}
	});
});
