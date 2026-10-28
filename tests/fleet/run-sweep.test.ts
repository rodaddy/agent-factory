/**
 * @module tests/fleet/run-sweep
 * @description `fleet/bin/run-sweep` (S1.3), the stale `running` row sweeper,
 *   run as a real child process against a fake board. `RUN_SWEEP_UNDER_TEST`
 *   points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { resolve } from "node:path";

const SCRIPT =
	process.env.RUN_SWEEP_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/run-sweep");
const NOW = Date.now();
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
}

const seen: Seen[] = [];
let runs: Record<string, unknown>[] = [];
let failRuns = false;
let failCancel = false;
/** Run ids whose cancel answers 409 (the run finished under us). */
let conflictCancel = new Set<string>();
let server: ReturnType<typeof Bun.serve>;
let api = "";

/** Agent a-1: timeout 3600 s, grace 60 s; a-2 has no timeout at all. */
const AGENTS: Record<string, unknown> = {
	"a-1": { id: "a-1", name: "Adams", adapterConfig: { timeoutSec: 3600, graceSec: 60 } },
	"a-2": { id: "a-2", name: "Baker", adapterConfig: {} },
};

function run(id: string, agentId: string, ageSec: number, errorCode: string | null = null) {
	return {
		id,
		agentId,
		status: "running",
		startedAt: ago(ageSec),
		createdAt: ago(ageSec + 5),
		errorCode,
		contextSnapshot: { issueId: `i-${id}` },
	};
}

function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

/** First free port in 7180-7189; board-link owns 7150-7179. */
async function freePort(): Promise<number> {
	for (let port = 7180; port <= 7189; port++) {
		if (await isFree(port)) return port;
	}
	throw new Error("no free port in 7180-7189");
}

async function sweep(args: string[], extraEnv: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			PAPERCLIP_API_URL: api,
			PAPERCLIP_API_KEY: "k-1",
			PAPERCLIP_COMPANY_ID: "co-1",
			...extraEnv,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

const cancels = () => seen.filter((s) => s.method === "POST").map((s) => s.path);

beforeAll(async () => {
	server = Bun.serve({
		port: await freePort(),
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			seen.push({
				method: request.method,
				path,
				authorization: request.headers.get("authorization"),
			});
			// Both list routes mirror Paperclip (sf-fleet-01, @paperclipai/server
			// routes/agents.js): newest createdAt first; heartbeat-runs caps
			// `limit` at 1000 with no status filter and no offset; live-runs
			// keeps only queued/running, caps at 50, and carries no errorCode.
			const newest = () =>
				[...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
			if (request.method === "GET" && path === "/api/companies/co-1/heartbeat-runs") {
				if (failRuns) return Response.json({ error: "boom" }, { status: 500 });
				const limit = Math.min(1000, Number(url.searchParams.get("limit")) || 200);
				return Response.json(newest().slice(0, limit));
			}
			if (request.method === "GET" && path === "/api/companies/co-1/live-runs") {
				if (failRuns) return Response.json({ error: "boom" }, { status: 500 });
				const limit = Math.min(50, Number(url.searchParams.get("limit")) || 50);
				const live = newest().filter((r) => r.status === "queued" || r.status === "running");
				return Response.json(
					live.slice(0, limit).map(({ errorCode: _e, contextSnapshot, ...r }) => ({
						...r,
						issueId: (contextSnapshot as { issueId?: string } | null)?.issueId ?? null,
					})),
				);
			}
			const one = path.match(/^\/api\/heartbeat-runs\/([^/]+)$/);
			if (request.method === "GET" && one?.[1]) {
				const hit = runs.find((r) => r.id === one[1]);
				if (hit) return Response.json(hit);
			}
			const agent = path.match(/^\/api\/agents\/([^/]+)$/);
			if (request.method === "GET" && agent?.[1] && AGENTS[agent[1]]) {
				return Response.json(AGENTS[agent[1]]);
			}
			if (request.method === "POST" && /^\/api\/heartbeat-runs\/[^/]+\/cancel$/.test(path)) {
				if (failCancel) return Response.json({ error: "boom" }, { status: 500 });
				const id = path.split("/")[3] ?? "";
				if (conflictCancel.has(id)) return Response.json({ error: "done" }, { status: 409 });
				return Response.json({ ok: true });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
	seen.length = 0;
	failRuns = false;
	failCancel = false;
	conflictCancel = new Set();
	runs = [
		// 3600 + 60 + 600 = 4260 s threshold for a-1.
		run("old", "a-1", 5000),
		run("fresh", "a-1", 100),
		// Past its timeout but inside grace+margin: kept unless detached.
		run("det", "a-1", 3700, "process_detached"),
		run("young-det", "a-1", 1000, "process_detached"),
		// No timeout known: age never qualifies it.
		run("notimeout", "a-2", 99_999),
		{ ...run("done", "a-1", 9000), status: "succeeded" },
	];
});

describe("run-sweep", () => {
	test("dry run lists stale-by-age and stale-by-detached rows and writes nothing", async () => {
		const r = await sweep([]);
		expect(r.code).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(lines.filter((l) => l.startsWith("stale ")).length).toBe(2);
		expect(r.stdout).toMatch(/stale old agent=Adams issue=i-old age=\d+s reason=age>4260s/);
		expect(r.stdout).toMatch(/stale det agent=Adams issue=i-det age=\d+s reason=process_detached/);
		expect(r.stdout).not.toContain("fresh");
		expect(r.stdout).not.toContain("young-det");
		expect(r.stdout).not.toContain("notimeout");
		expect(r.stdout).toContain("run-sweep: 2 stale of 5 running (dry run)");
		expect(cancels()).toEqual([]);
		expect(seen.every((s) => s.authorization === "Bearer k-1")).toBe(true);
	});

	test("--apply cancels exactly once per stale row through the board endpoint", async () => {
		const r = await sweep(["--apply"]);
		expect(r.code).toBe(0);
		expect(cancels().sort()).toEqual([
			"/api/heartbeat-runs/det/cancel",
			"/api/heartbeat-runs/old/cancel",
		]);
		expect(r.stdout).toContain("run-sweep: 2 stale of 5 running (cancelled 2)");
	});

	test("no running rows: exit 0 and 0 stale", async () => {
		runs = [];
		const r = await sweep([]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("run-sweep: 0 stale of 0 running (dry run)");
	});

	test("an API error on listing exits 1 and cancels nothing", async () => {
		failRuns = true;
		const r = await sweep(["--apply"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("500");
		expect(cancels()).toEqual([]);
	});

	test("an API error on cancel exits 1", async () => {
		failCancel = true;
		const r = await sweep(["--apply"]);
		expect(r.code).toBe(1);
	});

	test("bad usage and missing env exit 3 with no request", async () => {
		expect((await sweep(["--bogus"])).code).toBe(3);
		expect((await sweep([], { PAPERCLIP_COMPANY_ID: "" })).code).toBe(3);
		expect(seen).toEqual([]);
	});

	test("the key never reaches stdout or stderr", async () => {
		const r = await sweep(["--apply"], { PAPERCLIP_API_KEY: "sekrit-key-xyz" });
		expect(r.stdout + r.stderr).not.toContain("sekrit-key-xyz");
	});

	test("F1: a running row older than the newest 1000 runs is still seen", async () => {
		runs = [run("buried", "a-1", 30_000)];
		for (let i = 0; i < 1001; i++) {
			runs.push({ ...run(`h-${i}`, "a-1", 10 + i), status: "succeeded" });
		}
		const r = await sweep([]);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/stale buried agent=Adams issue=i-buried/);
		expect(r.stdout).toContain("run-sweep: 1 stale of 1 running (dry run)");
	});

	test("F1: a full live-run page with no next page fails loud and cancels nothing", async () => {
		runs = Array.from({ length: 50 }, (_, i) => run(`r-${i}`, "a-1", 5000 + i));
		const r = await sweep(["--apply"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("listing truncated");
		expect(cancels()).toEqual([]);
	});

	test("F2: a 409 on one cancel continues, prints the summary, and exits 1", async () => {
		conflictCancel = new Set(["old"]);
		const r = await sweep(["--apply"]);
		expect(r.code).toBe(1);
		expect(cancels().sort()).toEqual([
			"/api/heartbeat-runs/det/cancel",
			"/api/heartbeat-runs/old/cancel",
		]);
		expect(r.stderr).toContain("409");
		expect(r.stdout).toContain("run-sweep: 2 stale of 5 running (cancelled 1, 1 failed)");
	});

	test("F3: --apply cancels at most --max-cancel runs (default 10), lists the rest, exits 1", async () => {
		runs = Array.from({ length: 12 }, (_, i) => run(`s-${i}`, "a-1", 5000 + i));
		const r = await sweep(["--apply"]);
		expect(r.code).toBe(1);
		expect(cancels().length).toBe(10);
		expect(r.stdout.split("\n").filter((l) => l.startsWith("stale ")).length).toBe(12);
		expect(r.stdout).toContain("(cancelled 10, 2 over --max-cancel 10)");

		seen.length = 0;
		const one = await sweep(["--apply", "--max-cancel", "1"]);
		expect(one.code).toBe(1);
		// Oldest first: s-11 is the oldest row.
		expect(cancels()).toEqual(["/api/heartbeat-runs/s-11/cancel"]);
		expect(one.stdout).toContain("(cancelled 1, 11 over --max-cancel 1)");
	});

	test("F3: --max-cancel within the cap exits 0; a bad value is usage", async () => {
		const r = await sweep(["--apply", "--max-cancel=2"]);
		expect(r.code).toBe(0);
		expect(cancels().length).toBe(2);
		expect((await sweep(["--apply", "--max-cancel", "x"])).code).toBe(3);
		expect((await sweep(["--apply", "--max-cancel"])).code).toBe(3);
	});

	test("P3: an agent lookup 404 skips that agent's runs with a warning", async () => {
		runs = [run("old", "a-1", 5000), run("orphan", "ghost", 99_999)];
		const r = await sweep(["--apply"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("agent ghost not found");
		expect(cancels()).toEqual(["/api/heartbeat-runs/old/cancel"]);
		expect(r.stdout).toContain(
			"run-sweep: 1 stale of 2 running (cancelled 1); skipped 1 run of 1 missing agent",
		);
	});
});
