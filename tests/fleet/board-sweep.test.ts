/**
 * @module tests/fleet/board-sweep
 * @description `fleet/skills/board-sweep/bin/board-sweep`, run as a
 *   real child process against a fake board and a fake Forge on one port. Every
 *   request is recorded, so each test asserts on what was written and in what
 *   order: a dry run writes nothing, a write is a comment then a PATCH, review
 *   duplicates group by exact title, Nagatha's work is never touched, stalled
 *   reviews are kickstarted or kicked back, and the todo queue is released by
 *   priority within each assignee's free run slots.
 *   `BOARD_SWEEP_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT =
	process.env.BOARD_SWEEP_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/board-sweep/bin/board-sweep");
const TOKEN = ["fake", "forge", "value", "1338"].join("-");
const BOARD_KEY = ["fake", "board", "value", "1338"].join("-");
const COMPANY = "co-1";
const NAGATHA = "agent-nagatha";
const SMYTHE = "agent-smythe";
const BISHOP = "agent-bishop";
const ADAMS = "agent-adams";
const CHANG = "agent-chang";
const LIVE = "b".repeat(40);

type Issue = {
	description?: string;
	createdByAgentId?: string;
	id: string;
	identifier: string;
	title: string;
	status: string;
	createdAt: string;
	assigneeAgentId?: string | null;
	parentId?: string | null;
	originKind?: string;
	originId?: string | null;
	updatedAt?: string;
	priority?: string;
	labels?: { name: string }[];
	/** First-class blocker ids: only the detail read shows them, as `blockedBy` summaries. */
	blockedByIds?: string[];
};
type Run = { agentId: string; status: string; contextSnapshot?: { issueId: string } };
type Pr = { state: string; merged: boolean; sha: string };
type ForgeIssue = {
	state: string;
	user: { login: string };
	comments: { user: { login: string }; created_at: string }[];
};
type Req = { method: string; path: string; body: unknown; runId: string | null };

let issues: Issue[] = [];
let pulls: Record<string, Pr> = {};
let forgeIssues: Record<string, ForgeIssue> = {};
/**
 * Heartbeat runs (the old, windowed read: the fake honours `limit`), live runs
 * (queued and running, capped at 50 rows like the real board), each issue's own
 * runs, board comments per issue id, commit statuses per sha, Forge PR comments.
 */
let runs: Run[] = [];
let liveRuns: Run[] = [];
let issueRuns: Record<string, Run[]> = {};
let boardComments: Record<string, { body: string; authorAgentId?: string; createdAt?: string }[]> =
	{};
let statuses: Record<string, { context: string; status: string }[]> = {};
let prComments: Record<string, { body: string }[]> = {};
let log: Req[] = [];
/** Issue ids whose detail read answers without a `blockedBy` array. */
let detailWithoutBlockers = new Set<string>();
/** A board write the fake answers itself (429, 422, ...) before its normal reply. */
let fault: ((method: string, path: string) => Response | undefined) | null = null;
let server: ReturnType<typeof Bun.serve>;
let api = "";

let seq = 0;
function issue(title: string, extra: Partial<Issue> = {}): Issue {
	seq += 1;
	return {
		id: `i-${seq}`,
		identifier: `SOF-${seq}`,
		title,
		status: "blocked",
		createdAt: `2026-10-03T10:${String(seq).padStart(2, "0")}:00.000Z`,
		assigneeAgentId: SMYTHE,
		parentId: null,
		originKind: "manual",
		originId: null,
		description: LIVE,
		...extra,
	};
}

beforeEach(() => {
	issues = [];
	pulls = {
		"o/r#1": { state: "closed", merged: true, sha: LIVE },
		"o/r#2": { state: "open", merged: false, sha: LIVE },
		"o/r#3": { state: "closed", merged: false, sha: LIVE },
	};
	forgeIssues = {};
	runs = [];
	liveRuns = [];
	issueRuns = {};
	boardComments = {};
	statuses = {};
	prComments = {};
	log = [];
	detailWithoutBlockers = new Set();
	fault = null;
});

/** An issue as a list row: like the real board, no blockedBy. */
const row = ({ blockedByIds: _, ...rest }: Issue) => rest;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const u = new URL(req.url);
			const raw = req.method === "GET" ? "" : await req.text();
			log.push({
				method: req.method,
				path: u.pathname + u.search,
				body: raw ? JSON.parse(raw) : null,
				runId: req.headers.get("x-paperclip-run-id"),
			});
			if (u.pathname.startsWith("/api/")) {
				if (req.headers.get("authorization") !== `Bearer ${BOARD_KEY}`)
					return new Response("auth", { status: 401 });
				const injected = fault?.(req.method, u.pathname);
				if (injected) return injected;
				if (u.pathname === `/api/companies/${COMPANY}/agents`)
					return Response.json([
						{ id: NAGATHA, name: "Nagatha" },
						{ id: SMYTHE, name: "Smythe", runtimeConfig: { heartbeat: { maxConcurrentRuns: 6 } } },
						{ id: BISHOP, name: "Bishop" },
						{ id: ADAMS, name: "Adams" },
						{ id: CHANG, name: "Chang" },
						...["Colter", "Giraud", "Kong"].map((name) => ({
							id: `agent-${name.toLowerCase()}`,
							name,
						})),
					]);
				if (u.pathname === `/api/companies/${COMPANY}/heartbeat-runs`)
					return Response.json(runs.slice(0, Number(u.searchParams.get("limit") ?? "100")));
				if (u.pathname === `/api/companies/${COMPANY}/live-runs`)
					return Response.json(liveRuns.slice(0, 50));
				if (u.pathname === `/api/companies/${COMPANY}/issues` && req.method === "POST") {
					const made = issue("", { status: "todo", ...(JSON.parse(raw) as Partial<Issue>) });
					issues.push(made);
					return Response.json(made, { status: 201 });
				}
				if (u.pathname === `/api/companies/${COMPANY}/issues`) {
					const status = u.searchParams.get("status");
					const limit = Number(u.searchParams.get("limit") ?? "50");
					const offset = Number(u.searchParams.get("offset") ?? "0");
					const hit = issues.filter((i) => !status || i.status === status);
					return Response.json(hit.slice(offset, offset + limit).map(row));
				}
				if (u.pathname.endsWith("/activity")) return Response.json([]);
				const rm = u.pathname.match(/^\/api\/issues\/([\w-]+)\/runs$/);
				if (rm && req.method === "GET") return Response.json(issueRuns[rm[1] as string] ?? []);
				const m = u.pathname.match(/^\/api\/issues\/([\w-]+)(\/comments)?$/);
				const target = m ? issues.find((i) => i.id === m[1]) : undefined;
				if (!m || !target) return new Response("nf", { status: 404 });
				if (req.method === "GET" && m[2]) return Response.json(boardComments[target.id] ?? []);
				if (req.method === "GET") {
					if (detailWithoutBlockers.has(target.id)) return Response.json(row(target));
					const blockedBy = (target.blockedByIds ?? []).map((id) => {
						const b = issues.find((i) => i.id === id) as Issue;
						return { id: b.id, identifier: b.identifier, title: b.title, status: b.status };
					});
					return Response.json({ ...row(target), blockedBy, blocks: [] });
				}
				if (req.method === "POST" && m[2]) {
					boardComments[target.id] = [
						...(boardComments[target.id] ?? []),
						JSON.parse(raw) as { body: string },
					];
					return Response.json({ id: "c-1" }, { status: 201 });
				}
				if (req.method === "PATCH" && !m[2]) {
					target.status = (JSON.parse(raw) as { status: string }).status;
					return Response.json(target);
				}
				return new Response("bad", { status: 405 });
			}
			if (req.headers.get("authorization") !== `token ${TOKEN}`)
				return new Response("auth", { status: 401 });
			const sm = u.pathname.match(/^\/repos\/[\w.-]+\/[\w.-]+\/commits\/(\w+)\/status$/);
			if (sm) return Response.json({ statuses: statuses[sm[1] as string] ?? [] });
			const im = u.pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(\/comments)?$/);
			const pk = im ? `${im[1]}#${im[2]}` : "";
			if (im?.[3] && pulls[pk] && !forgeIssues[pk]) {
				if (req.method === "POST") {
					prComments[pk] = [...(prComments[pk] ?? []), JSON.parse(raw) as { body: string }];
					return Response.json({ id: 1 }, { status: 201 });
				}
				return Response.json(prComments[pk] ?? []);
			}
			if (im) {
				const fi = forgeIssues[`${im[1]}#${im[2]}`];
				if (!fi) return new Response("nf", { status: 404 });
				if (im[3]) return Response.json(fi.comments);
				return Response.json({ state: fi.state, user: fi.user });
			}
			const m = u.pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)$/);
			const pr = m ? pulls[`${m[1]}#${m[2]}`] : undefined;
			if (!pr) return new Response("nf", { status: 404 });
			return Response.json({
				state: pr.state,
				merged: pr.merged,
				head: { sha: pr.sha },
				user: { login: "author" },
			});
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function run(args: string[] = [], env: Record<string, string> = {}) {
	const p = Bun.spawn(["python3", SCRIPT, ...args, "--base-url", api, "--forge-url", api], {
		env: {
			PATH: process.env.PATH ?? "",
			FORGEJO_TOKEN: TOKEN,
			PAPERCLIP_API_KEY: BOARD_KEY,
			PAPERCLIP_COMPANY_ID: COMPANY,
			PAPERCLIP_RUN_ID: "run-1",
			BOARD_SWEEP_NO_WAIT: "1",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
}

async function pairVerdict(authority = false) {
	const gate = resolve(import.meta.dir, "../../fleet/skills/merge-pr/bin/merge-check");
	const p = Bun.spawn(
		[
			"python3",
			"-c",
			`import runpy,sys,json; m=runpy.run_path(sys.argv[1]); print(json.dumps(m['${authority ? "review_verdict" : "pair_verdict"}'](*sys.argv[2:])[0]))`,
			gate,
			api,
			BOARD_KEY,
			COMPANY,
			"o/r",
			"2",
			LIVE,
			"author",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [out, err, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	expect({ code, err }).toEqual({ code: 0, err: "" });
	return JSON.parse(out);
}

const writes = () => log.filter((r) => r.method !== "GET");
const writesFor = (i: Issue) => writes().filter((r) => r.path.startsWith(`/api/issues/${i.id}`));
type Item = { identifier: string; action: string; reason: string; assignee: string | null };
const itemFor = (out: { items: Item[] }, i: Issue) =>
	out.items.find((x) => x.identifier === i.identifier) as Item;

describe("board-sweep", () => {
	test("a dry run makes zero writes and still reports the plan", async () => {
		const merged = issue(`Review o/r#1 @ ${LIVE.slice(0, 7)}`);
		const stray = issue("Something unusual");
		issues = [merged, stray];
		const r = await run();
		expect(r.code).toBe(0);
		expect(writes()).toEqual([]);
		expect(r.json.mode).toBe("dry-run");
		expect(r.json.blocked_before).toBe(2);
		expect(r.json.actions.cancel).toBe(1);
		expect(r.json.actions.other).toBe(1);
		expect(itemFor(r.json, merged)).toMatchObject({ action: "cancel", reason: "PR merged" });
		expect(r.json.blocked_after).toBeUndefined();
	});

	test("a review for a merged PR: comment, then PATCH cancelled, in that order", async () => {
		const merged = issue(`Review o/r#1 @ ${LIVE.slice(0, 7)}`);
		const closed = issue(`Review o/r#3 @ ${LIVE.slice(0, 7)}`);
		issues = [merged, closed];
		const r = await run(["--apply"]);
		expect(r.code).toBe(0);
		const w = writesFor(merged);
		expect(w.map((x) => x.method)).toEqual(["POST", "PATCH"]);
		expect(w[0]?.path).toBe(`/api/issues/${merged.id}/comments`);
		expect(w[0]?.body).toEqual({ body: "board-sweep: cancel -- PR merged" });
		expect(w[1]?.body).toEqual({ status: "cancelled" });
		expect(w.every((x) => x.runId === "run-1")).toBe(true);
		expect(itemFor(r.json, closed).reason).toBe("PR closed");
		expect(r.json.mode).toBe("apply");
		expect(r.json.blocked_after).toBe(0);
	});

	test("same-title reviews of the live head: newest todo, older superseded; lead and Chang are separate", async () => {
		const title = `Review o/r#2 @ ${LIVE.slice(0, 7)}`;
		const old = issue(title);
		const chang = issue(`Chang: ${title}`, { createdAt: "2026-10-03T09:00:00.000Z" });
		const fresh = issue(title);
		issues = [fresh, chang, old];
		const r = await run(["--apply"]);
		expect(r.code).toBe(0);
		expect(itemFor(r.json, fresh)).toMatchObject({
			action: "todo",
			reason: "newest review for the live head",
		});
		expect(itemFor(r.json, old)).toMatchObject({
			action: "cancel",
			reason: `superseded by ${fresh.identifier}`,
		});
		expect(itemFor(r.json, chang).action).toBe("todo");
		expect(writesFor(fresh).map((x) => x.body)).toEqual([
			{ body: "board-sweep: todo -- newest review for the live head" },
			{ status: "todo" },
		]);
		expect(writesFor(old)[1]?.body).toEqual({ status: "cancelled" });
		expect(writesFor(chang)[1]?.body).toEqual({ status: "todo" });
	});

	test("reviewer sub-task titles count as reviews: a merged PR cancels every shape", async () => {
		const sha = LIVE.slice(0, 7);
		const shapes = [
			`Adams: blind review o/r#1 @ ${sha}`,
			`Chang: blind senior shadow review o/r#1 @ ${sha}`,
			`Adams: blind shadow review o/r#1 @ ${sha}`,
			`Chang review o/r#1 @ ${sha}`,
			`Blind review o/r#1 @ ${sha}`,
		];
		const all = shapes.map((title) => issue(title));
		issues = [...all];
		const r = await run(["--apply"]);
		expect(r.code).toBe(0);
		for (const it of all) {
			expect(itemFor(r.json, it)).toMatchObject({ action: "cancel", reason: "PR merged" });
		}
		expect(r.json.actions.other).toBe(0);
	});

	test("a review whose sha is not the live head is cancelled, head moved", async () => {
		const stale = issue(`Review o/r#2 @ ${"c".repeat(7)}`);
		issues = [stale];
		const r = await run(["--apply"]);
		expect(itemFor(r.json, stale)).toMatchObject({
			action: "cancel",
			reason: `head moved to ${LIVE.slice(0, 7)}`,
		});
		expect(writesFor(stale)[1]?.body).toEqual({ status: "cancelled" });
	});

	test("Nagatha's blocked task is untouched, action nagatha", async () => {
		const hers = issue(`Review o/r#1 @ ${LIVE.slice(0, 7)}`, { assigneeAgentId: NAGATHA });
		issues = [hers];
		const r = await run(["--apply"]);
		expect(r.code).toBe(0);
		expect(itemFor(r.json, hers).action).toBe("nagatha");
		expect(r.json.actions.nagatha).toBe(1);
		expect(writes()).toEqual([]);
	});

	test("three blocked instances of one routine plus an open todo instance: all three cancelled", async () => {
		const routine = { originKind: "routine_execution", originId: "rt-1" };
		const a = issue("Hourly sweep", routine);
		const b = issue("Hourly sweep", routine);
		const c = issue("Hourly sweep", routine);
		const live = issue("Hourly sweep", { ...routine, status: "todo" });
		issues = [a, b, c, live];
		const r = await run(["--apply"]);
		expect(r.code).toBe(0);
		for (const i of [a, b, c]) {
			expect(itemFor(r.json, i)).toMatchObject({
				action: "cancel",
				reason: `one open instance per routine; newest is ${live.identifier}`,
			});
			expect(writesFor(i).map((x) => x.method)).toEqual(["POST", "PATCH"]);
		}
		expect(writesFor(live)).toEqual([]);
		expect(r.json.blocked_after).toBe(0);
	});

	test("a newest routine instance that is blocked stays blocked as routine-kept", async () => {
		const routine = { originKind: "routine_execution", originId: "rt-2" };
		const older = issue("Daily", routine);
		const top = issue("Daily", routine);
		issues = [older, top];
		const r = await run(["--apply"]);
		expect(itemFor(r.json, top).action).toBe("routine-kept");
		expect(itemFor(r.json, older).action).toBe("cancel");
		expect(writesFor(top)).toEqual([]);
	});

	test("a stalled parent whose children are all done goes to todo", async () => {
		const parent = issue("Triage Epic");
		const k1 = issue("child 1", { parentId: parent.id, status: "done" });
		const k2 = issue("child 2", { parentId: parent.id, status: "cancelled" });
		const busy = issue("Triage Epic 2");
		const k3 = issue("child 3", { parentId: busy.id, status: "done" });
		const k4 = issue("child 4", { parentId: busy.id, status: "in_progress" });
		issues = [parent, k1, k2, busy, k3, k4];
		const r = await run(["--apply"]);
		expect(itemFor(r.json, parent)).toMatchObject({
			action: "todo",
			reason: "all children finished",
		});
		expect(writesFor(parent)[1]?.body).toEqual({ status: "todo" });
		expect(itemFor(r.json, busy).action).toBe("other");
		expect(writesFor(busy)).toEqual([]);
	});

	describe("a parent with finished children still waits on its first-class blockers (SOF-10842)", () => {
		test("SOF-10510 shape: done direct child, nested in_progress blocker: stays blocked, no writes", async () => {
			// SOF-10510 (blocked) -> child SOF-10579 (done) -> child SOF-10584 (in_progress),
			// and SOF-10510 is blockedBy SOF-10584. Direct-child terminality alone said todo.
			const parent = issue("Merge parent");
			const child = issue("direct child", { parentId: parent.id, status: "done" });
			const nested = issue("nested blocker", { parentId: child.id, status: "in_progress" });
			parent.blockedByIds = [nested.id];
			issues = [parent, child, nested];
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, parent)).toMatchObject({
				action: "other",
				reason: `children finished; blocked by ${nested.identifier} (in_progress)`,
			});
			expect(r.json.actions.todo).toBe(0);
			expect(writes()).toEqual([]);
			expect(parent.status).toBe("blocked");
			// The list rows carry no blockedBy, so the decision came from the detail read.
			expect(log.some((x) => x.method === "GET" && x.path === `/api/issues/${parent.id}`)).toBe(
				true,
			);
		});

		test("every non-done blocker status keeps the parent blocked, cancelled included", async () => {
			const unresolved = ["backlog", "todo", "in_progress", "in_review", "blocked", "cancelled"];
			const parents = unresolved.map((status) => {
				const p = issue(`Triage parent waiting on ${status}`);
				const kid = issue(`child of ${status}`, { parentId: p.id, status: "done" });
				const dep = issue(`blocker ${status}`, { status });
				p.blockedByIds = [dep.id];
				issues.push(p, kid, dep);
				return { p, dep, status };
			});
			const r = await run(["--apply"]);
			for (const { p, dep, status } of parents) {
				expect(itemFor(r.json, p)).toMatchObject({
					action: "other",
					reason: `children finished; blocked by ${dep.identifier} (${status})`,
				});
				expect(writesFor(p)).toEqual([]);
				expect(p.status).toBe("blocked");
			}
			expect(r.json.actions.todo).toBe(0);
		});

		test("one done blocker and one open blocker: still blocked, the open one named", async () => {
			const parent = issue("Triage Epic");
			const kid = issue("child", { parentId: parent.id, status: "done" });
			const ok = issue("finished blocker", { status: "done" });
			const open = issue("open blocker", { status: "todo" });
			parent.blockedByIds = [ok.id, open.id];
			issues = [parent, kid, ok, open];
			const r = await run(["--apply"]);
			expect(itemFor(r.json, parent)).toMatchObject({
				action: "other",
				reason: `children finished; blocked by ${open.identifier} (todo)`,
			});
			expect(writesFor(parent)).toEqual([]);
		});

		test("every blocker done: todo, comment then PATCH", async () => {
			const parent = issue("Triage Epic");
			const kid = issue("child", { parentId: parent.id, status: "cancelled" });
			const dep = issue("blocker", { status: "done" });
			parent.blockedByIds = [dep.id];
			issues = [parent, kid, dep];
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, parent)).toMatchObject({
				action: "todo",
				reason: "all children finished",
			});
			expect(writesFor(parent).map((x) => x.body)).toEqual([
				{ body: "board-sweep: todo -- all children finished" },
				{ status: "todo" },
			]);
			expect(parent.status).toBe("todo");
		});

		test("a failed detail read fails closed: other, errors 1, exit 1, no writes", async () => {
			const parent = issue("Triage Epic");
			const kid = issue("child", { parentId: parent.id, status: "done" });
			issues = [parent, kid];
			fault = (method, path) =>
				method === "GET" && path === `/api/issues/${parent.id}`
					? Response.json({ error: "boom" }, { status: 500 })
					: undefined;
			const r = await run(["--apply"]);
			expect(r.code).toBe(1);
			expect(r.json.errors).toBe(1);
			expect(itemFor(r.json, parent)).toMatchObject({
				action: "other",
				reason: "children finished; blocker read failed",
			});
			expect(writes()).toEqual([]);
			expect(r.stderr).toContain(`board GET detail for ${parent.identifier} failed: HTTP 500 boom`);
			expect(r.stdout + r.stderr).not.toContain(BOARD_KEY);
		});

		test("a detail without a blockedBy list fails closed the same way", async () => {
			const parent = issue("Triage Epic");
			const kid = issue("child", { parentId: parent.id, status: "done" });
			issues = [parent, kid];
			detailWithoutBlockers = new Set([parent.id]);
			const r = await run(["--apply"]);
			expect(r.code).toBe(1);
			expect(itemFor(r.json, parent).reason).toBe("children finished; blocker read failed");
			expect(writes()).toEqual([]);
		});
	});

	test("an open merge follow-up is listed; a merged one is cancelled", async () => {
		const open = issue("Checks not green for o/r#2");
		const done = issue("Resolve merge-check read failure on o/r#1");
		issues = [open, done];
		const r = await run(["--apply"]);
		expect(itemFor(r.json, open).action).toBe("merge-check");
		expect(writesFor(open)).toEqual([]);
		expect(itemFor(r.json, done)).toMatchObject({ action: "cancel", reason: "PR merged" });
	});

	test("an unknown title is other, untouched, with its assignee named", async () => {
		const stray = issue("Something unusual");
		issues = [stray];
		const r = await run(["--apply"]);
		expect(itemFor(r.json, stray)).toMatchObject({ action: "other", assignee: "Smythe" });
		expect(writes()).toEqual([]);
	});

	describe("triage waiting on the author", () => {
		const SINCE = "2026-10-03T10:00:00.000Z";
		const by = (login: string, created_at: string) => ({ user: { login }, created_at });
		const triage = () => issue("Triage o/r#5", { updatedAt: SINCE });

		test("the author replied after updatedAt: comment, then PATCH todo", async () => {
			const t = triage();
			issues = [t];
			// +02:00 is 09:30Z (before SINCE); the reply at 10:05Z is after it.
			forgeIssues = {
				"o/r#5": {
					state: "open",
					user: { login: "alice" },
					comments: [
						by("alice", "2026-10-03T11:30:00+02:00"),
						by("alice", "2026-10-03T10:05:00Z"),
						by("bob", "2026-10-03T10:20:00Z"),
					],
				},
			};
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, t)).toMatchObject({
				action: "todo",
				reason: "author replied 2026-10-03T10:05:00Z",
			});
			expect(writesFor(t).map((x) => x.body)).toEqual([
				{ body: "board-sweep: todo -- author replied 2026-10-03T10:05:00Z" },
				{ status: "todo" },
			]);
			expect(writesFor(t)[0]?.path).toBe(`/api/issues/${t.id}/comments`);
		});

		test("only someone else commented after updatedAt: waiting-author, no writes", async () => {
			const t = triage();
			issues = [t];
			forgeIssues = {
				"o/r#5": {
					state: "open",
					user: { login: "alice" },
					comments: [by("alice", "2026-10-03T09:00:00Z"), by("bob", "2026-10-03T12:00:00Z")],
				},
			};
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, t)).toMatchObject({
				action: "waiting-author",
				reason: `no author reply since ${SINCE}`,
			});
			expect(r.json.actions["waiting-author"]).toBe(1);
			expect(writes()).toEqual([]);
		});

		test("the Forge issue is closed: cancel", async () => {
			const t = triage();
			issues = [t];
			forgeIssues = { "o/r#5": { state: "closed", user: { login: "alice" }, comments: [] } };
			const r = await run(["--apply"]);
			expect(itemFor(r.json, t)).toMatchObject({ action: "cancel", reason: "issue closed" });
			expect(writesFor(t).map((x) => x.body)).toEqual([
				{ body: "board-sweep: cancel -- issue closed" },
				{ status: "cancelled" },
			]);
		});

		test("a dry run with an author reply makes no writes", async () => {
			const t = triage();
			issues = [t];
			forgeIssues = {
				"o/r#5": {
					state: "open",
					user: { login: "alice" },
					comments: [by("alice", "2026-10-03T10:05:00Z")],
				},
			};
			const r = await run();
			expect(itemFor(r.json, t).action).toBe("todo");
			expect(writes()).toEqual([]);
		});

		test("a Forge issue read failure: other, errors 1", async () => {
			const t = issue("Triage o/r#404", { updatedAt: SINCE });
			issues = [t];
			const r = await run(["--apply"]);
			expect(r.code).toBe(1);
			expect(r.json.errors).toBe(1);
			expect(itemFor(r.json, t)).toMatchObject({ action: "other", reason: "issue read failed" });
			expect(writes()).toEqual([]);
		});
	});

	describe("a throttling or refusing board (SOF-3908, SOF-3922, SOF-3955)", () => {
		const merged = () => issue(`Review o/r#1 @ ${LIVE.slice(0, 7)}`);
		const throttle = () =>
			new Response(JSON.stringify({ error: "rate limited" }), {
				status: 429,
				headers: { "Retry-After": "0", "Content-Type": "application/json" },
			});
		const comments = (i: Issue) => writesFor(i).filter((x) => x.method === "POST");

		test("429 twice then 200 on the comment: retried, no error, status changed", async () => {
			const t = merged();
			issues = [t];
			let n = 0;
			fault = (method, path) => {
				if (method === "POST" && path.endsWith("/comments") && ++n <= 2) return throttle();
				return undefined;
			};
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(r.json.errors).toBe(0);
			expect(itemFor(r.json, t)).not.toHaveProperty("error");
			expect(comments(t)).toHaveLength(3);
			expect(t.status).toBe("cancelled");
		});

		test("always 429: HTTP 429 in the item, error_codes counted, exit 1, 5 attempts", async () => {
			const t = merged();
			issues = [t];
			fault = (method) => (method === "POST" ? throttle() : undefined);
			const r = await run(["--apply"]);
			expect(r.code).toBe(1);
			expect(r.json.errors).toBe(1);
			expect((itemFor(r.json, t) as Item & { error: string }).error).toContain("HTTP 429");
			expect(r.json.error_codes["429"]).toBe(1);
			expect(comments(t)).toHaveLength(5);
			expect(writesFor(t).filter((x) => x.method === "PATCH")).toEqual([]);
			expect(r.stdout + r.stderr).not.toContain(BOARD_KEY);
		});

		test("422 on the todo PATCH: skipped with the reason, not an error, exit 0", async () => {
			const parent = issue("Triage Epic");
			const kid = issue("child", { parentId: parent.id, status: "done" });
			issues = [parent, kid];
			fault = (method) =>
				method === "PATCH"
					? Response.json({ error: "blocked by open issues" }, { status: 422 })
					: undefined;
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(r.json.errors).toBe(0);
			expect(r.json.skipped).toBe(1);
			expect(itemFor(r.json, parent)).toMatchObject({
				action: "todo",
				skipped: "board refused todo: HTTP 422 blocked by open issues",
			});
			expect(writesFor(parent).filter((x) => x.method === "PATCH")).toHaveLength(1);
		});
	});

	describe("the per-run cross-issue write cap (SOF-10747)", () => {
		const sha = LIVE.slice(0, 7);
		const merged = (extra: Partial<Issue> = {}) => issue(`Review o/r#1 @ ${sha}`, extra);
		/** The board's real refusal shape (paperclipai 2026.916.1, issue-write-denial.js). */
		const capped = () =>
			new Response(
				JSON.stringify({
					error: "This run has spent its cross-issue write budget",
					details: { code: "cross_issue_influence_cap_exceeded", cap: 20, count: 21 },
				}),
				{ status: 429, headers: { "Retry-After": "0", "Content-Type": "application/json" } },
			);
		const issueWrites = () => writes().filter((x) => x.path.startsWith("/api/issues/"));
		/** The board accepts `limit` issue writes, then answers every later one with the cap 429. */
		const capAfter = (limit: number) => {
			let n = 0;
			fault = (method, path) =>
				method !== "GET" && path.startsWith("/api/issues/") && ++n > limit ? capped() : undefined;
		};
		type Left = Item & { planned?: string; partial?: string };
		const nextPass = (out: { items: Left[] }) => out.items.filter((x) => x.action === "next-pass");

		test("cap 429 on write 21: no retry, the rest next-pass, JSON printed, exit 0", async () => {
			const all = Array.from({ length: 15 }, () => merged());
			issues = [...all];
			capAfter(20);
			const r = await run(["--apply"], { BOARD_SWEEP_MAX_WRITES: "100" });
			expect(r.code).toBe(0);
			expect(r.json.errors).toBe(0);
			// 20 accepted plus the one refused: nothing after it, no retry of it.
			expect(issueWrites()).toHaveLength(21);
			expect(r.json.writes).toBe(21);
			expect(r.json.actions.cancel).toBe(10);
			expect(r.json.actions["next-pass"]).toBe(5);
			expect(r.json.stopped).toContain("HTTP 429");
			const left = nextPass(r.json);
			expect(left.map((x) => x.planned)).toEqual(Array(5).fill("cancel"));
			expect(left[0]?.reason).toBe("cross-issue write cap reached; planned cancel -- PR merged");
			expect(left[0]).not.toHaveProperty("partial");
			expect(all.filter((i) => i.status === "cancelled")).toHaveLength(10);
			expect(all.filter((i) => i.status === "blocked")).toHaveLength(5);
			expect(r.stderr).toContain("cross-issue write cap reached");
		});

		test("cap 429 on an item's PATCH: next-pass, marked partial, its comment already posted", async () => {
			const a = merged();
			const b = merged();
			issues = [a, b];
			capAfter(3);
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(issueWrites()).toHaveLength(4);
			const item = itemFor(r.json, b) as Left;
			expect(item).toMatchObject({ action: "next-pass", planned: "cancel" });
			expect(item.partial).toBe("1 write went out before the cap");
			expect([a.status, b.status]).toEqual(["cancelled", "blocked"]);
		});

		test("a plain 429 (no cap code) is still retried", async () => {
			const t = merged();
			issues = [t];
			let n = 0;
			fault = (method) =>
				method === "POST" && ++n === 1
					? Response.json(
							{ error: "rate limited" },
							{ status: 429, headers: { "Retry-After": "0" } },
						)
					: undefined;
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(r.json.stopped).toBeNull();
			expect(t.status).toBe("cancelled");
		});

		describe("a retry keeps room for the rest of its item (SOF-10912)", () => {
			const plain429 = () =>
				Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": "0" } });
			/** The first `method` write is answered with a plain (retryable) 429. */
			const firstRefused = (method: string) => {
				let n = 0;
				fault = (m, path) =>
					m === method && path.startsWith("/api/issues/") && ++n === 1 ? plain429() : undefined;
			};
			const accepted = (i: Issue) =>
				(boardComments[i.id] ?? []).filter((c) => c.body.startsWith("board-sweep: "));

			test("budget 2, comment 429: no retry, no accepted comment, next-pass, nothing partial", async () => {
				const t = merged();
				issues = [t];
				firstRefused("POST");
				const r = await run(["--apply"], { BOARD_SWEEP_MAX_WRITES: "2" });
				expect(r.code).toBe(0);
				expect(r.json.errors).toBe(0);
				// The refused comment is the only write: its retry would leave no room for the PATCH.
				expect(issueWrites().map((x) => x.method)).toEqual(["POST"]);
				expect(r.json.writes).toBe(1);
				expect(accepted(t)).toEqual([]);
				expect(t.status).toBe("blocked");
				expect(r.json.stopped).toStartWith("write budget of 2 spent");
				const item = itemFor(r.json, t) as Left;
				expect(item).toMatchObject({ action: "next-pass", planned: "cancel" });
				expect(item.reason).toBe("write budget of 2 spent; planned cancel -- PR merged");
				expect(item).not.toHaveProperty("partial");
			});

			test("budget 3, comment 429: the retry fits with its PATCH, the item finishes", async () => {
				const t = merged();
				issues = [t];
				firstRefused("POST");
				const r = await run(["--apply"], { BOARD_SWEEP_MAX_WRITES: "3" });
				expect(r.code).toBe(0);
				expect(r.json.stopped).toBeNull();
				expect(issueWrites().map((x) => x.method)).toEqual(["POST", "POST", "PATCH"]);
				expect(accepted(t)).toHaveLength(1);
				expect(t.status).toBe("cancelled");
			});

			test("every accepted comment has its PATCH whatever the budget", async () => {
				for (const budget of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
					log = [];
					boardComments = {};
					const all = [merged(), merged(), merged()];
					issues = [...all];
					let n = 0;
					// Every other comment POST is refused once with a plain 429.
					fault = (m, path) =>
						m === "POST" && path.startsWith("/api/issues/") && ++n % 2 === 1
							? plain429()
							: undefined;
					const r = await run(["--apply"], { BOARD_SWEEP_MAX_WRITES: String(budget) });
					expect(r.code).toBe(0);
					expect(r.json.writes).toBeLessThanOrEqual(budget);
					for (const i of all) {
						const commented = accepted(i).length > 0;
						expect({ budget, id: i.identifier, commented, status: i.status }).toEqual({
							budget,
							id: i.identifier,
							commented,
							status: commented ? "cancelled" : "blocked",
						});
					}
				}
			});

			test("kickstart, budget 3, PATCH 429: no retry, the refusal note uses the reserved write", async () => {
				const t = issue(`Review o/r#2 @ ${sha}`, {
					status: "in_progress",
					updatedAt: "2026-10-04T11:00:00.000Z",
				});
				issues = [t];
				firstRefused("PATCH");
				const r = await run(["--apply"], {
					BOARD_SWEEP_MAX_WRITES: "3",
					BOARD_SWEEP_NOW: "2026-10-04T12:00:00.000Z",
				});
				expect(r.code).toBe(0);
				expect(issueWrites().map((x) => x.method)).toEqual(["POST", "PATCH", "POST"]);
				const bodies = accepted(t).map((c) => c.body);
				expect(bodies[0]).toStartWith("board-sweep: kickstart -- ");
				// The note cancels the kickstart, so it never counts toward escalation.
				expect(bodies[1]).toStartWith("board-sweep: kickstart-refused -- status not written");
				expect(t.status).toBe("in_progress");
				const item = itemFor(r.json, t) as Left;
				expect(item).toMatchObject({ action: "next-pass", planned: "kickstart" });
				expect(item.partial).toBe("2 writes went out before the write budget ran out");
			});

			test("budget 2, PATCH 429 after an accepted comment: partial names the budget, not the cap", async () => {
				const t = merged();
				issues = [t];
				firstRefused("PATCH");
				const r = await run(["--apply"], { BOARD_SWEEP_MAX_WRITES: "2" });
				expect(r.code).toBe(0);
				expect(issueWrites().map((x) => x.method)).toEqual(["POST", "PATCH"]);
				const item = itemFor(r.json, t) as Left;
				expect(item).toMatchObject({ action: "next-pass", planned: "cancel" });
				expect(item.partial).toBe("1 write went out before the write budget ran out");
				expect(r.json.stopped).toStartWith("write budget of 2 spent");
			});
		});

		test("the default budget stops at 18 writes, highest priority first", async () => {
			const low = Array.from({ length: 10 }, () => merged({ priority: "low" }));
			const high = [merged({ priority: "high" }), merged({ priority: "critical" })];
			issues = [...low, ...high];
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(issueWrites()).toHaveLength(18);
			expect(r.json.write_budget).toBe(18);
			expect(r.json.writes).toBe(18);
			expect(r.json.stopped).toBe("write budget of 18 spent");
			expect(r.json.actions.cancel).toBe(9);
			expect(r.json.actions["next-pass"]).toBe(3);
			expect(high.map((i) => i.status)).toEqual(["cancelled", "cancelled"]);
			// critical before high, then low by age.
			expect(issueWrites()[1]?.path).toBe(`/api/issues/${high[1]?.id}`);
			expect(issueWrites()[3]?.path).toBe(`/api/issues/${high[0]?.id}`);
			expect(nextPass(r.json).map((x) => x.identifier)).toEqual(
				low.slice(7).map((i) => i.identifier),
			);
			expect(nextPass(r.json)[0]?.reason).toBe(
				"write budget of 18 spent; planned cancel -- PR merged",
			);
		});

		test("a dry run previews the same budget and writes nothing", async () => {
			issues = Array.from({ length: 4 }, () => merged());
			const r = await run([], { BOARD_SWEEP_MAX_WRITES: "4" });
			expect(r.code).toBe(0);
			expect(writes()).toEqual([]);
			expect(r.json.actions.cancel).toBe(2);
			expect(r.json.actions["next-pass"]).toBe(2);
		});

		test("a bad BOARD_SWEEP_MAX_WRITES: exit 2, nothing sent", async () => {
			issues = [merged()];
			const r = await run(["--apply"], { BOARD_SWEEP_MAX_WRITES: "many" });
			expect(r.code).toBe(2);
			expect(log).toEqual([]);
		});
	});

	describe("stalled reviews: kickback, kickstart, escalate, priority queue", () => {
		const NOW = "2026-10-04T12:00:00.000Z";
		const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
		const sha = LIVE.slice(0, 7);
		const busyRuns = (n: number, agentId = SMYTHE) =>
			Array.from({ length: n }, (_, k) => ({
				agentId,
				status: "running",
				contextSnapshot: { issueId: `elsewhere-${k}` },
			}));
		/** 300 finished runs: the whole window the old heartbeat-runs read saw. */
		const finished = () =>
			Array.from({ length: 300 }, (_, k) => ({
				agentId: SMYTHE,
				status: "succeeded",
				contextSnapshot: { issueId: `done-${k}` },
			}));
		const sweep = (args: string[] = ["--apply"]) => run(args, { BOARD_SWEEP_NOW: NOW });

		test("a red required check: kickback, one Forge comment, the task cancelled; a second run posts none", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`, { status: "in_progress", updatedAt: ago(5) });
			issues = [t];
			statuses = {
				[LIVE]: [
					{ context: "factory/smoke", status: "success" },
					{ context: "factory/prepush", status: "failure" },
				],
			};
			const reason = `factory/prepush failed at ${sha}: the author fixes it and pushes; a new head gets a new review`;
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(itemFor(r.json, t)).toMatchObject({ action: "kickback", reason });
			expect(r.json.actions.kickback).toBe(1);
			expect(prComments["o/r#2"]).toEqual([{ body: `REVIEW KICKBACK: ${reason}` }]);
			expect(writesFor(t).map((x) => x.body)).toEqual([
				{ body: `board-sweep: kickback -- ${reason}` },
				{ status: "cancelled" },
			]);
			// The task is cancelled now; a fresh review of the same sha is kicked back too.
			const again = issue(`Chang: Review o/r#2 @ ${sha}`, { status: "todo", updatedAt: ago(5) });
			issues.push(again);
			const r2 = await sweep();
			expect(itemFor(r2.json, again).action).toBe("kickback");
			expect(prComments["o/r#2"]).toHaveLength(1);
		});

		test("in_progress, no run, updatedAt 31 min ago: kickstart, comment then todo", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`, { status: "in_progress", updatedAt: ago(31) });
			issues = [t];
			const r = await sweep();
			expect(r.code).toBe(0);
			const why = "in_progress, no queued or running run, idle 31 min";
			expect(itemFor(r.json, t)).toMatchObject({ action: "kickstart", reason: why });
			expect(r.json.actions.kickstart).toBe(1);
			expect(writesFor(t).map((x) => x.body)).toEqual([
				{ body: `board-sweep: kickstart -- ${why}` },
				{ status: "todo" },
			]);
		});

		test("in_progress, no run, updatedAt 29 min ago: untouched", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`, { status: "in_progress", updatedAt: ago(29) });
			issues = [t];
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(r.json.actions.kickstart).toBe(0);
			expect(writes()).toEqual([]);
		});

		test("a stale review with a queued run for it: untouched", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`, { status: "in_progress", updatedAt: ago(90) });
			issues = [t];
			issueRuns = { [t.id]: [{ agentId: SMYTHE, status: "queued" }] };
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(r.json.actions.kickstart).toBe(0);
			expect(writes()).toEqual([]);
		});

		test("third stall after two kickstarts: escalate, exactly one Bishop issue across two runs", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`, { status: "in_progress", updatedAt: ago(45) });
			issues = [t];
			boardComments = {
				[t.id]: [{ body: "board-sweep: kickstart -- a" }, { body: "board-sweep: kickstart -- b" }],
			};
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(itemFor(r.json, t)).toMatchObject({
				action: "escalate",
				reason: "stalled after two kickstarts",
			});
			expect(writesFor(t).map((x) => x.body)).toEqual([
				{ body: "board-sweep: escalate -- stalled after two kickstarts" },
			]);
			const r2 = await sweep();
			expect(r2.code).toBe(0);
			expect(itemFor(r2.json, t).action).toBe("escalate");
			const made = issues.filter((i) => i.title === `Stalled review: ${t.title}`);
			expect(made).toHaveLength(1);
			expect(made[0]).toMatchObject({ assigneeAgentId: BISHOP, priority: "high", status: "todo" });
			expect(writes().filter((x) => x.path === `/api/companies/${COMPANY}/issues`)).toHaveLength(1);
		});

		test("priority queue: high before an older medium, pri:0 before pri:2 within medium", async () => {
			const medium2 = issue(`Aa: Review o/r#2 @ ${sha}`, {
				priority: "medium",
				labels: [{ name: "pri:2" }],
			});
			const medium0 = issue(`Ab: Review o/r#2 @ ${sha}`, {
				priority: "medium",
				labels: [{ name: "pri:0" }],
			});
			const high = issue(`Ac: Review o/r#2 @ ${sha}`, { priority: "high" });
			issues = [medium2, medium0, high];
			liveRuns = busyRuns(5);
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(itemFor(r.json, high).action).toBe("todo");
			expect(itemFor(r.json, medium0)).toMatchObject({
				action: "queue",
				reason: "queued: priority medium, position 1",
			});
			expect(itemFor(r.json, medium2).reason).toBe("queued: priority medium, position 2");
			expect(r.json.queue).toEqual([
				{ identifier: medium0.identifier, priority: "medium", assignee: "Smythe" },
				{ identifier: medium2.identifier, priority: "medium", assignee: "Smythe" },
			]);
			// Waiting for a reviewer is queued, not blocked: it moves to backlog.
			expect(writesFor(medium0).map((x) => x.body)).toEqual([
				{ body: "board-sweep: queue -- queued: priority medium, position 1" },
				{ status: "backlog" },
			]);
		});

		test("a queued run on the task's own runs list blocks the kickstart behind 300 finished runs", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`, { status: "in_progress", updatedAt: ago(90) });
			issues = [t];
			const queued = { agentId: SMYTHE, status: "queued", contextSnapshot: { issueId: t.id } };
			runs = [...finished(), queued];
			liveRuns = [queued];
			issueRuns = { [t.id]: [{ agentId: SMYTHE, status: "succeeded" }, queued] };
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(r.json.actions.kickstart).toBe(0);
			expect(writes()).toEqual([]);
		});

		test("five running live runs beyond the old window leave exactly 6 - 5 = 1 free slot", async () => {
			const a = issue(`Aa: Review o/r#2 @ ${sha}`);
			const b = issue(`Ab: Review o/r#2 @ ${sha}`);
			const c = issue(`Ac: Review o/r#2 @ ${sha}`);
			issues = [a, b, c];
			runs = [...finished(), ...busyRuns(5)];
			liveRuns = busyRuns(5);
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(r.json.actions.todo).toBe(1);
			expect(r.json.actions.queue).toBe(2);
			expect(itemFor(r.json, a).action).toBe("todo");
		});

		test("live-runs at its 50-row cap counts as at least 50 active: zero free slots of 6", async () => {
			const a = issue(`Aa: Review o/r#2 @ ${sha}`);
			const b = issue(`Ab: Review o/r#2 @ ${sha}`);
			issues = [a, b];
			// None of the 50 rows is Smythe's, but rows past 50 are unseen: fail closed.
			liveRuns = busyRuns(60, "agent-other");
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(r.json.actions.todo).toBe(0);
			expect(r.json.actions.queue).toBe(2);
		});

		test("a failed live-runs read: no release and no kickstart this sweep, named on stderr, exit 1", async () => {
			const waiting = issue(`Aa: Review o/r#2 @ ${sha}`);
			const stale = issue(`Ab: Review o/r#2 @ ${sha}`, {
				status: "in_progress",
				updatedAt: ago(45),
			});
			issues = [waiting, stale];
			fault = (method, path) =>
				method === "GET" && path.endsWith("/live-runs")
					? Response.json({ error: "boom" }, { status: 500 })
					: undefined;
			const r = await sweep();
			expect(r.code).toBe(1);
			expect(r.json.actions.todo).toBe(0);
			expect(r.json.actions.kickstart).toBe(0);
			expect(writes().filter((x) => x.method === "PATCH")).toEqual([]);
			expect(r.stderr).toContain("board GET live-runs failed: HTTP 500 boom");
			expect([waiting.status, stale.status]).toEqual(["blocked", "in_progress"]);
		});

		test("admitted releases are written in priority order, not list order", async () => {
			const low = issue(`Aa: Review o/r#2 @ ${sha}`, { priority: "low" });
			const high = issue(`Ab: Review o/r#2 @ ${sha}`, { priority: "high" });
			issues = [low, high];
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(r.json.actions.todo).toBe(2);
			const patched = writes()
				.filter((x) => x.method === "PATCH")
				.map((x) => x.path);
			expect(patched).toEqual([`/api/issues/${high.id}`, `/api/issues/${low.id}`]);
		});

		test("kickstarts the board refused (422) do not count toward escalation", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`, { status: "in_progress", updatedAt: ago(45) });
			issues = [t];
			fault = (method) =>
				method === "PATCH"
					? Response.json({ error: "blocked by open issues" }, { status: 422 })
					: undefined;
			for (const _ of [1, 2]) {
				const r = await sweep();
				expect(r.code).toBe(0);
				expect(itemFor(r.json, t).action).toBe("kickstart");
			}
			const r3 = await sweep();
			expect(r3.code).toBe(0);
			expect(r3.json.actions.escalate).toBe(0);
			expect(itemFor(r3.json, t).action).toBe("kickstart");
			expect(issues.filter((i) => i.title.startsWith("Stalled review:"))).toEqual([]);
		});

		test("capacity: an assignee with 6 slots and 5 runs gets 1 release", async () => {
			const a = issue(`Aa: Review o/r#2 @ ${sha}`);
			const b = issue(`Ab: Review o/r#2 @ ${sha}`);
			const c = issue(`Ac: Review o/r#2 @ ${sha}`);
			issues = [a, b, c];
			liveRuns = busyRuns(5);
			const r = await sweep();
			expect(r.code).toBe(0);
			expect(r.json.actions.todo).toBe(1);
			expect(r.json.actions.queue).toBe(2);
			expect(itemFor(r.json, a).action).toBe("todo");
			expect(writes().filter((x) => x.method === "PATCH")).toHaveLength(3);
			expect([b.status, c.status]).toEqual(["backlog", "backlog"]);
			expect(r.json.blocked_after).toBe(0);
			// A later pass with free slots releases the queue, oldest first.
			liveRuns = [];
			const r2 = await sweep();
			expect(r2.code).toBe(0);
			expect(itemFor(r2.json, b)).toMatchObject({
				action: "todo",
				reason: "released from the queue",
			});
			expect(itemFor(r2.json, c).action).toBe("todo");
			expect([b.status, c.status]).toEqual(["todo", "todo"]);
		});
	});

	describe("a lead's fix-first verdict kicks the review back", () => {
		const sha = LIVE.slice(0, 7);
		const reason = `verdict fix-first at ${sha}: the author fixes the findings and pushes; a new head gets a new review`;
		const said = (who: string, at: string, verdict: string, head = sha) => ({
			body: `## Review of o/r#2 at ${head}\n\nfindings\n\nverdict: ${verdict}\n`,
			authorAgentId: who,
			createdAt: at,
		});

		test("P0: authoritative pair fix-first remains visible to merge-check after sweep", async () => {
			issues = ["Adams", "Colter", "Giraud", "Kong"].map((name) =>
				issue(`Review o/r#2 @ ${sha} (${name})`, {
					status: name === "Adams" ? "blocked" : "done",
					originKind: "plugin:rodaddy.forge-pr",
				}),
			);
			for (const [index, task] of issues.entries()) {
				const name = ["Adams", "Colter", "Giraud", "Kong"][index] as string;
				boardComments[task.id] = [
					{
						...said(
							`agent-${name.toLowerCase()}`,
							"2026-10-03T12:00:00.000Z",
							name === "Adams" ? "fix-first" : "approve",
						),
						body: `## Review of o/r#2 at ${sha}\nverdict: ${name === "Adams" ? "fix-first" : "approve"}\nblast radius: confirmed\n`,
					},
				];
			}
			expect(await pairVerdict()).toBe("fix-first");
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, issues[0] as Issue).action).toBe("kickback");
			expect(prComments["o/r#2"]).toHaveLength(1);
			expect(issues[0]?.status).toBe("cancelled");
			expect(await pairVerdict()).toBe("fix-first");
		});

		test("P0: cancelled approved pairs retain authority over a later legacy lead approve after sweep", async () => {
			const parent = issue(`Review o/r#2 @ ${sha}`, { status: "done" });
			const pairs = ["Adams", "Colter"].map((name) =>
				issue(`Review o/r#2 @ ${sha} (${name})`, { originKind: "plugin:rodaddy.forge-pr" }),
			);
			issues = [parent, ...pairs];
			boardComments[parent.id] = [
				{
					body: "Dispatched to Adams (0 open) per review-dispatch",
					authorAgentId: SMYTHE,
					createdAt: "2026-10-03T09:00:00.000Z",
				},
				said(SMYTHE, "2026-10-03T12:00:00.000Z", "fix-first"),
				said(ADAMS, "2026-10-03T13:00:00.000Z", "approve"),
			];
			for (const [index, task] of pairs.entries()) {
				boardComments[task.id] = [
					said(index === 0 ? ADAMS : "agent-colter", "2026-10-03T10:00:00.000Z", "approve"),
				];
			}
			expect(await pairVerdict(true)).toBe("fix-first");
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(pairs.map((task) => task.status)).toEqual(["cancelled", "cancelled"]);
			expect(await pairVerdict(true)).toBe("fix-first");
		});

		test("P1: undispatched manual child fix-first cannot cancel Smythe approved parent", async () => {
			const parent = issue(`Review o/r#2 @ ${sha}`);
			const child = issue(`Adams: blind review o/r#2 @ ${sha}`, {
				status: "done",
				parentId: parent.id,
			});
			issues = [parent, child];
			boardComments = {
				[parent.id]: [said(SMYTHE, "2026-10-03T11:00:00.000Z", "approve")],
				[child.id]: [said(ADAMS, "2026-10-03T12:00:00.000Z", "fix-first")],
			};
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, parent).action).not.toBe("kickback");
			expect(parent.status).not.toBe("cancelled");
			expect(prComments["o/r#2"] ?? []).toEqual([]);
		});

		for (const status of ["blocked", "backlog"]) {
			test(`a ${status} review: one Forge REVIEW KICKBACK, the task cancelled`, async () => {
				const lead = issue(`Review o/r#2 @ ${sha}`, { status: "done", assigneeAgentId: ADAMS });
				const t = issue(`Adams: blind review o/r#2 @ ${sha}`, { status });
				issues = [lead, t];
				boardComments = {
					[lead.id]: [
						{
							body: "Dispatched to Adams (lead) per review-dispatch",
							authorAgentId: SMYTHE,
							createdAt: "2026-10-03T10:00:00.000Z",
						},
						said(ADAMS, "2026-10-03T11:00:00.000Z", "approve"),
						said(ADAMS, "2026-10-03T12:00:00.000Z", "fix-first"),
					],
				};
				const r = await run(["--apply"]);
				expect(r.code).toBe(0);
				expect(itemFor(r.json, t)).toMatchObject({ action: "kickback", reason });
				expect(prComments["o/r#2"]).toEqual([{ body: `REVIEW KICKBACK: ${reason}` }]);
				expect(writesFor(t).map((x) => x.body)).toEqual([
					{ body: `board-sweep: kickback -- ${reason}` },
					{ status: "cancelled" },
				]);
			});
		}

		test("a fix-first at an older sha does not kick back the current head's review", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`);
			issues = [t];
			boardComments = {
				[t.id]: [said(SMYTHE, "2026-10-03T12:00:00.000Z", "fix-first", "c".repeat(7))],
			};
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, t).action).toBe("todo");
			expect(prComments["o/r#2"]).toBeUndefined();
		});

		test("a fix-first from a reviewer seat, not a lead, is ignored", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`);
			issues = [t];
			boardComments = { [t.id]: [said(CHANG, "2026-10-03T12:00:00.000Z", "fix-first")] };
			const r = await run(["--apply"]);
			expect(r.code).toBe(0);
			expect(itemFor(r.json, t).action).toBe("todo");
			expect(prComments["o/r#2"]).toBeUndefined();
		});

		test("a second sweep posts no second Forge comment", async () => {
			const t = issue(`Review o/r#2 @ ${sha}`);
			issues = [t];
			boardComments = { [t.id]: [said(SMYTHE, "2026-10-03T12:00:00.000Z", "fix-first")] };
			const r = await run(["--apply"]);
			expect(itemFor(r.json, t).action).toBe("kickback");
			const again = issue(`Chang: Review o/r#2 @ ${sha}`);
			issues.push(again);
			const r2 = await run(["--apply"]);
			expect(r2.code).toBe(0);
			expect(itemFor(r2.json, again)).toMatchObject({ action: "kickback", reason });
			expect(prComments["o/r#2"]).toHaveLength(1);
		});
	});

	test("missing PAPERCLIP_API_KEY: exit 3 and no request sent", async () => {
		issues = [issue("Something unusual")];
		const r = await run(["--apply"], { PAPERCLIP_API_KEY: "" });
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
		expect(log).toEqual([]);
	});

	test("neither credential reaches stdout or stderr", async () => {
		issues = [
			issue(`Review o/r#1 @ ${LIVE.slice(0, 7)}`),
			issue(`Review o/r#9 @ ${LIVE.slice(0, 7)}`),
		];
		const r = await run(["--apply"]);
		expect(r.code).toBe(1);
		expect(r.json.errors).toBe(1);
		expect(r.stdout + r.stderr).not.toContain(TOKEN);
		expect(r.stdout + r.stderr).not.toContain(BOARD_KEY);
	});
});

test("board-sweep holds unspecified paid redispatch before comment or todo PATCH", async () => {
	const parent = issue("Add feature");
	issues = [parent, issue("finished child", { parentId: parent.id, status: "done" })];
	const r = await run(["--apply"]);
	expect(r.code).toBe(0);
	expect(writesFor(parent)).toEqual([]);
	expect(itemFor(r.json, parent)).toMatchObject({ skipped: "spec-ready hold: write-spec" });
	expect(
		writes().filter((r) => (r.body as Record<string, unknown>)?.originKind === "spec-ready"),
	).toHaveLength(1);
});
