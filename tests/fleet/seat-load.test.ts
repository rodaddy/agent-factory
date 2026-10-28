/**
 * @module tests/fleet/seat-load
 * @description `fleet/bin/seat-load`, the board reads behind task-route, run as
 *   a real child process against a fake Paperclip board (`Bun.serve`). The fake
 *   ignores every issues filter except limit/offset, so a count that is right
 *   proves the script filters status and assignee itself; it can also cap
 *   limit or ignore offset. `SEAT_LOAD_UNDER_TEST` points the suite at a
 *   mutated copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT =
	process.env.SEAT_LOAD_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/seat-load");
// Built at runtime so no credential-looking literal sits in the file.
const KEY = ["fake", "board", "key", String(Date.now())].join("-");
const COMPANY = "co-1";

// Crowd is first, so a board that ignores offset returns only its issues.
const SEATS = [
	{ id: "agent-crowd", name: "Crowd", status: "idle", model: "gpt-6-luna", load: 150 },
	{ id: "agent-two", name: "Two", status: "paused", model: "claude-sonnet-5-5", load: 2 },
	{ id: "agent-none", name: "None", status: "idle", model: null, load: 0 },
];

const LIVE = SEATS.map((s) => ({
	id: s.id,
	name: s.name,
	status: s.status,
	adapterType: "pi_local",
	adapterConfig: s.model === null ? {} : { model: s.model },
}));

// Each seat's load as open issues, plus closed and blocked ones that must not count.
const ISSUES = SEATS.flatMap((s) => [
	...Array.from({ length: s.load }, (_, i) => ({
		id: `${s.id}-open-${i}`,
		status: ["todo", "in_progress", "in_review"][i % 3],
		assigneeAgentId: s.id,
	})),
	...["done", "blocked", "cancelled", "backlog"].map((st) => ({
		id: `${s.id}-${st}`,
		status: st,
		assigneeAgentId: s.id,
	})),
]);

let status = 200;
// Board quirks: cap `limit` per call, or ignore `offset` and repeat the first page.
let cap = Number.POSITIVE_INFINITY;
let ignoreOffset = false;
let paths: string[] = [];
let board: ReturnType<typeof Bun.serve>;

beforeAll(() => {
	board = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			paths.push(`${req.method} ${url.pathname}`);
			if (req.method !== "GET") return new Response("no writes", { status: 405 });
			const auth = req.headers.get("authorization");
			if (auth !== `Bearer ${KEY}`) return new Response("unauthorized", { status: 401 });
			// The error body echoes the key, so only the scrub keeps it off stderr.
			if (status !== 200) return new Response(`boom ${auth}`, { status });
			if (url.pathname === `/api/companies/${COMPANY}/agents`) return Response.json(LIVE);
			if (url.pathname === `/api/companies/${COMPANY}/issues`) {
				const limit = Math.min(cap, Number(url.searchParams.get("limit") ?? 50));
				const offset = ignoreOffset ? 0 : Number(url.searchParams.get("offset") ?? 0);
				return Response.json(ISSUES.slice(offset, offset + limit));
			}
			return new Response("not found", { status: 404 });
		},
	});
});
afterAll(() => board.stop(true));
beforeEach(() => {
	status = 200;
	cap = Number.POSITIVE_INFINITY;
	ignoreOffset = false;
	paths = [];
});

async function run(args: string[] = [], extra: Record<string, string> = {}) {
	const p = Bun.spawn([SCRIPT, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: "/nonexistent-seat-load-home",
			PAPERCLIP_API_URL: `http://127.0.0.1:${board.port}`,
			PAPERCLIP_API_KEY: KEY,
			PAPERCLIP_COMPANY_ID: COMPANY,
			...extra,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	expect(stdout + stderr).not.toContain(KEY);
	return { stdout, stderr, code };
}

const lines = (stdout: string) =>
	stdout
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
const openOf = (stdout: string, name: string) => lines(stdout).find((l) => l.name === name)?.open;

describe("seat-load reads the board", () => {
	test("one line per agent; closed, blocked and backlog issues do not count", async () => {
		const r = await run();
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
		expect(lines(r.stdout)).toEqual([
			{ id: "agent-crowd", name: "Crowd", status: "idle", model: "gpt-6-luna", open: 150 },
			{ id: "agent-two", name: "Two", status: "paused", model: "claude-sonnet-5-5", open: 2 },
			{ id: "agent-none", name: "None", status: "idle", model: null, open: 0 },
		]);
	});

	test("the script only reads the board", async () => {
		await run();
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.every((p) => p.startsWith("GET "))).toBe(true);
	});
});

describe("seat-load paging", () => {
	test("a board that caps limit at 100 still counts all 150 open issues", async () => {
		cap = 100;
		const r = await run();
		expect(r.code).toBe(0);
		expect(openOf(r.stdout, "Crowd")).toBe(150);
	});

	test("a board that ignores offset ends on the repeated page: open 100, exit 0", async () => {
		cap = 100;
		ignoreOffset = true;
		const r = await run();
		expect(r.code).toBe(0);
		expect(openOf(r.stdout, "Crowd")).toBe(100);
	});
});

describe("seat-load exit grammar", () => {
	test("board 500: exit 3, the key in the error body is scrubbed", async () => {
		status = 500;
		const r = await run();
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("HTTP 500");
		expect(r.stderr).toContain("boom Bearer ***");
	});

	test("unreachable board: exit 3", async () => {
		const r = await run([], { PAPERCLIP_API_URL: "http://127.0.0.1:1" });
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("seat-load: board unreachable");
	});

	test("PAPERCLIP_BOARD_TOKEN works when PAPERCLIP_API_KEY is unset", async () => {
		const r = await run([], { PAPERCLIP_API_KEY: "", PAPERCLIP_BOARD_TOKEN: KEY });
		expect(r.code).toBe(0);
	});

	test("an argument, no company or no key: exit 2, no request", async () => {
		expect((await run(["--bogus"])).code).toBe(2);
		expect((await run([], { PAPERCLIP_COMPANY_ID: "" })).code).toBe(2);
		expect((await run([], { PAPERCLIP_API_KEY: "" })).code).toBe(2);
		expect(paths.length).toBe(0);
	});
});
