/**
 * @module tests/actions/render-second-pass
 * @description Functional tests for the pr-review adversarial second-pass
 *   renderer: the trust-path rule, the refute/checklist plan derived
 *   from pass-1 chunk replies, the two request builders (fixed system prompts,
 *   untrusted text only in the fenced user message, review text capped), and
 *   the CLI file contract and exit codes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_ENGINE_MODEL, MAX_DIFF_BYTES } from "../../scripts/actions/render-pr-review";
import { applySecondPass } from "../../scripts/actions/second-pass";
import {
	buildChecklistRequest,
	buildRefuteRequest,
	CHECKLIST_PROMPT,
	countBlockingFindings,
	parseDiffSections,
	planSecondPass,
	REFUTE_FINDINGS_MAX_BYTES,
	REFUTER_PROMPT,
	trustFiles,
	UNPARSEABLE_MARKER,
} from "../../scripts/actions/render-second-pass";
import { testTmpBase } from "../support/test-temp";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const VALID = { REPO: "rodaddy/software-factory", PR: "939", HEAD_SHA: HEAD, BASE_SHA: BASE };
const bytes = (text: string) => new TextEncoder().encode(text);
const DIFF = bytes("diff --git a/x b/x\n--- a/x\n+++ b/x\n+one\n");
const SCRIPT = new URL("../../scripts/actions/render-second-pass.ts", import.meta.url).pathname;

const content = (request: { messages: { content: string }[] }, i: number): string => {
	const message = request.messages[i];
	if (message === undefined) throw new Error(`no message at index ${i}`);
	return message.content;
};

const FIX = "- P1 a.ts:1 bad\nverdict: fix-first";
const OK = "no findings\nverdict: approve";

describe("trustFiles", () => {
	test("matches each trust rule, sorted and deduped, and rejects look-alikes", () => {
		const input = [
			"src/results/change-ingest.ts",
			".forgejo/workflows/pr-review.yml",
			"src/hooks/pre-push.ts",
			"scripts/actions/post-pr-review.ts",
			"src/results/bundle-inspector.ts",
			"src/hooks.ts",
			"docs/scripts/actions/x.md",
			"src/results/store.ts",
			".forgejo/workflows/pr-review.yml",
		];
		expect(trustFiles(input)).toEqual([
			".forgejo/workflows/pr-review.yml",
			"scripts/actions/post-pr-review.ts",
			"src/hooks/pre-push.ts",
			"src/results/bundle-inspector.ts",
			"src/results/change-ingest.ts",
		]);
		expect(
			trustFiles(["src/hooks.ts", "docs/scripts/actions/x.md", "src/results/store.ts"]),
		).toEqual([]);
	});
});

const sections = (diff: string) => parseDiffSections(diff);
const WF =
	"diff --git a/.forgejo/workflows/x.yml b/.forgejo/workflows/x.yml\n--- a/.forgejo/workflows/x.yml\n+++ b/.forgejo/workflows/x.yml\n+x\n";
const PLAIN = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+x\n";

describe("planSecondPass", () => {
	test("all approve and no trust file requests nothing", () => {
		expect(planSecondPass([{ review: OK }, { review: OK }], sections(PLAIN), 0)).toEqual({
			refute: false,
			checklist: false,
			trust_files: [],
		});
	});

	test("one fix-first chunk requests the refuter", () => {
		const plan = planSecondPass([{ review: OK }, { review: FIX }], sections(PLAIN), 0);
		expect(plan.refute).toBe(true);
		expect(plan.checklist).toBe(false);
		expect(plan.refute_skipped).toBeUndefined();
	});

	test("a workflow file in the diff requests the checklist and is listed", () => {
		expect(planSecondPass([{ review: OK }], sections(WF), 0)).toEqual({
			refute: false,
			checklist: true,
			trust_files: [".forgejo/workflows/x.yml"],
		});
	});

	test("a non-empty diff with no `diff --git` header is unparseable and requests the checklist", () => {
		const diff = "--- a/.forgejo/workflows/x.yml\n+++ b/.forgejo/workflows/x.yml\n+x\n";
		expect(sections(diff)).toEqual([{ paths: [], unparseable: true }]);
		expect(planSecondPass([{ review: OK }], sections(diff), 0)).toEqual({
			refute: false,
			checklist: true,
			trust_files: [UNPARSEABLE_MARKER],
		});
		expect(sections("")).toEqual([]);
		expect(sections("\n")).toEqual([]);
	});

	test("(a) a C-quoted header is unparseable and requests the checklist", () => {
		const diff = [
			'diff --git "a/.forgejo/workflows/\\303\\251.yml" "b/.forgejo/workflows/\\303\\251.yml"',
			'--- "a/.forgejo/workflows/\\303\\251.yml"',
			'+++ "b/.forgejo/workflows/\\303\\251.yml"',
			"+x",
			"",
		].join("\n");
		const plan = planSecondPass([{ review: OK }], sections(PLAIN + diff), 0);
		expect(plan.checklist).toBe(true);
		expect(plan.trust_files).toContain("<unparseable diff header>");
	});

	test("(b) a rename out of the trust surface matches on the old path", () => {
		const diff =
			"diff --git a/src/hooks/gate.ts b/docs-gate.ts\nsimilarity index 100%\nrename from src/hooks/gate.ts\nrename to docs-gate.ts\n";
		const plan = planSecondPass([{ review: OK }], sections(diff), 0);
		expect(plan).toEqual({ refute: false, checklist: true, trust_files: ["src/hooks/gate.ts"] });
	});

	test("(c) a path containing ' b/' still matches from its +++ line", () => {
		const diff =
			"diff --git a/scripts/actions/x b/y.ts b/scripts/actions/x b/y.ts\n--- a/scripts/actions/x b/y.ts\n+++ b/scripts/actions/x b/y.ts\n+x\n";
		const plan = planSecondPass([{ review: OK }], sections(diff), 0);
		expect(plan.checklist).toBe(true);
		expect(plan.trust_files).toEqual(["scripts/actions/x b/y.ts"]);
	});

	test("a mode-only header with an ambiguous ' b/' split is unparseable", () => {
		const diff = "diff --git a/p b/q b/r b/s\nold mode 100644\nnew mode 100755\n";
		expect(planSecondPass([{ review: OK }], sections(diff), 0).trust_files).toEqual([
			"<unparseable diff header>",
		]);
	});

	test("fix-first reviews over the byte budget skip the refuter, fail closed", () => {
		const big = `${"a".repeat(REFUTE_FINDINGS_MAX_BYTES + 1)}\n${FIX}`;
		const plan = planSecondPass([{ review: big }], sections(PLAIN), 0);
		expect(REFUTE_FINDINGS_MAX_BYTES).toBe(20_000);
		expect(plan.refute).toBe(false);
		expect(plan.refute_skipped).toBe("findings exceed 20000 bytes");
	});
});

describe("buildRefuteRequest", () => {
	test("fixed system prompt; review and diff only in the fenced user message", () => {
		const request = buildRefuteRequest(VALID, ["REVIEW-TEXT-A"], DIFF);
		expect(request.model).toBe(DEFAULT_ENGINE_MODEL);
		expect(request.reasoning_effort).toBe("high");
		expect(request.max_completion_tokens).toBe(4000);
		expect(content(request, 0)).toBe(REFUTER_PROMPT);
		const user = content(request, 1);
		expect(user.startsWith(`Base sha: ${BASE}\nHead sha: ${HEAD}\n\n`)).toBe(true);
		expect(user).toContain("First review:\n```text\nREVIEW-TEXT-A\n```");
		expect(user).toContain("```diff\ndiff --git a/x b/x");
		expect(user.trimEnd().endsWith("```")).toBe(true);
	});

	test("a review holding a triple backtick gets a four-backtick fence", () => {
		const user = content(buildRefuteRequest(VALID, ["x\n```\ny"], DIFF), 1);
		expect(user).toContain("First review:\n````text\nx\n```\ny\n````\n\n");
		expect(user).toContain("```diff\ndiff --git");
	});
});

describe("buildChecklistRequest", () => {
	test("fixed system prompt and no first review", () => {
		const request = buildChecklistRequest(VALID, DIFF);
		expect(content(request, 0)).toBe(CHECKLIST_PROMPT);
		expect(content(request, 1)).not.toContain("First review:");
		expect(content(request, 1)).toContain("```diff\n");
	});

	test("a diff holding runs of 3 and 5 backticks gets a fence longer than 5", () => {
		const diff = bytes("diff --git a/x b/x\n+a ``` b\n+c ````` d\n");
		const user = content(buildChecklistRequest(VALID, diff), 1);
		const opener = user.split("\n").find((line) => /^`+diff$/.test(line)) ?? "";
		expect(opener.length - "diff".length).toBeGreaterThan(5);
	});
});

describe("development#910 D910-3: item 6 excepts enroll-app tag-rail workflows", () => {
	const ITEM_1 =
		"1. A job that runs repository or agent content holds at most the engine key: no forge token, no OIDC, no secrets.\n";
	const ITEM_2 =
		"2. No target repository tree is checked out inside the factory's own checkout or workspace import path.\n";
	const item6 = (): string => {
		const start = CHECKLIST_PROMPT.indexOf("\n6. ");
		const end = CHECKLIST_PROMPT.indexOf("\n7. ");
		if (start < 0 || end < start) throw new Error("item 6 not found");
		return CHECKLIST_PROMPT.slice(start + 1, end);
	};

	test("items 1 and 2 are byte-for-byte unchanged", () => {
		expect(CHECKLIST_PROMPT).toContain(ITEM_1 + ITEM_2);
	});

	test("item 6 keeps the D23 rule", () => {
		expect(
			item6().startsWith("6. A credentialed job runs only under `workflow_dispatch` (D23)."),
		).toBe(true);
	});

	test("the exception names the generator stamp exactly, the tag-only trigger, and keeps 1 and 2", () => {
		const text = item6().replace(/\n\s+/g, " ");
		expect(text).toContain("`# Written by enroll-app; re-run it to regenerate.`");
		expect(text).toContain("item 6 is n/a for it");
		expect(text).toContain("items 1 and 2 still apply to it in full");
	});
});

describe("development#910 D910-3 round 1 (PR 1394 P1): tag-push / dispatch must be the only triggers", () => {
	const item6 = (): string => {
		const start = CHECKLIST_PROMPT.indexOf("\n6. ");
		const end = CHECKLIST_PROMPT.indexOf("\n7. ");
		if (start < 0 || end < start) throw new Error("item 6 not found");
		return CHECKLIST_PROMPT.slice(start + 1, end).replace(/\n\s+/g, " ");
	};

	test("the exception holds only when ALL conditions hold, the sole-trigger one included", () => {
		const text = item6();
		expect(text).toContain("only when ALL of these hold");
		expect(text).toContain("its `on:` has no event other than `push` and `workflow_dispatch`");
		expect(text).toContain(
			"`on.push` lists `tags` only (no `branches`, no `branches-ignore`, no `paths` without `tags`)",
		);
	});

	test("every secret-receiving job must carry a release-tag `if:` guard", () => {
		expect(item6()).toContain(
			"every job that receives secrets carries an `if:` admitting only the app's release tag form",
		);
	});

	test("pull_request, or any other non-push/non-dispatch event, voids the exception", () => {
		expect(item6()).toContain(
			"If any other event is present (`pull_request`, `pull_request_target`, `push` to branches, `schedule`, `issue_comment`, `workflow_run`, or any other), the exception does not apply and item 6 is judged normally",
		);
	});
});

describe("sf#939 fix round 3 (PR 1100 review): diff truncation", () => {
	test("a diff over MAX_DIFF_BYTES marks the plan truncated", () => {
		const plan = planSecondPass([{ review: OK }], sections(PLAIN), MAX_DIFF_BYTES + 1);
		expect(plan.diff_truncated).toBe(true);
	});

	test("a diff of exactly MAX_DIFF_BYTES omits the key", () => {
		const plan = planSecondPass([{ review: OK }], sections(PLAIN), MAX_DIFF_BYTES);
		expect("diff_truncated" in plan).toBe(false);
	});
});

const reply = (text: string) => JSON.stringify({ choices: [{ message: { content: text } }] });

async function runCli(env: Record<string, string>) {
	const proc = Bun.spawn(["bun", SCRIPT], {
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	return { code, stderr: await new Response(proc.stderr).text() };
}

describe("CLI", () => {
	test("fix-first reply on a workflow diff writes the plan and both requests", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/sf939-second-pass-`);
		try {
			const files = [".forgejo/workflows/a.yml"];
			writeFileSync(`${dir}/manifest.json`, JSON.stringify({ chunks: [{ index: 1, files }] }));
			writeFileSync(`${dir}/reply-1.json`, reply(FIX));
			writeFileSync(
				`${dir}/pr.diff`,
				"diff --git a/.forgejo/workflows/a.yml b/.forgejo/workflows/a.yml\n+x\n",
			);
			const { code, stderr } = await runCli({
				...VALID,
				CHUNK_DIR: dir,
				DIFF_FILE: `${dir}/pr.diff`,
			});
			expect(code).toBe(0);
			expect(stderr).toBe("render-second-pass: refute=true checklist=true\n");
			expect(JSON.parse(readFileSync(`${dir}/second-pass.json`, "utf8"))).toEqual({
				refute: true,
				checklist: true,
				trust_files: [".forgejo/workflows/a.yml"],
				refute_findings: 1,
			});
			const refute = JSON.parse(readFileSync(`${dir}/refute-request.json`, "utf8"));
			expect(refute.messages[0].content).toBe(REFUTER_PROMPT);
			expect(refute.messages[1].content).toContain("- P1 a.ts:1 bad");
			const checklist = JSON.parse(readFileSync(`${dir}/checklist-request.json`, "utf8"));
			expect(checklist.messages[0].content).toBe(CHECKLIST_PROMPT);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("approve reply and no trust file writes only the plan", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/sf939-second-pass-`);
		try {
			writeFileSync(
				`${dir}/manifest.json`,
				JSON.stringify({ chunks: [{ index: 1, files: ["src/a.ts"] }] }),
			);
			writeFileSync(`${dir}/reply-1.json`, reply(OK));
			writeFileSync(`${dir}/pr.diff`, "diff --git a/src/a.ts b/src/a.ts\n+x\n");
			const { code } = await runCli({ ...VALID, CHUNK_DIR: dir, DIFF_FILE: `${dir}/pr.diff` });
			expect(code).toBe(0);
			expect(JSON.parse(readFileSync(`${dir}/second-pass.json`, "utf8"))).toEqual({
				refute: false,
				checklist: false,
				trust_files: [],
			});
			expect(existsSync(`${dir}/refute-request.json`)).toBe(false);
			expect(existsSync(`${dir}/checklist-request.json`)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an invalid REPO exits 2 with one stderr line", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/sf939-second-pass-`);
		try {
			writeFileSync(
				`${dir}/manifest.json`,
				JSON.stringify({ chunks: [{ index: 1, files: ["src/a.ts"] }] }),
			);
			writeFileSync(`${dir}/reply-1.json`, reply(FIX));
			writeFileSync(`${dir}/pr.diff`, "diff --git a/src/a.ts b/src/a.ts\n+x\n");
			const { code, stderr } = await runCli({
				...VALID,
				REPO: "not a repo",
				CHUNK_DIR: dir,
				DIFF_FILE: `${dir}/pr.diff`,
			});
			expect(code).toBe(2);
			expect(stderr.trim().split("\n")).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sf#939 fix round 2: countBlockingFindings", () => {
	test("counts every line that names P0/P1 once each, bullet or prose, and ignores P2", () => {
		const a = "- **P1 — src/a.ts:1** bad\n- P0 -- src/b.ts:2 worse\nverdict: fix-first";
		const b =
			"* P1 c.ts:3 also\n- P2 d.ts:4 minor\nThis mentions P1 mid-line.\n- note: a P1 elsewhere\nverdict: fix-first";
		// sf#1992: the two prose lines block the review (ANY_BLOCKING_GRADE), so the refuter
		// owes them a line too; before, they blocked without being counted.
		expect(countBlockingFindings([a, b])).toBe(5);
		expect(countBlockingFindings([])).toBe(0);
	});

	test("CLI: second-pass.json carries refute_findings for two P1 lines", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/sf939-second-pass-`);
		try {
			writeFileSync(
				`${dir}/manifest.json`,
				JSON.stringify({ chunks: [{ index: 1, files: ["src/a.ts"] }] }),
			);
			writeFileSync(
				`${dir}/reply-1.json`,
				reply("- P1 a.ts:1 bad\n- P1 b.ts:2 bad\nverdict: fix-first"),
			);
			writeFileSync(`${dir}/pr.diff`, "diff --git a/src/a.ts b/src/a.ts\n+x\n");
			const { code } = await runCli({ ...VALID, CHUNK_DIR: dir, DIFF_FILE: `${dir}/pr.diff` });
			expect(code).toBe(0);
			const plan = JSON.parse(readFileSync(`${dir}/second-pass.json`, "utf8"));
			expect(plan.refute_findings).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sf#1992: the count is the severity rule's own blocking rule, line by line", () => {
	test("numbered, heading, quoted, bolded and off-start P0/P1 lines count; P2 does not", () => {
		const numbered =
			"1. **P1 — a.ts:1** bad\n2. **P2 — b.ts:2** minor\n3) P0 c.ts:3 worse\nverdict: fix-first";
		const offStart =
			"### P1 d.ts:4 bad\n> P1 quoted e.ts:5\n**Severity: P1** f.ts:6\nFinding 2 — P1 g.ts:7\nverdict: fix-first";
		expect(countBlockingFindings([numbered, offStart])).toBe(6);
	});

	test("a second P1 written off line-start must be refuted too: one REFUTED line no longer approves", () => {
		const review = "1. **P1 a.ts:1** bad\nFinding 2 — P1 b.ts:2 also bad\nverdict: fix-first";
		const need = countBlockingFindings([review]);
		expect(need).toBe(2);
		const plan = { refute: true, checklist: false, trust_files: [], refute_findings: need };
		expect(
			applySecondPass("fix-first", plan, "- REFUTED: a -- x\nverdict: approve", null).verdict,
		).toBe("fix-first");
		expect(
			applySecondPass(
				"fix-first",
				plan,
				"- REFUTED: a -- x\n- REFUTED: b -- y\nverdict: approve",
				null,
			).verdict,
		).toBe("approve");
	});

	test("a grade named in a fence or in prose inflates the count and can only fail closed", () => {
		const review = "1. **P1 a.ts:1** bad\n```\nP1 is the priority label\n```\nverdict: fix-first";
		expect(countBlockingFindings([review])).toBe(2);
		const plan = { refute: true, checklist: false, trust_files: [], refute_findings: 2 };
		expect(
			applySecondPass("fix-first", plan, "- REFUTED: a -- x\nverdict: approve", null).verdict,
		).toBe("fix-first");
	});

	test("run 9355's real review counts its one numbered P1, and its real refuter reply then approves", () => {
		const review = readFileSync(`${import.meta.dir}/fixtures/sf1992/run-9355-review.md`, "utf8");
		const refuter = readFileSync(`${import.meta.dir}/fixtures/sf1992/run-9355-refuter.md`, "utf8");
		expect(countBlockingFindings([review])).toBe(1);
		const plan = { refute: true, checklist: false, trust_files: [], refute_findings: 1 };
		expect(applySecondPass("fix-first", plan, refuter, null).verdict).toBe("approve");
		// One refutation short, or an upheld finding, still blocks.
		expect(
			applySecondPass("fix-first", { ...plan, refute_findings: 2 }, refuter, null).verdict,
		).toBe("fix-first");
		expect(
			applySecondPass("fix-first", plan, `- UPHELD: another -- stands\n${refuter}`, null).verdict,
		).toBe("fix-first");
	});
});
