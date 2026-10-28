/**
 * @module tests/actions/post-pr-review
 * @description Functional tests for the Forgejo Actions pr-review publisher.
 *  The load-bearing property is that a reply with NO verdict line
 *   maps to the commit-status state `error` and never to `success` — a green
 *   required check for an outcome nobody could parse is exactly the failure a
 *   required check exists to prevent. The verdict regex is pinned as a WHOLE
 *   line and taken from the LAST match, so a reply that quotes its own
 *   instructions before answering is scored on the answer.
 *
 *   The comment cap is asserted in bytes, since the limit being respected is
 *   the forge API's.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applySeverityRule,
	buildChunkedReview,
	buildCommentBody,
	COMMENT_TRUNCATION_MARKER,
	describeStatus,
	describeVerdict,
	extractReply,
	MAX_COMMENT_BYTES,
	mergeVerdicts,
	parseVerdict,
	publishedState,
	readAdvisory,
	readChunkReplies,
	reviewStatusMode,
	STATUS_CONTEXT,
	skippedStatus,
	statusForVerdict,
	statusModeFromEnv,
	truncateComment,
} from "../../scripts/actions/post-pr-review";
import { configSchema } from "../../src/config/schema";
import { testTmpBase } from "../support/test-temp";

// Review F4 on PR #473: the comment is the review; a status that says
// `success` while the findings never landed certifies nothing.
describe("publishedState", () => {
	test("follows the verdict when the comment posted", () => {
		expect(publishedState("approve", true)).toBe("success");
		expect(publishedState("fix-first", true)).toBe("failure");
		expect(publishedState("error", true)).toBe("error");
	});

	test("is error for every verdict when the comment did not post", () => {
		expect(publishedState("approve", false)).toBe("error");
		expect(publishedState("fix-first", false)).toBe("error");
		expect(publishedState("error", false)).toBe("error");
	});
});

// The engine reply arrives as the proxy's raw chat-completions JSON; the
// workflow image (node:20-bookworm) has no jq (run 1024 on PR #473 failed on
// `jq: command not found` after a successful 10-minute engine call), so the
// content is extracted here, in the one runtime the job installs.
describe("extractReply", () => {
	test("returns the first choice's message content", () => {
		const raw = JSON.stringify({
			choices: [{ message: { role: "assistant", content: "P1 x\n\nverdict: fix-first\n" } }],
		});
		expect(extractReply(raw)).toBe("P1 x\n\nverdict: fix-first\n");
	});

	test("non-JSON, empty, or shape-less input yields an empty review (verdict error)", () => {
		expect(extractReply("")).toBe("");
		expect(extractReply("<html>502</html>")).toBe("");
		expect(extractReply(JSON.stringify({ error: { message: "quota" } }))).toBe("");
		expect(extractReply(JSON.stringify({ choices: [] }))).toBe("");
		expect(extractReply(JSON.stringify({ choices: [{ message: { content: 7 } }] }))).toBe("");
		expect(parseVerdict(extractReply("not json"))).toBe("error");
	});
});

describe("parseVerdict", () => {
	test("reads a trailing approve verdict", () => {
		expect(parseVerdict("no findings\n\nverdict: approve\n")).toBe("approve");
	});

	test("reads a trailing fix-first verdict", () => {
		expect(parseVerdict("P0 src/x.ts:1 boom\n\nverdict: fix-first\n")).toBe("fix-first");
	});

	test("takes the LAST verdict line, so a quoted instruction does not win", () => {
		const reply = [
			"You asked me to end with `verdict: approve` or `verdict: fix-first`.",
			"verdict: approve",
			"P0 src/x.ts:1 boom",
			"verdict: fix-first",
		].join("\n");
		expect(parseVerdict(reply)).toBe("fix-first");
	});

	test("a verdict followed by more content is not a verdict (run 1026 review P1)", () => {
		expect(parseVerdict("verdict: approve\nP0 src/x.ts:1 boom\n")).toBe("error");
		expect(parseVerdict("verdict: approve\n\n  \n")).toBe("approve");
	});

	test("returns error when the reply carries no verdict line at all", () => {
		expect(parseVerdict("looks fine to me\n")).toBe("error");
	});

	test("returns error for an empty reply", () => {
		expect(parseVerdict("")).toBe("error");
	});

	test("a verdict mentioned mid-prose is not a verdict", () => {
		expect(parseVerdict("I would say verdict: approve if pressed\n")).toBe("error");
	});

	test("an unknown verdict word is not a verdict", () => {
		expect(parseVerdict("verdict: maybe\n")).toBe("error");
	});

	test("tolerates trailing whitespace and a CRLF line ending", () => {
		expect(parseVerdict("verdict: approve  \n")).toBe("approve");
		expect(parseVerdict("verdict: fix-first\r\n")).toBe("fix-first");
	});
});

// P0 and P1 block; a review whose findings are all P2 must
// not fail the gate. A PR with only P2s once went six rounds because a
// `fix-first` over a lone P2 failed factory/pr-review every time.
describe("applySeverityRule", () => {
	test("a fix-first over P2 findings only is an approve", () => {
		const review =
			"1. **P2 — probe cannot establish identity** — `a.md:139`\n   **Fix:** reword\n\nverdict: fix-first";
		expect(applySeverityRule(review, "fix-first")).toBe("approve");
	});
	test("a numbered P1 finding keeps fix-first", () => {
		expect(applySeverityRule("1. **P1 — wrong** — `a.ts:1`\nverdict: fix-first", "fix-first")).toBe(
			"fix-first",
		);
	});
	test("a bulleted or bare P0 finding keeps fix-first", () => {
		expect(applySeverityRule("- P0 src/x.ts:1 boom\nverdict: fix-first", "fix-first")).toBe(
			"fix-first",
		);
		expect(applySeverityRule("P0 src/x.ts:1 boom\n\nverdict: fix-first", "fix-first")).toBe(
			"fix-first",
		);
	});
	test("bracketed, bold-bracketed, heading and parenthesised P0/P1 findings keep fix-first", () => {
		for (const line of [
			"- [P1] a.ts:1 bad",
			"1. **[P1]** a.ts:1 bad",
			"### P0 a.ts:1 bad",
			"* (P1) a.ts:1 bad",
			"2) **P1** a.ts:1",
		]) {
			expect(applySeverityRule(`${line}\nverdict: fix-first`, "fix-first")).toBe("fix-first");
		}
	});
	test("an inline-code P1 finding keeps fix-first", () => {
		expect(
			applySeverityRule("- `P1` a.ts:1 bad\n- `P2` b.ts:2 nit\nverdict: fix-first", "fix-first"),
		).toBe("fix-first");
	});
	test("a fix-first with no parsable graded finding stays fix-first (inconclusive is not approval)", () => {
		expect(
			applySeverityRule("The handler drops errors. Please fix.\nverdict: fix-first", "fix-first"),
		).toBe("fix-first");
		expect(applySeverityRule("Severity: P1 in a.ts\nverdict: fix-first", "fix-first")).toBe(
			"fix-first",
		);
	});
	test("a bold severity label (**Severity:** P1) keeps fix-first", () => {
		const review = "- P2 b.ts:1 nit\n**Severity:** P1 in a.ts\nverdict: fix-first";
		expect(applySeverityRule(review, "fix-first")).toBe("fix-first");
	});
	test("any P0 or P1 anywhere keeps fix-first (fail-safe; reviewers are told not to write them when there are none)", () => {
		const review =
			"No P0/P1 findings. This mentions P1 mid-line.\n- P2 d.ts:4 minor\nverdict: fix-first";
		expect(applySeverityRule(review, "fix-first")).toBe("fix-first");
		expect(
			applySeverityRule(
				"Issue (blocking, P1): a.ts\n- P2 b.ts nit\nverdict: fix-first",
				"fix-first",
			),
		).toBe("fix-first");
	});
	test("approve and error pass through unchanged", () => {
		expect(applySeverityRule("- P1 a.ts:1 bad", "approve")).toBe("approve");
		expect(applySeverityRule("- P2 a.ts:1", "error")).toBe("error");
	});
});

describe("statusForVerdict", () => {
	test("maps each verdict to its forge state", () => {
		expect(statusForVerdict("approve")).toBe("success");
		expect(statusForVerdict("fix-first")).toBe("failure");
		expect(statusForVerdict("error")).toBe("error");
	});

	test("an unparseable review is never reported as success", () => {
		expect(statusForVerdict(parseVerdict("no verdict here"))).not.toBe("success");
	});
});

describe("describeVerdict", () => {
	test.each(["approve", "fix-first", "error"] as const)(
		"stays within the 100-character forge bound for %s",
		(verdict) => {
			expect(describeVerdict(verdict).length).toBeLessThanOrEqual(100);
			expect(describeVerdict(verdict).length).toBeGreaterThan(0);
		},
	);
});

describe("truncateComment", () => {
	test("a limit smaller than the marker cuts to the limit and omits the marker", () => {
		const marker = new TextEncoder().encode(COMMENT_TRUNCATION_MARKER).byteLength;
		for (const limit of [0, 1, marker - 1, marker]) {
			const out = truncateComment("z".repeat(200), limit);
			expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(limit);
		}
	});

	test("a prefix that leaves no room for the marker still keeps the signed body under the cap", () => {
		// A pathological model literal: the prefix alone is near the ceiling.
		const body = buildCommentBody("z".repeat(500), "m".repeat(MAX_COMMENT_BYTES - 20), "abc1234");
		expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		const over = buildCommentBody("z", "m".repeat(MAX_COMMENT_BYTES + 5), "abc1234");
		expect(new TextEncoder().encode(over).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
	});

	test("passes a body at the cap through untouched", () => {
		const exact = "a".repeat(MAX_COMMENT_BYTES);
		expect(truncateComment(exact)).toBe(exact);
	});

	test("truncates one byte over the cap and states it in band", () => {
		const over = "a".repeat(MAX_COMMENT_BYTES + 1);
		const capped = truncateComment(over);
		expect(capped).toContain(COMMENT_TRUNCATION_MARKER);
		// The ceiling is on the WHOLE string Forge receives, marker included:
		// the cut lands below the cap by the marker's length.
		expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		expect(capped.startsWith("aaaa")).toBe(true);
	});

	test("bounds a body far over the cap in BYTES, not characters", () => {
		const wide = "é".repeat(MAX_COMMENT_BYTES);
		const capped = truncateComment(wide);
		expect(new TextEncoder().encode(capped).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
	});
});

describe("buildCommentBody", () => {
	test("opens with the agent signature line, then the provenance header", () => {
		const body = buildCommentBody("findings\n", "gpt-5.6-luna", "abc1234");
		const [signature, blank, header] = body.split("\n");
		expect(signature).toMatch(
			/^\*\*agent:\*\* forgejo-actions · model gpt-5.6-luna · seat software-factory lane pr-review · \d{4}-\d{2}-\d{2} UTC$/,
		);
		expect(blank).toBe("");
		expect(header).toBe(`## ${STATUS_CONTEXT} — gpt-5.6-luna on abc1234`);
		expect(body).toContain("findings");
	});

	test("the body carries the run URL, so two runs on the same SHA, model and output differ", () => {
		const a = buildCommentBody(
			"findings\n",
			"gpt-5.6-luna",
			"abc1234",
			"https://git.example/r/actions/runs/1",
		);
		const b = buildCommentBody(
			"findings\n",
			"gpt-5.6-luna",
			"abc1234",
			"https://git.example/r/actions/runs/2",
		);
		expect(a).not.toBe(b);
		expect(a.split("\n")[4]).toBe("run: https://git.example/r/actions/runs/1");
		// No run URL (local invocation): no run line, the header is followed by the review.
		expect(buildCommentBody("findings\n", "gpt-5.6-luna", "abc1234").split("\n")[4]).toBe(
			"findings",
		);
	});

	test("the posted body is bounded even when the review is not", () => {
		const body = buildCommentBody("z".repeat(MAX_COMMENT_BYTES * 2), "m", "abc1234");
		// Signature line and provenance header count against the SAME ceiling as
		// the review: the posted body never exceeds it.
		expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		expect(body).toContain(COMMENT_TRUNCATION_MARKER);
		expect(body.startsWith("**agent:** forgejo-actions")).toBe(true);
		expect(body).toContain(COMMENT_TRUNCATION_MARKER);
	});
});

// sf#476: the attempt count exists only inside the job, and the commit status
// is the only durable API-queryable thing the job writes besides the comment,
// so the description is the carrier. A count nobody measured must not be
// asserted, which is why every non-positive-integer input yields the bare
// verdict rather than a suffix.
describe("describeStatus", () => {
	test("appends the attempt count when one was measured", () => {
		expect(describeStatus("approve", "1")).toBe("pr-review: no blocking findings (attempts=1)");
		expect(describeStatus("fix-first", "3")).toBe(
			"pr-review: blocking findings, fix first (attempts=3)",
		);
	});

	test("is the bare verdict when the count is absent or empty", () => {
		expect(describeStatus("approve", undefined)).toBe(describeVerdict("approve"));
		expect(describeStatus("approve", "")).toBe(describeVerdict("approve"));
		expect(describeStatus("approve", "   ")).toBe(describeVerdict("approve"));
	});

	test("is the bare verdict for anything that is not a positive integer", () => {
		for (const bad of ["abc", "0", "-1", "2.5", "NaN", "1e3x"]) {
			expect(describeStatus("fix-first", bad)).toBe(describeVerdict("fix-first"));
		}
	});

	// The cap is re-applied AFTER concatenation, and the ORDER is the property
	// worth pinning: every real verdict string is well under 100 characters, so a
	// length assertion alone passes with the cap deleted entirely (mutation-proved
	// 2026-08-31 — it stayed green). What a wrong order would actually do is cut
	// the suffix off a base already at the limit, so that is what is asserted.
	test("appends the suffix, then caps — never caps the base first", () => {
		const longest = ["approve", "fix-first", "error"].reduce(
			(worst, verdict) => Math.max(worst, describeStatus(verdict as never, "999").length),
			0,
		);
		expect(longest).toBeLessThanOrEqual(100);
		// The suffix is present on the longest description rather than sliced away,
		// which a base-first cap at any smaller bound would have removed.
		expect(describeStatus("error", "999")).toBe(`${describeVerdict("error")} (attempts=999)`);
		expect(describeStatus("error", "999").endsWith("(attempts=999)")).toBe(true);
	});
});

describe("sf#697: skippedStatus", () => {
	test("a lane that could not run is a warning, distinct from fix-first and error", () => {
		const status = skippedStatus("pr-review skipped: diff too large (9 lines)", "http://run");
		expect(status).toEqual({
			state: "warning",
			context: STATUS_CONTEXT,
			description: "pr-review skipped: diff too large (9 lines)",
			target_url: "http://run",
		});
		expect(status.state).not.toBe(statusForVerdict("fix-first"));
		expect(status.state).not.toBe(statusForVerdict("error"));
	});

	test("the description is bounded to 100 characters", () => {
		expect(skippedStatus("x".repeat(300), "").description).toHaveLength(100);
	});
});

// sf#988: advisory mode publishes success on every terminal state.
describe("sf#988: advisory status mode", () => {
	const config = configSchema.parse({
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/adv", provider: "forgejo", pr_review_status: "advisory" },
			{ name: "rodaddy/enf", provider: "forgejo" },
		],
	});

	test("a fix-first reply ends success on an advisory repo, failure on an enforcing one", () => {
		expect(publishedState("fix-first", true, "advisory")).toBe("success");
		expect(publishedState("fix-first", true, "enforcing")).toBe("failure");
		expect(publishedState("fix-first", true, reviewStatusMode(config, "rodaddy/adv"))).toBe(
			"success",
		);
		expect(publishedState("fix-first", true, reviewStatusMode(config, "rodaddy/enf"))).toBe(
			"failure",
		);
		expect(reviewStatusMode(config, "rodaddy/unknown")).toBe("enforcing");
	});

	test("advisory descriptions for all three verdicts", () => {
		expect(describeStatus("approve", undefined, "advisory")).toBe(
			"pr-review advisory: no blocking findings",
		);
		expect(describeStatus("fix-first", undefined, "advisory")).toBe(
			"pr-review advisory: blocking findings in the comment",
		);
		expect(describeStatus("error", "2", "advisory")).toBe(
			"pr-review advisory: the reviewer returned no verdict line (attempts=2)",
		);
		expect(describeStatus("fix-first", undefined)).toBe("pr-review: blocking findings, fix first");
	});

	test("comment-not-posted is success in advisory, error in enforcing", () => {
		expect(publishedState("approve", false, "advisory")).toBe("success");
		expect(publishedState("approve", false, "enforcing")).toBe("error");
	});

	test("skippedStatus advisory is success with the prefixed description", () => {
		expect(skippedStatus("pr-review skipped: diff too large", "http://run", "advisory")).toEqual({
			state: "success",
			context: STATUS_CONTEXT,
			description: "pr-review advisory: pr-review skipped: diff too large",
			target_url: "http://run",
		});
		expect(skippedStatus("x".repeat(300), "", "advisory").description).toHaveLength(100);
		expect(skippedStatus("s", "").state).toBe("warning");
	});

	test("statusModeFromEnv maps exactly advisory only", () => {
		expect(statusModeFromEnv("advisory")).toBe("advisory");
		expect(statusModeFromEnv("Advisory")).toBe("enforcing");
		expect(statusModeFromEnv("")).toBe("enforcing");
		expect(statusModeFromEnv(undefined)).toBe("enforcing");
	});

	test("the mode CLI prints the repo's mode from config/repos.yml", () => {
		const dir = mkdtempSync(join(testTmpBase(), "post-pr-review-mode-"));
		try {
			mkdirSync(join(dir, "config"));
			writeFileSync(
				join(dir, "config", "repos.yml"),
				[
					"poll_interval_minutes: 15",
					"repositories:",
					"  - name: rodaddy/adv",
					"    provider: forgejo",
					"    pr_review_status: advisory",
					"  - name: rodaddy/enf",
					"    provider: forgejo",
					"",
				].join("\n"),
			);
			const cli = join(import.meta.dir, "../../scripts/actions/post-pr-review.ts");
			// LOG_LEVEL pinned so traced() debug lines never reach the asserted stderr.
			const opts = { cwd: dir, env: { ...process.env, LOG_LEVEL: "info" } };
			const adv = Bun.spawnSync(["bun", cli, "mode", "rodaddy/adv"], opts);
			expect(adv.stderr.toString()).toBe("");
			expect(adv.exitCode).toBe(0);
			expect(adv.stdout.toString()).toBe("advisory\n");
			const enf = Bun.spawnSync(["bun", cli, "mode", "rodaddy/enf"], opts);
			expect(enf.exitCode).toBe(0);
			expect(enf.stdout.toString()).toBe("enforcing\n");
			expect(Bun.spawnSync(["bun", cli, "mode"], opts).exitCode).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// sf#979: a chunked review merges into one verdict and one comment.
describe("mergeVerdicts", () => {
	test("empty is error", () => expect(mergeVerdicts([])).toBe("error"));
	test("all approve is approve", () =>
		expect(mergeVerdicts(["approve", "approve"])).toBe("approve"));
	test("any fix-first beats approve", () =>
		expect(mergeVerdicts(["approve", "fix-first"])).toBe("fix-first"));
	test("any error beats fix-first", () =>
		expect(mergeVerdicts(["fix-first", "error"])).toBe("error"));
	test("a merged fix-first publishes per mode", () => {
		const v = mergeVerdicts(["approve", "fix-first"]);
		expect(publishedState(v, true, "advisory")).toBe("success");
		expect(publishedState(v, true, "enforcing")).toBe("failure");
	});
});

describe("buildChunkedReview", () => {
	test("one part is its review, byte for byte", () => {
		const review = "finding\n\nverdict: approve\n";
		expect(buildChunkedReview([{ index: 1, files: ["a.ts"], review }])).toBe(review);
	});
	test("two parts carry headers, file lists and the separator", () => {
		const out = buildChunkedReview([
			{ index: 1, files: ["a.ts", "b.ts"], review: "r1" },
			{ index: 2, files: ["c.ts"], review: "r2" },
		]);
		expect(out).toBe("### Chunk 1 of 2: a.ts, b.ts\n\nr1\n\n---\n\n### Chunk 2 of 2: c.ts\n\nr2");
	});
	test("an empty review shows the no-reply text", () => {
		const out = buildChunkedReview([
			{ index: 1, files: ["a.ts"], review: "r1" },
			{ index: 2, files: ["c.ts"], review: "" },
		]);
		expect(out).toContain("### Chunk 2 of 2: c.ts\n\n(no reply from the engine)");
	});
});

describe("readChunkReplies", () => {
	test("a missing reply reads as empty and merges to error", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/chunk-replies-`);
		try {
			writeFileSync(
				join(dir, "manifest.json"),
				JSON.stringify({
					chunks: [
						{ index: 2, files: ["b.ts"], lines: 3, bytes: 30 },
						{ index: 1, files: ["a.ts"], lines: 12, bytes: 345 },
					],
				}),
			);
			writeFileSync(
				join(dir, "reply-1.json"),
				JSON.stringify({ choices: [{ message: { content: "ok\n\nverdict: approve" } }] }),
			);
			const parts = await readChunkReplies(dir);
			expect(parts.map((p) => p.index)).toEqual([1, 2]);
			expect(parts[0]?.review).toBe("ok\n\nverdict: approve");
			expect(parts[1]?.review).toBe("");
			expect(mergeVerdicts(parts.map((p) => parseVerdict(p.review)))).toBe("error");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("a missing manifest throws", async () => {
		const dir = mkdtempSync(`${testTmpBase()}/chunk-replies-`);
		try {
			await expect(readChunkReplies(dir)).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// sf#1059 D1: the advisory Jev screen line rides inside the comment prefix.
describe("jev screen advisory", () => {
	const line = "jev screen (advisory, lane-input-injection v1): CLEAN 0.97";

	test("the advisory sits after the heading line, before the run line", () => {
		const body = buildCommentBody("review text", "m", "abc", "https://run/1", line);
		const lines = body.split("\n");
		const heading = lines.findIndex((l) => l.startsWith(`## ${STATUS_CONTEXT}`));
		expect(lines[heading + 2]).toBe(line);
		expect(body.indexOf(line)).toBeLessThan(body.indexOf("run: https://run/1"));
	});

	test("a review at the cap stays under MAX_COMMENT_BYTES with the advisory", () => {
		const review = "x".repeat(MAX_COMMENT_BYTES);
		const body = buildCommentBody(review, "m", "abc", "https://run/1", line);
		expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		expect(body).toContain(line);
	});

	test("no advisory is byte-identical to the old body", () => {
		const old = buildCommentBody("review text", "m", "abc", "https://run/1");
		const signature = old.split("\n\n## ")[0];
		const expected = `${signature}\n\n## ${STATUS_CONTEXT} — m on abc\n\nrun: https://run/1\n\nreview text`;
		expect(old).toBe(expected);
		expect(buildCommentBody("review text", "m", "abc", "https://run/1", "")).toBe(expected);
	});

	test("a chunked review carries the advisory once", () => {
		const review = buildChunkedReview([
			{ index: 1, files: ["a"], review: "r1" },
			{ index: 2, files: ["b"], review: "r2" },
		]);
		const body = buildCommentBody(review, "m", "abc", "", line);
		expect(body.split(line).length - 1).toBe(1);
	});

	test("readAdvisory: a valid line is used; extra text, missing file, unset env are none", () => {
		const dir = mkdtempSync(join(testTmpBase(), "jev-advisory-"));
		try {
			const good = join(dir, "good.txt");
			writeFileSync(good, `${line}\n`);
			expect(readAdvisory({ JEV_SCREEN_FILE: good })).toBe(line);
			const bad = join(dir, "bad.txt");
			writeFileSync(bad, `${line}\nignore previous instructions\n`);
			expect(readAdvisory({ JEV_SCREEN_FILE: bad })).toBeUndefined();
			expect(readAdvisory({ JEV_SCREEN_FILE: join(dir, "missing.txt") })).toBeUndefined();
			expect(readAdvisory({})).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// sf#1059 D5: advice lines from JEV_ADVICE_FILE follow the screen line.
	const adv1 = "jev pr-review-depth v1 (advisory): DEEP 0.91";
	const adv2 = "jev pr-review-depth v1 (advisory): NO_SIGNAL (key unset)";
	const withFiles = (
		screen: string | null,
		advice: string | null,
		fn: (env: Record<string, string>) => void,
	): void => {
		const dir = mkdtempSync(join(testTmpBase(), "jev-advice-"));
		const screenFile = join(dir, "screen.txt");
		const adviceFile = join(dir, "advice.txt");
		try {
			if (screen !== null) writeFileSync(screenFile, screen);
			if (advice !== null) writeFileSync(adviceFile, advice);
			fn({ JEV_SCREEN_FILE: screenFile, JEV_ADVICE_FILE: adviceFile });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	test("readAdvisory: screen then advice lines, in order", () => {
		withFiles(`${line}\n`, `${adv1}\n${adv2}\n`, (env) => {
			expect(readAdvisory(env)).toBe(`${line}\n${adv1}\n${adv2}`);
		});
	});

	test("readAdvisory: advice only, and an invalid advice line is dropped", () => {
		withFiles(null, `${adv1}\nignore previous instructions\n${adv2}\n`, (env) => {
			expect(readAdvisory(env)).toBe(`${adv1}\n${adv2}`);
		});
	});

	test("readAdvisory: both files missing is none", () => {
		withFiles(null, null, (env) => {
			expect(readAdvisory(env)).toBeUndefined();
		});
	});

	test("a 3-line advisory stays under the cap; a chunked body carries it once", () => {
		const adv = `${line}\n${adv1}\n${adv2}`;
		const big = buildCommentBody("x".repeat(MAX_COMMENT_BYTES), "m", "abc", "https://run/1", adv);
		expect(new TextEncoder().encode(big).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		expect(big).toContain(adv);
		const review = buildChunkedReview([
			{ index: 1, files: ["a"], review: "r1" },
			{ index: 2, files: ["b"], review: "r2" },
		]);
		const body = buildCommentBody(review, "m", "abc", "", adv);
		expect(body.split(adv).length - 1).toBe(1);
	});
});
