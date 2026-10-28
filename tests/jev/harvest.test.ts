/**
 * @module tests/jev/harvest
 * @description Fix-round tables parse into labelled Jev examples:
 *   only tables under a fix-round heading with the fix-round header count, a
 *   pipe inside a backtick span does not split a cell, and a disposition that
 *   cannot be read is counted as skipped rather than guessed.
 */
import { describe, expect, test } from "bun:test";
import {
	examplesFrom,
	isHeldOut,
	labelForDisposition,
	parseFixRounds,
} from "../../src/jev/harvest";

const ROUND_1 = `## Fix round 1 (head ad3a5ba)

| # | Finding | Disposition | Evidence |
|---|---|---|---|
| P1 | Missing employee keys do not fail closed (\`fleet/fleetd.mjs\`, \`childEnv()\`) | FIXED | The inherited key is removed. |
| P2 | Existing key files keep unsafe permissions (\`fleet/agent-keys.sh\`) | FIXED | \`chmod 600\` before any key is written. |
`;

const ROUND_6 = `## Round 6 dispositions (head ee8be82, unchanged) and merge

| # | Finding | Disposition | Reason |
|---|---|---|---|
| P2 | Assignment polling expires before the configured run timeout (\`fleet/assign.sh\`) | ACCEPTED, follow-up PR | True. |
| P2 | Echo verification times out (\`a | b\` in code) | DISAGREED, recorded (rule 25) | Bounded on purpose. |
`;

describe("jev harvest", () => {
	test("a fix-round table yields one row per finding, backtick spans intact", () => {
		const rows = parseFixRounds(ROUND_1);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.round)).toEqual([1, 1]);
		expect(rows.map((r) => r.severity)).toEqual(["P1", "P2"]);
		expect(rows.map((r) => r.disposition)).toEqual(["FIXED", "FIXED"]);
		expect(rows[0]?.finding).toBe(
			"Missing employee keys do not fail closed (`fleet/fleetd.mjs`, `childEnv()`)",
		);
		expect(rows[1]?.finding).toBe(
			"Existing key files keep unsafe permissions (`fleet/agent-keys.sh`)",
		);
		expect(rows[1]?.evidence).toBe("`chmod 600` before any key is written.");
	});

	test("a pipe inside a backtick span does not split the cell", () => {
		const rows = parseFixRounds(ROUND_6);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.round)).toEqual([6, 6]);
		expect(rows[1]).toEqual({
			round: 6,
			severity: "P2",
			finding: "Echo verification times out (`a | b` in code)",
			disposition: "DISAGREED, recorded (rule 25)",
			evidence: "Bounded on purpose.",
		});
	});

	test("a disposition reads as defect, hardening ask, or null", () => {
		expect(labelForDisposition("FIXED")).toBe("defect");
		expect(labelForDisposition("ACCEPTED, follow-up PR")).toBe("defect");
		expect(labelForDisposition("DISAGREED, recorded (rule 25)")).toBe("hardening ask");
		expect(labelForDisposition("disagree")).toBe("hardening ask");
		expect(labelForDisposition("")).toBeNull();
		expect(labelForDisposition("WONTFIX")).toBeNull();
	});

	test("examples carry the label, and an unreadable row is skipped, not guessed", () => {
		const rows = parseFixRounds(ROUND_6);
		const { examples, skipped } = examplesFrom("feat(fleet): assign", rows);
		expect(skipped).toBe(0);
		expect(examples.map((e) => e.expect)).toEqual(["defect", "hardening ask"]);
		expect(examples[1]?.fields).toEqual({
			pr_title: "feat(fleet): assign",
			severity: "P2",
			finding: "Echo verification times out (`a | b` in code)",
		});

		const withUnreadable = parseFixRounds(`${ROUND_6}| P2 | Something else | WONTFIX | No. |\n`);
		expect(withUnreadable).toHaveLength(3);
		const second = examplesFrom("feat(fleet): assign", withUnreadable);
		expect(second.skipped).toBe(1);
		expect(second.examples.map((e) => e.expect)).toEqual(["defect", "hardening ask"]);
	});

	test("a table outside a fix round, or with another header, yields nothing", () => {
		const summary = ROUND_1.replace("## Fix round 1 (head ad3a5ba)", "## Summary");
		expect(parseFixRounds(summary)).toEqual([]);
		const otherHeader = `## Fix round 2

| Commit | Row | What |
|---|---|---|
| abc1234 | 1 | FIXED |
`;
		expect(parseFixRounds(otherHeader)).toEqual([]);
	});

	test("an item number divisible by 5 is held out", () => {
		expect(isHeldOut(1135)).toBe(true);
		expect(isHeldOut(1131)).toBe(false);
		expect(isHeldOut(5)).toBe(true);
		expect(isHeldOut(0)).toBe(true);
	});

	test("a body holding both tables yields every row with its own round", () => {
		const rows = parseFixRounds(`Review notes.\n\n${ROUND_1}\nSome prose.\n\n${ROUND_6}`);
		expect(rows.map((r) => r.round)).toEqual([1, 1, 6, 6]);
	});
});
