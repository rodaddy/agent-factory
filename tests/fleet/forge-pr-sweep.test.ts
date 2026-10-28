import { describe, expect, test } from "bun:test";
import {
	issueDedupeKey,
	parseIssueEvent,
	prFromApi,
	sweepCandidates,
	triageIssue,
} from "../../fleet/plugins/forge-pr/logic.js";
import * as sweepModule from "../../fleet/plugins/forge-pr/sweep.js";
import { runSweep } from "../../fleet/plugins/forge-pr/sweep.js";

const SHA = "b".repeat(40);
const allowed = ["rodaddy/demo"];
const headers = { "x-forgejo-event": "issues" };
const issueBody = (over: Record<string, unknown> = {}) => ({
	action: "opened",
	repository: { full_name: "rodaddy/demo" },
	issue: {
		number: 12,
		title: "Bug",
		html_url: "https://forge.example.internal/rodaddy/demo/issues/12",
		labels: [{ name: "factory-work" }],
	},
	...over,
});

describe("parseIssueEvent", () => {
	test("accepts opened and reopened", () => {
		expect(parseIssueEvent(headers, issueBody(), allowed)).toEqual({
			repo: "rodaddy/demo",
			number: 12,
			title: "Bug",
			url: "https://forge.example.internal/rodaddy/demo/issues/12",
			action: "opened",
			priority: "medium",
			priorityWhy: "default",
		});
		expect(parseIssueEvent(headers, issueBody({ action: "reopened" }), allowed)?.action).toBe(
			"reopened",
		);
	});
	test("rejects closed", () => {
		expect(parseIssueEvent(headers, issueBody({ action: "closed" }), allowed)).toBeNull();
	});
	test("rejects a PR-backed issue", () => {
		const b = issueBody();
		(b.issue as Record<string, unknown>).pull_request = { merged: false };
		expect(parseIssueEvent(headers, b, allowed)).toBeNull();
	});
	test("skips an issue a crew account opened (sf-*): the company does not triage its own maps", () => {
		const b = issueBody();
		(b.issue as Record<string, unknown>).user = { login: "sf-chotek" };
		expect(parseIssueEvent(headers, b, allowed)).toBeNull();
		const human = issueBody();
		(human.issue as Record<string, unknown>).user = { login: "rodaddy0" };
		expect(parseIssueEvent(headers, human, allowed)?.number).toBe(12);
	});
	test("rejects a repo outside the allowlist", () => {
		expect(parseIssueEvent(headers, issueBody(), ["rodaddy/other"])).toBeNull();
	});
	test("rejects a non-issues event header", () => {
		expect(parseIssueEvent({ "x-forgejo-event": "push" }, issueBody(), allowed)).toBeNull();
	});
});

test("triageIssue shape and key", () => {
	const ev = parseIssueEvent(headers, issueBody(), allowed);
	if (!ev) throw new Error("no event");
	expect(issueDedupeKey(ev)).toBe("issue:rodaddy/demo#12");
	const t = triageIssue(ev, { triageAgentId: "agent-t" });
	expect(t.title).toBe("Triage rodaddy/demo#12");
	expect(t.assigneeAgentId).toBe("agent-t");
	expect(t.status).toBe("todo");
	expect(t.description.split("\n")[0]).toBe(
		"https://forge.example.internal/rodaddy/demo/issues/12",
	);
});

const apiPr = (n: number, draft = false) => ({
	number: n,
	draft,
	title: `PR ${n}`,
	html_url: `https://forge.example.internal/rodaddy/demo/pulls/${n}`,
	user: { login: "operator" },
	head: { sha: SHA },
});
const apiIssue = (n: number, pr = false) => ({
	number: n,
	title: `Issue ${n}`,
	html_url: `https://forge.example.internal/rodaddy/demo/issues/${n}`,
	pull_request: pr ? { merged: false } : null,
	labels: [{ name: "factory-work" }],
});

test("prFromApi skips drafts", () => {
	expect(prFromApi("rodaddy/demo", apiPr(1, true))).toBeNull();
	expect(prFromApi("rodaddy/demo", apiPr(1))?.headSha).toBe(SHA);
});

test("sweepCandidates keys PRs and issues, skipping drafts and PR-backed issues", () => {
	const c = sweepCandidates(
		"rodaddy/demo",
		[apiPr(1), apiPr(2, true)],
		[apiIssue(3), apiIssue(4, true)],
	);
	expect(c.map((x) => x.key)).toEqual([`rodaddy/demo#1@${SHA}`, "issue:rodaddy/demo#3"]);
});

describe("runSweep", () => {
	const BASE = "https://forge.example.internal/api/v1";
	const repos = ["rodaddy/demo", "rodaddy/two", "rodaddy/three"];
	const searchPr = (repo: string, n: number, updated = "2026-09-30T10:00:00Z") => ({
		number: n,
		updated_at: updated,
		repository: { full_name: repo },
		pull_request: { merged: false },
	});
	const searchIssue = (
		repo: string,
		n: number,
		login = "operator",
		created = "2026-09-30T20:00:00Z",
	) => ({
		number: n,
		created_at: created,
		title: `Issue ${n}`,
		html_url: `https://forge.example.internal/${repo}/issues/${n}`,
		user: { login },
		repository: { full_name: repo },
		pull_request: null,
		labels: [{ name: "factory-work" }],
	});
	const makeDeps = (
		opts: {
			failFirst?: boolean;
			throwFirst?: boolean;
			/** Extra Forge paths: a JSON body, or a bare HTTP status. */
			extra?: Record<string, unknown>;
			/** Board titles listTitles returns (the review-round count). */
			titles?: string[];
			/** HTTP status every comment POST answers with (default 201). */
			postStatus?: number;
			/** Milliseconds createTask waits before it answers (a slow board). */
			createDelay?: number;
			/** Tier per repo (default 1); null drops the repoTier dep. */
			tiers?: Record<string, number> | null;
		} = {},
	) => {
		const state = new Map<string, unknown>();
		const created: Array<{ title: string }> = [];
		const urls: string[] = [];
		const posts: Array<{ url: string; body: string }> = [];
		const fetch = async (url: string, init?: RequestInit) => {
			urls.push(url);
			if (init?.method === "POST") {
				posts.push({ url, body: String(init.body) });
				return new Response("{}", { status: opts.postStatus ?? 201 });
			}
			if (urls.length === 1 && opts.throwFirst) throw new TypeError("dns refused");
			if (urls.length === 1 && opts.failFirst) return new Response("no", { status: 502 });
			const path = url.slice(BASE.length);
			let body: unknown = [];
			if (path.startsWith("/repos/issues/search?") && path.includes("type=pulls")) {
				body = [
					searchPr("rodaddy/demo", 1),
					searchPr("rodaddy/two", 4),
					searchPr("rodaddy/two", 2),
					searchPr("outsider/repo", 7),
				];
			} else if (path.startsWith("/repos/issues/search?") && path.includes("type=issues")) {
				body = [
					searchIssue("rodaddy/three", 3),
					searchIssue("rodaddy/demo", 9),
					searchIssue("rodaddy/three", 8, "sf-chotek"),
					searchIssue("outsider/repo", 5),
					searchIssue("rodaddy/two", 11, "operator", "2026-09-01T00:00:00Z"),
				];
			} else if (opts.extra && path in opts.extra) {
				const x = opts.extra[path];
				if (typeof x === "number") return new Response("no", { status: x });
				body = x;
			} else if (path === "/repos/rodaddy/demo/pulls/1") body = apiPr(1);
			else if (path === "/repos/rodaddy/two/pulls/2") body = apiPr(2);
			else if (path === "/repos/rodaddy/two/pulls/4") body = apiPr(4, true);
			else return new Response("nf", { status: 404 });
			return new Response(JSON.stringify(body), { status: 200 });
		};
		const logs: string[] = [];
		state.set("issue:rodaddy/demo#9", { issueId: "old" });
		return {
			state,
			created,
			urls,
			posts,
			logs,
			deps: {
				fetch,
				baseUrl: BASE,
				token: "t",
				repos,
				now: () => Date.parse("2026-10-01T00:00:00Z"),
				stateGet: async (k: string) => state.get(k) ?? null,
				stateSet: async (k: string, v: unknown) => void state.set(k, v),
				createTask: async (t: { title: string }): Promise<{ id: string } | null> => {
					if (opts.createDelay) await new Promise((r) => setTimeout(r, opts.createDelay));
					created.push(t);
					return { id: `id-${created.length}` };
				},
				listTitles: async (_q: string) => opts.titles ?? [],
				...(opts.tiers === null
					? {}
					: { repoTier: async (repo: string) => opts.tiers?.[repo] ?? 1 }),
				cfg: { reviewerAgentId: "r", triageAgentId: "t" },
				log: (l: string) => void logs.push(l),
			},
		};
	};
	test("a tier 5 repo gets no review task from the sweep, and its PR is not fetched", async () => {
		const h = makeDeps({ tiers: { "rodaddy/demo": 5, "rodaddy/two": 2 } });
		await runSweep(h.deps);
		expect(h.created.map((t) => t.title)).toEqual([
			`Review rodaddy/two#2 @ ${SHA.slice(0, 7)}`,
			"Triage rodaddy/three#3",
		]);
		expect(h.urls.some((u) => u.endsWith("/repos/rodaddy/demo/pulls/1"))).toBe(false);
		const client = h.created[0] as { description?: string; priority?: string };
		expect(client.priority).toBe("high");
		expect(client.description).toContain("Priority: high (tier 2)");
	});
	test("tiers 0-4 get sweep review tasks, tier 0 critical, tier 4 low", async () => {
		for (const tier of [0, 1, 2, 3, 4]) {
			const h = makeDeps({ tiers: { "rodaddy/demo": tier, "rodaddy/two": 5 } });
			await runSweep(h.deps);
			const review = h.created.find((t) => t.title.startsWith("Review rodaddy/demo#1 ")) as
				| { priority?: string; description?: string }
				| undefined;
			expect(review?.description).toContain(`(tier ${tier})`);
			if (tier === 0) expect(review?.priority).toBe("critical");
			if (tier === 4) expect(review?.priority).toBe("low");
			expect(h.created.some((t) => t.title.startsWith("Review rodaddy/two#"))).toBe(false);
		}
	});
	test("every sweep-created task names its repo to createTask", async () => {
		const h = makeDeps({ tiers: { "rodaddy/demo": 5, "rodaddy/two": 2 } });
		const seen: Array<[string, unknown]> = [];
		const create = h.deps.createTask;
		h.deps.createTask = async (t: { title: string }, repo?: string) => {
			seen.push([t.title, repo]);
			return create(t);
		};
		await runSweep(h.deps);
		expect(seen).toEqual([
			[`Review rodaddy/two#2 @ ${SHA.slice(0, 7)}`, "rodaddy/two"],
			["Triage rodaddy/three#3", "rodaddy/three"],
		]);
	});
	// createTask answers null when the repo has no board project: the
	// head and the issue stay unmarked, so the next pass files them.
	test("a task not filed for a missing project is retried on the next pass", async () => {
		const h = makeDeps({ tiers: { "rodaddy/demo": 5, "rodaddy/two": 2 } });
		const create = h.deps.createTask;
		h.deps.createTask = async () => null;
		const first = await runSweep(h.deps);
		expect(first.created).toBe(0);
		expect([...h.state.keys()].filter((k) => k.startsWith("prseen:rodaddy/two#2"))).toEqual([]);
		expect(h.state.has("issue:rodaddy/three#3")).toBe(false);
		h.deps.createTask = create;
		await runSweep(h.deps);
		expect(h.created.map((t) => t.title)).toEqual([
			`Review rodaddy/two#2 @ ${SHA.slice(0, 7)}`,
			"Triage rodaddy/three#3",
		]);
	});
	test("without a tier reader the sweep makes no review task (fail toward less work)", async () => {
		const h = makeDeps({ tiers: null });
		await runSweep(h.deps);
		expect(h.created.map((t) => t.title)).toEqual(["Triage rodaddy/three#3"]);
	});
	test("the sweep makes no triage task for an issue without the factory-work label", async () => {
		const h = makeDeps();
		const fetch = h.deps.fetch;
		h.deps.fetch = async (url: string, init?: RequestInit) => {
			const res = await fetch(url, init);
			if (!url.includes("type=issues")) return res;
			const items = (await res.json()) as Array<Record<string, unknown>>;
			return new Response(JSON.stringify(items.map((i) => ({ ...i, labels: [] }))), {
				status: 200,
			});
		};
		await runSweep(h.deps);
		expect(h.created.some((t) => t.title.startsWith("Triage "))).toBe(false);
	});
	test("an old issue that was only updated (a milestone set) gets no triage task", async () => {
		const h = makeDeps();
		await runSweep(h.deps);
		expect(h.created.some((t) => t.title.includes("rodaddy/two#11"))).toBe(false);
	});
	test("uses cross-repo search, few calls, creates only missing tasks; second sweep only searches", async () => {
		const h = makeDeps();
		const r1 = await runSweep(h.deps);
		expect(h.created.map((t) => t.title)).toEqual([
			`Review rodaddy/demo#1 @ ${SHA.slice(0, 7)}`,
			`Review rodaddy/two#2 @ ${SHA.slice(0, 7)}`,
			"Triage rodaddy/three#3",
		]);
		expect(r1.created).toBe(3);
		// 2 search pages + 3 allowlisted PR detail GETs (one is a draft); outsider never fetched.
		expect(r1.calls).toBe(5);
		expect(h.urls.length).toBe(5);
		expect(h.urls.some((u) => u.includes("outsider"))).toBe(false);
		expect(h.urls.filter((u) => u.includes("/repos/issues/search?")).length).toBe(2);
		expect(
			h.urls.some((u) => u.includes(`since=${encodeURIComponent("2026-09-30T00:00:00.000Z")}`)),
		).toBe(true);
		expect(h.logs[0]).toMatch(
			/^forge-sweep repos=3 prs=2 issues=2 created=3 calls=5 stale=0 took=\d+$/,
		);
		const before = h.urls.length;
		const r2 = await runSweep(h.deps);
		expect(r2.created).toBe(0);
		expect(r2.calls).toBe(2);
		expect(h.urls.slice(before).every((u) => u.includes("/repos/issues/search?"))).toBe(true);
		expect(h.created.length).toBe(3);
	});
	test("a PR with two review rounds gets its task and one limit comment; round 2 still opens", async () => {
		const h = makeDeps({
			titles: [
				"Review rodaddy/demo#1 @ 1111111",
				"Review rodaddy/demo#1 @ 2222222",
				"Review rodaddy/two#2 @ 1111111",
				"Review rodaddy/two#21 @ 1111111",
			],
		});
		const r = await runSweep(h.deps);
		expect(h.created.map((t) => t.title)).toEqual([
			`Review rodaddy/demo#1 @ ${SHA.slice(0, 7)}`,
			`Review rodaddy/two#2 @ ${SHA.slice(0, 7)}`,
			"Triage rodaddy/three#3",
		]);
		expect(r.created).toBe(3);
		expect(h.posts.length).toBe(1);
		expect(h.posts[0]?.url).toBe(`${BASE}/repos/rodaddy/demo/issues/1/comments`);
		expect(JSON.parse(h.posts[0]?.body ?? "{}").body).toBe(
			"ROUND LIMIT: this pull request has had 2 review rounds. Fix any open P0 or P1 findings before you push again. Review continues on every new head (The operator, 2026-10-08).\n\n@operator: this goes back to you.",
		);
		expect(h.logs).toContain(`forge-pr: round limit rodaddy/demo#1 @ ${SHA.slice(0, 7)}`);
		await runSweep(h.deps);
		expect(h.posts.length).toBe(1);
		expect(h.created.length).toBe(3);
	});
	test("admission hold still emits ROUND LIMIT once for the head without dispatching", async () => {
		const h = makeDeps({
			titles: ["Review rodaddy/demo#1 @ 1111111", "Review rodaddy/demo#1 @ 2222222"],
		});
		const deps = {
			...h.deps,
			admitReview: async () => ({ action: "hold" as const, cause: "receipt_required" }),
		};
		await runSweep(deps);
		await runSweep(deps);
		expect(h.posts.filter((p) => p.url.endsWith("/issues/1/comments"))).toHaveLength(1);
		expect(h.created.filter((task) => task.title.startsWith("Review "))).toHaveLength(0);
	});

	// The old sweep wrote `{ limited }` when it refused round 3 and never filed
	// a review, and its roundlimit memo records the obsolete "open a new pull
	// request" comment; after the upgrade that unchanged head is reviewed and
	// gets the current warning once (SOF-11517).
	test("a head the old round-limit stop memoed as `limited` is reviewed and warned once after the upgrade", async () => {
		const h = makeDeps({
			titles: ["Review rodaddy/demo#1 @ 1111111", "Review rodaddy/demo#1 @ 2222222"],
		});
		const seenKey = "prseen:rodaddy/demo#1@2026-09-30T10:00:00Z";
		const limitKey = `roundlimit:rodaddy/demo#1@${SHA}`;
		h.state.set(seenKey, { limited: `rodaddy/demo#1@${SHA}` });
		h.state.set(limitKey, { commented: true, kickedBack: "mention" });
		await runSweep(h.deps);
		await runSweep(h.deps);
		const demo = `Review rodaddy/demo#1 @ ${SHA.slice(0, 7)}`;
		expect(h.created.filter((t) => t.title === demo).length).toBe(1);
		expect(h.posts.map((p) => [p.url, JSON.parse(p.body).body])).toEqual([
			[
				`${BASE}/repos/rodaddy/demo/issues/1/comments`,
				"ROUND LIMIT: this pull request has had 2 review rounds. Fix any open P0 or P1 findings before you push again. Review continues on every new head (The operator, 2026-10-08).\n\n@operator: this goes back to you.",
			],
		]);
		expect(h.state.get(seenKey)).toEqual({ key: `rodaddy/demo#1@${SHA}` });
		expect(h.state.get(limitKey)).toEqual({ commented: true, kickedBack: "mention", rounds: 2 });
	});
	test("a refused ROUND LIMIT comment is quarantined: the sweep goes on to the next PR, issues and approvals", async () => {
		const h = makeDeps({
			titles: ["Review rodaddy/demo#1 @ 1111111", "Review rodaddy/demo#1 @ 2222222"],
			postStatus: 403,
		});
		const decided: string[] = [];
		const approvals = {
			list: async () => [
				{
					id: "ap-stale",
					type: "request_board_approval",
					status: "pending",
					payload: { title: "Go on rodaddy/two#2 at 1234567" },
				},
			],
			decide: async (id: string) => {
				decided.push(id);
				return {};
			},
		};
		const run = () =>
			runSweep({
				...h.deps,
				approvals,
				companyId: "co-1",
				cfg: { ...h.deps.cfg, boardUserId: "operator-user" },
			});
		const r = await run();
		expect(r.stopped).toBe(false);
		expect(h.posts.length).toBe(1);
		expect(h.created.map((t) => t.title)).toEqual([
			`Review rodaddy/demo#1 @ ${SHA.slice(0, 7)}`,
			`Review rodaddy/two#2 @ ${SHA.slice(0, 7)}`,
			"Triage rodaddy/three#3",
		]);
		expect(decided).toEqual(["ap-stale"]);
		expect(h.logs).toContain(
			`forge-pr: round-limit comment failed rodaddy/demo#1 @ ${SHA.slice(0, 7)}: 403 (quarantined)`,
		);
		expect(h.state.get(`roundlimit:rodaddy/demo#1@${SHA}`)).toMatchObject({
			commented: false,
			reason: "403",
		});
		// The quarantine holds: the next sweep neither posts again nor stops on it.
		const r2 = await run();
		expect(r2.stopped).toBe(false);
		expect(h.posts.length).toBe(1);
		expect(h.created.length).toBe(3);
	});
	test("two sweeps racing on one head create one review task", async () => {
		const h = makeDeps({ createDelay: 5 });
		await Promise.all([runSweep(h.deps), runSweep(h.deps)]);
		const reviews = h.created.filter((t) => t.title.startsWith("Review rodaddy/demo#1 @ "));
		expect(reviews.length).toBe(1);
	});
	test("the webhook and the sweep racing on one head create one review task", async () => {
		const h = makeDeps({ createDelay: 5 });
		const ev = prFromApi("rodaddy/demo", apiPr(1));
		if (!ev) throw new Error("fixture must parse");
		const deps = { ...h.deps, companyId: "co-1" };
		const webhook = sweepModule.reviewPrOnce({ ...deps, postComment: async () => undefined }, ev);
		await Promise.all([runSweep(deps), webhook]);
		const reviews = h.created.filter((t) => t.title.startsWith("Review rodaddy/demo#1 @ "));
		expect(reviews.length).toBe(1);
		expect(h.state.get(`rodaddy/demo#1@${SHA}`)).toMatchObject({ issueId: expect.any(String) });
	});
	test("a non-2xx first call stops the sweep after 1 call", async () => {
		const h = makeDeps({ failFirst: true });
		const r = await runSweep(h.deps);
		expect(h.urls.length).toBe(1);
		expect(r.calls).toBe(1);
		expect(r.stopped).toBe(true);
		expect(r.created).toBe(0);
		expect(h.logs[0]).toMatch(/^forge-sweep stopped: \/repos\/issues\/search\?\S+ 502$/);
	});
	test("a thrown first fetch stops the sweep after 1 call", async () => {
		const h = makeDeps({ throwFirst: true });
		const r = await runSweep(h.deps);
		expect(h.urls.length).toBe(1);
		expect(h.logs[0]).toMatch(/^forge-sweep stopped: \S+ TypeError$/);
		expect(r.created).toBe(0);
	});
	test("rejects exactly the stale pending approval, never the live one", async () => {
		const h = makeDeps();
		const decided: Array<{ id: string; input: Record<string, unknown>; companyId: string }> = [];
		const approvals = {
			list: async () => [
				{
					id: "ap-stale",
					type: "request_board_approval",
					status: "pending",
					payload: { title: "Go on rodaddy/demo#1 at 1234567" },
				},
				{
					id: "ap-live",
					type: "request_board_approval",
					status: "pending",
					payload: { title: `Go on rodaddy/two#2 at ${SHA.slice(0, 7)}` },
				},
			],
			decide: async (id: string, input: Record<string, unknown>, companyId: string) => {
				decided.push({ id, input, companyId });
				return { approval: {}, applied: true };
			},
		};
		const r = await runSweep({
			...h.deps,
			approvals,
			companyId: "co-1",
			cfg: { ...h.deps.cfg, boardUserId: "operator-user" },
		});
		expect(decided.length).toBe(1);
		expect(decided[0]?.id).toBe("ap-stale");
		expect(decided[0]?.input.action).toBe("reject");
		expect(decided[0]?.input.actorUserId).toBe("operator-user");
		expect(decided[0]?.companyId).toBe("co-1");
		expect(r.stale).toBe(1);
		expect(h.logs.at(-1)).toMatch(/ stale=1 took=\d+$/);
	});

	type Decision = { id: string; input: Record<string, unknown>; companyId: string };
	const go = (id: string, target: string, over: Record<string, unknown> = {}) => ({
		id,
		type: "request_board_approval",
		status: "pending",
		payload: { title: `Go on ${target}` },
		...over,
	});
	const sweepWith = (
		h: ReturnType<typeof makeDeps>,
		pending: unknown[],
		over: { list?: () => Promise<unknown[]>; failDecide?: string } = {},
	) => {
		const decided: Decision[] = [];
		const approvals = {
			list: over.list ?? (async () => pending),
			decide: async (id: string, input: Record<string, unknown>, companyId: string) => {
				if (id === over.failDecide) throw new TypeError("decide body: top-secret-note");
				decided.push({ id, input, companyId });
				return { approval: {}, applied: true };
			},
		};
		const run = () =>
			runSweep({
				...h.deps,
				approvals,
				companyId: "co-1",
				cfg: { ...h.deps.cfg, boardUserId: "operator-user" },
			});
		return { decided, run };
	};
	const live = `rodaddy/two#2 at ${SHA.slice(0, 7)}`;

	test("rejects the approval of a merged PR and of a closed PR, head unchanged", async () => {
		const h = makeDeps({
			extra: {
				"/repos/rodaddy/three/pulls/20": { ...apiPr(20), merged: true, state: "closed" },
				"/repos/rodaddy/three/pulls/21": { ...apiPr(21), merged: false, state: "closed" },
			},
		});
		const s = sweepWith(h, [
			go("ap-merged", `rodaddy/three#20 at ${SHA.slice(0, 7)}`),
			go("ap-live", live),
			go("ap-closed", `rodaddy/three#21 at ${SHA.slice(0, 7)}`),
		]);
		const r = await s.run();
		expect(s.decided.map((d) => d.id)).toEqual(["ap-merged", "ap-closed"]);
		expect(s.decided.every((d) => d.input.action === "reject")).toBe(true);
		expect(r.stale).toBe(2);
	});
	test("an approval for a repo outside the allowlist is never fetched or decided", async () => {
		const h = makeDeps();
		const s = sweepWith(h, [go("ap-out", "outsider/repo#7 at 1234567")]);
		const r = await s.run();
		expect(s.decided).toEqual([]);
		expect(r.stale).toBe(0);
		expect(r.stopped).toBe(false);
		expect(h.urls.some((u) => u.includes("outsider"))).toBe(false);
	});
	test("decides at most 20 approvals in one run", async () => {
		const h = makeDeps();
		const s = sweepWith(
			h,
			Array.from({ length: 25 }, (_, i) => go(`ap-${i}`, "rodaddy/demo#1 at 1234567")),
		);
		const r = await s.run();
		expect(s.decided.length).toBe(20);
		expect(r.stale).toBe(20);
	});
	test("an approval that names a PR but is not a merge go stays pending", async () => {
		const h = makeDeps();
		const before = h.urls.length;
		const s = sweepWith(h, [
			// Same type, another ask about the same stale head.
			go("ap-deploy", "x", { payload: { title: "Deploy rodaddy/demo#1 at 1234567 to prod" } }),
			// A merge-go title under another approval type.
			go("ap-hire", "rodaddy/demo#1 at 1234567", { type: "hire_agent" }),
			// Payload fields alone, no merge-go title.
			go("ap-fields", "x", {
				payload: { title: "Rollback", repo: "rodaddy/demo", number: 1, headSha: "1234567" },
			}),
		]);
		const r = await s.run();
		expect(s.decided).toEqual([]);
		expect(r.stale).toBe(0);
		// Only the two searches and the PR sweep's own detail GETs: no approval target fetched.
		expect(h.urls.slice(before).length).toBe(5);
	});
	test("an inaccessible approval target stops one run, then is skipped so later cleanup happens", async () => {
		for (const status of [404, 403]) {
			const h = makeDeps({ extra: { "/repos/rodaddy/demo/pulls/99": status } });
			const s = sweepWith(h, [
				go("ap-bad", "rodaddy/demo#99 at 1234567"),
				go("ap-stale", "rodaddy/demo#1 at 1234567"),
			]);
			const r1 = await s.run();
			expect(r1.stopped).toBe(true);
			expect(r1.stale).toBe(0);
			expect(s.decided).toEqual([]);
			expect(h.logs).toContain(
				`forge-sweep approval ap-bad quarantined: /repos/rodaddy/demo/pulls/99 ${status}`,
			);
			expect(h.state.get("approvalbad:ap-bad")).toBeTruthy();
			const before = h.urls.length;
			const r2 = await s.run();
			expect(r2.stopped).toBe(false);
			expect(r2.stale).toBe(1);
			expect(s.decided.map((d) => d.id)).toEqual(["ap-stale"]);
			expect(h.urls.slice(before).some((u) => u.endsWith("/pulls/99"))).toBe(false);
			expect(h.logs).toContain(
				"forge-sweep approvals quarantined=1 (inaccessible PR, left pending)",
			);
		}
	});
	test("a 502 on an approval target stops the run and quarantines nothing", async () => {
		const h = makeDeps({ extra: { "/repos/rodaddy/demo/pulls/99": 502 } });
		const s = sweepWith(h, [go("ap-flaky", "rodaddy/demo#99 at 1234567")]);
		const r = await s.run();
		expect(r.stopped).toBe(true);
		expect(h.state.has("approvalbad:ap-flaky")).toBe(false);
	});
	test("a failing approvals.list is logged by name with the summary, never thrown", async () => {
		const h = makeDeps();
		const s = sweepWith(h, [], {
			list: async () => {
				throw new RangeError("list body: top-secret-note");
			},
		});
		const r = await s.run();
		expect(r.stopped).toBe(true);
		expect(r.created).toBe(3);
		expect(h.logs).toContain("forge-sweep stopped: approvals.list RangeError");
		expect(h.logs.at(-1)).toMatch(/^forge-sweep repos=3 .* stale=0 took=\d+$/);
		expect(h.logs.join("\n")).not.toContain("top-secret-note");
	});
	test("a failing approvals.decide is logged with the summary and the count so far", async () => {
		const h = makeDeps();
		const s = sweepWith(
			h,
			[go("ap-1", "rodaddy/demo#1 at 1234567"), go("ap-2", "rodaddy/demo#1 at 7654321")],
			{ failDecide: "ap-2" },
		);
		const r = await s.run();
		expect(r.stopped).toBe(true);
		expect(r.stale).toBe(1);
		expect(s.decided.map((d) => d.id)).toEqual(["ap-1"]);
		expect(h.logs).toContain("forge-sweep stopped: approvals.decide ap-2 TypeError");
		expect(h.logs.at(-1)).toMatch(/ stale=1 took=\d+$/);
		expect(h.logs.join("\n")).not.toContain("top-secret-note");
	});

	describe("a live merge go that is not the operator's (merge-check class)", () => {
		type Verdict = { class: string; reasons: string[] } | null;
		const classified = (h: ReturnType<typeof makeDeps>, answer: () => Verdict) => {
			const calls: unknown[][] = [];
			Object.assign(h.deps, {
				classify: async (repo: string, number: number, sha: string) => {
					calls.push([repo, number, sha]);
					return answer();
				},
			});
			return calls;
		};
		for (const [cls, reasons, note] of [
			["A", ["checks green", "verdict approve"], "class A (checks green; verdict approve)"],
			["C", ["no checks: council"], "class C (no checks: council)"],
		] as const) {
			test(`class ${cls} is rejected with the merge-check note`, async () => {
				const h = makeDeps();
				const calls = classified(h, () => ({ class: cls, reasons: [...reasons] }));
				const s = sweepWith(h, [go("ap-live", live)]);
				const r = await s.run();
				expect(calls).toEqual([["rodaddy/two", 2, SHA]]);
				expect(s.decided.map((d) => [d.id, d.input.action, d.input.decisionNote])).toEqual([
					["ap-live", "reject", `Not the operator's: merge-check ${note}`],
				]);
				expect(r.stale).toBe(1);
			});
		}
		test("class B stays pending", async () => {
			const h = makeDeps();
			classified(h, () => ({ class: "B", reasons: ["label needs-operator"] }));
			const s = sweepWith(h, [go("ap-live", live)]);
			expect((await s.run()).stale).toBe(0);
			expect(s.decided).toEqual([]);
		});
		test("a classify that throws leaves it pending, logged by name only", async () => {
			const h = makeDeps();
			classified(h, () => {
				throw new TypeError("merge-check stderr: top-secret-note");
			});
			const s = sweepWith(h, [go("ap-live", live)]);
			const r = await s.run();
			expect(s.decided).toEqual([]);
			expect(r.stopped).toBe(false);
			expect(h.logs).toContain("forge-sweep approval ap-live classify failed: TypeError");
			expect(h.logs.join("\n")).not.toContain("top-secret-note");
		});
		test("a classify that answers null leaves it pending", async () => {
			const h = makeDeps();
			classified(h, () => null);
			const s = sweepWith(h, [go("ap-live", live)]);
			expect((await s.run()).stale).toBe(0);
			expect(s.decided).toEqual([]);
		});
		test("the 'Go on <owner/repo> PR <n> at <sha7>' title form is a merge go", async () => {
			const approval = go("ap-pr", `rodaddy/two PR 2 at ${SHA.slice(0, 7)}`);
			expect(sweepModule.isMergeApproval(approval)).toBe(true);
			expect(sweepModule.approvalTarget(approval)).toEqual({
				repo: "rodaddy/two",
				number: 2,
				sha: SHA.slice(0, 7),
			});
			const h = makeDeps();
			classified(h, () => ({ class: "C", reasons: ["no checks: council"] }));
			const s = sweepWith(h, [approval]);
			await s.run();
			expect(s.decided.map((d) => d.id)).toEqual(["ap-pr"]);
		});
	});
	// PR 912 got 15 heads in 8 hours; 70 of 105 review tasks finished on stale heads.
	describe("a head is reviewed once its checks settle", () => {
		// The combined status every head answers; flipped by the test.
		const checked = (h: ReturnType<typeof makeDeps>, state: { now: string }) => {
			let t = Date.parse("2026-10-01T00:00:00Z");
			const deps = {
				...h.deps,
				now: () => t,
				checksOf: async () => ({ state: state.now, total_count: 3, statuses: [] }),
			};
			const advance = (ms: number) => {
				t += ms;
			};
			return { deps, advance };
		};
		const reviews = (h: ReturnType<typeof makeDeps>) =>
			h.created.map((t) => t.title).filter((t) => t.startsWith("Review "));
		const sha7 = SHA.slice(0, 7);
		test("a head with pending checks gets no task, however long; once they finish it gets exactly one", async () => {
			const h = makeDeps();
			const s = { now: "pending" };
			const c = checked(h, s);
			await runSweep(c.deps);
			c.advance(60 * 60 * 1000);
			await runSweep(c.deps);
			expect(reviews(h)).toEqual([]);
			s.now = "success";
			await runSweep(c.deps);
			expect(reviews(h)).toEqual([
				`Review rodaddy/demo#1 @ ${sha7}`,
				`Review rodaddy/two#2 @ ${sha7}`,
			]);
			await runSweep(c.deps);
			expect(reviews(h).length).toBe(2);
			expect("REVIEW_SETTLE_MS" in sweepModule).toBe(false);
		});
		test("a tier 5 head the webhook recorded is created by the sweep once its checks finish", async () => {
			const h = makeDeps({ tiers: { "rodaddy/demo": 5 } });
			const s = { now: "pending" };
			const c = checked(h, s);
			const ev = prFromApi("rodaddy/demo", apiPr(1));
			if (!ev) throw new Error("fixture must parse");
			const hook = { ...c.deps, companyId: "co-1", postComment: async () => undefined };
			expect((await sweepModule.reviewPrOnce(hook, ev)).outcome).toBe("settling");
			s.now = "failure";
			await runSweep(c.deps);
			expect(reviews(h)).toContain(`Review rodaddy/demo#1 @ ${sha7}`);
		});
	});
});

describe("a new head's review retires older heads' open reviews", () => {
	test("the older open parent is cancelled; its per-reviewer child and closed parents are left", async () => {
		const p = "Review rodaddy/demo#1 @ ";
		const board = [
			{ id: "old", title: `${p}1111111`, status: "in_progress" },
			{ id: "child", title: `${p}1111111 — Adams`, status: "todo" },
			{ id: "closed", title: `${p}2222222`, status: "done" },
			{ id: "new", title: `${p}${SHA.slice(0, 7)}`, status: "todo" },
		];
		const cancelled: Array<[string, string]> = [];
		const state = new Map<string, unknown>();
		const ev = prFromApi("rodaddy/demo", apiPr(1));
		if (!ev) throw new Error("fixture must parse");
		const r = await sweepModule.reviewPrOnce(
			{
				companyId: "co-1",
				cfg: { reviewerAgentId: "r", triageAgentId: "t" },
				listTitles: async () => [],
				postComment: async () => undefined,
				stateGet: async (k: string) => state.get(k) ?? null,
				stateSet: async (k: string, v: unknown) => void state.set(k, v),
				log: () => undefined,
				createTask: async () => ({ id: "new" }),
				listIssues: async () => board,
				cancelTask: async (id: string, comment: string) => void cancelled.push([id, comment]),
			},
			ev,
		);
		expect(r.outcome).toBe("created");
		expect(cancelled).toEqual([["old", `Superseded: head moved to ${SHA.slice(0, 7)}.`]]);
	});
});

describe("settleFinishedTasks", () => {
	const BASE = "https://forge.example.internal/api/v1";
	const harness = (
		tasks: Array<{ id: string; title: string; status: string }>,
		prs: Record<string, unknown>,
	) => {
		const settled: Array<{ id: string; status: string; comment: string }> = [];
		const reads: string[] = [];
		const logs: string[] = [];
		const deps = {
			fetch: async (url: string) => {
				const path = url.slice(BASE.length);
				reads.push(path);
				const x = prs[path];
				if (x === undefined || typeof x === "number")
					return new Response("no", { status: (x as number) ?? 404 });
				return new Response(JSON.stringify(x), { status: 200 });
			},
			baseUrl: BASE,
			token: "t",
			repos: ["rodaddy/demo"],
			log: (l: string) => void logs.push(l),
			listOpenTasks: async () => tasks,
			settleTask: async (id: string, p: { status: string; comment: string }) =>
				void settled.push({ id, ...p }),
		};
		return { deps, settled, reads, logs };
	};
	const SHA7 = "abcdef1";

	test("merged PR -> done, closed PR -> cancelled, open PR -> untouched", async () => {
		const h = harness(
			[
				{ id: "m", title: `Merge rodaddy/demo#1 @ ${SHA7}`, status: "blocked" },
				{ id: "r", title: `Review rodaddy/demo#1 @ ${SHA7}`, status: "todo" },
				{ id: "c", title: "Rework rodaddy/demo#2: review round limit", status: "todo" },
				{ id: "o", title: `Review rodaddy/demo#3 @ ${SHA7}`, status: "in_progress" },
			],
			{
				"/repos/rodaddy/demo/pulls/1": { state: "closed", merged: true },
				"/repos/rodaddy/demo/pulls/2": { state: "closed", merged: false },
				"/repos/rodaddy/demo/pulls/3": { state: "open", merged: false },
			},
		);
		expect(await sweepModule.settleFinishedTasks(h.deps)).toBe(3);
		expect(h.settled).toEqual([
			{ id: "m", status: "done", comment: "Settled: rodaddy/demo#1 merged." },
			{ id: "r", status: "done", comment: "Settled: rodaddy/demo#1 merged." },
			{ id: "c", status: "cancelled", comment: "Settled: rodaddy/demo#2 closed." },
		]);
		// One read per PR per pass.
		expect(h.reads).toEqual([
			"/repos/rodaddy/demo/pulls/1",
			"/repos/rodaddy/demo/pulls/2",
			"/repos/rodaddy/demo/pulls/3",
		]);
	});

	test("a failed PR read leaves the task; done, unwatched and other titles are never read", async () => {
		const h = harness(
			[
				{ id: "f", title: `Merge rodaddy/demo#4 @ ${SHA7}`, status: "blocked" },
				{ id: "d", title: `Review rodaddy/demo#5 @ ${SHA7}`, status: "done" },
				{ id: "x", title: `Review outsider/repo#6 @ ${SHA7}`, status: "todo" },
				{ id: "t", title: "Triage rodaddy/demo#7", status: "todo" },
			],
			{ "/repos/rodaddy/demo/pulls/4": 502 },
		);
		expect(await sweepModule.settleFinishedTasks(h.deps)).toBe(0);
		expect(h.settled).toEqual([]);
		expect(h.reads).toEqual(["/repos/rodaddy/demo/pulls/4"]);
		expect(h.logs).toContain("forge-sweep settle read failed rodaddy/demo#4: 502");
	});

	test("more PRs than the bound: only MAX_SETTLE_READS read and settled in one pass", async () => {
		const n = sweepModule.MAX_SETTLE_READS + 5;
		const tasks = Array.from({ length: n }, (_, i) => ({
			id: `t${i}`,
			title: `Merge rodaddy/demo#${i + 1} @ ${SHA7}`,
			status: "blocked",
		}));
		const prs = Object.fromEntries(
			tasks.map((_, i) => [
				`/repos/rodaddy/demo/pulls/${i + 1}`,
				{ state: "closed", merged: true },
			]),
		);
		const h = harness(tasks, prs);
		expect(await sweepModule.settleFinishedTasks(h.deps)).toBe(sweepModule.MAX_SETTLE_READS);
		expect(h.reads.length).toBe(sweepModule.MAX_SETTLE_READS);
	});

	test("50 open PRs ahead of a merged one: later passes rotate past them and settle it", async () => {
		const open = Array.from({ length: sweepModule.MAX_SETTLE_READS }, (_, i) => ({
			id: `o${i}`,
			title: `Review rodaddy/demo#${i + 1} @ ${SHA7}`,
			status: "todo",
		}));
		const last = sweepModule.MAX_SETTLE_READS + 1;
		const tasks = [
			...open,
			{ id: "m", title: `Merge rodaddy/demo#${last} @ ${SHA7}`, status: "blocked" },
		];
		const prs: Record<string, unknown> = Object.fromEntries(
			open.map((_, i) => [`/repos/rodaddy/demo/pulls/${i + 1}`, { state: "open", merged: false }]),
		);
		prs[`/repos/rodaddy/demo/pulls/${last}`] = { state: "closed", merged: true };
		const h = harness(tasks, prs);
		const state = new Map<string, unknown>();
		const deps = {
			...h.deps,
			stateGet: async (k: string) => state.get(k),
			stateSet: async (k: string, v: unknown) => void state.set(k, v),
		};
		for (let pass = 0; pass < 3 && h.settled.length === 0; pass++) {
			const before = h.reads.length;
			await sweepModule.settleFinishedTasks(deps);
			expect(h.reads.length - before).toBeLessThanOrEqual(sweepModule.MAX_SETTLE_READS);
		}
		expect(h.settled).toEqual([
			{ id: "m", status: "done", comment: `Settled: rodaddy/demo#${last} merged.` },
		]);
	});

	test("runSweep runs the settle pass even after a Forge stop", async () => {
		const h = harness([{ id: "m", title: `Merge rodaddy/demo#1 @ ${SHA7}`, status: "blocked" }], {
			"/repos/rodaddy/demo/pulls/1": { state: "closed", merged: true },
		});
		const r = await runSweep({
			...h.deps,
			now: () => 0,
			stateGet: async () => null,
			stateSet: async () => {},
			createTask: async () => ({ id: "x" }),
			listTitles: async () => [],
			cfg: { reviewerAgentId: "r", triageAgentId: "t" },
		});
		expect(r.stopped).toBe(true);
		expect(h.settled.map((s) => s.id)).toEqual(["m"]);
	});
});
