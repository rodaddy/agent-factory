import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ADVICE_LINE_RE,
	adviceFields,
	adviseOne,
	inputCapped,
	parseAdviceLines,
} from "../../scripts/actions/jev-advise";
import type { Ask } from "../../src/jev/classifier";
import type { JevResult } from "../../src/jev/client";
import { testTmpBase } from "../support/test-temp";

const choice = (label: string, confidence: number): JevResult => ({
	ok: true,
	answers: {
		"issue-type": {
			type: "choice",
			choice: label,
			probabilities: { [label]: confidence },
			confidence,
		},
	},
	inputTokens: 1,
	ms: 1,
});
const fault: JevResult = { ok: false, error: "no key", ms: 1 };
const scripted =
	(r: JevResult): Ask =>
	async () =>
		r;
const tmp = (): Promise<string> => mkdtemp(join(testTmpBase(), "jev-advise-"));

describe("adviceFields", () => {
	test("issue: title and body capped at 4000", async () => {
		const dir = await tmp();
		const input = join(dir, "issue.json");
		await writeFile(input, JSON.stringify({ title: "T", body: "b".repeat(5000) }));
		const f = await adviceFields("issue", input);
		expect(f.title).toBe("T");
		expect(f.body?.length).toBe(4000);
	});

	test("pr: files from diff headers, title from pr.json, diff capped", async () => {
		const dir = await tmp();
		const diff = `diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/old.md b/new.md\n${"y".repeat(5000)}`;
		await writeFile(join(dir, "pr.diff"), diff);
		await writeFile(join(dir, "pr.json"), JSON.stringify({ title: "PR title", body: "ignored" }));
		const f = await adviceFields("pr", dir);
		expect(f.title).toBe("PR title");
		expect(f.files).toBe("src/a.ts\nnew.md");
		expect(f.diff?.length).toBe(4000);
	});

	test("pr: title is empty when pr.json is absent", async () => {
		const dir = await tmp();
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "pr.diff"), "diff --git a/x b/x\n");
		const f = await adviceFields("pr", dir);
		expect(f.title).toBe("");
		expect(f.files).toBe("x");
	});
});

describe("adviseOne", () => {
	const fields = { title: "Crash", body: "It crashes." };
	test("confident -> the verdict and confidence", async () => {
		const line = await adviseOne("issue-type", fields, scripted(choice("bug", 0.97)));
		expect(line).toBe("jev issue-type v1 (advisory): BUG 0.97");
		expect(ADVICE_LINE_RE.test(line)).toBe(true);
	});
	test("low confidence -> UNSURE below the threshold", async () => {
		const line = await adviseOne("issue-type", fields, scripted(choice("bug", 0.5)));
		expect(line).toBe("jev issue-type v1 (advisory): UNSURE 0.50 (below 0.7)");
		expect(ADVICE_LINE_RE.test(line)).toBe(true);
	});
	test("no signal -> NO_SIGNAL", async () => {
		const line = await adviseOne("issue-type", fields, scripted(fault));
		expect(line).toBe("jev issue-type v1 (advisory): NO_SIGNAL (no Jev signal)");
		expect(ADVICE_LINE_RE.test(line)).toBe(true);
	});
});

describe("adviseOne on a capped (partial) input", () => {
	const score = (s: number, confidence: number): JevResult => ({
		ok: true,
		answers: {
			"pr-review-depth": {
				type: "score",
				score: s,
				confidence,
				legend: {},
				probabilities: {},
			},
		},
		inputTokens: 1,
		ms: 1,
	});
	const prFields = { title: "t", files: "a.md", diff: "d" };
	test("the freest verdict (LIGHT) on a partial input becomes UNSURE", async () => {
		const line = await adviseOne("pr-review-depth", prFields, scripted(score(0, 0.95)), true);
		expect(line).toBe("jev pr-review-depth v2 (advisory): UNSURE 0.95 (partial input)");
		expect(ADVICE_LINE_RE.test(line)).toBe(true);
	});
	test("a heavier verdict on a partial input keeps its verdict and says partial", async () => {
		const line = await adviseOne("pr-review-depth", prFields, scripted(score(2, 0.9)), true);
		expect(line).toBe("jev pr-review-depth v2 (advisory): FULL 0.90 (partial input)");
	});
	test("an unordered classifier keeps its label and says partial", async () => {
		const line = await adviseOne(
			"issue-type",
			{ title: "t", body: "b" },
			scripted(choice("bug", 0.97)),
			true,
		);
		expect(line).toBe("jev issue-type v1 (advisory): BUG 0.97 (partial input)");
	});
	test("not partial: the freest verdict stands", async () => {
		const line = await adviseOne("pr-review-depth", prFields, scripted(score(0, 0.95)));
		expect(line).toBe("jev pr-review-depth v2 (advisory): LIGHT 0.95");
	});
	test("inputCapped flags a long issue body; a PR only when its file list was cut", async () => {
		const dir = await tmp();
		const issue = join(dir, "issue.json");
		await writeFile(issue, JSON.stringify({ title: "T", body: "b".repeat(5000) }));
		expect(await inputCapped("issue", issue)).toBe(true);
		await writeFile(issue, JSON.stringify({ title: "T", body: "short" }));
		expect(await inputCapped("issue", issue)).toBe(false);
		const pr = join(dir, "pr");
		await mkdir(pr);
		// A long diff over a short file list is NOT partial: every path is visible.
		await writeFile(join(pr, "pr.diff"), `diff --git a/x b/x\n${"+".repeat(5000)}\n`);
		expect(await inputCapped("pr", pr)).toBe(false);
		// A file list over the 2000-char cap IS partial.
		const many = Array.from(
			{ length: 80 },
			(_, i) => `diff --git a/some/long/path/file-${i}.ts b/some/long/path/file-${i}.ts\n+x`,
		).join("\n");
		await writeFile(join(pr, "pr.diff"), `${many}\n`);
		expect(await inputCapped("pr", pr)).toBe(true);
	});
});

describe("parseAdviceLines", () => {
	test("keeps valid lines, drops malformed ones, caps at max", () => {
		const good = [
			"jev issue-type v1 (advisory): BUG 0.97",
			"jev a v1 (advisory): NO_SIGNAL (no Jev signal)",
			"jev b v2 (advisory): UNSURE 0.50 (below 0.7)",
			"jev c v1 (advisory): OK",
			"jev d v1 (advisory): OK",
		];
		const text = [
			`  ${good[0]}  `,
			"jev x v1 (advisory): BUG 0.97 and more",
			"jev x v1 (advisory): bug",
			"jev x v1 (advisory): BUG (<script>)",
			...good.slice(1),
		].join("\n");
		expect(parseAdviceLines(text)).toEqual(good.slice(0, 4));
		expect(parseAdviceLines(text, 2)).toEqual(good.slice(0, 2));
	});
});

describe("jev-advise CLI", () => {
	const script = join(import.meta.dir, "..", "..", "scripts", "actions", "jev-advise.ts");
	test("issue with no key -> two NO_SIGNAL lines, exit 0", async () => {
		const dir = await tmp();
		const input = join(dir, "issue.json");
		const out = join(dir, "advice.txt");
		await writeFile(input, JSON.stringify({ title: "Fix typo", body: "README typo." }));
		const env = { ...process.env, TYPESAFE_API_KEY: "" };
		const proc = Bun.spawnSync(
			["bun", script, "issue", input, out, "issue-type", "issue-implementable"],
			{ env },
		);
		expect(proc.exitCode).toBe(0);
		const lines = (await readFile(out, "utf8")).trim().split("\n");
		expect(lines.length).toBe(2);
		expect(lines[0]).toBe("jev issue-type v1 (advisory): NO_SIGNAL (no Jev signal)");
		expect(lines[1]).toMatch(
			/^jev issue-implementable v\d+ \(advisory\): NO_SIGNAL \(no Jev signal\)$/,
		);
	});
	test("unknown id -> exit 3", async () => {
		const dir = await tmp();
		const input = join(dir, "issue.json");
		await writeFile(input, JSON.stringify({ title: "t", body: "b" }));
		const proc = Bun.spawnSync(["bun", script, "issue", input, join(dir, "o"), "no-such-clf"]);
		expect(proc.exitCode).toBe(3);
	});
});
