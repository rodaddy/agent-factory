/**
 * @module tests/fleet/rico-notify-run
 * @description `fleet/notify/rico-notify.ts` run as a real child process
 *   against a fake board (`Bun.serve`, in-memory rows, every request
 *   recorded) and a fake `imsg` that logs its argv. Nothing is sent and no real
 *   board is called. `RICO_NOTIFY_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.RICO_NOTIFY_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/notify/rico-notify.ts");
const TOKEN = ["fake", "board", "value"].join("-");
const HANDLE = "someone@example.invalid";
const COMPANY = "co-1";
const SCRATCH = join(testTmpBase(), `rico-notify-${process.pid}-${Date.now()}`);
const STATE = join(SCRATCH, "state.json");
const SENDER = join(SCRATCH, "imsg");
const SENT_LOG = join(SCRATCH, "sent.log");
const CONTROL = join(SCRATCH, "control.json");

/**
 * The fake `imsg`: logs its argv as one JSON line, then answers as the control
 * file says (exit code, a stderr line, the JSON status). Default: sent, exit 0.
 */
const FAKE_SENDER = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(SENT_LOG)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const file = ${JSON.stringify(CONTROL)};
const c = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
if (c.stderr) process.stderr.write(c.stderr + "\\n");
if ((c.code ?? 0) === 0) process.stdout.write(JSON.stringify({ status: c.status ?? "sent" }) + "\\n");
process.exit(c.code ?? 0);
`;

type Row = Record<string, unknown>;
let issues: Row[] = [];
let approvals: Row[] = [];
let agents: Row[] = [];
let runs: Row[] = [];
let comments: Record<string, Row[]> = {};
let fail: { path: string; status: number } | null = null;
let requests: Array<{ path: string; auth: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;

function blocked(
	n: number,
	action = `NEEDS RICO on rodaddy/x: https://forge.example.internal/rodaddy/x/pulls/${n}`,
): Row {
	return {
		id: `iss-${n}`,
		identifier: `SOF-${n}`,
		title: `task ${n}`,
		status: "blocked",
		blockedTransitionAt: "2026-10-03T10:00:00.000Z",
		unblockDescriptor: { owner: "board", action },
	};
}

beforeAll(() => {
	mkdirSync(SCRATCH, { recursive: true });
	writeFileSync(SENDER, FAKE_SENDER, { mode: 0o755 });
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			requests.push({ path, auth: req.headers.get("authorization") });
			if (fail && path.endsWith(fail.path)) return new Response("no", { status: fail.status });
			const co = `/api/companies/${COMPANY}`;
			if (path === `${co}/issues`) return Response.json(issues);
			if (path === `${co}/approvals`) return Response.json(approvals);
			if (path === `${co}/agents`) return Response.json(agents);
			if (path === `${co}/heartbeat-runs`) return Response.json(runs);
			const one = /^\/api\/issues\/([^/]+)(\/comments)?$/.exec(path);
			const issue = one ? issues.find((row) => row.id === one[1]) : undefined;
			if (one && issue) return Response.json(one[2] ? (comments[one[1] ?? ""] ?? []) : issue);
			return new Response("nf", { status: 404 });
		},
	});
});
afterAll(() => {
	server.stop(true);
	rmSync(SCRATCH, { recursive: true, force: true });
});
beforeEach(() => {
	issues = [];
	approvals = [];
	agents = [];
	runs = [];
	comments = {};
	fail = null;
	requests = [];
	for (const file of [STATE, SENT_LOG, CONTROL]) rmSync(file, { force: true });
});

function baseEnv(): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		PAPERCLIP_API_URL: `http://127.0.0.1:${server.port}`,
		PAPERCLIP_COMPANY_ID: COMPANY,
		PAPERCLIP_BOARD_TOKEN: TOKEN,
		RICO_NOTIFY_TO: HANDLE,
		RICO_NOTIFY_STATE: STATE,
		RICO_NOTIFY_SEND: SENDER,
	};
}

async function run(args: string[], env: Record<string, string> = baseEnv()) {
	const p = Bun.spawn([process.execPath, SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	const all = stdout + stderr;
	expect(all).not.toContain(TOKEN);
	expect(all).not.toContain(HANDLE);
	return { stdout, stderr, code };
}

function primedState(): void {
	const state = { v: 1, primed: true, sent: {}, sends: [], errorPasses: {}, boardFails: 0 };
	writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
}

/** A primed state with `over` applied, written as the job would find it. */
function writeState(over: Record<string, unknown>): void {
	const state = {
		v: 1,
		primed: true,
		sent: {},
		sends: [],
		errorPasses: {},
		boardFails: 0,
		...over,
	};
	writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
}

function readState(): Record<string, unknown> & { sends: string[] } {
	return JSON.parse(readFileSync(STATE, "utf8"));
}

test("company kill-switch approval is sent once even on the first pass", async () => {
	approvals = [
		{
			id: "budget-stop-1",
			type: "request_board_approval",
			status: "pending",
			payload: {
				source: "company_daily_budget",
				title: "Company daily budget STOP: ceiling crossed. All seats paused.",
			},
		},
	];
	await run([]);
	await run([]);
	expect(calls()).toHaveLength(1);
	expect(textOf(calls()[0])).toContain("Company daily budget STOP");
});

describe("rico-notify config", () => {
	test("a missing RICO_NOTIFY_TO is exit 2, names the variable, calls no board", async () => {
		const env = baseEnv();
		delete env.RICO_NOTIFY_TO;
		const r = await run(["--dry-run"], env);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("rico-notify: RICO_NOTIFY_TO is required");
		expect(requests.length).toBe(0);
	});

	test("an env file others can read is exit 2; the same file at 0600 is read", async () => {
		const file = join(SCRATCH, "env");
		const body = Object.entries(baseEnv())
			.filter(([key]) => key !== "PATH")
			.map(([key, value]) => `${key}=${value}`);
		writeFileSync(file, ["# notifier", "", ...body, ""].join("\n"));
		const env = { PATH: process.env.PATH ?? "", RICO_NOTIFY_ENV_FILE: file };

		chmodSync(file, 0o644);
		const open = await run(["--dry-run"], env);
		expect(open.code).toBe(2);
		expect(open.stderr).toContain("rico-notify: env file must be mode 600");
		expect(requests.length).toBe(0);

		chmodSync(file, 0o600);
		const closed = await run(["--dry-run"], env);
		expect(closed.code).toBe(0);
		expect(requests.length).toBeGreaterThan(0);
	});

	test("any argument other than --dry-run is exit 2 and calls no board", async () => {
		const r = await run(["--send-now"]);
		expect(r.code).toBe(2);
		expect(requests.length).toBe(0);
	});
});

describe("rico-notify --dry-run", () => {
	test("a first pass prints one summary of the board-owned blocked issues and writes nothing", async () => {
		issues = [blocked(1), blocked(2), { ...blocked(3), status: "todo" }];
		const r = await run(["--dry-run"]);
		expect(r.code).toBe(0);
		expect(r.stdout.startsWith("--- blocked:iss-1:")).toBe(true);
		expect(r.stdout).toContain("Factory notifier is on. 2 already waiting");
		expect(r.stdout.match(/^--- /gm)?.length).toBe(1);
		expect(existsSync(STATE)).toBe(false);
	});

	test("every board request carries the Bearer token", async () => {
		issues = [blocked(1)];
		await run(["--dry-run"]);
		expect(requests.length).toBeGreaterThanOrEqual(4);
		for (const request of requests) expect(request.auth).toBe(`Bearer ${TOKEN}`);
	});

	test("a text links straight to its own issue or approval, never to a list page", async () => {
		primedState();
		issues = [blocked(7, "answer Nagatha's questions")];
		approvals = [
			{
				id: "ap-1",
				type: "request_board_approval",
				status: "pending",
				payload: { title: "Rotate" },
			},
		];
		const r = await run(["--dry-run"]);
		expect(r.code).toBe(0);
		const board = `http://127.0.0.1:${server.port}`;
		expect(r.stdout).toContain(`SOF-7: answer Nagatha's questions\n${board}/issues/SOF-7\n`);
		expect(r.stdout).toContain(`Approval waiting: Rotate\n${board}/approvals/ap-1\n`);
		expect(readFileSync(STATE, "utf8")).not.toContain("blocked:");
	});

	test("a Forge link in the action wins over the board link", async () => {
		primedState();
		issues = [blocked(8)];
		const r = await run(["--dry-run"]);
		expect(r.stdout).toContain("\nhttps://forge.example.internal/rodaddy/x/pulls/8\n");
	});
});

describe("rico-notify board failures", () => {
	test("a 500 from /agents is exit 1 and stderr names the path and the status", async () => {
		fail = { path: "/agents", status: 500 };
		const r = await run(["--dry-run"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`rico-notify: board GET /companies/${COMPANY}/agents -> 500`);
	});

	test("a 401 is exit 1", async () => {
		fail = { path: "/issues", status: 401 };
		const r = await run(["--dry-run"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("-> 401");
	});
});

function control(value: { code?: number; stderr?: string; status?: string }): void {
	writeFileSync(CONTROL, JSON.stringify(value));
}

/** The argv of every sender call so far, oldest first. */
function calls(): string[][] {
	if (!existsSync(SENT_LOG)) return [];
	return readFileSync(SENT_LOG, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as string[]);
}

function textOf(call: string[] | undefined): string {
	return call?.[(call?.indexOf("--text") ?? -1) + 1] ?? "";
}

function failedRun(agentId: string, minutesAgo: number): Row {
	const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
	return { agentId, status: "failed", errorCode: "adapter_failed", createdAt: at, finishedAt: at };
}

describe("rico-notify sends", () => {
	test("the first pass sends one summary through imsg, the second sends nothing", async () => {
		issues = [blocked(1), blocked(2)];
		const first = await run([]);
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("rico-notify: sent blocked:iss-1:");
		const sent = calls();
		expect(sent.length).toBe(1);
		const text = textOf(sent[0]);
		expect(sent[0]).toEqual([
			"send",
			"--to",
			HANDLE,
			"--service",
			"imessage",
			"--text",
			text,
			"--json",
		]);
		expect(text.startsWith("Factory notifier is on. 2")).toBe(true);

		const second = await run([]);
		expect(second.code).toBe(0);
		expect(second.stdout).toBe("");
		expect(calls().length).toBe(1);
	});

	test("a new blocked issue is sent once, with its identifier and its Forge link", async () => {
		issues = [blocked(1), blocked(2)];
		await run([]);
		issues.push(blocked(3));
		await run([]);
		expect(calls().length).toBe(2);
		const text = textOf(calls()[1]);
		expect(text).toContain("SOF-3");
		expect(text).toContain("https://forge.example.internal/rodaddy/x/pulls/3");
		await run([]);
		expect(calls().length).toBe(2);
	});

	test("a failed send is exit 1, leaves the key unsent, and goes on the next pass", async () => {
		primedState();
		issues = [blocked(1)];
		control({ code: 1, stderr: `cannot reach ${HANDLE}` });
		const bad = await run([]);
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("rico-notify: send failed: cannot reach <redacted>");
		expect(readFileSync(STATE, "utf8")).not.toContain("blocked:iss-1");

		control({});
		const good = await run([]);
		expect(good.code).toBe(0);
		expect(calls().length).toBe(2);
		expect(readFileSync(STATE, "utf8")).toContain("blocked:iss-1");
	});

	test("exit 0 without status sent is a failed send", async () => {
		primedState();
		issues = [blocked(1)];
		control({ status: "queued" });
		const r = await run([]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("rico-notify: send failed");
		expect(readFileSync(STATE, "utf8")).not.toContain("blocked:iss-1");
	});

	test("five new blocked issues are ONE text", async () => {
		primedState();
		issues = [1, 2, 3, 4, 5].map((n) => blocked(n));
		await run([]);
		expect(calls().length).toBe(1);
		expect(textOf(calls()[0]).startsWith("5 things need you:")).toBe(true);
	});

	test("the board down three passes in a row is one text, and a fourth is none", async () => {
		fail = { path: "/issues", status: 500 };
		for (const expected of [0, 0, 1, 1]) {
			const r = await run([]);
			expect(r.code).toBe(1);
			expect(calls().length).toBe(expected);
		}
		expect(textOf(calls()[0])).toContain("Board unreachable");
		expect(JSON.parse(readFileSync(STATE, "utf8")).primed).toBe(false);
	});

	test("an agent whose last three runs failed is named once, with its own board page", async () => {
		primedState();
		agents = [{ id: "ag-1", name: "Nagatha", status: "idle" }];
		runs = [failedRun("ag-1", 30), failedRun("ag-1", 40), failedRun("ag-1", 50)];
		await run([]);
		await run([]);
		expect(calls().length).toBe(1);
		const text = textOf(calls()[0]);
		expect(text).toContain("Nagatha is failing");
		expect(text).toContain(`http://127.0.0.1:${server.port}/agents/ag-1`);
	});

	test("a TELL RICO: comment on the issue of an unfinished run is one text", async () => {
		primedState();
		const now = new Date().toISOString();
		issues = [{ id: "iss-9", identifier: "SOF-9", title: "council", status: "in_progress" }];
		runs = [
			{
				agentId: "ag-1",
				status: "running",
				createdAt: now,
				finishedAt: null,
				contextSnapshot: { issueId: "iss-9" },
			},
		];
		comments = {
			"iss-9": [
				{ id: "c-1", body: "TELL RICO: council decided X", authorAgentId: "ag-1", createdAt: now },
			],
		};
		await run([]);
		await run([]);
		expect(calls().length).toBe(1);
		expect(textOf(calls()[0])).toBe(
			`SOF-9: council decided X\nhttp://127.0.0.1:${server.port}/issues/SOF-9`,
		);
	});

	test("a TELL comment held back by the hourly cap is sent after its run leaves the scan window (PR 1316)", async () => {
		const fullHour = Array.from({ length: 6 }, () => new Date().toISOString());
		writeState({ sends: fullHour });
		const now = new Date().toISOString();
		issues = [{ id: "iss-9", identifier: "SOF-9", title: "council", status: "in_progress" }];
		runs = [
			{
				agentId: "ag-1",
				status: "running",
				createdAt: now,
				finishedAt: null,
				contextSnapshot: { issueId: "iss-9" },
			},
		];
		comments = {
			"iss-9": [
				{ id: "c-1", body: "TELL RICO: council decided X", authorAgentId: "ag-1", createdAt: now },
			],
		};
		await run([]);
		expect(calls().length).toBe(0);

		const old = new Date(Date.now() - 20 * 60_000).toISOString();
		runs = [{ ...runs[0], status: "succeeded", finishedAt: old }];
		writeState({ ...readState(), sends: [] });
		await run([]);
		expect(calls().length).toBe(1);
		expect(textOf(calls()[0])).toStartWith("SOF-9: council decided X");
		await run([]);
		expect(calls().length).toBe(1);
	});

	test("the heartbeat does not go past the hourly cap (PR 1316)", async () => {
		writeState({ sends: Array.from({ length: 6 }, () => new Date().toISOString()) });
		const env = { ...baseEnv(), RICO_NOTIFY_HEARTBEAT: "1", RICO_NOTIFY_HEARTBEAT_HOUR: "0" };
		await run([], env);
		expect(calls().length).toBe(0);
		expect(readState().sends).toHaveLength(6);
	});

	test("a board-down alert held back by the hourly cap is sent on a later failed pass (PR 1316)", async () => {
		writeState({ sends: Array.from({ length: 6 }, () => new Date().toISOString()) });
		fail = { path: "/issues", status: 500 };
		for (let i = 0; i < 3; i++) await run([]);
		expect(calls().length).toBe(0);
		expect(readState().sends).toHaveLength(6);

		writeState({ ...readState(), sends: [] });
		await run([]);
		expect(calls().length).toBe(1);
		expect(textOf(calls()[0])).toContain("Board unreachable");
		await run([]);
		expect(calls().length).toBe(1);
	});

	test("a quiet pass prints nothing and still writes a 0600 state file with no secret in it", async () => {
		primedState();
		rmSync(STATE);
		issues = [blocked(1)];
		await run([]);
		const quiet = await run([]);
		expect(quiet.stdout + quiet.stderr).toBe("");
		expect(statSync(STATE).mode & 0o777).toBe(0o600);
		const state = readFileSync(STATE, "utf8");
		expect(state).not.toContain(TOKEN);
		expect(state).not.toContain(HANDLE);
	});

	test("the morning heartbeat is off by default and sends once a day when switched on", async () => {
		primedState();
		await run([]);
		expect(calls().length).toBe(0);

		const env = { ...baseEnv(), RICO_NOTIFY_HEARTBEAT: "1", RICO_NOTIFY_HEARTBEAT_HOUR: "0" };
		await run([], env);
		await run([], env);
		expect(calls().length).toBe(1);
		expect(textOf(calls()[0]).startsWith("Factory notifier is alive. 0 waiting on you.")).toBe(
			true,
		);
	});
});
