/**
 * @module tests/actions/second-pass
 * @description Functional tests for the publisher's adversarial second pass:
 *  the verdict rules in their fixed order (refute, then checklist;
 *   `error` stays `error`), the fail-closed checklist, the comment sections,
 *   and the reader's tolerance of absent or malformed files.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applySecondPass,
	CHECKLIST_UNAVAILABLE,
	checklistComplete,
	DIFF_TRUNCATED,
	REFUTER_UNAVAILABLE,
	readSecondPass,
	type SecondPassPlan,
	withSecondPass,
} from "../../scripts/actions/second-pass";
import { testTmpBase } from "../support/test-temp";

const REFUTE: SecondPassPlan = { refute: true, checklist: false, trust_files: [] };
const REFUTE1: SecondPassPlan = { ...REFUTE, refute_findings: 1 };
const COMPLETE = [1, 2, 3, 4, 5, 6, 7].map((n) => `| ${n} | item | pass | x:1 |`).join("\n");
const CHECK: SecondPassPlan = {
	refute: false,
	checklist: true,
	trust_files: ["scripts/actions/a.ts"],
};
const BOTH: SecondPassPlan = {
	refute: true,
	checklist: true,
	trust_files: ["src/hooks/x.ts"],
	refute_findings: 1,
};
const reply = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });

describe("applySecondPass", () => {
	test("no plan leaves every verdict and adds no section", () => {
		for (const v of ["approve", "fix-first", "error"] as const) {
			expect(applySecondPass(v, null, "verdict: approve", "verdict: fix-first")).toEqual({
				verdict: v,
				sections: "",
			});
		}
	});

	test("a refuter approve downgrades fix-first and is shown", () => {
		const out = applySecondPass("fix-first", REFUTE1, "- REFUTED: x -- y\nverdict: approve", null);
		expect(out.verdict).toBe("approve");
		expect(out.sections.startsWith("### Second pass: refuter")).toBe(true);
		expect(out.sections).toContain("### Second pass: refuter");
		expect(out.sections).toContain("- REFUTED: x -- y");
	});

	test("a refuter fix-first keeps fix-first", () => {
		expect(applySecondPass("fix-first", REFUTE1, "verdict: fix-first", null).verdict).toBe(
			"fix-first",
		);
	});

	test("an unavailable refuter leaves the verdict and says so", () => {
		for (const r of [null, "", "no verdict here"]) {
			const out = applySecondPass("fix-first", REFUTE1, r, null);
			expect(out.verdict).toBe("fix-first");
			expect(out.sections).toContain(REFUTER_UNAVAILABLE);
		}
	});

	test("the checklist fails closed on a trust-surface diff", () => {
		expect(applySecondPass("approve", CHECK, null, "verdict: fix-first").verdict).toBe("fix-first");
		const missing = applySecondPass("approve", CHECK, null, null);
		expect(missing.verdict).toBe("fix-first");
		expect(missing.sections).toContain(CHECKLIST_UNAVAILABLE);
		expect(missing.sections).toContain("### Second pass: trust-surface checklist (1 file(s))");
		expect(applySecondPass("approve", CHECK, null, `${COMPLETE}\nverdict: approve`).verdict).toBe(
			"approve",
		);
	});

	test("the checklist is applied after the refute", () => {
		expect(
			applySecondPass(
				"fix-first",
				BOTH,
				"- REFUTED: x -- y\nverdict: approve",
				"verdict: fix-first",
			).verdict,
		).toBe("fix-first");
	});

	test("error stays error", () => {
		expect(
			applySecondPass("error", BOTH, "- REFUTED: x -- y\nverdict: approve", "verdict: approve")
				.verdict,
		).toBe("error");
	});

	// The sf#939 done-check fixture.
	test("a refuted wrong P1 approves and is still shown; a failed checklist item 2 is fix-first", () => {
		const pass1 = "- P1 src/a.ts:3 -- wrong claim\nverdict: fix-first";
		const refuter = "- REFUTED: wrong claim -- line 3 does not do that\nverdict: approve";
		const out = applySecondPass("fix-first", REFUTE1, refuter, null);
		expect(out.verdict).toBe("approve");
		const comment = withSecondPass(pass1, out.sections);
		expect(comment).toContain("- P1 src/a.ts:3 -- wrong claim");
		expect(comment).toContain("- REFUTED: wrong claim");
		const checklist =
			"| # | item | result | evidence |\n|---|---|---|---|\n| 2 | target checkout | fail | .forgejo/workflows/x.yml:9 checks out into the workspace |\nverdict: fix-first";
		expect(applySecondPass("approve", CHECK, null, checklist).verdict).toBe("fix-first");
	});
});

describe("sf#939 fix round 1", () => {
	test("a bare approve with no REFUTED line leaves fix-first", () => {
		const out = applySecondPass("fix-first", REFUTE1, "verdict: approve", null);
		expect(out.verdict).toBe("fix-first");
		expect(out.sections).toContain("verdict: approve");
	});

	test("an UPHELD line blocks the downgrade even with approve", () => {
		const r = "- REFUTED: a -- b\n- UPHELD: c -- d\nverdict: approve";
		expect(applySecondPass("fix-first", REFUTE1, r, null).verdict).toBe("fix-first");
	});

	test("REFUTED-only with approve downgrades", () => {
		const r = "- REFUTED: a -- b\n- REFUTED: c -- d\nverdict: approve";
		expect(applySecondPass("fix-first", { ...REFUTE, refute_findings: 2 }, r, null).verdict).toBe(
			"approve",
		);
	});

	test("sections come first in the wired review, without a leading separator", () => {
		const out = applySecondPass("fix-first", REFUTE1, "- REFUTED: a -- b\nverdict: approve", null);
		expect(out.sections.startsWith("---")).toBe(false);
		const review = withSecondPass("pass-1 body", out.sections);
		expect(review.startsWith("### Second pass: refuter")).toBe(true);
		expect(review.endsWith("\n\n---\n\npass-1 body")).toBe(true);
		expect(withSecondPass("pass-1 body", "")).toBe("pass-1 body");
	});

	test("refute_skipped renders its line and the pass-1 verdict stands", () => {
		const plan: SecondPassPlan = {
			refute: false,
			checklist: false,
			trust_files: [],
			refute_skipped: "findings exceed 20000 bytes",
		};
		const out = applySecondPass("fix-first", plan, null, null);
		expect(out.verdict).toBe("fix-first");
		expect(out.sections).toBe(
			"### Second pass: refuter\n\nRefuter skipped: findings exceed 20000 bytes. The pass-1 findings stand.",
		);
	});

	test("the plan reader accepts a string refute_skipped and rejects other types", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/second-pass-`);
		try {
			const plan = { ...REFUTE, refute: false, refute_skipped: "findings exceed 20000 bytes" };
			writeFileSync(join(dir, "second-pass.json"), JSON.stringify(plan));
			expect((await readSecondPass(dir)).plan).toEqual(plan);
			writeFileSync(
				join(dir, "second-pass.json"),
				JSON.stringify({ ...REFUTE, refute_skipped: 3 }),
			);
			expect((await readSecondPass(dir)).plan).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("readSecondPass", () => {
	test("missing files read as a null plan and null replies", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/second-pass-`);
		try {
			expect(await readSecondPass(dir)).toEqual({ plan: null, refute: null, checklist: null });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a valid plan and replies parse", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/second-pass-`);
		try {
			writeFileSync(join(dir, "second-pass.json"), JSON.stringify(BOTH));
			writeFileSync(join(dir, "refute-reply.json"), reply("verdict: approve"));
			writeFileSync(join(dir, "checklist-reply.json"), "");
			expect(await readSecondPass(dir)).toEqual({
				plan: BOTH,
				refute: "verdict: approve",
				checklist: "",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a malformed or wrong-shape plan is null", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/second-pass-`);
		try {
			writeFileSync(join(dir, "second-pass.json"), "{not json");
			expect((await readSecondPass(dir)).plan).toBeNull();
			writeFileSync(join(dir, "second-pass.json"), JSON.stringify({ refute: "yes" }));
			expect((await readSecondPass(dir)).plan).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sf#939 fix round 2", () => {
	const PLAN2: SecondPassPlan = { ...REFUTE, refute_findings: 2 };
	const SEVEN = [1, 2, 3, 4, 5, 6, 7]
		.map((n) => `| ${n} | item ${n} | ${n % 2 === 0 ? "N/A" : "pass"} | x:1 |`)
		.join("\n");
	const table = (rows: string) => `| # | item | result | evidence |\n|---|---|---|---|\n${rows}`;
	const SIX = SEVEN.split("\n").slice(0, 6).join("\n");
	const FAILED = SEVEN.replace("| 3 | item 3 | pass |", "| 3 | item 3 | fail |");

	test("two P1 findings need two REFUTED lines to downgrade", () => {
		const one = "- REFUTED: a -- b\nverdict: approve";
		const two = "- REFUTED: a -- b\n- REFUTED: c -- d\nverdict: approve";
		expect(applySecondPass("fix-first", PLAN2, one, null).verdict).toBe("fix-first");
		expect(applySecondPass("fix-first", PLAN2, two, null).verdict).toBe("approve");
	});

	test("refute_findings absent or 0 never downgrades", () => {
		const two = "- REFUTED: a -- b\n- REFUTED: c -- d\nverdict: approve";
		expect(applySecondPass("fix-first", REFUTE, two, null).verdict).toBe("fix-first");
		const zero = { ...REFUTE, refute_findings: 0 };
		expect(applySecondPass("fix-first", zero, two, null).verdict).toBe("fix-first");
	});

	test("checklistComplete needs all seven rows passing or n/a", () => {
		expect(checklistComplete(table(SEVEN))).toBe(true);
		expect(checklistComplete("verdict: approve")).toBe(false);
		expect(checklistComplete(table(SIX))).toBe(false);
		expect(checklistComplete(table(FAILED))).toBe(false);
		// A duplicate `pass` row for item 3 cannot mask its `fail` row.
		expect(checklistComplete(table(`${FAILED}\n| 3 | item 3 | pass | x |`))).toBe(false);
	});

	test("a checklist approve needs the complete table", () => {
		const verdictOf = (text: string) => applySecondPass("approve", CHECK, null, text).verdict;
		expect(verdictOf("verdict: approve")).toBe("fix-first");
		expect(verdictOf(`${table(SEVEN)}\nverdict: approve`)).toBe("approve");
		expect(verdictOf(`${table(SIX)}\nverdict: approve`)).toBe("fix-first");
		expect(verdictOf(`${table(FAILED)}\nverdict: approve`)).toBe("fix-first");
	});

	test("the plan reader accepts a non-negative integer refute_findings only", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/second-pass-`);
		try {
			writeFileSync(join(dir, "second-pass.json"), JSON.stringify(PLAN2));
			expect((await readSecondPass(dir)).plan).toEqual(PLAN2);
			for (const bad of [-1, 1.5, "2"]) {
				writeFileSync(
					join(dir, "second-pass.json"),
					JSON.stringify({ ...REFUTE, refute_findings: bad }),
				);
				expect((await readSecondPass(dir)).plan).toBeNull();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sf#939 fix round 3 (PR 1100 review)", () => {
	const TRUNC: SecondPassPlan = { ...REFUTE1, diff_truncated: true };
	const TRUNC_CHECK: SecondPassPlan = { ...CHECK, diff_truncated: true };
	const table = (rows: string) => `| # | item | result | evidence |\n|---|---|---|---|\n${rows}`;
	const rows = (evidence: string, result = "pass") =>
		[1, 2, 3, 4, 5, 6, 7].map((n) => `| ${n} | item ${n} | ${result} | ${evidence} |`).join("\n");

	test("a truncated diff never downgrades on the refuter", () => {
		const r = "- REFUTED: x -- y\nverdict: approve";
		expect(applySecondPass("fix-first", REFUTE1, r, null).verdict).toBe("approve");
		const out = applySecondPass("fix-first", TRUNC, r, null);
		expect(out.verdict).toBe("fix-first");
		expect(out.sections.startsWith(DIFF_TRUNCATED)).toBe(true);
	});

	test("a truncated diff never checklist-approves", () => {
		const text = `${table(rows("x:1"))}\nverdict: approve`;
		expect(applySecondPass("approve", CHECK, null, text).verdict).toBe("approve");
		const out = applySecondPass("approve", TRUNC_CHECK, null, text);
		expect(out.verdict).toBe("fix-first");
		expect(out.sections).toContain(DIFF_TRUNCATED);
	});

	test("identical REFUTED lines count once", () => {
		const plan = { ...REFUTE, refute_findings: 2 };
		const dup = "- REFUTED: x -- y\n- REFUTED: x -- y\nverdict: approve";
		expect(applySecondPass("fix-first", plan, dup, null).verdict).toBe("fix-first");
	});

	test("an indented UPHELD line blocks the downgrade", () => {
		const r = "- REFUTED: x -- y\n  - UPHELD: z -- w\nverdict: approve";
		expect(applySecondPass("fix-first", { ...REFUTE, refute_findings: 1 }, r, null).verdict).toBe(
			"fix-first",
		);
	});

	test("indented distinct REFUTED lines count", () => {
		const r = "  - REFUTED: a -- b\n  * REFUTED: c -- d\nverdict: approve";
		expect(applySecondPass("fix-first", { ...REFUTE, refute_findings: 2 }, r, null).verdict).toBe(
			"approve",
		);
	});

	test("checklist rows need a non-empty evidence cell", () => {
		expect(checklistComplete(table(rows("")))).toBe(false);
		expect(checklistComplete(table(rows("-")))).toBe(false);
		expect(checklistComplete(table(rows("x:1")))).toBe(true);
		expect(checklistComplete(table(rows("not touched", "n/a")))).toBe(true);
	});

	test("the plan reader accepts a boolean diff_truncated only", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/second-pass-`);
		try {
			writeFileSync(join(dir, "second-pass.json"), JSON.stringify(TRUNC));
			expect((await readSecondPass(dir)).plan).toEqual(TRUNC);
			writeFileSync(
				join(dir, "second-pass.json"),
				JSON.stringify({ ...REFUTE, diff_truncated: "yes" }),
			);
			expect((await readSecondPass(dir)).plan).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
