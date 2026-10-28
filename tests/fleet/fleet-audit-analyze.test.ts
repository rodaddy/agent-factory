/**
 * @module tests/fleet/fleet-audit-analyze
 * @description `fleet/audit/analyze.py`, run as a real child process.
 *   Each rule fires at threshold+1 and not at threshold; output is byte-identical
 *   across runs; an empty snapshot yields no findings and a valid report; a
 *   threshold changed in a temp rules file changes the outcome.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT = resolve(import.meta.dir, "../../fleet/audit/analyze.py");
const FIX = resolve(import.meta.dir, "fixtures/fleet-audit");
const dir = mkdtempSync(join(testTmpBase(), "fleet-audit-analyze-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Finding = { rule: string; severity: string; subject: string };
type Row = Record<string, unknown>;
type Report = { schema: string; totals: { runs: number }; findings: Finding[] };

let n = 0;
function analyze(snap: Row | string, extra: string[] = []): Report {
	const path = typeof snap === "string" ? snap : join(dir, `s${++n}.json`);
	if (typeof snap !== "string") writeFileSync(path, JSON.stringify(snap));
	const p = Bun.spawnSync(["python3", SCRIPT, path, ...extra]);
	expect(p.stderr.toString()).toBe("");
	expect(p.exitCode).toBe(0);
	return JSON.parse(p.stdout.toString() || "null");
}

/** The empty fixture plus one idle agent `a1`, with `over` laid on top. */
function snap(over: Row = {}): Row {
	const s = JSON.parse(readFileSync(join(FIX, "empty.json"), "utf8"));
	return { ...s, agents: [{ id: "a1", name: "Alpha", status: "idle" }], ...over };
}
const run = (i: number, over: Row = {}) => ({
	id: `r${i}`,
	agentId: "a1",
	status: "succeeded",
	...over,
});
const issue = (i: number, over: Row = {}) => ({
	id: `i${i}`,
	identifier: `SOF-${i}`,
	status: "todo",
	...over,
});
const times = <T>(k: number, f: (i: number) => T) => Array.from({ length: k }, (_, i) => f(i));
const hoursBefore = (h: number) =>
	new Date(Date.parse("2026-10-07T04:00:00Z") - h * 3_600_000).toISOString();

// rule -> [the threshold, a snapshot whose measured value is k]
const CASES: Record<string, [number, (k: number) => Row]> = {
	"queue-depth": [20, (k) => snap({ runs: times(k, (i) => run(i, { status: "queued" })) })],
	"work-on-paused": [
		0,
		(k) =>
			snap({
				agents: [{ id: "a1", name: "Alpha", status: "paused" }],
				issues: times(k, (i) => issue(i, { assigneeAgentId: "a1" })),
			}),
	],
	"fail-rate": [
		3,
		(k) => snap({ runs: times(10, (i) => run(i, { status: i < k ? "timed_out" : "succeeded" })) }),
	],
	"issue-churn": [
		3,
		(k) => snap({ issues: [issue(1)], runs: times(k, (i) => run(i, { issueId: "i1" })) }),
	],
	"review-churn": [
		3,
		(k) =>
			snap({
				issues: times(k, (i) => issue(i, { title: `Review o/r#5 @ abcdef${i} round ${i}` })),
			}),
	],
	"stale-blocked": [
		24,
		(k) =>
			snap({
				issues: [issue(1, { status: "blocked", assigneeAgentId: "a1", updatedAt: hoursBefore(k) })],
			}),
	],
	"unfinished-tokens": [
		25,
		(k) =>
			snap({
				issues: [issue(1, { status: "cancelled" })],
				runs: [run(1, { issueId: "i1", inputTokens: k }), run(2, { inputTokens: 100 - k })],
			}),
	],
	// Five traced=null runs: counting nulls as gaps would fire at the threshold.
	"trace-gap": [
		5,
		(k) =>
			snap({
				runs: [...times(100, (i) => run(i, { traced: i >= k })), ...times(5, (i) => run(100 + i))],
			}),
	],
	"recovery-active": [50, (k) => snap({ recovery: { activeByCause: { stale_run: k } } })],
	"collection-gap": [
		0,
		(k) => snap({ errors: times(k, () => ({ source: "langfuse", message: "401" })) }),
	],
	"idle-with-todo": [
		0.5,
		(k) =>
			snap({
				issues: [issue(1, { status: "todo", assigneeAgentId: "a1", updatedAt: hoursBefore(k) })],
			}),
	],
};

describe("analyze.py rules", () => {
	test("rules.json names exactly the implemented rules", () => {
		const rules = JSON.parse(readFileSync(join(SCRIPT, "../rules.json"), "utf8")).rules;
		expect(rules.map((r: { id: string }) => r.id).sort()).toEqual(Object.keys(CASES).sort());
	});
	for (const [rule, [at, build]] of Object.entries(CASES)) {
		test(`${rule} does not fire at ${at} and fires at ${at + 1}`, () => {
			expect(analyze(build(at)).findings.filter((f) => f.rule === rule)).toEqual([]);
			expect(analyze(build(at + 1)).findings.filter((f) => f.rule === rule)).toHaveLength(1);
		});
	}
});

describe("analyze.py idle-with-todo", () => {
	const idle = (s: Row) => analyze(s).findings.filter((f) => f.rule === "idle-with-todo");
	const oldTodo = issue(1, { assigneeAgentId: "a1", updatedAt: hoursBefore(5) });

	test("the old todo work alone fires for an idle seat", () => {
		expect(idle(snap({ issues: [oldTodo] })).map((f) => f.subject)).toEqual(["Alpha"]);
	});

	test("a queued run for the seat suppresses the finding", () => {
		expect(idle(snap({ issues: [oldTodo], runs: [run(1, { status: "queued" })] }))).toEqual([]);
	});

	test("a paused seat holding old todo work is left to work-on-paused", () => {
		const s = snap({ agents: [{ id: "a1", name: "Alpha", status: "paused" }], issues: [oldTodo] });
		expect(idle(s)).toEqual([]);
	});

	test("an old issue assigned to the seat fires only while it is todo", () => {
		for (const status of ["done", "cancelled", "blocked", "in_progress"]) {
			expect(idle(snap({ issues: [{ ...oldTodo, status }] }))).toEqual([]);
		}
	});
});

describe("analyze.py report", () => {
	test("output is byte-identical across runs, sorted act first", () => {
		const out = (i: number) => {
			const [json, md] = [join(dir, `out${i}.json`), join(dir, `out${i}.md`)];
			analyze(join(FIX, "sample.json"), ["--json", json, "--md", md]);
			return [readFileSync(json, "utf8"), readFileSync(md, "utf8")] as const;
		};
		const [a, b] = [out(1), out(2)];
		expect(a).toEqual(b);
		expect(
			(JSON.parse(a[0]) as Report).findings.map((f) => `${f.severity} ${f.rule} ${f.subject}`),
		).toEqual([
			"act stale-blocked Greene",
			"act work-on-paused Vance",
			"watch collection-gap langfuse",
			"watch issue-churn SOF-1",
			"watch trace-gap fleet",
		]);
		expect(a[1]).toContain("# Fleet audit 4h: 2026-10-07T00:00:00Z to 2026-10-07T04:00:00Z");
		expect(a[1]).toContain("| Greene | 3 | 1 | 1 | 1 | 900 |");
		expect(a[1]).toContain("- issue-churn -- SOF-1: 4 (3) -- r1, r2, r3, r4");
	});

	test("an empty snapshot yields no findings and a valid report", () => {
		const md = join(dir, "empty.md");
		const r = analyze(join(FIX, "empty.json"), ["--md", md]);
		expect([r.schema, r.totals.runs, r.findings]).toEqual(["fleet-audit-findings/1", 0, []]);
		expect(readFileSync(md, "utf8")).toContain("## Act\n\n- none\n\n## Watch\n\n- none\n");
	});

	test("a threshold changed in a rules file changes the outcome", () => {
		const s = snap({ runs: times(3, (i) => run(i, { status: "queued" })) });
		const rules = join(dir, "rules.json");
		writeFileSync(
			rules,
			JSON.stringify({ rules: [{ id: "queue-depth", threshold: 2, severity: "act" }] }),
		);
		expect(analyze(s).findings).toEqual([]);
		expect(analyze(s, ["--rules", rules]).findings.map((f) => f.subject)).toEqual(["Alpha"]);
	});
});

type Bench = {
	minRuns: number;
	fleet: Row;
	bySeat: Record<string, Row>;
	capacity?: { measured: number; constant: number };
};
const bench = (s: Row, extra: string[] = []) =>
	(analyze(s, extra) as Report & { benchmark: Bench }).benchmark;
/** Runs of agent `a1` (or `agentId`) whose peakRssKb are `values`, ids offset by `from`. */
const rssRuns = (values: (number | null | undefined)[], agentId = "a1", from = 0) =>
	values.map((v, i) => run(from + i, v === undefined ? { agentId } : { agentId, peakRssKb: v }));
const oneTo = (k: number) => times(k, (i) => i + 1);
function reportMd(s: Row, extra: string[] = []): string {
	const md = join(dir, `bench${++n}.md`);
	analyze(s, ["--md", md, ...extra]);
	return readFileSync(md, "utf8");
}

describe("analyze.py RSS benchmark", () => {
	test("19 runs are insufficient; 20 and 21 give nearest-rank p50/p95/max", () => {
		expect(bench(snap({ runs: rssRuns(oneTo(19)) })).bySeat.Alpha).toEqual({
			n: 19,
			insufficient: true,
		});
		expect(bench(snap({ runs: rssRuns(oneTo(20)) })).bySeat.Alpha).toEqual({
			n: 20,
			p50: 10,
			p95: 19,
			max: 20,
		});
		// Non-integer q*n: ceil and floor differ here, so the rank rounding is pinned.
		expect(bench(snap({ runs: rssRuns(oneTo(21)) })).bySeat.Alpha).toEqual({
			n: 21,
			p50: 11,
			p95: 20,
			max: 21,
		});
	});

	test("runs with no peakRssKb or null are missing, never 0", () => {
		const nulls = times(30, (i) => (i % 2 ? null : undefined));
		const b = bench(snap({ runs: rssRuns([...oneTo(20), ...nulls]) }));
		expect(b.bySeat.Alpha).toEqual({ n: 20, p50: 10, p95: 19, max: 20 });
		expect(b.fleet.n).toBe(20);
	});

	test("the fleet row can be sufficient while every seat is not", () => {
		const s = snap({
			agents: [
				{ id: "a1", name: "Alpha", status: "idle" },
				{ id: "a2", name: "Beta", status: "idle" },
			],
			runs: [...rssRuns(oneTo(10), "a1"), ...rssRuns(oneTo(10), "a2", 10)],
		});
		const b = bench(s);
		expect(b.fleet).toEqual({ n: 20, p50: 5, p95: 10, max: 10 });
		expect(b.bySeat).toEqual({
			Alpha: { n: 10, insufficient: true },
			Beta: { n: 10, insufficient: true },
		});
	});

	test("capacity at the measured fleet p95 sits beside the hand-set constant", () => {
		const s = snap({ runs: rssRuns(times(20, () => 2097152)) });
		expect(bench(s).capacity).toEqual({ measured: 6, constant: 20 });
		const md = reportMd(s);
		expect(md).toContain("capacity at measured p95: 6 | hand-set constant: 20");
		expect(md).toContain("Pi process RSS only, bash children excluded; capacity is an upper bound");
		expect(md).toContain("| fleet | 20 | 2097152 | 2097152 | 2097152 |");
	});

	test("an insufficient fleet row gives no capacity", () => {
		const s = snap({ runs: rssRuns(oneTo(19)) });
		expect(Object.keys(bench(s))).not.toContain("capacity");
		const md = reportMd(s);
		expect(md).toContain("| Alpha | 19 | insufficient data (n=19) |");
		expect(md).not.toContain("capacity at measured p95");
	});

	test("an empty snapshot keeps Act and Watch, then the benchmark section", () => {
		const md = join(dir, "empty-bench.md");
		const r = analyze(join(FIX, "empty.json"), ["--md", md]) as Report & { benchmark: Bench };
		expect(r.benchmark).toEqual({
			minRuns: 20,
			fleet: { n: 0, insufficient: true },
			bySeat: {},
		});
		const text = readFileSync(md, "utf8");
		const watch = "## Act\n\n- none\n\n## Watch\n\n- none\n";
		expect(text).toContain(watch);
		expect(text.indexOf(watch)).toBeLessThan(text.indexOf("## RSS benchmark"));
		expect(text).toContain("| fleet | 0 | insufficient data (n=0) |");
	});

	test("benchmark.minRuns set in a rules file changes the outcome", () => {
		const rules = join(dir, "bench-rules.json");
		writeFileSync(rules, JSON.stringify({ rules: [], benchmark: { minRuns: 5 } }));
		const b = bench(snap({ runs: rssRuns(oneTo(19)) }), ["--rules", rules]);
		expect(b.minRuns).toBe(5);
		expect(b.bySeat.Alpha).toEqual({ n: 19, p50: 10, p95: 19, max: 19 });
	});
});
