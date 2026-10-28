/**
 * @module tests/fleet/fleet-audit-collect
 * @description `fleet/audit/collect.py` as a real child process against a
 *   fake board and fake Langfuse on one port: snapshot shape, a failed read as an
 *   `errors` entry, the window filter, per-agent paging, and no key in the output.
 *   `FLEET_AUDIT_COLLECT_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.FLEET_AUDIT_COLLECT_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/audit/collect.py");
const BOARD_KEY = ["fake", "board", "value", "1690"].join("-");
const LF_SECRET = ["fake", "langfuse", "value", "1690"].join("-");
const CO = "co-1";
const PAGE = 1000;
/** The suite owns the clock: every timestamp and the collector's `--now` share this instant. */
const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ids = (list: { id: string }[]) => String(list.map((x) => x.id).sort());

type Run = Record<string, unknown>;
const RUN = {
	errorCode: null,
	usageJson: { inputTokens: 70, outputTokens: 5, costUsd: 0.1 },
	contextSnapshot: { issueId: "i-ref", wakeReason: "issue_assigned" },
};
const run = (id: string, agentId: string, status: string, min: number): Run => ({
	...RUN,
	id,
	agentId,
	status,
	createdAt: ago(min),
	startedAt: ago(min),
	finishedAt: status === "queued" || status === "running" ? null : ago(min - 1),
});
const ISSUE = { title: "t", createdAt: ago(90), updatedAt: ago(9), originKind: "manual", x: 1 };
const issue = (id: string, status: string, assigneeAgentId: string | null) => ({
	...ISSUE,
	id,
	identifier: `SOF-${id}`,
	status,
	assigneeAgentId,
});
const AGENTS = [
	{
		id: "a-1",
		name: "Adams",
		status: "idle",
		runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } },
	},
	{ id: "a-2", name: "Bishop", status: "paused", pauseReason: "manual", runtimeConfig: {} },
];

type State = {
	runs: Run[];
	perAgent: Record<string, Run[]>;
	fail: string[];
	traces: string[];
	recoveryRows: unknown[];
	/** Langfuse `pi-run` observations, one array per page; `meta.totalPages` is the page count. */
	observations: unknown[][];
	/** When set, the agents read answers 302 to this URL. */
	redirectAgents: string | null;
};
let state: State;
const seen: string[] = [];
const auth: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let api = "";
const work = mkdtempSync(join(testTmpBase(), "fleet-audit-collect-"));

function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

/** First free port in 7190-7199, clear of the 7100-7189 ranges other fleet suites use. */
async function freePort(): Promise<number> {
	for (let port = 7190; port <= 7199; port++) {
		if (await isFree(port)) return port;
	}
	throw new Error("no free port in 7190-7199");
}

function route(url: URL): unknown {
	const p = url.pathname;
	const last = p.split("/").pop() ?? "";
	if (p.startsWith("/api/public/traces/")) return state.traces.includes(last) ? { id: last } : null;
	if (p === "/api/public/observations") {
		const page = Number(url.searchParams.get("page") ?? "1");
		const totalPages = Math.max(1, state.observations.length);
		return { data: state.observations[page - 1] ?? [], meta: { page, totalPages } };
	}
	if (p === `/api/companies/${CO}/agents` || p === "/moved/agents") return AGENTS;
	if (p === `/api/companies/${CO}/heartbeat-runs`) {
		const agent = url.searchParams.get("agentId");
		return agent ? (state.perAgent[agent] ?? []) : state.runs.slice(0, PAGE);
	}
	if (p === `/api/companies/${CO}/issues`) {
		const todo = url.searchParams.get("status") === "todo";
		return todo ? [issue("i-open", "todo", "a-1"), issue("i-free", "todo", null)] : [];
	}
	if (p === `/api/companies/${CO}/recovery-observability`) return { byCause: state.recoveryRows };
	if (p.startsWith("/api/issues/")) return issue(last, "done", null);
	return null;
}

async function collect(args: string[] = ["--window", "4h"]) {
	const urls = { PATH: process.env.PATH ?? "", PAPERCLIP_API_URL: api, LANGFUSE_BASE_URL: api };
	const keys = { PAPERCLIP_API_KEY: BOARD_KEY, LANGFUSE_SECRET_KEY: LF_SECRET };
	const env = { ...urls, ...keys, PAPERCLIP_COMPANY_ID: CO, LANGFUSE_PUBLIC_KEY: "pk-1" };
	const now = new Date(NOW).toISOString();
	const p = Bun.spawn(["python3", SCRIPT, ...args, "--now", now], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = [p.stdout, p.stderr].map((s) => new Response(s).text());
	const [stdout = "", stderr = ""] = await Promise.all(out);
	const code = await p.exited;
	expect(stdout + stderr).not.toContain(BOARD_KEY);
	expect(stdout + stderr).not.toContain(LF_SECRET);
	return { stdout, stderr, code };
}

/** The fleet-audit-snapshot/1 keys, sorted, per object kind. */
const SHAPE = {
	top: "agents collectedAt errors issues recovery runs schema window",
	window: "from label to",
	agent: "id maxConcurrentRuns name pauseReason status",
	run: "agentId createdAt errorCode finishedAt id inputTokens issueId outputTokens peakRssKb startedAt status traced wakeReason",
	issue: "assigneeAgentId createdAt id identifier originKind status title updatedAt",
	error: "message source",
};

/** The fleet-audit-snapshot/1 contract, checked key by key. */
function expectShape(snap: Record<string, unknown>) {
	const has = (o: unknown, kind: keyof typeof SHAPE) =>
		expect(Object.keys(o as object).sort()).toEqual(SHAPE[kind].split(" "));
	expect(snap.schema).toBe("fleet-audit-snapshot/1");
	has(snap, "top");
	has(snap.window, "window");
	for (const a of snap.agents as object[]) has(a, "agent");
	for (const r of snap.runs as object[]) has(r, "run");
	for (const i of snap.issues as object[]) has(i, "issue");
	for (const e of snap.errors as object[]) has(e, "error");
	for (const n of Object.values((snap.recovery as { activeByCause: object }).activeByCause))
		expect(typeof n).toBe("number");
}

beforeAll(async () => {
	server = Bun.serve({
		port: await freePort(),
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			seen.push(url.pathname + url.search);
			auth.push(request.headers.get("authorization") ?? "");
			if (state.redirectAgents && url.pathname === `/api/companies/${CO}/agents`)
				return new Response(null, { status: 302, headers: { location: state.redirectAgents } });
			if (state.fail.some((f) => url.pathname.endsWith(f)))
				return new Response("boom", { status: 500 });
			const body = route(url);
			return body === null ? new Response("nf", { status: 404 }) : Response.json(body);
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	rmSync(work, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
	auth.length = 0;
	const row = (activeCount: number) => ({ cause: "stranded", activeCount });
	state = {
		runs: [],
		perAgent: {},
		fail: [],
		traces: [],
		recoveryRows: [row(2), row(3)],
		observations: [],
		redirectAgents: null,
	};
});

/** The observations GETs the collector made, as parsed query params. */
const observationReads = () =>
	seen
		.filter((s) => s.startsWith("/api/public/observations"))
		.map((s) => new URL(s, "http://x").searchParams);
const rssOf = (snap: { runs: Run[] }) =>
	Object.fromEntries(snap.runs.map((r) => [r.id as string, r.peakRssKb]));
const pirun = (traceId: string, value: unknown) => ({
	traceId,
	metadata: { peak_rss_kb_pi_process: value },
});

describe("fleet/audit/collect.py", () => {
	test("writes a valid snapshot with tokens, wake, traces, issues and recovery", async () => {
		state.runs = [run("r-new", "a-1", "succeeded", 30), run("r-gone", "a-2", "failed", 20)];
		state.traces = ["r-new"];
		const out = join(work, "snap.json");
		const { stdout, code } = await collect(["--window", "4h", "--out", out]);
		expect([code, stdout]).toEqual([0, ""]);
		const written = readFileSync(out, "utf8");
		expect(written).not.toContain(BOARD_KEY);
		expect(written).not.toContain(LF_SECRET);
		const snap = JSON.parse(written);
		expectShape(snap);
		expect(snap.window).toEqual({ label: "4h", from: ago(240), to: ago(0) });
		expect(snap.agents.map((a: Run) => a.maxConcurrentRuns)).toEqual([3, null]);
		const [fresh, gone] = snap.runs;
		expect(fresh).toMatchObject({ traced: true, inputTokens: 70, wakeReason: "issue_assigned" });
		expect([fresh.issueId, gone.id, gone.traced]).toEqual(["i-ref", "r-gone", false]);
		expect(ids(snap.issues)).toBe("i-open,i-ref");
		expect(snap.recovery.activeByCause).toEqual({ stranded: 5 });
		expect(snap.errors).toEqual([]);
		expect(auth).toContain(`Bearer ${BOARD_KEY}`);
		expect(auth).toContain(`Basic ${btoa(`pk-1:${LF_SECRET}`)}`);
	});

	test("a 500 from one endpoint is an errors entry and the snapshot stays valid", async () => {
		state.runs = [run("r-1", "a-1", "succeeded", 30)];
		state.fail = ["/recovery-observability", "/traces/r-1"];
		const { stdout, code } = await collect();
		expect(code).toBe(0);
		const snap = JSON.parse(stdout);
		expectShape(snap);
		const board = `GET /api/companies/${CO}/recovery-observability failed: HTTP 500`;
		expect(snap.errors).toEqual([
			{ source: "board", message: board },
			{ source: "langfuse", message: "trace lookup failed for 1 runs: HTTP 500" },
		]);
		expect(snap.recovery.activeByCause).toEqual({});
		expect(snap.runs[0].traced).toBeNull();
	});

	test("the window keeps queued and running runs from before it and drops old finished ones", async () => {
		state.runs = [
			run("r-in", "a-1", "succeeded", 60),
			run("r-old", "a-1", "succeeded", 600),
			run("r-queued", "a-1", "queued", 600),
			run("r-running", "a-2", "running", 900),
		];
		const snap = JSON.parse((await collect(["--window", "4h", "--no-langfuse"])).stdout);
		expect(ids(snap.runs)).toBe("r-in,r-queued,r-running");
		expect(seen.some((s) => s.startsWith("/api/public/") || s.includes("agentId="))).toBe(false);
	});

	test("a full company page is re-read per agent, and a full agent page is recorded as capped", async () => {
		state.runs = Array.from({ length: PAGE }, (_, n) => run(`c-${n}`, "a-1", "succeeded", 10));
		state.perAgent = { "a-1": state.runs, "a-2": [run("b-only", "a-2", "failed", 50)] };
		const snap = JSON.parse((await collect(["--window", "4h", "--no-langfuse"])).stdout);
		expectShape(snap);
		expect(seen.filter((s) => s.includes("agentId=")).length).toBe(2);
		expect(snap.runs.length).toBe(PAGE + 1);
		expect(snap.runs.some((r: Run) => r.id === "b-only")).toBe(true);
		expect(snap.errors).toEqual([{ source: "board", message: "runs capped for Adams" }]);
	});

	test("a malformed recovery row is an errors entry and the good rows still count", async () => {
		state.recoveryRows = [
			{ cause: "stranded", activeCount: 2 },
			null,
			{ cause: "stranded", activeCount: "many" },
			{ cause: "stranded", activeCount: [1] },
			{ cause: "lost", activeCount: 4 },
		];
		const { stdout, code } = await collect(["--window", "4h", "--no-langfuse"]);
		expect(code).toBe(0);
		const snap = JSON.parse(stdout);
		expectShape(snap);
		expect(snap.recovery.activeByCause).toEqual({ stranded: 2, lost: 4 });
		expect(snap.errors).toEqual(
			[1, 2, 3].map((n) => ({ source: "board", message: `recovery row ${n} malformed, skipped` })),
		);
	});

	test("a redirect keeps the Authorization header on the same origin and drops it across origins", async () => {
		const bearer = `Bearer ${BOARD_KEY}`;
		const movedAuth = () => auth[seen.indexOf("/moved/agents")];
		state.redirectAgents = `${api}/moved/agents`;
		const same = JSON.parse((await collect(["--window", "4h", "--no-langfuse"])).stdout);
		expect(same.agents.length).toBe(2);
		expect(movedAuth()).toBe(bearer);
		seen.length = 0;
		auth.length = 0;
		state.redirectAgents = `${api.replace("127.0.0.1", "localhost")}/moved/agents`;
		const cross = JSON.parse((await collect(["--window", "4h", "--no-langfuse"])).stdout);
		expect(cross.agents.length).toBe(2);
		expect(movedAuth()).toBe("");
		expect(auth).toContain(bearer);
	});

	test("peakRssKb joins a pi-run observation to its run by trace id = run id", async () => {
		state.runs = [run("r-new", "a-1", "succeeded", 30), run("r-gone", "a-2", "failed", 20)];
		state.observations = [[pirun("r-new", 123456)]];
		const snap = JSON.parse((await collect()).stdout);
		expectShape(snap);
		expect(rssOf(snap)).toEqual({ "r-new": 123456, "r-gone": null });
		expect(snap.errors).toEqual([]);
		const [q, ...more] = observationReads();
		expect(more.length).toBe(0);
		const want = { name: "pi-run", fromStartTime: ago(240), limit: "100", page: "1" };
		expect(Object.fromEntries(q?.entries() ?? [])).toEqual(want);
	});

	test("peakRssKb reads every page up to meta.totalPages", async () => {
		state.runs = [run("r-a", "a-1", "succeeded", 30), run("r-b", "a-1", "succeeded", 20)];
		state.observations = [[pirun("r-a", 1000)], [pirun("r-b", 2000.7)]];
		const snap = JSON.parse((await collect()).stdout);
		expect(rssOf(snap)).toEqual({ "r-a": 1000, "r-b": 2000 });
		expect(observationReads().map((q) => q.get("page"))).toEqual(["1", "2"]);
		expect(snap.errors).toEqual([]);
	});

	test("a non-numeric, negative or boolean peak RSS is null and not an error", async () => {
		state.runs = ["r-s", "r-neg", "r-bool", "r-ok"].map((id, n) =>
			run(id, "a-1", "succeeded", 30 + n),
		);
		state.observations = [
			[pirun("r-s", "abc"), pirun("r-neg", -5), pirun("r-bool", true), pirun("r-ok", 0)],
		];
		const snap = JSON.parse((await collect()).stdout);
		expect(rssOf(snap)).toEqual({ "r-s": null, "r-neg": null, "r-bool": null, "r-ok": 0 });
		expect(snap.errors).toEqual([]);
	});

	test("a 500 from observations is one langfuse errors entry and every peakRssKb is null", async () => {
		state.runs = [run("r-1", "a-1", "succeeded", 30), run("r-2", "a-1", "succeeded", 20)];
		state.observations = [[pirun("r-1", 5)], [pirun("r-2", 6)]];
		state.fail = ["/api/public/observations"];
		const { stdout, stderr, code } = await collect();
		expect(code).toBe(0);
		const snap = JSON.parse(stdout);
		expectShape(snap);
		expect(rssOf(snap)).toEqual({ "r-1": null, "r-2": null });
		expect(snap.errors).toEqual([{ source: "langfuse", message: "rss page 1 failed: HTTP 500" }]);
		expect(observationReads().length).toBe(1);
		expect(stdout + stderr).not.toContain(btoa(`pk-1:${LF_SECRET}`));
	});

	test("--no-langfuse makes no observations request", async () => {
		state.runs = [run("r-1", "a-1", "succeeded", 30)];
		state.observations = [[pirun("r-1", 5)]];
		const snap = JSON.parse((await collect(["--window", "4h", "--no-langfuse"])).stdout);
		expect(observationReads().length).toBe(0);
		expect(rssOf(snap)).toEqual({ "r-1": null });
	});
});
