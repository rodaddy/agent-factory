import { describe, expect, test } from "bun:test";
import { type GateCheck, GateReport } from "../../src/gates/report";

describe("GateReport", () => {
	test("derives violations from the failed checks only, in check order", () => {
		const report = new GateReport()
			.check("first", false, "first was wrong")
			.check("second", true, "second verified")
			.check("third", false, "third was wrong");
		expect(report.violations).toEqual(["first was wrong", "third was wrong"]);
		expect(report.passed).toBe(false);
	});

	test("passes only when at least one check ran and none failed", () => {
		expect(new GateReport().check("only", true, "verified").passed).toBe(true);
		expect(new GateReport().check("only", false, "wrong").passed).toBe(false);
	});

	test("an empty report is NOT a pass — a gate that checked nothing verified nothing", () => {
		// Trap #84: a never-run gate must never be indistinguishable from a green
		// one. An accumulator that treated "no failures" as a pass would make the
		// empty report the most permissive possible result.
		const report = new GateReport();
		expect(report.passed).toBe(false);
		expect(report.checkedNothing).toBe(true);
		expect(report.violations).toEqual([]);
	});

	test("records EVERY item, including ones after the first failure", () => {
		// The no-early-return rule: the operator fixes more per round trip when the
		// report shows all failures at once.
		const report = new GateReport()
			.check("a", false, "a failed")
			.check("b", false, "b failed")
			.check("c", true, "c verified");
		expect(report.checks.map((c) => c.item)).toEqual(["a", "b", "c"]);
		expect(report.violations).toHaveLength(2);
	});

	test("keeps the note of PASSING checks as the evidence of what was verified", () => {
		const report = new GateReport().check("artifact", true, "plan.md exists, 454B");
		expect(report.checks).toEqual([
			{ item: "artifact", ok: true, state: "pass", note: "plan.md exists, 454B" },
		]);
	});

	test("checkedNothing is false as soon as one check is recorded", () => {
		expect(new GateReport().check("x", true, "verified").checkedNothing).toBe(false);
	});

	// The record is evidence, and evidence a caller can edit after the fact is not
	// evidence. `readonly GateCheck[]` is erased at runtime, so the copy and the
	// freeze are what actually hold — this is the type whose stated job is
	// trap-#84 honesty about what a gate really looked at.
	test("mutating the returned ARRAY cannot flip a failing report to passed", () => {
		const report = new GateReport()
			.check("ok", true, "verified")
			.check("bad", false, "not verified");
		expect(report.passed).toBe(false);
		const checks = report.checks as GateCheck[];
		checks.splice(1, 1);
		checks.push({ item: "forged", ok: true, state: "pass", note: "forged" });
		expect(report.passed).toBe(false);
		expect(report.checks).toHaveLength(2);
		expect(report.violations).toEqual(["not verified"]);
	});

	test("mutating a returned CHECK OBJECT cannot flip a failing report to passed", () => {
		const report = new GateReport().check("bad", false, "not verified");
		const [check] = report.checks as GateCheck[];
		expect(() => {
			(check as { ok: boolean }).ok = true;
		}).toThrow();
		expect(report.passed).toBe(false);
		expect(report.checks[0]?.ok).toBe(false);
	});
});

describe("GateReport skip state", () => {
	test("a report of ONLY skips does not pass — an unperformed check is not evidence", () => {
		// The defect this state exists to close: with only pass/fail, a gate that
		// could not perform any of its checks had to record them as passes, and the
		// report read green while having verified nothing at all.
		const report = new GateReport()
			.skip("first", "input unavailable")
			.skip("second", "input unavailable");
		expect(report.passed).toBe(false);
		// And it is NOT the empty-report case — items were recorded, just not verified.
		expect(report.checkedNothing).toBe(false);
		expect(report.violations).toEqual([]);
		expect(report.skipped).toEqual(["input unavailable", "input unavailable"]);
	});

	test("a skip does not prevent a report with a real pass from passing", () => {
		const report = new GateReport()
			.check("verified", true, "looked and it is right")
			.skip("unknown", "no destination supplied");
		expect(report.passed).toBe(true);
		expect(report.skipped).toEqual(["no destination supplied"]);
	});

	test("a skip never suppresses a real failure", () => {
		const report = new GateReport()
			.check("verified", true, "looked and it is right")
			.skip("unknown", "no destination supplied")
			.check("broken", false, "wrong");
		expect(report.passed).toBe(false);
		expect(report.violations).toEqual(["wrong"]);
	});

	test("a skip is NOT a violation and NOT ok — it is its own third state", () => {
		const report = new GateReport().skip("item", "could not check");
		expect(report.checks).toEqual([
			{ item: "item", ok: false, state: "skipped", note: "could not check" },
		]);
		// `ok:false` keeps existing consumers honest by default: a consumer that
		// only knows pass/fail must never read a skip as verified.
		expect(report.violations).toEqual([]);
	});

	test("a recorded skip is frozen like any other evidence", () => {
		const report = new GateReport().skip("item", "could not check");
		const [check] = report.checks as GateCheck[];
		expect(() => {
			(check as { state: string }).state = "pass";
		}).toThrow();
		expect(report.passed).toBe(false);
	});
});
