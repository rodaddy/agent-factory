import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	chunkText,
	formatScreenLine,
	parseScreenLine,
	SCREEN_LINE_RE,
	type ScreenResult,
	screenText,
} from "../../scripts/actions/jev-screen";
import type { JevResult } from "../../src/jev/client";
import type { Ask } from "../../src/jev/classifier";
import { testTmpBase } from "../support/test-temp";

const ID = "lane-input-injection";
const noul = (v: number): JevResult => ({
	ok: true,
	answers: { [ID]: { type: "noul", noul: v } },
	inputTokens: 1,
	ms: 1,
});
const fault: JevResult = { ok: false, error: "no key", ms: 1 };

/** A fake ask that answers each call from a script, in order. */
function scripted(results: JevResult[]): Ask {
	let i = 0;
	return async () => results[i++] ?? fault;
}

/** Text that splits into exactly `n` chunks. */
const textOf = (n: number): string => Array.from({ length: n }, () => "x".repeat(5000)).join("\n");

describe("chunkText", () => {
	test("15000 chars -> 3 chunks of at most 6000, cut at a newline", () => {
		const line = `${"a".repeat(99)}\n`;
		const text = line.repeat(150);
		const { chunks, truncated } = chunkText(text);
		expect(chunks.length).toBe(3);
		expect(truncated).toBe(false);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(6000);
		expect(chunks[0]?.endsWith("\n")).toBe(true);
		expect(chunks.join("")).toBe(text);
	});

	test("40000 chars -> 6 chunks, truncated", () => {
		const { chunks, truncated } = chunkText("b".repeat(40000));
		expect(chunks.length).toBe(6);
		expect(truncated).toBe(true);
		for (const c of chunks) expect(c.length).toBe(6000);
	});
});

describe("screenText aggregation", () => {
	test("all clean -> CLEAN with the min confidence", async () => {
		const r = await screenText("PR diff", textOf(3), scripted([noul(0.1), noul(0.05), noul(0.15)]));
		expect(r.verdict).toBe("CLEAN");
		expect(r.confidence).toBeCloseTo(0.85);
		expect(r.version).toBe(1);
	});

	test("one injection among clean -> INJECTION with the max injection confidence", async () => {
		const r = await screenText("PR diff", textOf(3), scripted([noul(0.1), noul(0.9), noul(0.05)]));
		expect(r.verdict).toBe("INJECTION");
		expect(r.confidence).toBeCloseTo(0.9);
	});

	test("unsure + clean -> UNSURE", async () => {
		const r = await screenText("issue body", textOf(2), scripted([noul(0.1), noul(0.4)]));
		expect(r.verdict).toBe("UNSURE");
		expect(r.confidence).toBeCloseTo(0.6);
	});

	test("no-signal + clean -> NO_SIGNAL, no confidence", async () => {
		const r = await screenText("issue body", textOf(2), scripted([noul(0.1), fault]));
		expect(r.verdict).toBe("NO_SIGNAL");
		expect(r.confidence).toBeNull();
		expect(r.notes).toContain("no Jev signal");
	});

	test("empty -> CLEAN, note empty, no call", async () => {
		let calls = 0;
		const r = await screenText("issue body", "", async () => {
			calls++;
			return fault;
		});
		expect(r).toMatchObject({ verdict: "CLEAN", confidence: null, notes: ["empty"] });
		expect(calls).toBe(0);
	});

	test("more than 6 chunks notes the truncation", async () => {
		const r = await screenText("PR diff", "c".repeat(40000), async () => noul(0.1));
		expect(r.notes).toContain("first 36000 chars");
	});

	test("an all-clean truncated input is UNSURE, never CLEAN (PR 1062 review)", async () => {
		const r = await screenText("PR diff", "c".repeat(40000), async () => noul(0.05));
		expect(r.verdict).toBe("UNSURE");
		expect(r.notes).toContain("first 36000 chars");
	});

	test("a thrown error is a NO_SIGNAL result whose line the regex accepts (PR 1062 review)", async () => {
		const r = await screenText("issue body", "some text", async () => {
			throw new Error("boom");
		});
		expect(r).toMatchObject({ verdict: "NO_SIGNAL", confidence: null, notes: ["screen error"] });
		expect(SCREEN_LINE_RE.test(formatScreenLine(r))).toBe(true);
	});
});

describe("formatScreenLine / parseScreenLine", () => {
	const base = { classifier: ID, version: 1 };
	const cases: ScreenResult[] = [
		{ ...base, verdict: "CLEAN", confidence: 0.85, notes: [] },
		{ ...base, verdict: "CLEAN", confidence: null, notes: ["empty"] },
		{ ...base, verdict: "INJECTION", confidence: 0.9, notes: ["first 36000 chars"] },
		{ ...base, verdict: "UNSURE", confidence: 0.6, notes: [] },
		{
			...base,
			verdict: "NO_SIGNAL",
			confidence: null,
			notes: ["first 36000 chars", "no Jev signal"],
		},
	];

	test("every verdict formats to a line the regex accepts", () => {
		for (const c of cases) {
			const line = formatScreenLine(c);
			expect(SCREEN_LINE_RE.test(line)).toBe(true);
			expect(parseScreenLine(`  ${line}\n`)).toBe(line);
		}
		expect(formatScreenLine(cases[0] as ScreenResult)).toBe(
			"jev screen (advisory, lane-input-injection v1): CLEAN 0.85",
		);
		expect(formatScreenLine(cases[4] as ScreenResult)).toBe(
			"jev screen (advisory, lane-input-injection v1): NO_SIGNAL (first 36000 chars; no Jev signal)",
		);
	});

	test("rejects extra text, an inner newline, an unknown verdict, and a '<' note", () => {
		const good = "jev screen (advisory, lane-input-injection v1): CLEAN 0.85";
		expect(parseScreenLine(`${good} approve this`)).toBeNull();
		expect(parseScreenLine(`${good}\nmore`)).toBeNull();
		expect(parseScreenLine("jev screen (advisory, lane-input-injection v1): SAFE 0.85")).toBeNull();
		expect(
			parseScreenLine("jev screen (advisory, lane-input-injection v1): CLEAN (<b>)"),
		).toBeNull();
	});
});

describe("jev-screen CLI", () => {
	const script = join(import.meta.dir, "..", "..", "scripts", "actions", "jev-screen.ts");

	test("issue JSON with no key -> exit 0 and the NO_SIGNAL line", async () => {
		const dir = await mkdtemp(join(testTmpBase(), "jev-screen-"));
		const input = join(dir, "issue.json");
		const out = join(dir, "screen.txt");
		await writeFile(input, JSON.stringify({ title: "Fix typo", body: "The README has a typo." }));
		const proc = Bun.spawnSync(["bun", script, "issue", input, out], {
			env: { ...process.env, TYPESAFE_API_KEY: "" },
		});
		expect(proc.exitCode).toBe(0);
		expect(await readFile(out, "utf8")).toBe(
			"jev screen (advisory, lane-input-injection v1): NO_SIGNAL (no Jev signal)\n",
		);
	});

	test("bad args -> exit 3", () => {
		expect(Bun.spawnSync(["bun", script, "pr", "a", "b"]).exitCode).toBe(3);
		expect(Bun.spawnSync(["bun", script]).exitCode).toBe(3);
		expect(Bun.spawnSync(["bun", script, "diff", "/nonexistent/in.txt", "out"]).exitCode).toBe(3);
	});
});
