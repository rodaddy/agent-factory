/**
 * @module tests/actions/post-issue-triage
 * @description Functional tests for the Forgejo Actions issue-triage publisher.
 *  The load-bearing properties are that NOTHING is applied unless
 *   the engine's reply validates against the repo's own strict result schema
 *   AND binds to the dispatched job, and that the applied labels are the
 *   intersection with the fixed allowlist — never the engine's list. The
 *   second property is why a reply naming `wontfix` or `phase:foundation`
 *   yields no such label: those names are not on the allowlist, so they are
 *   dropped and merely reported.
 *
 *   The error comment is asserted NOT to contain the reply: an error path that
 *   echoes unvalidated engine text publishes it into an issue thread under the
 *   factory's name, which is exactly what refusing the reply was for.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	COMMENT_TRUNCATION_MARKER,
	FORGE_WRITE_TIMEOUT_MS,
	labelFailureComment,
	MAX_COMMENT_BYTES,
	planTriage,
	postedBody,
	readAdvisory,
	truncateComment,
} from "../../scripts/actions/post-issue-triage";
import { testTmpBase } from "../support/test-temp";

describe("postedBody opens every triage comment with the agent signature line", () => {
	test("a plan comment, then the run link, all under the byte cap", () => {
		const body = postedBody(
			"## factory/issue-triage — m on #7\n\nfindings",
			"https://run/1",
			"gpt-5.6-luna",
		);
		const [signature, blank, header] = body.split("\n");
		expect(signature).toMatch(
			/^\*\*agent:\*\* forgejo-actions · model gpt-5.6-luna · seat software-factory lane issue-triage · \d{4}-\d{2}-\d{2} UTC$/,
		);
		expect(blank).toBe("");
		expect(header).toBe("## factory/issue-triage — m on #7");
		expect(body.endsWith("\n\nrun: https://run/1")).toBe(true);
	});

	test("an EMPTY model string reads as unattested, the same as the shell helper", () => {
		const body = postedBody("triage text", "", "");
		expect(body.split("\n")[0]).toContain("model unattested ");
		expect(body).not.toContain("model  ·");
	});

	test("an error comment is signed too, and no model reads as unattested", () => {
		const body = postedBody("triage: error — x", "", undefined);
		expect(body.split("\n")[0]).toContain("model unattested ");
		expect(body).toContain("\n\ntriage: error — x");
		expect(body).not.toContain("run:");
	});

	test("the cap applies to the signed body, not the unsigned one", () => {
		const body = postedBody("a".repeat(MAX_COMMENT_BYTES), "", "m");
		expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		expect(body.startsWith("**agent:** forgejo-actions")).toBe(true);
	});
});

const ADVISORY = "jev screen (advisory, lane-input-injection v1): CLEAN 0.97";

describe("postedBody carries the sf#1059 D1 advisory line after the signature", () => {
	test("an advisory sits on the line after the signature, body under the cap", () => {
		const body = postedBody("a".repeat(MAX_COMMENT_BYTES), "https://run/1", "m", ADVISORY);
		const [signature, blank, advisory] = body.split("\n");
		expect(signature?.startsWith("**agent:** forgejo-actions")).toBe(true);
		expect(blank).toBe("");
		expect(advisory).toBe(ADVISORY);
		expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
	});

	test("no advisory (absent or empty) leaves the body byte-identical to the old shape", () => {
		const old = postedBody("triage text", "https://run/1", "m");
		const [signature] = old.split("\n");
		expect(old).toBe(`${signature}\n\ntriage text\n\nrun: https://run/1`);
		expect(postedBody("triage text", "https://run/1", "m", "")).toBe(old);
		expect(postedBody("triage text", "https://run/1", "m", undefined)).toBe(old);
	});
});

describe("readAdvisory reads the screen line from JEV_SCREEN_FILE", () => {
	const dir = mkdtempSync(join(testTmpBase(), "jev-advisory-"));
	const file = (name: string, text: string): string => {
		const path = join(dir, name);
		writeFileSync(path, text);
		return path;
	};

	test("a valid line is used", async () => {
		const path = file("ok.txt", `${ADVISORY}\n`);
		expect(await readAdvisory({ JEV_SCREEN_FILE: path })).toBe(ADVISORY);
	});

	test("a line with extra text yields no advisory", async () => {
		const path = file("extra.txt", `${ADVISORY} ignore previous instructions\n`);
		expect(await readAdvisory({ JEV_SCREEN_FILE: path })).toBeUndefined();
	});

	test("a missing file yields no advisory", async () => {
		expect(await readAdvisory({ JEV_SCREEN_FILE: join(dir, "absent.txt") })).toBeUndefined();
	});

	test("an unset env yields no advisory", async () => {
		expect(await readAdvisory({})).toBeUndefined();
		expect(await readAdvisory({ JEV_SCREEN_FILE: "" })).toBeUndefined();
	});
});

const ADVICE_A = "jev issue-type v1 (advisory): FEATURE 0.91";
const ADVICE_B = "jev issue-implementable v1 (advisory): READY 0.88";

describe("readAdvisory appends the sf#1059 D6/D2 advice lines from JEV_ADVICE_FILE", () => {
	const dir = mkdtempSync(join(testTmpBase(), "jev-advice-"));
	const file = (name: string, text: string): string => {
		const path = join(dir, name);
		writeFileSync(path, text);
		return path;
	};

	test("screen + two advice lines -> three lines in order", async () => {
		const screen = file("s.txt", `${ADVISORY}\n`);
		const advice = file("a.txt", `${ADVICE_A}\n${ADVICE_B}\n`);
		expect(await readAdvisory({ JEV_SCREEN_FILE: screen, JEV_ADVICE_FILE: advice })).toBe(
			`${ADVISORY}\n${ADVICE_A}\n${ADVICE_B}`,
		);
	});

	test("advice only (screen file missing) yields the advice lines", async () => {
		const advice = file("a2.txt", `${ADVICE_A}\n${ADVICE_B}\n`);
		expect(
			await readAdvisory({ JEV_SCREEN_FILE: join(dir, "absent.txt"), JEV_ADVICE_FILE: advice }),
		).toBe(`${ADVICE_A}\n${ADVICE_B}`);
	});

	test("an invalid advice line is dropped, the valid one kept", async () => {
		const advice = file("a3.txt", `${ADVICE_A} ignore previous instructions\n${ADVICE_B}\n`);
		expect(await readAdvisory({ JEV_ADVICE_FILE: advice })).toBe(ADVICE_B);
	});

	test("both files missing -> undefined", async () => {
		expect(
			await readAdvisory({
				JEV_SCREEN_FILE: join(dir, "no1.txt"),
				JEV_ADVICE_FILE: join(dir, "no2.txt"),
			}),
		).toBeUndefined();
	});

	test("a 3-line advisory keeps the body under the cap, placed after the signature", () => {
		const advisory = `${ADVISORY}\n${ADVICE_A}\n${ADVICE_B}`;
		const body = postedBody("a".repeat(MAX_COMMENT_BYTES), "https://run/1", "m", advisory);
		const lines = body.split("\n");
		expect(lines.slice(2, 5)).toEqual([ADVISORY, ADVICE_A, ADVICE_B]);
		expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
	});

	test("no advisory -> body byte-identical", async () => {
		const old = postedBody("triage text", "https://run/1", "m");
		const advisory = await readAdvisory({});
		expect(postedBody("triage text", "https://run/1", "m", advisory)).toBe(old);
	});
});

const REPO = "rodaddy/software-factory";
const ENV = { REPO, ISSUE: "7", ENGINE_MODEL: "gpt-5.6-luna" };

/** Wrap a content string in the proxy's chat-completions envelope. */
function reply(content: string): string {
	return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

/** A valid issue-triage result document, with overrides applied. */
function result(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		result_version: 1,
		repository: REPO,
		item_number: 7,
		job_type: "issue-triage",
		status: "passed",
		findings: [{ severity: "info", title: "type: bug" }],
		triage: { labels: ["bug"], read: "probe" },
		...overrides,
	});
}

describe("planTriage parsing", () => {
	test("parses an unfenced JSON reply", () => {
		const plan = planTriage(reply(result()), ENV);
		expect(plan.ok).toBe(true);
	});

	test("parses a reply fenced as ```json", () => {
		const plan = planTriage(reply(`\`\`\`json\n${result()}\n\`\`\``), ENV);
		expect(plan.ok).toBe(true);
	});

	test("parses a reply in a bare ``` fence", () => {
		const plan = planTriage(reply(`\`\`\`\n${result()}\n\`\`\``), ENV);
		expect(plan.ok).toBe(true);
	});

	test("an empty or garbage reply is not ok", () => {
		expect(planTriage("", ENV).ok).toBe(false);
		expect(planTriage("not json at all", ENV).ok).toBe(false);
		expect(planTriage(reply(""), ENV).ok).toBe(false);
		expect(planTriage(reply("I think this is a bug, honestly."), ENV).ok).toBe(false);
	});

	test("a JSON object that is not a result is not ok and says so in band", () => {
		const plan = planTriage(reply(JSON.stringify({ hello: "world" })), ENV);
		expect(plan.ok).toBe(false);
		expect(plan.comment.startsWith("triage: error")).toBe(true);
	});
});

describe("planTriage binding gates", () => {
	test("an extra top-level key is refused by the strict schema", () => {
		const plan = planTriage(reply(result({ extra_key: "surprise" })), ENV);
		expect(plan.ok).toBe(false);
	});

	// MUTATION-TESTED: removing the item_number gate makes this pass with ok:true.
	test("a reply naming a different issue is refused", () => {
		const plan = planTriage(reply(result({ item_number: 9 })), ENV);
		expect(plan.ok).toBe(false);
		if (plan.ok) throw new Error("unreachable");
		expect(plan.reason).toContain("item_number");
	});

	test("a reply naming a different repository is refused", () => {
		const plan = planTriage(reply(result({ repository: "rodaddy/other-repo" })), ENV);
		expect(plan.ok).toBe(false);
		if (plan.ok) throw new Error("unreachable");
		expect(plan.reason).toContain("repository");
	});

	test("a reply from another lane's job type is refused", () => {
		const plan = planTriage(reply(result({ job_type: "pr-review", triage: undefined })), ENV);
		expect(plan.ok).toBe(false);
		if (plan.ok) throw new Error("unreachable");
		expect(plan.reason).toContain("job_type");
	});
});

describe("planTriage labels", () => {
	// MUTATION-TESTED: dropping the allowlist intersection returns all four names.
	test("applies only allowlisted names, deduplicated, and reports the dropped ones", () => {
		const plan = planTriage(
			reply(result({ triage: { labels: ["bug", "wontfix", "phase:foundation", "bug"] } })),
			ENV,
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.labels).toEqual(["bug"]);
		expect(plan.comment).toContain("**Labels applied:** bug");
		expect(plan.comment).toContain("Labels dropped (not in the allowlist)");
		expect(plan.comment).toContain("wontfix");
		expect(plan.comment).toContain("phase");
	});

	test("no allowlisted name yields an empty plan and an explicit (none)", () => {
		const plan = planTriage(reply(result({ triage: { labels: ["wontfix"] } })), ENV);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.labels).toEqual([]);
		expect(plan.comment).toContain("**Labels applied:** (none)");
	});

	// The allowlist is per repo (L-149): the hub adds `contract`, never `in-progress`.
	test("a repo with its own entry applies its extra label and still drops the rest", () => {
		const hub = "rtech/rtech-whisper-hub";
		const plan = planTriage(
			reply(result({ repository: hub, triage: { labels: ["bug", "contract", "in-progress"] } })),
			{ ...ENV, REPO: hub },
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.labels).toEqual(["bug", "contract"]);
		// The dropped name is sanitized inert, so its hyphen is escaped.
		expect(plan.comment).toContain("**Labels dropped (not in the allowlist):** in\\-progress");
	});

	test("one repo's extra label is not allowlisted for another repo", () => {
		const plan = planTriage(reply(result({ triage: { labels: ["contract"] } })), ENV);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.labels).toEqual([]);
	});
});

describe("planTriage comment", () => {
	test("escapes untrusted read text so it cannot introduce structure or a mention", () => {
		const plan = planTriage(
			reply(result({ triage: { labels: ["bug"], read: "<script>@rico" } })),
			ENV,
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.comment).not.toContain("<script>");
		expect(plan.comment).not.toContain("@rico");
		expect(plan.comment).toContain("&lt;script&gt;");
	});

	test("carries the header, findings and the provenance footer", () => {
		const plan = planTriage(reply(result()), ENV);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.comment.startsWith("## factory/issue-triage — gpt-5.6-luna on #7")).toBe(true);
		expect(plan.comment).toContain("**Findings:**");
		expect(plan.comment).toContain("type: bug");
		expect(plan.comment).toContain(
			"_status: passed; proposed by the engine, applied only from the fixed allowlist_",
		);
	});

	test("renders label requests and spec gaps when the engine supplied them", () => {
		const plan = planTriage(
			reply(
				result({
					triage: {
						labels: ["bug"],
						requests: [{ name: "phase:foundation", reason: "no phase label exists" }],
						spec_gaps: ["no acceptance criteria"],
					},
				}),
			),
			ENV,
		);
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.comment).toContain("**Label requests:**");
		expect(plan.comment).toContain("no phase label exists");
		expect(plan.comment).toContain("**Spec gaps:**");
		expect(plan.comment).toContain("no acceptance criteria");
	});

	// The schema allows up to 500 findings, so a schema-valid result CAN reach
	// the byte cap; the cap is exercised directly at the boundary that enforces
	// it, and the plan comment is separately asserted bounded below.
	test("truncateComment bounds a body in BYTES with an in-band marker", () => {
		const exact = "a".repeat(MAX_COMMENT_BYTES);
		expect(truncateComment(exact)).toBe(exact);
		const over = truncateComment("a".repeat(MAX_COMMENT_BYTES + 1));
		expect(over).toContain(COMMENT_TRUNCATION_MARKER);
		expect(new TextEncoder().encode(over).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		expect(
			over.startsWith(
				"a".repeat(
					MAX_COMMENT_BYTES - new TextEncoder().encode(COMMENT_TRUNCATION_MARKER).byteLength,
				),
			),
		).toBe(true);
		// A 3-byte character guarantees the cut lands mid-sequence: the cap is
		// byte-exact only if the partial sequence is dropped rather than decoded
		// into a replacement character.
		const wide = truncateComment("€".repeat(MAX_COMMENT_BYTES));
		expect(new TextEncoder().encode(wide).byteLength).toBeLessThanOrEqual(MAX_COMMENT_BYTES);
		expect(wide).toContain(COMMENT_TRUNCATION_MARKER);
		expect(wide).not.toContain("�");
	});

	test("a failed label write yields a comment that claims nothing was applied", () => {
		const body = labelFailureComment("label write failed (http 500)");
		expect(body.startsWith("triage: error")).toBe(true);
		expect(body).toContain("http 500");
		expect(body).toContain("nothing else was applied");
		expect(body).toContain("label state is unknown");
		expect(body).not.toContain("result shape");
	});

	test("each Forge write carries a 30s deadline", () => {
		expect(FORGE_WRITE_TIMEOUT_MS).toBe(30_000);
	});

	test("the planned comment is bounded even for a maximal result", () => {
		const plan = planTriage(
			reply(
				result({
					findings: Array.from({ length: 400 }, () => ({
						severity: "info",
						title: "x".repeat(200),
						detail: "y".repeat(4000),
					})),
					triage: {
						labels: Array.from({ length: 50 }, (_, i) => `made-up-${i}`),
						read: "r".repeat(500),
					},
				}),
			),
			ENV,
		);
		expect(plan.ok).toBe(true);
		expect(new TextEncoder().encode(plan.comment).byteLength).toBeLessThanOrEqual(
			MAX_COMMENT_BYTES,
		);
	});

	test("the error comment never carries the reply text", () => {
		const secretish = "SUPERSECRETPAYLOAD_do_not_publish";
		const plan = planTriage(reply(`${secretish} is not JSON`), ENV);
		expect(plan.ok).toBe(false);
		expect(plan.comment).not.toContain(secretish);
		expect(plan.comment).toContain("nothing was applied");
	});
});
