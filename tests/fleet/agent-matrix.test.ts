/**
 * @module tests/fleet/agent-matrix
 * @description Pure logic of `fleet/bin/agent-matrix`: stats,
 *   lead-verdict credit parsing, and bottleneck selection, on fixture objects.
 */
import { describe, expect, test } from "bun:test";
import {
	type AgentStatsRow,
	type BoardData,
	buildMatrix,
	median,
	p90,
	parseVerdictCredits,
	selectBottlenecks,
} from "../../fleet/bin/agent-matrix-lib";

describe("stats", () => {
	test("median of odd, even and empty arrays", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([])).toBeNull();
	});
	test("p90 of a known array and an empty array", () => {
		expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
		expect(p90([5])).toBe(5);
		expect(p90([])).toBeNull();
	});
});

describe("parseVerdictCredits", () => {
	const names = new Map([
		["adams", "id-adams"],
		["chang", "id-chang"],
		["baker", "id-baker"],
	]);
	const body = [
		"verdict: fix-first",
		"",
		"### Upheld",
		"1. **P1 — race in watcher** found by Adams and Chang.",
		"2. **P3 — typo** found by Chang.",
		"",
		"### Not reproduced or refuted",
		"- claimed leak — Baker",
		"",
		"### Notes",
		"nothing",
	].join("\n");

	test("upheld item found by Adams and Chang credits both", () => {
		const r = parseVerdictCredits(body, names);
		expect(r.credits.get("id-adams")).toEqual({ upheld: 1, p01: 1, rejected: 0 });
		expect(r.credits.get("id-chang")).toEqual({ upheld: 2, p01: 1, rejected: 0 });
	});
	test("not reproduced bullet credits the named raiser", () => {
		const r = parseVerdictCredits(body, names);
		expect(r.credits.get("id-baker")).toEqual({ upheld: 0, p01: 0, rejected: 1 });
		expect(r.unknown).toEqual([]);
	});
});

function row(over: Partial<AgentStatsRow>): AgentStatsRow {
	return {
		agent: "x",
		n: 10,
		failed: 0,
		failPct: 0,
		queueMed: 0,
		queueP90: 0,
		runMed: 1,
		runP90: 1,
		...over,
	};
}

describe("selectBottlenecks", () => {
	test("queue median above run median is listed; queue 0 is not", () => {
		const b = selectBottlenecks([
			row({ agent: "slowq", queueMed: 10, runMed: 4 }),
			row({ agent: "fastq", queueMed: 0, runMed: 4 }),
		]);
		expect(b.queueOverRun.map((r) => r.agent)).toEqual(["slowq"]);
	});
	test("fail % 10 with n = 5 is listed; with n = 4 it is not", () => {
		const b = selectBottlenecks([
			row({ agent: "five", n: 5, failed: 1, failPct: 10 }),
			row({ agent: "four", n: 4, failed: 1, failPct: 10 }),
		]);
		expect(b.highFail.map((r) => r.agent)).toEqual(["five"]);
	});
	test("top 5 by queue p90, highest first", () => {
		const rows = [1, 7, 3, 9, 5, 2, 8].map((q) => row({ agent: `a${q}`, queueP90: q }));
		expect(selectBottlenecks(rows).topQueueP90.map((r) => r.agent)).toEqual([
			"a9",
			"a8",
			"a7",
			"a5",
			"a3",
		]);
	});
});

const agentA = {
	id: "a1",
	name: "Adams",
	title: "Reviewer",
	harness: "claude_local",
	model: "m",
	effort: "e",
	maxConc: 1,
};

describe("per-PR cost", () => {
	test("sums lead and child runs, excludes unrelated issues", () => {
		const issues = [
			{ id: "lead", title: "Review o/r#7 @ abc", createdAt: "2026-10-01T00:00:00Z" },
			{ id: "child", title: "Review findings", parentId: "lead", assigneeAgentId: "a1" },
			{ id: "other", title: "Unrelated" },
		];
		const run = (issueId: string, inputTokens: number, outputTokens: number, costUsd: number) => ({
			agentId: "a1",
			createdAt: "2026-10-01T01:00:00Z",
			contextSnapshot: { issueId },
			usageJson: { inputTokens, outputTokens, costUsd },
		});
		const data: BoardData = {
			agents: [agentA],
			runs: [run("lead", 100, 10, 1.5), run("child", 20, 2, 0), run("other", 1000, 1000, 9)],
			issues,
			verdicts: new Map(),
		};
		const row = buildMatrix(data).prRows[0];
		expect(row?.tokens).toBe(132);
		expect(row?.usd).toBe(1.5);
		expect(row?.zeroCostRuns).toBe(1);
	});
});

describe("--hours window", () => {
	const now = Date.parse("2026-10-03T12:00:00Z");
	const at = (h: number) => ({
		agentId: "a1",
		createdAt: new Date(now - h * 3600000).toISOString(),
	});
	test("(a) runs before sinceMs are not counted", () => {
		const m = buildMatrix({
			agents: [agentA],
			runs: [at(30), at(1)],
			issues: [],
			verdicts: new Map(),
			sinceMs: now - 24 * 3600000,
		});
		expect(m.counts.runs).toBe(1);
	});
	test("(b) oldest run after the cutoff adds a truncation gap", () => {
		const m = buildMatrix({
			agents: [agentA],
			runs: [at(2), at(1)],
			issues: [],
			verdicts: new Map(),
			sinceMs: now - 12 * 3600000,
		});
		expect(m.gaps.some((g) => g.includes("window truncated"))).toBe(true);
	});
});
