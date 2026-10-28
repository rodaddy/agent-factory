import { describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import {
	BASE_MERGE_LINE,
	dedupeKey,
	headerValue,
	parseIssueEvent,
	parsePullRequestEvent,
	pickLinkedTask,
	priorityOf,
	reviewIssue,
	roundDecision,
	roundLimitText,
	sweepCandidates,
	taskStatusFor,
	tierOf,
	triageIssue,
	verifySignature,
	WORK_LABEL,
	withTier,
} from "../../fleet/plugins/forge-pr/logic.js";
import {
	baseMergeHead,
	forgeAssign,
	forgeLabel,
	reviewPrOnce,
	warnRoundLimit,
} from "../../fleet/plugins/forge-pr/sweep.js";

const SECRET = "s3cret";
const SHA = "a".repeat(40);
// Worker fakes: the head settled long ago (PR 1696 debounce), nothing else is recorded.
const settledState = (key: string) => (key.startsWith("settle:") ? { sha: SHA, at: 0 } : null);
const sign = (body: string, secret = SECRET) =>
	`sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const body = (over: Record<string, unknown> = {}) => ({
	action: "opened",
	number: 7,
	repository: { full_name: "rodaddy/demo" },
	pull_request: {
		head: { sha: SHA },
		html_url: "https://forge.example.internal/rodaddy/demo/pulls/7",
		title: "Add thing",
		user: { login: "rico" },
	},
	...over,
});
const headers = { "x-forgejo-event": "pull_request" };
const allowed = ["rodaddy/demo"];

describe("verifySignature", () => {
	const raw = JSON.stringify(body());
	test("valid signature true", () => expect(verifySignature(raw, sign(raw), SECRET)).toBe(true));
	test("wrong secret false", () =>
		expect(verifySignature(raw, sign(raw, "other"), SECRET)).toBe(false));
	test("tampered body false", () =>
		expect(verifySignature(raw + " ", sign(raw), SECRET)).toBe(false));
	test("missing header false", () =>
		expect(verifySignature(raw, undefined as unknown as string, SECRET)).toBe(false));
	test("sha1 prefix false", () => {
		const h = `sha1=${crypto.createHmac("sha256", SECRET).update(raw).digest("hex")}`;
		expect(verifySignature(raw, h, SECRET)).toBe(false);
	});
});

describe("headerValue", () => {
	test("array uses first element", () => expect(headerValue({ a: ["x", "y"] }, "a")).toBe("x"));
	test("case-insensitive", () =>
		expect(headerValue({ "X-Hub-Signature-256": "v" }, "x-hub-signature-256")).toBe("v"));
});

describe("parsePullRequestEvent", () => {
	test("opened, reopened, and synchronized are accepted", () => {
		for (const action of ["opened", "reopened", "synchronized"]) {
			const e = parsePullRequestEvent(headers, body({ action }), allowed);
			expect(e).toEqual({
				repo: "rodaddy/demo",
				number: 7,
				action,
				headSha: SHA,
				url: "https://forge.example.internal/rodaddy/demo/pulls/7",
				title: "Add thing",
				author: "rico",
				body: "",
				priority: "medium",
				priorityWhy: "default",
			});
		}
	});
	test("closed and edited are rejected", () => {
		for (const action of ["closed", "edited"]) {
			expect(parsePullRequestEvent(headers, body({ action }), allowed)).toBeNull();
		}
	});
	test("non-pull_request event rejected", () =>
		expect(parsePullRequestEvent({ "x-forgejo-event": "push" }, body(), allowed)).toBeNull());
	test("repo not in allowlist rejected", () =>
		expect(parsePullRequestEvent(headers, body(), ["rodaddy/other"])).toBeNull());
	test("bad head sha rejected", () => {
		const b = body();
		(b.pull_request as { head: { sha: string } }).head.sha = "XYZ";
		expect(parsePullRequestEvent(headers, b, allowed)).toBeNull();
	});
	test("draft (WIP) rejected", () => {
		const b = body();
		(b.pull_request as { draft?: boolean }).draft = true;
		expect(parsePullRequestEvent(headers, b, allowed)).toBeNull();
	});
	test("number 0 rejected", () =>
		expect(parsePullRequestEvent(headers, body({ number: 0 }), allowed)).toBeNull());
	test("edited with changes.title and not draft accepted (WIP left the title)", () => {
		const e = parsePullRequestEvent(
			headers,
			body({ action: "edited", changes: { title: { from: "WIP: Add thing" } } }),
			allowed,
		);
		expect(e?.action).toBe("edited");
		expect(e?.headSha).toBe(SHA);
	});
	// A body-only edit parses since sf#1730 (forge-pr-preflight.test.ts).
	test("edited with neither changes.title nor changes.body rejected", () =>
		expect(
			parsePullRequestEvent(
				headers,
				body({ action: "edited", changes: { base: { ref: { from: "dev" } } } }),
				allowed,
			),
		).toBeNull());
	test("edited with changes.title but still draft rejected", () => {
		const b = body({ action: "edited", changes: { title: { from: "Add thing" } } });
		(b.pull_request as { draft?: boolean }).draft = true;
		expect(parsePullRequestEvent(headers, b, allowed)).toBeNull();
	});
});

describe("dedupeKey and reviewIssue", () => {
	const parsed = parsePullRequestEvent(headers, body(), allowed);
	if (!parsed) throw new Error("fixture must parse");
	const e = parsed;
	test("dedupeKey shape", () => expect(dedupeKey(e)).toBe(`rodaddy/demo#7@${SHA}`));
	test("reviewIssue fields", () => {
		const i = reviewIssue(e, { reviewerAgentId: "agent-1" });
		expect(i.title).toBe(`Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`);
		expect(i.assigneeAgentId).toBe("agent-1");
		expect(i.status).toBe("todo");
		expect(i.description).toContain(e.url);
		expect(i.description).toContain(SHA);
		expect(i.description).toContain(
			"Publish: post the combined verdict on the Forge PR as well as the board (sf#1365).",
		);
		expect(i.description).not.toContain("Shadow");
		expect(i.priority).toBe("medium");
		expect(i.description.split("\n")).toContain("Priority: medium (default)");
	});
});

describe("priorityOf", () => {
	const label = (...names: string[]) => names.map((name) => ({ name }));
	test("a priority label sets it", () => {
		expect(priorityOf({ labels: label("priority/critical"), title: "t", body: "" })).toBe(
			"critical",
		);
		expect(priorityOf({ labels: label("bug", "priority/low"), title: "t", body: "" })).toBe("low");
	});
	test("with two priority labels the highest wins", () => {
		expect(priorityOf({ labels: label("priority/low", "priority/high"), title: "t" })).toBe("high");
		expect(priorityOf({ labels: label("priority/high", "priority/low"), title: "t" })).toBe("high");
	});
	test("a [blocker] marker in the title or the body, any case, is critical", () => {
		expect(priorityOf({ labels: [], title: "fix: thing [BLOCKER]", body: "" })).toBe("critical");
		expect(priorityOf({ title: "fix: thing", body: "Why:\n[blocker] for the release" })).toBe(
			"critical",
		);
	});
	test("a label beats the marker", () => {
		expect(priorityOf({ labels: label("priority/low"), title: "fix: thing [blocker]" })).toBe(
			"low",
		);
	});
	test("neither is medium", () => {
		expect(priorityOf({ labels: label("bug"), title: "fix: thing", body: "blocker" })).toBe(
			"medium",
		);
	});
	test("labels missing, null, or an array of strings is medium and does not throw", () => {
		expect(priorityOf({ title: "t", body: "b" })).toBe("medium");
		expect(priorityOf({ labels: null, title: "t", body: "b" })).toBe("medium");
		expect(priorityOf({ labels: ["priority/critical"], title: "t", body: "b" })).toBe("medium");
		expect(priorityOf({ labels: "priority/critical", title: null, body: undefined })).toBe(
			"medium",
		);
		expect(priorityOf({ labels: [null, { name: 7 }], title: "t" })).toBe("medium");
	});
});

describe("priority on the review and triage tasks", () => {
	const prWith = (over: Record<string, unknown>) => {
		const b = body();
		Object.assign(b.pull_request, over);
		const e = parsePullRequestEvent(headers, b, allowed);
		if (!e) throw new Error("fixture must parse");
		return reviewIssue(e, { reviewerAgentId: "agent-1" });
	};
	const issueWith = (over: Record<string, unknown>) => {
		const e = parseIssueEvent(
			{ "x-forgejo-event": "issues" },
			{
				action: "opened",
				repository: { full_name: "rodaddy/demo" },
				issue: {
					number: 12,
					title: "Bug",
					html_url: "https://forge.example.internal/rodaddy/demo/issues/12",
					labels: [{ name: WORK_LABEL }],
					...over,
				},
			},
			allowed,
		);
		if (!e) throw new Error("fixture must parse");
		return triageIssue(e, { triageAgentId: "agent-t" });
	};
	const lines = (t: { description: string }) => t.description.split("\n");

	test("review task: label", () => {
		const t = prWith({ labels: [{ name: "priority/high" }] });
		expect(t.priority).toBe("high");
		expect(lines(t)).toContain("Priority: high (label priority/high)");
		expect(t.title).toBe(`Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`);
	});
	test("review task: marker in the body", () => {
		const t = prWith({ body: "[Blocker] Rico cannot ship" });
		expect(t.priority).toBe("critical");
		expect(lines(t)).toContain("Priority: critical ([blocker] marker)");
	});
	test("triage task: label, marker, default", () => {
		const low = issueWith({
			labels: [{ name: WORK_LABEL }, { name: "priority/low" }],
			title: "Bug [blocker]",
		});
		expect(low.priority).toBe("low");
		expect(lines(low)).toContain("Priority: low (label priority/low)");
		const marked = issueWith({ title: "Bug [blocker]" });
		expect(marked.priority).toBe("critical");
		expect(lines(marked)).toContain("Priority: critical ([blocker] marker)");
		const plain = issueWith({});
		expect(plain.priority).toBe("medium");
		expect(lines(plain)).toContain("Priority: medium (default)");
		expect(lines(plain)[0]).toBe("https://forge.example.internal/rodaddy/demo/issues/12");
		expect(plain.title).toBe("Triage rodaddy/demo#12");
	});
});

describe("client/*: PRs are reviewed, issues stay off (repo tiers)", () => {
	const work = [{ name: "factory-work" }];
	const issueBody = (repo: string) => ({
		action: "opened",
		repository: { full_name: repo },
		issue: {
			number: 12,
			title: "Bug",
			html_url: `https://forge.example.internal/${repo}/issues/12`,
			labels: work,
		},
	});
	const issueHeaders = { "x-forgejo-event": "issues" };
	const pull = {
		number: 7,
		head: { sha: SHA },
		html_url: "https://x/pulls/7",
		user: { login: "rico" },
	};
	const issue = {
		number: 12,
		html_url: "https://x/issues/12",
		user: { login: "rico" },
		labels: work,
	};
	test("a client PR event becomes a review task led by Skippy", () => {
		for (const repo of ["client/client-core", "Client/client-core"]) {
			const b = body({ repository: { full_name: repo } });
			const e = parsePullRequestEvent(headers, b, [repo]);
			expect(e?.repo).toBe(repo);
			if (!e) throw new Error("client PR must parse");
			const t = reviewIssue(withTier(e, tierOf(repo, [])), { reviewerAgentId: "agent-1" });
			expect(t.description.split("\n")).toContain("Lead: Skippy");
			expect(t.priority).toBe("high");
			const t1 = reviewIssue(withTier(e, tierOf(repo, ["tier-1"])), { reviewerAgentId: "a" });
			expect(t1.description.split("\n")).toContain("Lead: Skippy");
		}
	});
	test("a non-client review task carries no client lead line", () => {
		const e = parsePullRequestEvent(headers, body(), allowed);
		if (!e) throw new Error("fixture must parse");
		const t = reviewIssue(withTier(e, 2), { reviewerAgentId: "agent-1" });
		expect(t.description).not.toContain("Lead: Skippy");
	});
	test("a client issue event produces no task, even with the work label", () => {
		for (const repo of ["client/client-core", "CLIENT/client-core"]) {
			expect(parseIssueEvent(issueHeaders, issueBody(repo), [repo])).toBeNull();
		}
	});
	test("a client sweep yields the PR, never the issue", () => {
		expect(sweepCandidates("client/client-core", [pull], [issue]).map((c) => c.kind)).toEqual([
			"pr",
		]);
	});
	test("a rodaddy PR, issue and sweep still produce tasks", () => {
		expect(parsePullRequestEvent(headers, body(), allowed)).not.toBeNull();
		expect(parseIssueEvent(issueHeaders, issueBody("rodaddy/demo"), allowed)).not.toBeNull();
		expect(sweepCandidates("rodaddy/demo", [pull], [issue]).map((c) => c.kind)).toEqual([
			"pr",
			"issue",
		]);
	});
});

describe("tierOf (repo tiers 0-5 from tier-N Forge topics)", () => {
	test("topic tier-N is tier N", () => {
		for (const n of [0, 1, 2, 3, 4, 5] as const)
			expect(tierOf("rodaddy/demo", ["go", `tier-${n}`])).toBe(n);
	});
	test("several tier topics: the lowest number wins", () => {
		expect(tierOf("rodaddy/demo", ["tier-4", "tier-2", "tier-5"])).toBe(2);
		expect(tierOf("client/x", ["tier-5", "tier-1"])).toBe(1);
	});
	test("tier-0 beats tier-1 when both topics are present (infra, Rico 2026-10-07)", () =>
		expect(tierOf("rodaddy/rtech-infra", ["tier-1", "tier-0"])).toBe(0));
	test("a tier topic beats the client default", () =>
		expect(tierOf("client/client-core", ["tier-4"])).toBe(4));
	test("no tier topic: a client/* repo is tier 2, any case", () => {
		expect(tierOf("client/client-core", [])).toBe(2);
		expect(tierOf("Client/x", null)).toBe(2);
	});
	test("no tier topic: anything else is tier 5", () => {
		expect(tierOf("rodaddy/demo", ["typescript"])).toBe(5);
		expect(tierOf("rodaddy/demo", undefined)).toBe(5);
		expect(tierOf("rodaddy/demo", "tier-1")).toBe(5);
		expect(tierOf("rodaddy/demo", ["tier-6", "tier-12", "tier-00", "factory-core"])).toBe(5);
	});
});

describe("review priority by tier", () => {
	const ev = (over: Record<string, unknown> = {}) => {
		const b = body();
		Object.assign(b.pull_request, over);
		const e = parsePullRequestEvent(headers, b, allowed);
		if (!e) throw new Error("fixture must parse");
		return e;
	};
	const task = (e: ReturnType<typeof ev>, tier: unknown) =>
		reviewIssue(withTier(e, tier), { reviewerAgentId: "agent-1" });
	test("tier 0 and 1 critical, 2 high, 3 medium, 4 and 5 low, the tier on the line", () => {
		for (const [tier, want] of [
			[0, "critical"],
			[1, "critical"],
			[2, "high"],
			[3, "medium"],
			[4, "low"],
			[5, "low"],
		] as const) {
			const t = task(ev(), tier);
			expect(t.priority).toBe(want);
			expect(t.description.split("\n")).toContain(`Priority: ${want} (tier ${tier})`);
		}
	});
	test("an unknown tier is tier 5", () => {
		for (const tier of ["core", -1, 6, 2.5, null]) {
			const t = task(ev(), tier);
			expect(t.priority).toBe("low");
			expect(t.description.split("\n")).toContain("Priority: low (tier 5)");
		}
	});
	test("a priority label still wins over the tier", () => {
		const t = task(ev({ labels: [{ name: "priority/low" }] }), 1);
		expect(t.priority).toBe("low");
		expect(t.description.split("\n")).toContain("Priority: low (label priority/low)");
	});
	test("a [blocker] marker still wins over the tier", () => {
		const t = task(ev({ title: "fix [blocker]" }), 5);
		expect(t.priority).toBe("critical");
	});
});

describe("issues need the factory-work label", () => {
	const issueHeaders = { "x-forgejo-event": "issues" };
	const issueBody = (labels: unknown) => ({
		action: "opened",
		repository: { full_name: "rodaddy/demo" },
		issue: { number: 12, title: "Bug", html_url: "https://x/issues/12", labels },
	});
	test("without the label: no event", () => {
		expect(parseIssueEvent(issueHeaders, issueBody([]), allowed)).toBeNull();
		expect(parseIssueEvent(issueHeaders, issueBody([{ name: "bug" }]), allowed)).toBeNull();
		expect(parseIssueEvent(issueHeaders, issueBody(undefined), allowed)).toBeNull();
	});
	test("with the label: an event", () => {
		expect(
			parseIssueEvent(issueHeaders, issueBody([{ name: "factory-work" }]), allowed)?.number,
		).toBe(12);
	});
	test("the sweep yields no issue candidate without the label", () => {
		const i = { number: 3, html_url: "https://x/issues/3", user: { login: "rico" } };
		expect(sweepCandidates("rodaddy/demo", [], [i])).toEqual([]);
	});
});

describe("past two rounds review is warned, not stopped", () => {
	const repo = "rodaddy/demo";
	const t = (n: number, sha: string) => `Review ${repo}#${n} @ ${sha}`;
	test("two existing review tasks: limit; one: create (round 2); none: create", () => {
		expect(roundDecision([t(13, "1111111"), t(13, "2222222")], repo, 13)).toBe("limit");
		expect(roundDecision([t(13, "1111111")], repo, 13)).toBe("create");
		expect(roundDecision([], repo, 13)).toBe("create");
	});
	test("a review of another PR sharing the leading digits does not count", () => {
		expect(roundDecision([t(131, "1111111"), t(131, "2222222")], repo, 13)).toBe("create");
		expect(roundDecision([t(13, "1111111"), t(131, "2222222")], repo, 13)).toBe("create");
		expect(roundDecision([`Review rodaddy/demo2#13 @ 1111111`, t(13, "2")], repo, 13)).toBe(
			"create",
		);
		expect(roundDecision([`Triage ${repo}#13`, t(13, "1111111")], repo, 13)).toBe("create");
	});

	const parsed = parsePullRequestEvent(headers, body({ number: 13 }), allowed);
	if (!parsed) throw new Error("fixture must parse");
	const event = parsed;
	const harness = (titles: string[]) => {
		const state = new Map<string, unknown>();
		const comments: Array<{ repo: string; number: number; body: string }> = [];
		const logs: string[] = [];
		const queries: string[] = [];
		const deps = {
			listTitles: async (q: string) => {
				queries.push(q);
				return titles;
			},
			postComment: async (r: string, n: number, b: string) =>
				void comments.push({ repo: r, number: n, body: b }),
			stateGet: async (k: string) => state.get(k) ?? null,
			stateSet: async (k: string, v: unknown) => void state.set(k, v),
			log: (l: string) => void logs.push(l),
		};
		return { deps, comments, logs, queries };
	};
	test("two existing: one warning comment on the PR, naming the round count, logged", async () => {
		const h = harness([t(13, "1111111"), t(13, "2222222")]);
		await warnRoundLimit(h.deps, event);
		expect(h.queries).toEqual([`Review ${repo}#13 @ `]);
		expect(h.comments).toEqual([
			{
				repo,
				number: 13,
				body: "ROUND LIMIT: this pull request has had 2 review rounds. Fix any open P0 or P1 findings before you push again. Review continues on every new head (Rico, 2026-10-08).\n\n@rico: this goes back to you.",
			},
		]);
		expect(roundLimitText(3)).toBe(
			"ROUND LIMIT: this pull request has had 3 review rounds. Fix any open P0 or P1 findings before you push again. Review continues on every new head (Rico, 2026-10-08).",
		);
		expect(h.logs).toEqual([`forge-pr: round limit ${repo}#13 @ ${SHA.slice(0, 7)}`]);
	});
	test("the limit comment is not posted twice for the same head", async () => {
		const h = harness([t(13, "1111111"), t(13, "2222222")]);
		await warnRoundLimit(h.deps, event);
		await warnRoundLimit(h.deps, event);
		expect(h.comments.length).toBe(1);
	});
	test("a refused limit comment is quarantined, not thrown, and not retried for that head", async () => {
		const h = harness([t(13, "1111111"), t(13, "2222222")]);
		let tries = 0;
		const deps = {
			...h.deps,
			postComment: async () => {
				tries++;
				throw Object.assign(new Error("forge-pr: round-limit comment failed 403"), {
					reason: "403",
				});
			},
		};
		await warnRoundLimit(deps, event);
		await warnRoundLimit(deps, event);
		expect(tries).toBe(1);
		expect(h.logs).toContain(
			`forge-pr: round-limit comment failed ${repo}#13 @ ${SHA.slice(0, 7)}: 403 (quarantined)`,
		);
	});
	test("one existing: round 2 is created, no comment", async () => {
		const h = harness([t(13, "1111111")]);
		await warnRoundLimit(h.deps, event);
		expect(h.comments).toEqual([]);
	});
	test("two reviews of #131 do not limit #13", async () => {
		const h = harness([t(131, "1111111"), t(131, "2222222")]);
		await warnRoundLimit(h.deps, event);
		expect(h.comments).toEqual([]);
	});
});

describe("at the round limit the work goes back to its author", () => {
	const repo = "rodaddy/demo";
	const limit = [`Review ${repo}#13 @ 1111111`, `Review ${repo}#13 @ 2222222`];
	const ev = (login: string) => {
		const e = parsePullRequestEvent(
			headers,
			body({
				number: 13,
				pull_request: { ...body().pull_request, user: { login } },
			}),
			allowed,
		);
		if (!e) throw new Error("fixture must parse");
		return e;
	};
	const harness = (opts: { linked?: { id: string }; failBoard?: boolean } = {}) => {
		const state = new Map<string, unknown>();
		const comments: string[] = [];
		const created: object[] = [];
		const reopened: Array<{ id: string; patch: Record<string, unknown> }> = [];
		const logs: string[] = [];
		const deps = {
			listTitles: async () => limit,
			postComment: async (_r: string, _n: number, b: string) => void comments.push(b),
			stateGet: async (k: string) => state.get(k) ?? null,
			stateSet: async (k: string, v: unknown) => void state.set(k, v),
			log: (l: string) => void logs.push(l),
			findAgent: async (login: string) => (login === "sf-bishop" ? "agent-bishop" : null),
			findLinkedTask: async () => opts.linked ?? null,
			reopenTask: async (id: string, patch: Record<string, unknown>) => {
				if (opts.failBoard) throw Object.assign(new Error("board down"), { name: "BoardError" });
				reopened.push({ id, patch });
			},
			createTask: async (t: object) => {
				if (opts.failBoard) throw Object.assign(new Error("board down"), { name: "BoardError" });
				created.push(t);
				return { id: `new-${created.length}` };
			},
		};
		return { deps, state, comments, created, reopened, logs };
	};
	test("employee PR with a linked task: the task is reopened and assigned to its author", async () => {
		const h = harness({ linked: { id: "task-9" } });
		await warnRoundLimit(h.deps, ev("sf-bishop"));
		expect(h.created).toEqual([]);
		expect(h.reopened.length).toBe(1);
		expect(h.reopened[0]?.id).toBe("task-9");
		expect(h.reopened[0]?.patch).toMatchObject({ status: "todo", assigneeAgentId: "agent-bishop" });
		expect(String(h.reopened[0]?.patch.comment)).toContain(`${repo}#13`);
		expect(String(h.reopened[0]?.patch.comment)).toContain("ROUND LIMIT");
	});
	test("employee PR with no task: one Rework task for that agent", async () => {
		const h = harness();
		await warnRoundLimit(h.deps, ev("sf-bishop"));
		expect(h.reopened).toEqual([]);
		expect(h.created.length).toBe(1);
		expect(h.created[0]).toMatchObject({
			title: `Rework ${repo}#13: review round limit`,
			assigneeAgentId: "agent-bishop",
			status: "todo",
			description: `${roundLimitText(2)}\n\nPR: [${repo}#13](https://forge.example.internal/rodaddy/demo/pulls/7)`,
		});
		expect(JSON.stringify(h.created[0])).not.toContain("new pull request");
	});
	test("session-authored PR: the comment @-mentions the author, no task", async () => {
		const h = harness();
		await warnRoundLimit(h.deps, ev("claude-session"));
		expect(h.comments.length).toBe(1);
		expect(h.comments[0]).toContain("@claude-session");
		expect(h.created).toEqual([]);
		expect(h.reopened).toEqual([]);
	});
	test("a second sweep on the same head does nothing", async () => {
		const h = harness();
		await warnRoundLimit(h.deps, ev("sf-bishop"));
		await warnRoundLimit(h.deps, ev("sf-bishop"));
		expect(h.comments.length).toBe(1);
		expect(h.created.length).toBe(1);
	});
	test("a failing board call is quarantined: not thrown, recorded, not retried", async () => {
		const h = harness({ linked: { id: "task-9" }, failBoard: true });
		await warnRoundLimit(h.deps, ev("sf-bishop"));
		expect(h.state.get(`roundlimit:${repo}#13@${SHA}`)).toMatchObject({
			commented: true,
			kickedBack: false,
			kickBackReason: "BoardError",
		});
		expect(h.logs).toContain(
			`forge-pr: round-limit kick-back failed ${repo}#13 @ ${SHA.slice(0, 7)}: BoardError (quarantined)`,
		);
		await warnRoundLimit(h.deps, ev("sf-bishop"));
		expect(h.comments.length).toBe(1);
	});
});

describe("reviewPrOnce past the round limit: warned once per head, review task still created", () => {
	const repo = "rodaddy/demo";
	const headSha = (c: string) => c.repeat(40);
	const ev = (sha: string) => {
		const e = parsePullRequestEvent(
			headers,
			body({ number: 13, pull_request: { ...body().pull_request, head: { sha } } }),
			allowed,
		);
		if (!e) throw new Error("fixture must parse");
		return e;
	};
	const harness = (earlier: string[]) => {
		const board: string[] = earlier.map((s) => `Review ${repo}#13 @ ${s}`);
		const state = new Map<string, unknown>();
		const comments: string[] = [];
		const created: Array<{ title: string }> = [];
		const deps = {
			companyId: "co-r1",
			cfg: { reviewerAgentId: "rev", triageAgentId: "tri" },
			listTitles: async () => [...board],
			postComment: async (_r: string, _n: number, b: string) => void comments.push(b),
			stateGet: async (k: string) =>
				k.startsWith("settle:") ? { sha: "x", at: 0 } : (state.get(k) ?? null),
			stateSet: async (k: string, v: unknown) => void state.set(k, v),
			log: () => undefined,
			createTask: async (task: { title: string }) => {
				created.push(task);
				board.push(task.title);
				return { id: `new-${created.length}` };
			},
		};
		return { deps, comments, created };
	};
	const warning = (n: number) => `${roundLimitText(n)}\n\n@rico: this goes back to you.`;
	test("round 3: the task is created and one ROUND LIMIT comment names 2 rounds", async () => {
		const h = harness(["1111111", "2222222"]);
		const r = await reviewPrOnce(h.deps, ev(headSha("a")));
		expect(r.outcome).toBe("created");
		expect(h.created.map((t) => t.title)).toEqual([`Review ${repo}#13 @ aaaaaaa`]);
		expect(h.comments).toEqual([warning(2)]);
	});
	test("a second sweep on the same head: no second comment, no duplicate task", async () => {
		const h = harness(["1111111", "2222222"]);
		await reviewPrOnce(h.deps, ev(headSha("a")));
		const again = await reviewPrOnce(h.deps, ev(headSha("a")));
		expect(again.outcome).toBe("duplicate");
		expect(h.created.length).toBe(1);
		expect(h.comments.length).toBe(1);
	});
	test("a new head past the limit gets its own comment and its own task", async () => {
		const h = harness(["1111111", "2222222"]);
		await reviewPrOnce(h.deps, ev(headSha("a")));
		const next = await reviewPrOnce(h.deps, ev(headSha("b")));
		expect(next.outcome).toBe("created");
		expect(h.created.map((t) => t.title)).toEqual([
			`Review ${repo}#13 @ aaaaaaa`,
			`Review ${repo}#13 @ bbbbbbb`,
		]);
		expect(h.comments).toEqual([warning(2), warning(3)]);
	});
	test("round 4 (three earlier heads): the task is created and the count is 3", async () => {
		const h = harness(["1111111", "2222222", "3333333"]);
		const r = await reviewPrOnce(h.deps, ev(headSha("c")));
		expect(r.outcome).toBe("created");
		expect(h.created.map((t) => t.title)).toEqual([`Review ${repo}#13 @ ccccccc`]);
		expect(h.comments).toEqual([warning(3)]);
	});
});

describe("pickLinkedTask (kick-back finds the author's own task)", () => {
	const url = "https://forge.example.internal/rodaddy/software-factory/pulls/1466";
	test("picks the task whose description holds the PR link", () => {
		const own = { id: "t2", title: "Build the cap", description: `PR: ${url}` };
		expect(
			pickLinkedTask(
				[{ id: "t1", title: "Unrelated work", description: "no link here" }, own],
				url,
			),
		).toBe(own);
	});
	test("never reopens an unrelated task or a review task", () => {
		expect(
			pickLinkedTask(
				[
					{ id: "t1", title: "Unrelated work", description: "other PR" },
					{ id: "t3", title: "Review rodaddy/software-factory#1466 @ abc", description: url },
				],
				url,
			),
		).toBeNull();
		expect(pickLinkedTask(undefined, url)).toBeNull();
	});
});

describe("pickLinkedTask matches the PR link on a boundary (P2-B)", () => {
	const base = "https://forge.example.internal/rodaddy/software-factory/pulls/";
	const task = (id: string, n: number, tail = "") => ({
		id,
		title: `Work ${id}`,
		description: `PR: ${base}${n}${tail}`,
	});
	test("PR 14 never picks PR 146's task, and PR 146 never picks PR 14's", () => {
		expect(pickLinkedTask([task("t146", 146)], `${base}14`)).toBeNull();
		expect(pickLinkedTask([task("t14", 14)], `${base}146`)).toBeNull();
		const t146 = task("t146", 146);
		const t14 = task("t14", 14);
		expect(pickLinkedTask([t146, t14], `${base}14`)).toBe(t14);
		expect(pickLinkedTask([t14, t146], `${base}146`)).toBe(t146);
	});
	test("the link may end the text or be followed by any non-digit", () => {
		for (const tail of [")", "/files", ".\nmore"]) {
			const t = task("t", 14, tail);
			expect(pickLinkedTask([t], `${base}14`)).toBe(t);
		}
	});
});

describe("at the round limit the author is assigned and the PR labelled (P2-C)", () => {
	const repo = "rodaddy/demo";
	const limit = [`Review ${repo}#13 @ 1111111`, `Review ${repo}#13 @ 2222222`];
	const ev = (login: string) => {
		const e = parsePullRequestEvent(
			headers,
			body({ number: 13, pull_request: { ...body().pull_request, user: { login } } }),
			allowed,
		);
		if (!e) throw new Error("fixture must parse");
		return e;
	};
	const harness = (opts: { failAssign?: boolean; failLabel?: boolean } = {}) => {
		const state = new Map<string, unknown>();
		const comments: string[] = [];
		const assigned: Array<{ repo: string; number: number; login: string }> = [];
		const labelled: Array<{ repo: string; number: number; label: string }> = [];
		const logs: string[] = [];
		const deps = {
			listTitles: async () => limit,
			postComment: async (_r: string, _n: number, b: string) => void comments.push(b),
			stateGet: async (k: string) => state.get(k) ?? null,
			stateSet: async (k: string, v: unknown) => void state.set(k, v),
			log: (l: string) => void logs.push(l),
			assignPr: async (r: string, n: number, login: string) => {
				if (opts.failAssign) throw Object.assign(new Error("no"), { reason: "422" });
				assigned.push({ repo: r, number: n, login });
			},
			addLabel: async (r: string, n: number, label: string) => {
				if (opts.failLabel) throw Object.assign(new Error("no"), { reason: "403" });
				labelled.push({ repo: r, number: n, label });
			},
		};
		return { deps, state, comments, assigned, labelled, logs };
	};
	test("session author: assigned on the PR and round-limit label added, once per head", async () => {
		const h = harness();
		await warnRoundLimit(h.deps, ev("claude-session"));
		await warnRoundLimit(h.deps, ev("claude-session"));
		expect(h.assigned).toEqual([{ repo, number: 13, login: "claude-session" }]);
		expect(h.labelled).toEqual([{ repo, number: 13, label: "round-limit" }]);
		expect(h.comments.length).toBe(1);
		expect(h.state.get(`roundlimit:${repo}#13@${SHA}`)).toMatchObject({
			commented: true,
			assigned: true,
			labelled: true,
		});
	});
	test("a failing assign or label call is quarantined: not thrown, recorded, not retried", async () => {
		const h = harness({ failAssign: true, failLabel: true });
		await warnRoundLimit(h.deps, ev("claude-session"));
		expect(h.comments.length).toBe(1);
		expect(h.state.get(`roundlimit:${repo}#13@${SHA}`)).toMatchObject({
			commented: true,
			assigned: false,
			assignReason: "422",
			labelled: false,
			labelReason: "403",
		});
		expect(h.logs).toContain(
			`forge-pr: round-limit assign failed ${repo}#13 @ ${SHA.slice(0, 7)}: 422 (quarantined)`,
		);
		expect(h.logs).toContain(
			`forge-pr: round-limit label failed ${repo}#13 @ ${SHA.slice(0, 7)}: 403 (quarantined)`,
		);
		await warnRoundLimit(h.deps, ev("claude-session"));
		expect(h.comments.length).toBe(1);
	});
	test("an author that is not a plain login is not assigned; the label still lands", async () => {
		const h = harness();
		await warnRoundLimit(h.deps, ev("bad login"));
		expect(h.assigned).toEqual([]);
		expect(h.labelled.length).toBe(1);
	});
});

describe("forgeAssign and forgeLabel (the Forge calls behind assignPr and addLabel)", () => {
	type Call = { method: string; path: string; body?: unknown };
	const fake = (answers: Record<string, unknown>) => {
		const calls: Call[] = [];
		const call = async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			return answers[`${method} ${path}`] ?? null;
		};
		return { calls, call };
	};
	test("assign keeps existing assignees and adds the author", async () => {
		const f = fake({ "GET /repos/rodaddy/demo/issues/13": { assignees: [{ login: "rico" }] } });
		await forgeAssign(f.call, "rodaddy/demo", 13, "claude-session");
		expect(f.calls[1]).toEqual({
			method: "PATCH",
			path: "/repos/rodaddy/demo/issues/13",
			body: { assignees: ["rico", "claude-session"] },
		});
	});
	test("assign is a no-op when the author is already assigned", async () => {
		const f = fake({
			"GET /repos/rodaddy/demo/issues/13": { assignees: [{ login: "claude-session" }] },
		});
		await forgeAssign(f.call, "rodaddy/demo", 13, "claude-session");
		expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
	});
	test("label posts the name, and a label the repo lacks is a failure, not silence", async () => {
		const ok = fake({ "POST /repos/rodaddy/demo/issues/13/labels": [{ name: "round-limit" }] });
		await forgeLabel(ok.call, "rodaddy/demo", 13, "round-limit");
		expect(ok.calls).toEqual([
			{
				method: "POST",
				path: "/repos/rodaddy/demo/issues/13/labels",
				body: { labels: ["round-limit"] },
			},
		]);
		const missing = fake({ "POST /repos/rodaddy/demo/issues/13/labels": [{ name: "bug" }] });
		await expect(forgeLabel(missing.call, "rodaddy/demo", 13, "round-limit")).rejects.toMatchObject(
			{ reason: "label-missing" },
		);
	});
});

// A body-only fix (no new commit) is closed and reopened: the head is already
// reviewed, so the dedupe key exists.
describe("a reopened PR gets a fresh review when none is open", () => {
	const at = (action: string) => {
		const ev = parsePullRequestEvent(headers, body({ action }), allowed);
		if (!ev) throw new Error("fixture must parse");
		return ev;
	};
	const harness = (
		openTitles: string[],
		boardTitles = [`Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`],
	) => {
		const state = new Map<string, unknown>([[`rodaddy/demo#7@${SHA}`, { issueId: "old" }]]);
		const created: Array<{ title: string }> = [];
		const deps = {
			companyId: "co-sf1413",
			cfg: { reviewerAgentId: "rev", triageAgentId: "tri" },
			listTitles: async () => boardTitles,
			postComment: async () => undefined,
			stateGet: async (k: string) => state.get(k) ?? null,
			stateSet: async (k: string, v: unknown) => void state.set(k, v),
			log: () => undefined,
			createTask: async (task: { title: string }) => {
				created.push(task);
				return { id: `new-${created.length}` };
			},
			openTaskExists: async (task: { title: string }) => openTitles.includes(task.title),
		};
		return { deps, created, state };
	};
	const title = `Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`;
	test("reopened at a reviewed head whose review is done: a new review task", async () => {
		const h = harness([]);
		const r = await reviewPrOnce(h.deps, at("reopened"));
		expect(r).toEqual({ key: `rodaddy/demo#7@${SHA}`, outcome: "created", issueId: "new-1" });
		expect(h.created.map((t) => t.title)).toEqual([title]);
		expect(h.state.get(`rodaddy/demo#7@${SHA}`)).toEqual({ issueId: "new-1" });
	});
	test("reopened while its review is still open: no duplicate", async () => {
		const h = harness([title]);
		expect((await reviewPrOnce(h.deps, at("reopened"))).outcome).toBe("duplicate");
		expect(h.created).toEqual([]);
	});
	test("synchronized at a seen head: no duplicate, even with no open review", async () => {
		const h = harness([]);
		expect((await reviewPrOnce(h.deps, at("synchronized"))).outcome).toBe("duplicate");
		expect(h.created).toEqual([]);
	});
	// Round 1 as the board holds it: the plugin's review task plus the lead's
	// per-reviewer tasks under the same prefix (PR 1598 review, finding 1).
	test("reopened after one real round with per-reviewer tasks: reviewed, not round-limited", async () => {
		const h = harness([], [title, `${title} — Adams`, `${title} — Czajka`]);
		const r = await reviewPrOnce(h.deps, at("reopened"));
		expect(r.outcome).toBe("created");
		expect(h.created.map((t) => t.title)).toEqual([title]);
	});
});

describe("a review round is a plugin review task, not a per-reviewer task (PR 1598)", () => {
	const repo = "rodaddy/demo";
	const t = (sha: string) => `Review ${repo}#13 @ ${sha}`;
	test("per-reviewer siblings of one round do not count as rounds", () => {
		const one = t("1111111");
		expect(roundDecision([one, `${one} — Adams`, `${one} — Czajka`], repo, 13)).toBe("create");
		expect(roundDecision([one, `${one} (Adams)`], repo, 13)).toBe("create");
		expect(roundDecision([one, `${one} — Adams`, t("2222222")], repo, 13)).toBe("limit");
	});
});

// The worker's open-review check on a reopen, driven through onWebhook with a
// signed webhook (PR 1598 review, findings 2 and 3): review-dispatch reassigns
// the parent review to a lead, so the check must not depend on the assignee.
describe("forge-pr worker: reopen with the review reassigned to a lead (PR 1598)", () => {
	const CO = "co-1598";
	const title = `Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`;
	async function run(status: string) {
		// Scheduling fixture: the protected host admits this task. Real receipt/refusal
		// behavior is exercised separately in review-round-ledger.test.ts.
		mock.module("../../fleet/plugins/forge-pr/review-admission-client.js", () => ({
			reviewAdmissionFor: () => async () => ({ action: "start" }),
		}));
		mock.module("@paperclipai/plugin-sdk", () => ({
			definePlugin: (p: unknown) => p,
			runWorker: () => {},
		}));
		const workerPath: string = "../../fleet/plugins/forge-pr/worker.js";
		const mod = (await import(workerPath)) as {
			default: {
				setup: (c: unknown) => Promise<void>;
				onWebhook: (i: unknown) => Promise<unknown>;
			};
		};
		const board = [{ id: "old", title, status, assigneeAgentId: "lead" }];
		const created: Array<Record<string, unknown>> = [];
		const ctx = {
			companies: { list: async () => [{ id: CO }] },
			config: {
				get: async () => ({
					repos: ["rodaddy/demo"],
					webhookSecret: "ref",
					forgeToken: "ref",
					reviewerAgentId: "dispatcher",
					triageAgentId: "tri",
				}),
			},
			secrets: { resolve: async () => SECRET },
			projects: { list: async () => [{ id: "p-demo", name: "rodaddy/demo" }] },
			issues: {
				list: async (q: { assigneeAgentId?: string }) =>
					board.filter((i) => !q.assigneeAgentId || i.assigneeAgentId === q.assigneeAgentId),
				get: async (id: string) => board.find((i) => i.id === id) ?? null,
				create: async (t: Record<string, unknown>) => {
					created.push(t);
					return { id: `new-${created.length}` };
				},
			},
			state: {
				get: async (k: { stateKey: string }) =>
					k.stateKey === `rodaddy/demo#7@${SHA}` ? { issueId: "old" } : null,
				set: async () => {},
			},
			jobs: { register: () => {} },
			events: { on: () => {} },
			logger: { info: () => {}, warn: () => {} },
		};
		await mod.default.setup(ctx);
		const raw = JSON.stringify(body({ action: "reopened" }));
		await mod.default.onWebhook({
			endpointKey: "forge",
			headers: { "x-forgejo-event": "pull_request", "x-hub-signature-256": sign(raw) },
			rawBody: raw,
		});
		return created;
	}
	test("the lead's review is still open: no duplicate review", async () => {
		expect(await run("in_progress")).toEqual([]);
	});
	test("the lead's review is done: one new review", async () => {
		expect((await run("done")).map((t) => t.title)).toEqual([title]);
	});
});

// All 3 round limits in the window were tripped by a session merging main into
// the branch, not by review work: a cancelled review and a base-merge
// review are not rounds; a failed Forge read falls back to counting.
describe("what counts as a review round", () => {
	const repo = "rodaddy/demo";
	const P1 = "1".repeat(40);
	const P2 = "2".repeat(40);
	const real = (sha: string) => ({
		title: `Review ${repo}#7 @ ${sha}`,
		status: "done",
		description: "PR: x",
	});
	test("two real rounds: limit (unchanged)", () => {
		expect(roundDecision([real("1111111"), real("3333333")], repo, 7)).toBe("limit");
	});
	test("one real round plus one cancelled review: create", () => {
		const cancelled = { ...real("3333333"), status: "cancelled" };
		expect(roundDecision([real("1111111"), cancelled], repo, 7)).toBe("create");
	});
	test("one real round plus one base-merge review: create", () => {
		const merge = { ...real("3333333"), description: `PR: x\n${BASE_MERGE_LINE}` };
		expect(roundDecision([real("1111111"), merge], repo, 7)).toBe("create");
	});

	const ev = (() => {
		const e = parsePullRequestEvent(headers, body({ action: "synchronized" }), allowed);
		if (!e) throw new Error("fixture must parse");
		return e;
	})();
	// Forge as the plugin reads it; a path not listed answers 404.
	const forge = (over: Record<string, unknown> = {}) => {
		const answers: Record<string, unknown> = {
			[`/repos/${repo}/git/commits/${SHA}`]: { parents: [{ sha: P1 }, { sha: P2 }] },
			[`/repos/${repo}/pulls/7`]: { base: { ref: "main" } },
			[`/repos/${repo}/compare/main...${P2}`]: { total_commits: 0, commits: [] },
			...over,
		};
		const calls: string[] = [];
		const call = async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			if (answers[path] === undefined) throw Object.assign(new Error("404"), { reason: "404" });
			return answers[path];
		};
		return { call, calls };
	};
	test("merge of a base commit onto the reviewed head: a base merge", async () => {
		expect(await baseMergeHead(forge().call, ev, ["1111111"])).toBe(true);
	});
	test("first parent is not a reviewed head: counted", async () => {
		expect(await baseMergeHead(forge().call, ev, ["9999999"])).toBe(false);
	});
	test("second parent is not on the base branch: counted", async () => {
		const f = forge({ [`/repos/${repo}/compare/main...${P2}`]: { total_commits: 3 } });
		expect(await baseMergeHead(f.call, ev, ["1111111"])).toBe(false);
	});
	test("a single-parent head: counted", async () => {
		const f = forge({ [`/repos/${repo}/git/commits/${SHA}`]: { parents: [{ sha: P1 }] } });
		expect(await baseMergeHead(f.call, ev, ["1111111"])).toBe(false);
	});
	test("a failed commit read: counted", async () => {
		const f = forge({ [`/repos/${repo}/git/commits/${SHA}`]: undefined });
		expect(await baseMergeHead(f.call, ev, ["1111111"])).toBe(false);
		expect(f.calls).toEqual([`GET /repos/${repo}/git/commits/${SHA}`]);
	});

	// reviewPrOnce end to end: the board holds one real round at P1; the new
	// head's review is created, and whether it counts depends on the marker.
	const once = async (
		call: ReturnType<typeof forge>["call"],
		earlier: Array<Record<string, unknown>> = [],
	) => {
		const board: Array<Record<string, unknown>> = [...earlier, real(P1.slice(0, 7))];
		const state = new Map<string, unknown>();
		const comments: string[] = [];
		const r = await reviewPrOnce(
			{
				companyId: "co-sf1690",
				cfg: { reviewerAgentId: "rev", triageAgentId: "tri" },
				listTitles: async () => board.map((b) => ({ ...b })),
				postComment: async (_r: string, _n: number, b: string) => void comments.push(b),
				stateGet: async (k: string) => state.get(k) ?? null,
				stateSet: async (k: string, v: unknown) => void state.set(k, v),
				log: () => undefined,
				createTask: async (task: object) => {
					board.push({ ...task, status: "done" });
					return { id: `new-${board.length}` };
				},
				isBaseMerge: (e, reviewed) => baseMergeHead(call, e, reviewed),
			},
			ev,
		);
		return { r, board, comments };
	};
	test("a base-merge head is reviewed, marked, and does not use up a round", async () => {
		const { r, board } = await once(forge().call);
		expect(r.outcome).toBe("created");
		expect(String(board[1]?.description).split("\n")).toContain(BASE_MERGE_LINE);
		expect(String(board[1]?.title)).toBe(`Review ${repo}#7 @ ${SHA.slice(0, 7)}`);
		expect(roundDecision(board, repo, 7)).toBe("create");
	});
	test("a failed commit read: the review is unmarked and counted", async () => {
		const { r, board } = await once(
			forge({ [`/repos/${repo}/git/commits/${SHA}`]: undefined }).call,
		);
		expect(r.outcome).toBe("created");
		expect(String(board[1]?.description)).not.toContain(BASE_MERGE_LINE);
		expect(roundDecision(board, repo, 7)).toBe("limit");
	});
	test("two real rounds, then a base-merge head: reviewed and marked, not warned", async () => {
		const { r, board, comments } = await once(forge().call, [real("3333333")]);
		expect(r.outcome).toBe("created");
		expect(comments).toEqual([]);
		expect(board).toHaveLength(3);
		expect(String(board[2]?.description).split("\n")).toContain(BASE_MERGE_LINE);
		expect(roundDecision(board, repo, 7)).toBe("limit");
	});
	test("two real rounds, then a head that is not a base merge: warned once and still reviewed", async () => {
		const { r, board, comments } = await once(
			forge({ [`/repos/${repo}/git/commits/${SHA}`]: { parents: [{ sha: P1 }] } }).call,
			[real("3333333")],
		);
		expect(r.outcome).toBe("created");
		expect(board).toHaveLength(3);
		expect(String(board[2]?.title)).toBe(`Review ${repo}#7 @ ${SHA.slice(0, 7)}`);
		expect(String(board[2]?.description)).not.toContain(BASE_MERGE_LINE);
		expect(comments).toEqual([`${roundLimitText(2)}\n\n@rico: this goes back to you.`]);
	});
});

// The worker's board read carries status and description to the round count:
// a cancelled earlier review leaves the PR one round in.
describe("forge-pr worker: a cancelled review is not a round", () => {
	const CO = "co-1690";
	test("one done review plus one cancelled review: a new head is reviewed", async () => {
		// Scheduling fixture: the protected host admits this task. Real receipt/refusal
		// behavior is exercised separately in review-round-ledger.test.ts.
		mock.module("../../fleet/plugins/forge-pr/review-admission-client.js", () => ({
			reviewAdmissionFor: () => async () => ({ action: "start" }),
		}));
		mock.module("@paperclipai/plugin-sdk", () => ({
			definePlugin: (p: unknown) => p,
			runWorker: () => {},
		}));
		const workerPath: string = "../../fleet/plugins/forge-pr/worker.js";
		const mod = (await import(workerPath)) as {
			default: {
				setup: (c: unknown) => Promise<void>;
				onWebhook: (i: unknown) => Promise<unknown>;
			};
		};
		const board = [
			{ id: "r1", title: "Review rodaddy/demo#7 @ 1111111", status: "done", description: "" },
			{ id: "r2", title: "Review rodaddy/demo#7 @ 2222222", status: "cancelled", description: "" },
		];
		const created: Array<Record<string, unknown>> = [];
		await mod.default.setup({
			companies: { list: async () => [{ id: CO }] },
			config: {
				get: async () => ({
					repos: ["rodaddy/demo"],
					webhookSecret: "ref",
					forgeToken: "ref",
					reviewerAgentId: "dispatcher",
					triageAgentId: "tri",
				}),
			},
			secrets: { resolve: async () => SECRET },
			projects: { list: async () => [{ id: "p-demo", name: "rodaddy/demo" }] },
			issues: {
				list: async () => board,
				get: async () => null,
				create: async (t: Record<string, unknown>) => {
					created.push(t);
					return { id: `new-${created.length}` };
				},
			},
			agents: { list: async () => [] },
			state: {
				get: async (k: { stateKey: string }) => settledState(k.stateKey),
				set: async () => {},
			},
			jobs: { register: () => {} },
			events: { on: () => {} },
			logger: { info: () => {}, warn: () => {} },
		});
		const raw = JSON.stringify(body({ action: "synchronized" }));
		// The worker's Forge reads (repo topics, the head commit) are stubbed:
		// the head has one parent, so it is not a base merge. Nothing reaches the network.
		const forgeReads: string[] = [];
		const realFetch = globalThis.fetch;
		const answers: Record<string, unknown> = {
			"/repos/rodaddy/demo/topics": { topics: [] },
			[`/repos/rodaddy/demo/git/commits/${SHA}`]: { parents: [{ sha: "1".repeat(40) }] },
			// The checks settle reads the head's combined status.
			[`/repos/rodaddy/demo/commits/${SHA}/status`]: { state: "success", total_count: 1 },
		};
		globalThis.fetch = (async (url: string | URL | Request) => {
			const path = String(url).replace("https://forge.example.internal/api/v1", "");
			forgeReads.push(path);
			const answer = answers[path];
			return answer === undefined
				? new Response("{}", { status: 404 })
				: new Response(JSON.stringify(answer), { status: 200 });
		}) as typeof fetch;
		try {
			await mod.default.onWebhook({
				endpointKey: "forge",
				headers: { "x-forgejo-event": "pull_request", "x-hub-signature-256": sign(raw) },
				rawBody: raw,
			});
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(created.map((t) => t.title)).toEqual([`Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`]);
		expect(forgeReads).toContain(`/repos/rodaddy/demo/git/commits/${SHA}`);
		// The preflight's file-list read gets the 404, so it is skipped.
		const preflightRead = (p: string) => p.startsWith("/repos/rodaddy/demo/pulls/7/files?");
		expect(forgeReads.every((p) => p in answers || preflightRead(p))).toBe(true);
	});
});

describe("taskStatusFor: a seat that is not invokable gets backlog", () => {
	test("paused, error, terminated, archived hold the task in backlog", () => {
		for (const status of ["paused", "error", "terminated", "archived"])
			expect(taskStatusFor({ status })).toBe("backlog");
	});
	test("idle, running, unknown, or no agent stays todo", () => {
		for (const agent of [{ status: "idle" }, { status: "running" }, { status: "x" }, {}, null])
			expect(taskStatusFor(agent)).toBe("todo");
	});
});

// The worker's create path, driven through onWebhook: the reviewer seat is
// read once and a paused one gets its review task in backlog.
describe("forge-pr worker: a paused reviewer gets a backlog task", () => {
	async function run(agents: () => Promise<unknown[]>) {
		// Scheduling fixture: the protected host admits this task. Real receipt/refusal
		// behavior is exercised separately in review-round-ledger.test.ts.
		mock.module("../../fleet/plugins/forge-pr/review-admission-client.js", () => ({
			reviewAdmissionFor: () => async () => ({ action: "start" }),
		}));
		mock.module("@paperclipai/plugin-sdk", () => ({
			definePlugin: (p: unknown) => p,
			runWorker: () => {},
		}));
		const workerPath: string = "../../fleet/plugins/forge-pr/worker.js";
		const mod = (await import(workerPath)) as {
			default: {
				setup: (c: unknown) => Promise<void>;
				onWebhook: (i: unknown) => Promise<unknown>;
			};
		};
		const created: Array<Record<string, unknown>> = [];
		const ctx = {
			companies: { list: async () => [{ id: "co-1690" }] },
			config: {
				get: async () => ({
					repos: ["rodaddy/demo"],
					webhookSecret: "ref",
					forgeToken: "ref",
					reviewerAgentId: "dispatcher",
					triageAgentId: "tri",
				}),
			},
			secrets: { resolve: async () => SECRET },
			agents: { list: agents },
			projects: { list: async () => [{ id: "p-demo", name: "rodaddy/demo" }] },
			issues: {
				list: async () => [],
				create: async (t: Record<string, unknown>) => {
					created.push(t);
					return { id: `new-${created.length}` };
				},
			},
			state: {
				get: async (k: { stateKey: string }) => settledState(k.stateKey),
				set: async () => {},
			},
			jobs: { register: () => {} },
			events: { on: () => {} },
			logger: { info: () => {}, warn: () => {} },
		};
		await mod.default.setup(ctx);
		const raw = JSON.stringify(body());
		await mod.default.onWebhook({
			endpointKey: "forge",
			headers: { "x-forgejo-event": "pull_request", "x-hub-signature-256": sign(raw) },
			rawBody: raw,
		});
		return created;
	}
	test("paused reviewer: backlog, same assignee, the held line", async () => {
		const [t] = await run(async () => [{ id: "dispatcher", name: "Dispatcher", status: "paused" }]);
		expect(t?.status).toBe("backlog");
		expect(t?.assigneeAgentId).toBe("dispatcher");
		expect(String(t?.description).endsWith("Held in backlog: Dispatcher is paused.")).toBe(true);
	});
	test("idle reviewer: todo, no held line", async () => {
		const [t] = await run(async () => [{ id: "dispatcher", name: "Dispatcher", status: "idle" }]);
		expect(t?.status).toBe("todo");
		expect(String(t?.description)).not.toContain("Held in backlog");
	});
	test("a failed agent read keeps todo and still creates the task", async () => {
		const created = await run(async () => {
			throw new Error("board down");
		});
		expect(created.map((t) => t.status)).toEqual(["todo"]);
	});
});

// Every task the plugin creates carries the project named exactly <owner>/<repo>.
// No such project, or a failed project read, files nothing and
// records nothing, so the next pass retries.
describe("forge-pr worker: tasks carry the repo's project", () => {
	async function run(kind: "pull_request" | "issues", projects: unknown[] | (() => never)) {
		// Scheduling fixture: the protected host admits this task. Real receipt/refusal
		// behavior is exercised separately in review-round-ledger.test.ts.
		mock.module("../../fleet/plugins/forge-pr/review-admission-client.js", () => ({
			reviewAdmissionFor: () => async () => ({ action: "start" }),
		}));
		mock.module("@paperclipai/plugin-sdk", () => ({
			definePlugin: (p: unknown) => p,
			runWorker: () => {},
		}));
		const workerPath: string = "../../fleet/plugins/forge-pr/worker.js";
		const mod = (await import(workerPath)) as {
			default: {
				setup: (c: unknown) => Promise<void>;
				onWebhook: (i: unknown) => Promise<unknown>;
			};
		};
		const created: Array<Record<string, unknown>> = [];
		const warns: Array<[string, unknown]> = [];
		const recorded: string[] = [];
		const ctx = {
			companies: { list: async () => [{ id: "co-proj" }] },
			config: {
				get: async () => ({
					repos: ["rodaddy/demo"],
					webhookSecret: "ref",
					forgeToken: "ref",
					reviewerAgentId: "dispatcher",
					triageAgentId: "tri",
				}),
			},
			secrets: { resolve: async () => SECRET },
			agents: { list: async () => [] },
			projects: { list: async () => (typeof projects === "function" ? projects() : projects) },
			issues: {
				list: async () => [],
				create: async (t: Record<string, unknown>) => {
					created.push(t);
					return { id: `new-${created.length}` };
				},
			},
			state: {
				get: async (k: { stateKey: string }) => settledState(k.stateKey),
				set: async (k: { stateKey: string }) => void recorded.push(k.stateKey),
			},
			jobs: { register: () => {} },
			events: { on: () => {} },
			logger: { info: () => {}, warn: (m: string, d: unknown) => void warns.push([m, d]) },
		};
		await mod.default.setup(ctx);
		const payload =
			kind === "pull_request"
				? body({ number: 31 })
				: {
						action: "opened",
						repository: { full_name: "rodaddy/demo" },
						issue: {
							number: 32,
							title: "Bug",
							body: "",
							html_url: "https://forge.example.internal/rodaddy/demo/issues/32",
							user: { login: "rico" },
							labels: [{ name: WORK_LABEL }],
						},
					};
		const raw = JSON.stringify(payload);
		await mod.default.onWebhook({
			endpointKey: "forge",
			headers: { "x-forgejo-event": kind, "x-hub-signature-256": sign(raw) },
			rawBody: raw,
		});
		return {
			created,
			missing: warns.filter(([m]) => m.includes("no project for")).map(([m]) => m),
			recorded: recorded.filter((k) => !k.startsWith("settle:")),
		};
	}
	const PROJECTS = [
		{ id: "p-other", name: "rodaddy/demo-two" },
		{ id: "p-demo", name: "rodaddy/demo" },
	];
	const NOT_FILED = "forge-pr: no project for rodaddy/demo; task not filed (sf#1250)";
	test("a review task carries the project named for the PR's repo", async () => {
		const { created, missing } = await run("pull_request", PROJECTS);
		expect(created.map((t) => t.projectId)).toEqual(["p-demo"]);
		expect(missing).toEqual([]);
	});
	test("a triage task carries the project named for the issue's repo", async () => {
		const { created } = await run("issues", PROJECTS);
		expect(created.map((t) => [t.title, t.projectId])).toEqual([
			["Triage rodaddy/demo#32", "p-demo"],
		]);
	});
	for (const kind of ["pull_request", "issues"] as const) {
		test(`${kind}: no project of that name files no task, records nothing, logs the sf#1250 line`, async () => {
			const { created, missing, recorded } = await run(kind, [
				{ id: "p-x", name: "rodaddy/demo-two" },
			]);
			expect(created).toEqual([]);
			expect(recorded).toEqual([]);
			expect(missing).toEqual([NOT_FILED]);
		});
		test(`${kind}: a project read that throws is the same: no task, nothing recorded`, async () => {
			const { created, missing, recorded } = await run(kind, () => {
				throw new Error("board down");
			});
			expect(created).toEqual([]);
			expect(recorded).toEqual([]);
			expect(missing).toEqual([NOT_FILED]);
		});
	}
});

describe("warnRoundLimit: a Rework task names its repo to createTask", () => {
	test("createTask gets the PR's repo as its second argument", async () => {
		const repos: unknown[] = [];
		const e = parsePullRequestEvent(
			{ "x-forgejo-event": "pull_request" },
			body({ number: 13, pull_request: { ...body().pull_request, user: { login: "sf-bishop" } } }),
			["rodaddy/demo"],
		);
		if (!e) throw new Error("fixture must parse");
		const r1 = `Review rodaddy/demo#13 @ 1111111`;
		await warnRoundLimit(
			{
				listTitles: async () => [r1, `Review rodaddy/demo#13 @ 2222222`],
				postComment: async () => {},
				stateGet: async () => null,
				stateSet: async () => {},
				log: () => {},
				findAgent: async () => "agent-bishop",
				findLinkedTask: async () => null,
				reopenTask: async () => {},
				createTask: async (_t: object, repo?: string) => {
					repos.push(repo);
					return { id: "new" };
				},
			},
			e,
		);
		expect(repos).toEqual(["rodaddy/demo"]);
	});
});
