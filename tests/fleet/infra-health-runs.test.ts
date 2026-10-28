/**
 * @module tests/fleet/infra-health-runs
 * @description `infra-health runs` (SOF-3946) run as a real child process
 *   against a tiny fake Paperclip board that serves heartbeat runs and agents.
 *   Pins: the 2026-10-04 18:10Z continuation sweep is counted, not escalated;
 *   a failure injected at the top of the hour is classified and routed by the
 *   next run; each infra cause routes to Nagatha and each harness cause to
 *   Bishop; a board refusal is a harness error; bad usage exits 2.
 *   The runs feed (SOF-12351): `--publish` posts one comment per window on a
 *   standing issue, windows tile from the last feed comment, a second post
 *   inside the gap is skipped; `--feed` reads the newest feed comment through
 *   GET /api/issues/{id}/comments only and refuses a stale or missing feed.
 *   `INFRA_HEALTH_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT =
	process.env.INFRA_HEALTH_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/infra-health/bin/infra-health");

const CO = "co-1";
const TOKEN = "test-token";
const AGENTS = [
	{ id: "a-fried", name: "Friedlander" },
	{ id: "a-perk", name: "Perkins" },
	{ id: "a-simms", name: "Simms" },
];

interface Run {
	id: string;
	agentId: string;
	status: string;
	createdAt: string;
	finishedAt: string | null;
	errorCode: string | null;
	error: string | null;
}

// One test-owned clock: fixtures are built from NOW and the child reads the
// same instant from INFRA_HEALTH_NOW, so no assertion depends on the wall clock.
const NOW = new Date("2026-10-04T18:30:00Z");
const iso = (d: Date) => d.toISOString();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
let seq = 0;
function run(p: Partial<Run> & { at?: Date }): Run {
	const at = p.at ?? minsAgo(5);
	seq += 1;
	return {
		id: p.id ?? `run-${seq}`,
		agentId: p.agentId ?? "a-simms",
		status: p.status ?? "failed",
		createdAt: iso(at),
		finishedAt: iso(at),
		errorCode: p.errorCode ?? null,
		error: p.error ?? null,
	};
}

let runs: Run[] = [];
let refuse = false;
const seen: string[] = [];
const FEED = "SOF-900";
interface Comment {
	id: string;
	body: string;
	createdAt: string;
	deletedAt: string | null;
}
// Newest first, as the board returns them.
let comments: Comment[] = [];
let posted: { body: string; runId: string | null }[] = [];
// A feed comment exactly as --publish writes it, for a window ending at `checkedAt`.
function feedComment(checkedAt: Date, extra: Partial<Comment> = {}): Comment {
	const c = iso(checkedAt).replace(/\.000Z$/, "Z");
	const data = {
		checkedAt: c,
		since: c,
		failed: 0,
		causes: [],
		line: `${c} runs since ${c}: 0 failed`,
	};
	return {
		id: `old-${c}`,
		body: `infra-health runs feed v1 · ${data.line}\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n`,
		createdAt: iso(checkedAt),
		deletedAt: null,
		...extra,
	};
}
let server: ReturnType<typeof Bun.serve>;
let board = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			seen.push(`${req.method} ${url.pathname}`);
			if (req.headers.get("authorization") !== `Bearer ${TOKEN}`)
				return Response.json({ error: "no token" }, { status: 401 });
			if (url.pathname === `/api/companies/${CO}/heartbeat-runs`) {
				if (refuse)
					return Response.json(
						{ error: `Route not allowed: GET /api/companies/${CO}/heartbeat-runs` },
						{ status: 403 },
					);
				const limit = Number(url.searchParams.get("limit") ?? "1000");
				return Response.json(runs.slice(0, limit));
			}
			if (url.pathname === `/api/companies/${CO}/agents`) return Response.json(AGENTS);
			if (url.pathname === `/api/issues/${FEED}/comments`) {
				if (req.method === "POST") {
					const { body } = (await req.json()) as { body: string };
					posted.push({ body, runId: req.headers.get("x-paperclip-run-id") });
					const c = { id: `c-${posted.length}`, body, createdAt: iso(NOW), deletedAt: null };
					comments.unshift(c);
					return Response.json(c, { status: 201 });
				}
				const limit = Number(url.searchParams.get("limit") ?? "1000");
				return Response.json(comments.slice(0, limit));
			}
			return Response.json({ error: "unknown route" }, { status: 404 });
		},
	});
	board = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
	runs = [];
	refuse = false;
	seen.length = 0;
	comments = [];
	posted = [];
});

async function exec(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["python3", SCRIPT, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			PAPERCLIP_API_URL: board,
			PAPERCLIP_API_KEY: TOKEN,
			PAPERCLIP_COMPANY_ID: CO,
			INFRA_HEALTH_NOW: iso(NOW),
			...env,
		},
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

interface Cause {
	cause: string;
	route: string;
	count: number;
	agents: Record<string, number>;
	errors: string[];
	samples: string[];
	first: string;
	last: string;
}
interface Report {
	since: string;
	failed: number;
	truncated: boolean;
	causes: Cause[];
	line: string;
}
async function report(args: string[] = []): Promise<Report> {
	const r = await exec(["runs", ...args]);
	expect(r.err).toBe("");
	expect(r.code).toBe(0);
	return JSON.parse(r.out);
}
const routes = (res: Report) => res.causes.map((c) => [c.cause, c.route, c.count]);

describe("infra-health runs", () => {
	test("the 18:10Z continuation sweep is one benign cause, counted per agent", async () => {
		const sweep = (agentId: string) =>
			run({
				agentId,
				errorCode: "setup_failed",
				error: "continuation_task_ownership_changed",
			});
		runs = [
			...Array.from({ length: 121 }, () => sweep("a-fried")),
			...Array.from({ length: 64 }, () => sweep("a-perk")),
		];
		const res = await report();
		expect(res.failed).toBe(185);
		expect(routes(res)).toEqual([["continuation-task-changed", "count", 185]]);
		expect(res.causes[0]?.agents).toEqual({ Friedlander: 121, Perkins: 64 });
		expect(res.causes[0]?.errors).toEqual(["setup_failed: continuation_task_ownership_changed"]);
		expect(res.causes[0]?.samples).toHaveLength(5);
		expect(res.line).toContain(
			"185 failed; continuation-task-changed 185 counted (Friedlander 121, Perkins 64)",
		);
	});

	test("a failure injected at the top of the hour is classified and routed by the next run", async () => {
		// Now is 18:30Z (the test-owned clock). The previous routine run
		// reported at 17:07Z; a failure lands at 18:00Z; this run reads from the
		// previous checkedAt. The 17:20Z failure is inside the cursor window but
		// outside the default last hour, and the 17:06Z one is before the cursor,
		// so an ignored cursor goes red either way.
		const previous = new Date("2026-10-04T17:07:00Z");
		const injectedAt = new Date("2026-10-04T18:00:00Z");
		runs = [
			run({ id: "injected", at: injectedAt, errorCode: "process_lost", error: "child exited" }),
			run({ id: "after-cursor", at: new Date("2026-10-04T17:20:00Z"), errorCode: "process_lost" }),
			run({ id: "before-cursor", at: new Date("2026-10-04T17:06:00Z"), error: "ssh: refused" }),
			run({ id: "ok", status: "succeeded", at: injectedAt }),
			run({ id: "cancelled", status: "cancelled", at: injectedAt }),
		];
		const res = await report(["--since", iso(previous)]);
		expect(res.failed).toBe(2);
		expect(routes(res)).toEqual([["process-lost", "nagatha", 2]]);
		expect(res.causes[0]?.samples).toEqual(["injected", "after-cursor"]);
	});

	test("an offset --since and offset run times are reported as their UTC instant", async () => {
		runs = [{ ...run({ errorCode: "process_lost" }), finishedAt: "2026-10-04T20:25:00+02:00" }];
		const res = await report(["--since", "2026-10-04T19:30:00+02:00"]);
		expect(res.since).toBe("2026-10-04T17:30:00Z");
		expect(res.line).toStartWith("2026-10-04T18:30:00Z runs since 2026-10-04T17:30:00Z: 1 failed");
		expect(res.causes[0]?.first).toBe("2026-10-04T18:25:00Z");
		expect(res.causes[0]?.last).toBe("2026-10-04T18:25:00Z");
	});

	test("infra causes route to Nagatha, harness causes to Bishop, benign is counted", async () => {
		runs = [
			run({ errorCode: "adapter_failed", error: "Bifrost stream closed before completion" }),
			run({ error: "ssh: connect to host 10.0.1.21 port 22: Connection refused" }),
			run({ error: "mount /mnt/share: stale file handle" }),
			run({ error: "Paperclip server returned 503" }),
			run({ errorCode: "process_lost", error: null }),
			run({ errorCode: "setup_failed", error: "continuation_task_cancelled" }),
			run({ errorCode: "adapter_failed", error: "claude exited with code 1" }),
			run({ status: "timed_out" }),
			run({ errorCode: "mystery", error: "zzz" }),
		];
		const res = await report();
		expect(res.failed).toBe(9);
		expect(new Map(res.causes.map((c) => [c.cause, c.route]))).toEqual(
			new Map([
				["stream-drop", "nagatha"],
				["ssh-mount", "nagatha"],
				["paperclip-server", "nagatha"],
				["process-lost", "nagatha"],
				["continuation-task-changed", "count"],
				["harness", "bishop"],
				["run-timeout", "bishop"],
				["unclassified", "bishop"],
			]),
		);
		expect(res.causes.find((c) => c.cause === "ssh-mount")?.count).toBe(2);
		expect(res.line).toContain("unclassified 1 to Bishop (Simms 1)");
		expect(res.line).toContain("stream-drop 1 mine (Simms 1)");
	});

	test("no failures is a zero line, and only GETs reach the board", async () => {
		runs = [run({ status: "succeeded" }), run({ status: "failed", at: minsAgo(120), error: "x" })];
		const res = await report();
		expect(res.failed).toBe(0);
		expect(res.causes).toEqual([]);
		expect(res.line).toMatch(/runs since \S+Z: 0 failed$/);
		expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
	});

	test("any full page is flagged as possibly truncated, a short page is not", async () => {
		runs = Array.from({ length: 3 }, () => run({ error: "x" }));
		const res = await report(["--limit", "3"]);
		expect(res.truncated).toBe(true);
		expect(res.line).toContain("(page of 3 full: may be truncated, older runs not read)");
		// The page reaches back past --since and is still full: the board orders
		// by createdAt, so a long run that finished in the window may be cut off.
		runs.push(run({ status: "succeeded", at: minsAgo(90) }));
		const full = await report(["--limit", "4"]);
		expect(full.truncated).toBe(true);
		expect(full.line).toContain("may be truncated");
		const short = await report(["--limit", "5"]);
		expect(short.truncated).toBe(false);
		expect(short.line).not.toContain("truncated");
	});

	test("--limit above the board's 1000 cap is refused, not silently clamped", async () => {
		const r = await exec(["runs", "--limit", "1001"]);
		expect(r.code).toBe(2);
		expect(r.out).toBe("");
		expect(r.err).toContain("--limit");
		expect(seen).toEqual([]);
		expect((await exec(["runs", "--limit", "1000"])).code).toBe(0);
	});

	test("SKILL.md: a clean Prometheus pass never closes a failed-run issue", () => {
		const skill = readFileSync(
			resolve(import.meta.dir, "../../fleet/skills/infra-health/SKILL.md"),
			"utf8",
		);
		const step2 = skill.slice(skill.indexOf("\n2. `ok: true`"), skill.indexOf("\n3. "));
		expect(step2).toContain("`ok: true`");
		expect(step2).not.toContain("close every open `Infra: <key>` issue");
		expect(step2).toContain("`Infra: runs:<cause>`");
		expect(step2).toContain("`Infra: board-runs-unreadable`");
		expect(skill).not.toContain("larger `--limit`");
	});

	test("a board refusal exits 1 with the refusal text and empty stdout", async () => {
		refuse = true;
		const r = await exec(["runs"]);
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
		expect(r.err.trim().split("\n")).toHaveLength(1);
		expect(r.err).toContain("(403): Route not allowed");
	});

	test("--publish with no feed yet posts the last hour, with the run id, and --feed reads it back", async () => {
		runs = [
			run({ errorCode: "process_lost", at: minsAgo(10) }),
			run({ errorCode: "process_lost", at: minsAgo(90) }),
		];
		const r = await exec(["runs", "--publish", FEED], { PAPERCLIP_RUN_ID: "run-producer" });
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		const out = JSON.parse(r.out);
		expect(out.published).toBe(true);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.runId).toBe("run-producer");
		expect(posted[0]?.body).toStartWith(
			"infra-health runs feed v1 · 2026-10-04T18:30:00Z runs since 2026-10-04T17:30:00Z: 1 failed",
		);

		// The reader: no company id needed, only GET on the issue's comments.
		seen.length = 0;
		const f = await exec(["runs", "--feed", FEED], { PAPERCLIP_COMPANY_ID: "" });
		expect(f.err).toBe("");
		expect(f.code).toBe(0);
		const got = JSON.parse(f.out);
		expect(got.line).toBe(out.line);
		expect(got.failed).toBe(1);
		expect(got.causes[0].cause).toBe("process-lost");
		expect(got.source).toEqual({ issue: FEED, commentId: "c-1", postedAt: iso(NOW), ageMin: 0 });
		expect(seen).toEqual([`GET /api/issues/${FEED}/comments`]);
	});

	test("--publish windows tile from the newest feed comment, and skip inside the gap", async () => {
		comments = [
			{ id: "chat", body: "a human remark", createdAt: iso(minsAgo(1)), deletedAt: null },
			feedComment(minsAgo(80)),
			feedComment(minsAgo(140)),
		];
		runs = [
			run({ id: "in-window", errorCode: "process_lost", at: minsAgo(75) }),
			run({ id: "before-window", errorCode: "process_lost", at: minsAgo(85) }),
		];
		const r = await exec(["runs", "--publish", FEED]);
		expect(r.code).toBe(0);
		expect(posted).toHaveLength(1);
		expect(posted[0]?.body).toContain("runs since 2026-10-04T17:10:00Z: 1 failed");
		expect(posted[0]?.body).toContain('"in-window"');
		expect(posted[0]?.body).not.toContain('"before-window"');

		// That post is now the newest feed comment: a second producer this hour posts nothing.
		const again = await exec(["runs", "--publish", FEED]);
		expect(again.code).toBe(0);
		expect(JSON.parse(again.out).published).toBe(false);
		expect(posted).toHaveLength(1);
	});

	test("--feed refuses a stale feed, a missing feed, and skips deleted or malformed comments", async () => {
		comments = [feedComment(minsAgo(121))];
		const stale = await exec(["runs", "--feed", FEED]);
		expect(stale.code).toBe(1);
		expect(stale.out).toBe("");
		expect(stale.err.trim().split("\n")).toHaveLength(1);
		expect(stale.err).toContain("121 min old");
		expect((await exec(["runs", "--feed", FEED, "--max-age-min", "180"])).code).toBe(0);

		comments = [
			feedComment(minsAgo(5), { id: "gone", deletedAt: iso(minsAgo(1)) }),
			{
				...feedComment(minsAgo(4)),
				id: "broken",
				body: "infra-health runs feed v1 · ```json\n{nope\n```",
			},
			feedComment(minsAgo(30), { id: "good" }),
		];
		const ok = JSON.parse((await exec(["runs", "--feed", FEED])).out);
		expect(ok.source.commentId).toBe("good");

		comments = [{ id: "chat", body: "no feed here", createdAt: iso(NOW), deletedAt: null }];
		const none = await exec(["runs", "--feed", FEED]);
		expect(none.code).toBe(1);
		expect(none.err).toContain("no `infra-health runs feed v1` comment");
	});

	test("bad usage exits 2", async () => {
		expect((await exec(["runs"], { PAPERCLIP_API_KEY: "" })).code).toBe(2);
		expect((await exec(["runs", "--since", "2026-10-04T18:00:00"])).code).toBe(2);
		expect((await exec(["runs", "--since", "yesterday"])).code).toBe(2);
		expect((await exec(["check", "--since", "2026-10-04T18:00:00Z"])).code).toBe(2);
		expect((await exec(["check", "--feed", FEED])).code).toBe(2);
		expect((await exec(["runs", "--feed", FEED, "--publish", FEED])).code).toBe(2);
		expect((await exec(["runs", "--feed", FEED, "--since", "2026-10-04T18:00:00Z"])).code).toBe(2);
		expect((await exec(["runs", "--feed", FEED, "--max-age-min", "0"])).code).toBe(2);
		expect(posted).toEqual([]);
	});
});
