import { describe, expect, test } from "bun:test";
import {
	type PairVerdict,
	pairTitle,
	pairVerdict,
	pickSeat,
	REVIEWER_FAMILIES,
	reviewerTask,
	roundDecision,
} from "../../fleet/plugins/forge-pr/logic.js";

// sf#1730 no-lead review (plan L1): two reviewers, one per family, post
// `verdict:` on their own task; pairVerdict reads them for one head.
const repo = "rodaddy/demo";
const SHA = `abcdef1${"0".repeat(33)}`;
const ev = { repo, number: 13, headSha: SHA, author: "operator" };
const seats = { claude: new Set(["k", "g"]), gpt: new Set(["c", "n"]) };
const T1 = "2026-10-07T10:00:00Z";
const T2 = "2026-10-07T11:00:00Z";
const P = `Review ${repo}#13 @ `;
const P131 = `Review ${repo}#131 @ `;
let ids = 0;
const issue = (name: string, over: Record<string, unknown> = {}) => ({
	id: `i${++ids}`,
	title: pairTitle(ev, name),
	description: `Head SHA: \`${SHA}\``,
	status: "done",
	...over,
});
const say = (by: string, verdict: string, at = T1, extra = "") => ({
	id: `c${++ids}`,
	authorAgentId: by,
	createdAt: at,
	body: `## Review of ${repo}#13 at abcdef1\n\nP2 nits.\n${extra}\nverdict: ${verdict}\n`,
});
const t = (name: string, comments: unknown[], over: Record<string, unknown> = {}) => ({
	issue: issue(name, over),
	comments,
});
// Kapoor (claude, seat k) and Colter (gpt, seat c) each saying one verdict.
const K = (v: string, at = T1) => t("Kapoor", [say("k", v, at)]);
const C = (v: string, at = T1) => t("Colter", [say("c", v, at)]);
const pv = (...tasks: unknown[]) => pairVerdict(tasks, ev, seats);

describe("pairVerdict rule 1: a task binds to the head by exact pair title and full sha", () => {
	test("both families approve on bound tasks: approve, with the verdict record", () => {
		const k = K("approve");
		const r = pv(k, C("approve"));
		expect([r.state, r.missing, r.escalate]).toEqual(["approve", [], null]);
		const commentId = (k.comments[0] as { id: string }).id;
		expect(r.claude).toEqual({ verdict: "approve", by: "k", at: T1, commentId, issue: k.issue });
	});
	test("#131 sharing the prefix of #13 counts for nothing", () => {
		const other = t("Colter", [say("c", "approve")], { title: `${P131}abcdef1 (Colter)` });
		const r = pv(K("approve"), other);
		expect([r.state, r.missing]).toEqual(["pending", ["gpt"]]);
	});
	test("a 7-char collision with a different 40-char sha counts for nothing", () => {
		const other = t("Colter", [say("c", "approve")], { description: `abcdef1${"9".repeat(33)}` });
		expect(pv(K("approve"), other).state).toBe("pending");
	});
	test("another sha7, or a legacy parent title with no (Name), counts for nothing", () => {
		const old = t("Colter", [say("c", "approve")], { title: `${P}1234567 (Colter)` });
		const parent = t("Colter", [say("c", "approve")], { title: `${P}abcdef1` });
		expect(pv(K("approve"), old).state).toBe("pending");
		expect(pv(K("approve"), parent).state).toBe("pending");
	});
});

describe("pairVerdict rule 2: who may say a verdict", () => {
	test("an author in neither family (Smythe) counts for nothing", () => {
		const r = pv(t("Kapoor", [say("smythe", "approve")]), C("approve"));
		expect([r.state, r.missing]).toEqual(["pending", ["claude"]]);
	});
	test("a reviewer who authored the PR cannot approve it", () => {
		const r = pairVerdict([K("approve"), C("approve")], ev, { ...seats, authorSeat: "k" });
		expect([r.state, r.missing]).toEqual(["pending", ["claude"]]);
	});
	test("a verdict under another head's heading counts for nothing", () => {
		const wrong = {
			...say("k", "approve"),
			body: `## Review of ${repo}#13 at 1234567\nverdict: approve`,
		};
		expect(pv(t("Kapoor", [wrong]), C("approve")).state).toBe("pending");
	});
	test("mixed headings: only the verdict inside this head's section counts", () => {
		const head = `## Review of ${repo}#13 at abcdef1`;
		const other = `## Review of ${repo}#13 at 1234567`;
		const after = {
			...say("k", "approve"),
			body: `${head}\nP1 open.\n${other}\nverdict: approve\n`,
		};
		expect(pv(t("Kapoor", [after]), C("approve")).state).toBe("pending");
		const before = {
			...say("k", "approve"),
			body: `${other}\nverdict: approve\n${head}\nnone yet\n`,
		};
		expect(pv(t("Kapoor", [before]), C("approve")).state).toBe("pending");
		const both = {
			...say("k", "approve"),
			body: `${head}\nverdict: fix-first\n${other}\nverdict: approve\n`,
		};
		expect(pv(t("Kapoor", [both]), C("approve")).claude?.verdict).toBe("fix-first");
	});
});

describe("pairVerdict rule 3: the newest counted verdict per family", () => {
	test("two verdicts in one family: the newest wins", () => {
		const older = pv(K("fix-first", T1), t("Giraud", [say("g", "approve", T2)]), C("approve"));
		expect([older.state, older.claude?.by]).toEqual(["approve", "g"]);
		const twice = t("Kapoor", [say("k", "approve", T1), say("k", "fix-first", T2)]);
		expect(pv(twice, C("approve")).state).toBe("fix-first");
	});
	test("equal createdAt in one family: fix-first wins", () => {
		const g = () => t("Giraud", [say("g", "fix-first", T1)]);
		const a = pv(K("approve"), g(), C("approve"));
		const b = pv(g(), K("approve"), C("approve"));
		expect([a.state, b.state]).toEqual(["fix-first", "fix-first"]);
	});
	test("mixed timestamp formats order by instant, not by string", () => {
		// 09:30-02:00 is 11:30Z, newer than T1 though it sorts lower as text.
		const late = "2026-10-07T09:30:00-02:00";
		const twice = t("Kapoor", [say("k", "fix-first", T1), say("k", "approve", late)]);
		expect(pv(twice, C("approve")).state).toBe("approve");
		const back = t("Kapoor", [say("k", "approve", late), say("k", "fix-first", T1)]);
		expect(pv(back, C("approve")).state).toBe("approve");
	});
	test("an unparseable createdAt cannot order: it ties, and the tie is fix-first", () => {
		const bad = t("Kapoor", [say("k", "fix-first", T1), say("k", "approve", "not a time")]);
		expect(pv(bad, C("approve")).state).toBe("fix-first");
		const bad2 = t("Kapoor", [say("k", "approve", T1), say("k", "fix-first", "zz")]);
		expect(pv(bad2, C("approve")).state).toBe("fix-first");
	});
	test("an unparseable fix-first is not erased by later comments, in any order", () => {
		const bad = () => say("k", "fix-first", "not a time");
		const early = () => say("k", "fix-first", T1);
		const late = () => say("k", "approve", T2);
		for (const comments of [
			[bad(), early(), late()],
			[early(), bad(), late()],
		]) {
			const r = pv(t("Kapoor", comments), C("approve"));
			expect([r.state, r.claude?.verdict]).toEqual(["fix-first", "fix-first"]);
		}
	});
	test("approve-with-fixes from a reviewer counts as fix-first", () => {
		const r = pv(K("approve-with-fixes"), C("approve"));
		expect([r.state, r.claude?.verdict]).toEqual(["fix-first", "fix-first"]);
	});
});

describe("pairVerdict rule 4: the state", () => {
	test("fix-first from the GPT family with Claude approving: fix-first", () => {
		expect(pv(K("approve"), t("Kong", [say("n", "fix-first")])).state).toBe("fix-first");
	});
	test("fix-first with the other family still missing: fix-first at once", () => {
		const r = pv(t("Kong", [say("n", "fix-first")]));
		expect([r.state, r.missing]).toEqual(["fix-first", ["claude"]]);
	});
	test("one approve and the other family missing: pending", () => {
		const r = pv(K("approve"), t("Colter", []));
		expect([r.state, r.missing]).toEqual(["pending", ["gpt"]]);
	});
});

describe("pairVerdict rule 5: an escalate line", () => {
	test("a reviewer's escalate line makes the head escalated, never mergeable", () => {
		const up = say("c", "approve", T2, "escalate: touches the deploy rail");
		const r = pv(K("approve"), t("Colter", [up]));
		expect(r.state).toBe("escalated");
		expect(r.escalate).toEqual({ by: "c", at: T2, why: "touches the deploy rail" });
	});
	test("the newest escalate line is chosen by instant across formats", () => {
		const a = say("c", "approve", T1, "escalate: first");
		const b = say("c", "approve", "2026-10-07T09:30:00-02:00", "escalate: second");
		expect(pv(K("approve"), t("Colter", [b, a])).escalate?.why).toBe("second");
	});
	test("an escalate line from outside the families is ignored", () => {
		const up = { ...say("smythe", "approve"), body: "escalate: no" };
		expect(pv(t("Kapoor", [say("k", "approve"), up]), C("approve")).state).toBe("approve");
	});
});

describe("pairVerdict rules 6-8: status, head moves, malformed input", () => {
	test("a cancelled task's verdict still counts; cancelled with no verdict is missing", () => {
		const k = t("Kapoor", [say("k", "approve")], { status: "cancelled" });
		expect(pv(k, C("approve")).state).toBe("approve");
		const r = pv(k, t("Colter", [], { status: "cancelled" }));
		expect([r.state, r.missing]).toEqual(["pending", ["gpt"]]);
	});
	test("the old head's pair says nothing about the new head", () => {
		const moved = { ...ev, headSha: `1234567${"0".repeat(33)}` };
		expect(pairVerdict([K("approve"), C("approve")], moved, seats).state).toBe("pending");
	});
	test("malformed input yields pending and never throws", () => {
		const none = { claude: null, gpt: null, escalate: null };
		const pending: PairVerdict = { ...none, state: "pending", missing: ["claude", "gpt"] };
		expect(pairVerdict(null, ev, seats)).toEqual(pending);
		expect(pairVerdict([K("approve")], {} as never, seats)).toEqual(pending);
		expect(pairVerdict([K("approve")], ev, undefined)).toEqual(pending);
		const junk = [null, 7, { issue: null }, { issue: issue("Kapoor"), comments: "x" }];
		expect(pv(...junk, t("Colter", [null, { body: 5 }]))).toEqual(pending);
	});
});

describe("pairTitle, reviewerTask, REVIEWER_FAMILIES", () => {
	test("the families are the six reviewer seats", () => {
		expect(REVIEWER_FAMILIES).toEqual({
			claude: ["sf-kapoor", "sf-giraud", "sf-adams"],
			gpt: ["sf-colter", "sf-kong", "sf-czajka"],
		});
	});
	test("a reviewer task carries the pair title, the full head sha and the review-pr line", () => {
		const pr = {
			action: "opened",
			url: "https://f/pulls/13",
			title: "T",
			priorityWhy: "tier core",
		};
		const task = reviewerTask({ ...ev, ...pr, priority: "high" }, "k", "Kapoor");
		const { description, ...rest } = task;
		expect(rest).toEqual({
			title: `Review ${repo}#13 @ abcdef1 (Kapoor)`,
			assigneeAgentId: "k",
			status: "todo",
			priority: "high",
		});
		for (const line of [
			"PR: [rodaddy/demo#13](https://f/pulls/13)",
			`Head SHA: \`${SHA}\``,
			"Priority: high (tier core)",
			"Run review-pr on this head; post on the PR and here; end with `verdict: approve` or `verdict: fix-first`.",
		])
			expect(description.split("\n")).toContain(line);
	});
});

describe("pickSeat", () => {
	const configured = (id: string) => ({
		id,
		status: "idle",
		adapterType: "pi_local",
		adapterConfig: { model: "anthropic/claude-sonnet-5-5", thinking: "medium" },
	});
	const agents = { "sf-kapoor": configured("k"), "sf-giraud": configured("g") };
	const kapoor = { agentId: "k", name: "Kapoor" };
	const giraud = { agentId: "g", name: "Giraud" };
	test("the least loaded seat of the family", () => {
		const load = new Map(Object.entries({ k: 2, g: 1 }));
		expect(pickSeat("claude", load, agents)).toEqual(giraud);
	});
	test("a tie goes by login order", () => {
		expect(pickSeat("claude", new Map(), agents)).toEqual(kapoor);
	});
	test("a paused seat is skipped while another is invokable", () => {
		const paused = { ...agents, "sf-kapoor": { ...agents["sf-kapoor"], status: "paused" } };
		expect(pickSeat("claude", new Map([["g", 5]]), paused)).toEqual(giraud);
	});
	test("idle Opus never replaces a loaded qualified Sonnet or an absent Sonnet", () => {
		const opus = {
			...configured("a"),
			adapterConfig: { model: "claude-opus-5-5", thinking: "high" },
		};
		const on = { "sf-adams": opus, "sf-giraud": agents["sf-giraud"] };
		expect(pickSeat("claude", new Map([["g", 5]]), on)).toEqual(giraud);
		expect(pickSeat("claude", new Map(), { "sf-adams": opus })).toBeNull();
	});
	test("the GPT family requires its exact model leaf and low thinking", () => {
		const sol = {
			...configured("c"),
			adapterConfig: { model: "claudex-proxy/gpt-6.1-sol", thinking: "low" },
		};
		expect(pickSeat("gpt", new Map(), { "sf-colter": sol })).toEqual({
			agentId: "c",
			name: "Colter",
		});
		expect(pickSeat("gpt", new Map(), { "sf-colter": configured("c") })).toBeNull();
	});
	test("unverified configuration holds the family", () => {
		const valid = configured("k");
		for (const invalid of [
			{ id: "k", status: "idle" },
			{ ...valid, adapterType: "claude_local" },
			{ ...valid, adapterConfig: { thinking: "medium" } },
			{ ...valid, adapterConfig: { model: "claude-sonnet-5-5" } },
			{ ...valid, adapterConfig: { model: "claude-sonnet-5-5", thinking: "high" } },
			{ ...valid, adapterConfig: { model: "fleet-proxy/claude-haiku-5-5", thinking: "medium" } },
		])
			expect(pickSeat("claude", new Map(), { "sf-kapoor": invalid })).toBeNull();
	});
	test("a qualified running seat is picked by load like an idle one", () => {
		const running = { ...agents, "sf-giraud": { ...agents["sf-giraud"], status: "running" } };
		const load = new Map(Object.entries({ k: 2, g: 1 }));
		expect(pickSeat("claude", load, running)).toEqual(giraud);
	});
	test("every qualified seat paused: the least loaded paused one, never an idle Opus", () => {
		const opus = {
			...configured("a"),
			adapterConfig: { model: "claude-opus-5-5", thinking: "high" },
		};
		const on = {
			"sf-kapoor": { ...agents["sf-kapoor"], status: "paused" },
			"sf-giraud": { ...agents["sf-giraud"], status: "paused" },
			"sf-adams": opus,
		};
		const load = new Map(Object.entries({ k: 3, g: 1 }));
		expect(pickSeat("claude", load, on)).toEqual(giraud);
	});
	test("no seat of the family on the board: null", () => {
		expect(pickSeat("gpt", new Map(), agents)).toBeNull();
		expect(pickSeat("nope", new Map(), agents)).toBeNull();
	});
});

describe("roundDecision: a reviewer pair is one round (D5)", () => {
	const rd = (...heads: string[]) =>
		roundDecision(
			heads.map((s) => P + s),
			repo,
			13,
		);
	test("a pair-only head counts one round; two pair heads hit the limit", () => {
		expect(rd("1111111 (Kapoor)", "1111111 (Colter)")).toBe("create");
		const two = ["1111111 (Kapoor)", "1111111 (Colter)", "2222222 (Giraud)", "2222222 (Kong)"];
		expect(rd(...two)).toBe("limit");
	});
	test("a parent and its pair on one sha count once", () => {
		expect(rd("1111111", "1111111 (Kapoor)", "1111111 (Kong)")).toBe("create");
	});
	test("a legacy `— Adams` child counts under its sha7 once", () => {
		expect(rd("1111111 — Adams", "2222222 (Kong)")).toBe("limit");
		expect(rd("1111111 — Adams", "1111111 (Kong)")).toBe("create");
	});
	test("three heads hit the limit", () => {
		expect(rd("1111111 (Kapoor)", "2222222", "3333333 (Kong)")).toBe("limit");
	});
});
