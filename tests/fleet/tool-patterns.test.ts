/**
 * @module tests/fleet/tool-patterns
 * @description `fleet/audit/tool-patterns.py` run as a real python3
 *   child against a fixture run-log tree built under the test temp root. Pins:
 *   stdout chunks join in seq order (even when a JSON event is split across
 *   chunks); fixed program, subcommand and tool allowlists;
 *   the candidate threshold by runs and by seats; the mtime window; redaction
 *   of credentials; a bad line is counted, never fatal.
 *   `TOOL_PATTERNS_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.TOOL_PATTERNS_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/audit/tool-patterns.py");

const CO = "co-1";
const UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
let dir: string;
let root: string;

type Chunk = { seq: number; chunk: string; stream?: string };

/** One run log: lines written in the given (possibly shuffled) order. */
function writeRun(agent: string, run: string, chunks: Chunk[], raw: string[] = []): string {
	const d = join(root, CO, agent);
	mkdirSync(d, { recursive: true });
	const p = join(d, `${run}.ndjson`);
	const lines = chunks.map((c) =>
		JSON.stringify({
			ts: "2026-10-06T00:00:00Z",
			stream: c.stream ?? "stdout",
			chunk: c.chunk,
			seq: c.seq,
		}),
	);
	writeFileSync(p, `${[...lines, ...raw].join("\n")}\n`);
	return p;
}

const ev = (toolName: string, args: Record<string, unknown>) =>
	`${JSON.stringify({ type: "tool_execution_start", toolName, args })}\n`;
const bash = (command: string) => ev("bash", { command });

interface Pattern {
	key: string;
	tool: string;
	runs: number;
	calls: number;
	seats: string[];
	candidate: boolean;
}
interface Out {
	schema: string;
	window: Record<string, unknown>;
	totals: { calls: number; runs: number; patterns: number; badLines: number; skippedLogs: number };
	seats: { name: string; calls: number; runs: number }[];
	patterns: Pattern[];
}

let out: Out;
let md: string;
let outText: string;
let exitCode: number;

beforeAll(async () => {
	dir = mkdtempSync(join(testTmpBase(), "tool-patterns-"));
	root = join(dir, "run-logs");
	// split mid-JSON across two chunks, written seq 2 before seq 1
	const split = bash("git status --short");
	writeRun("agent-a", "run-split", [
		{ seq: 2, chunk: split.slice(20) },
		{ seq: 1, chunk: split.slice(0, 20) },
		{ seq: 3, chunk: "stderr noise\n", stream: "stderr" },
	]);
	// normalization cases
	writeRun("agent-a", "run-norm", [
		{ seq: 1, chunk: ev("read", { path: "/home/u/.pi/pi/skills/forge-post--ab12cd/SKILL.md" }) },
		{ seq: 2, chunk: bash(`cat /data/${UUID}/f.txt && echo done; ls`) },
		{ seq: 3, chunk: bash("git show 1a2b3c4d5e6f") },
		{ seq: 4, chunk: bash("forge issue view SOF-4321") },
		{ seq: 5, chunk: bash(`curl -H "${AUTH}: token zq9secretval" https://x`) },
		{ seq: 6, chunk: '{"type":"tool_execution_start", broken\n' },
	]);
	// threshold by runs: one seat, three runs
	for (const r of ["r1", "r2", "r3"])
		writeRun("agent-b", `run-many-${r}`, [{ seq: 1, chunk: bash("bun run lint") }]);
	// threshold by seats: two seats, two runs
	writeRun("agent-c", "run-seat-c", [{ seq: 1, chunk: bash("pwd") }]);
	writeRun("agent-d", "run-seat-d", [{ seq: 1, chunk: bash("pwd") }]);
	// below both thresholds
	writeRun("agent-c", "run-lonely", [{ seq: 1, chunk: bash("whoami") }]);
	// outside the window
	const old = writeRun("agent-d", "run-old", [{ seq: 1, chunk: bash("uptime") }]);
	const t = (Date.now() - 48 * 3600_000) / 1000;
	utimesSync(old, t, t);

	const outFile = join(dir, "out.json");
	const mdFile = join(dir, "out.md");
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: dir,
		PYTHONDONTWRITEBYTECODE: "1",
	};
	const flags = "--hours 24 --min-runs 3 --min-seats 2".split(" ");
	const argv = ["python3", SCRIPT, "--root", root, ...flags, "--out", outFile, "--md", mdFile];
	const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
	exitCode = await p.exited;
	outText = readFileSync(outFile, "utf8");
	out = JSON.parse(outText);
	md = readFileSync(mdFile, "utf8");
});

afterAll(() => renameSync(dir, `${dir}-archive`));

const find = (key: string) => out.patterns.find((p) => p.key === key);

/** key_of(tool, arg) imported from the script itself. */
function keyOf(tool: string, arg: string): string {
	const py = `import importlib.util as u,sys;s=u.spec_from_file_location("tp",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);print(m.key_of(sys.argv[2],__import__("json").loads(sys.argv[3])))`;
	return Bun.spawnSync(
		[
			"python3",
			"-c",
			py,
			SCRIPT,
			tool,
			JSON.stringify(tool === "bash" ? { command: arg } : JSON.parse(arg)),
		],
		{
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		},
	)
		.stdout.toString()
		.trim();
}
const AUTH = ["Author", "ization"].join("");

function namesResponse(body: unknown) {
	const py = `import importlib.util as u,sys,json,io;s=u.spec_from_file_location("tp",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);m.urllib.request.urlopen=lambda *a,**k: io.BytesIO(sys.argv[2].encode());print(json.dumps(m.agent_names()))`;
	return Bun.spawnSync(["python3", "-c", py, SCRIPT, JSON.stringify(body)], {
		env: {
			...process.env,
			PYTHONDONTWRITEBYTECODE: "1",
			PAPERCLIP_API_URL: "http://example.invalid",
			PAPERCLIP_API_KEY: "fixture",
			PAPERCLIP_COMPANY_ID: CO,
		},
	});
}

describe("tool-patterns", () => {
	test("exits 0 and writes the schema", () => {
		expect(exitCode).toBe(0);
		expect(out.schema).toBe("fleet-tool-patterns/1");
	});

	test("a chunk split mid-JSON joins in seq order", () => {
		expect(find("bash: git status …")).toBeDefined();
	});

	test("keeps only fixed tool, program and subcommand names", () => {
		expect(find("read")).toBeDefined();
		expect(find("bash: cat …")).toBeDefined();
		expect(find("bash: git show …")).toBeDefined();
		expect(find("bash: forge issue …")).toBeDefined();
	});

	test("candidate by runs and by seats, not below both", () => {
		const lint = find("bash: bun run …");
		expect(lint?.runs).toBe(3);
		expect(lint?.seats).toEqual(["agent-b"]);
		expect(lint?.candidate).toBe(true);
		const pwd = find("bash: pwd");
		expect(pwd?.runs).toBe(2);
		expect(pwd?.candidate).toBe(true);
		expect(find("bash: whoami")?.candidate).toBe(false);
		expect(out.patterns[0]?.key).toBe("bash: bun run …");
	});

	test("two agents with the same display name count as two seats", () => {
		const fixture = mkdtempSync(join(dir, "same-name-"));
		for (const agent of ["agent-one", "agent-two"]) {
			const seat = join(fixture, CO, agent);
			mkdirSync(seat, { recursive: true });
			writeFileSync(
				join(seat, `${agent}-run.ndjson`),
				JSON.stringify({ stream: "stdout", chunk: bash("pwd") }),
			);
		}
		const py = `import importlib.util as u,sys,json;s=u.spec_from_file_location("tp",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);r=m.collect(sys.argv[2],24,3,2,{"agent-one":"Shared","agent-two":"Shared"});print(json.dumps(r));print(m.markdown(r))`;
		const result = Bun.spawnSync(["python3", "-c", py, SCRIPT, fixture], {
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		});
		expect(result.exitCode).toBe(0);
		const [report, ...rendered] = result.stdout.toString().split("\n");
		const duplicateNames = JSON.parse(report ?? "") as Out;
		expect(duplicateNames.seats).toEqual([
			{ name: "Shared", calls: 1, runs: 1 },
			{ name: "Shared", calls: 1, runs: 1 },
		]);
		expect(duplicateNames.patterns[0]).toMatchObject({
			key: "bash: pwd",
			seats: ["Shared", "Shared"],
			runs: 2,
			candidate: true,
		});
		expect(rendered.join("\n")).toContain("Shared, Shared");
	});

	test("the window excludes an old file", () => {
		expect(find("bash: uptime")).toBeUndefined();
		expect(out.totals.runs).toBe(8);
	});

	test("values never appear in JSON or markdown", () => {
		expect(outText + md).not.toContain("zq9secretval");
		expect(find("bash: curl …")).toBeDefined();
	});

	test.each([
		["lowercase echo argument", "bash", { command: "echo huntersecret" }],
		["option-shaped printf value", "bash", { command: "printf '%s' --huntersecret" }],
		["secret argument key", "read", { huntersecret: "value" }],
		["unknown tool name", "huntersecret", { path: "value" }],
		["escaped JSON quote", "read", { password: 'abc" visible tail' }],
		["equals user option", "bash", { command: "curl --user=user:zq9fakeval" }],
		["attached user option", "bash", { command: "curl -uuser:zq9fakeval" }],
		["attached header option", "bash", { command: 'curl -H"abc visible tail"' }],
		["suffixed secret env", "bash", { command: "AWS_SECRET_ACCESS_KEY=zq9fakeval cli" }],
	])("report excludes all values: %s", async (_label, tool, args) => {
		const fixture = mkdtempSync(join(dir, "leak-"));
		const agent = join(fixture, CO, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(
			join(agent, "run.ndjson"),
			JSON.stringify({
				stream: "stdout",
				chunk: ev(tool as string, args as Record<string, unknown>),
			}),
		);
		const mdFile = join(fixture, "report.md");
		const result = Bun.spawnSync(["python3", SCRIPT, "--root", fixture, "--md", mdFile], {
			env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
		});
		expect(result.exitCode).toBe(0);
		const report = result.stdout.toString() + readFileSync(mdFile, "utf8");
		for (const value of ["huntersecret", "zq9fakeval", "visible tail", "abc"])
			expect(report).not.toContain(value);
		expect(JSON.parse(result.stdout.toString()).totals.calls).toBe(1);
	});

	test("git commit retains its fixed subcommand and omits options and values", () => {
		expect(keyOf("bash", 'git commit -m "x"')).toBe("bash: git commit …");
	});

	test("unknown programs become a fixed placeholder", () => {
		expect(keyOf("bash", "mytool --flag")).toBe("bash: <prog> …");
	});

	test("only the first following word can be a fixed subcommand", () => {
		expect(keyOf("bash", "git huntersecret status")).toBe("bash: git …");
		expect(keyOf("bash", "forge issue view extra")).toBe("bash: forge issue …");
		expect(keyOf("bash", "/usr/bin/git status")).toBe("bash: git status");
		expect(keyOf("read", '{"z":"value","a":"value"}')).toBe("read");
		expect(keyOf("huntersecret", "{}")).toBe("<tool>");
	});

	test("a vanished log is skipped and counted", () => {
		const py = `import importlib.util as u,sys,json,os;s=u.spec_from_file_location("tp",sys.argv[1]);m=u.module_from_spec(s);s.loader.exec_module(m);m.run_logs=lambda *args: iter([("a","gone",os.path.join(sys.argv[2],"gone.ndjson"))]);print(json.dumps(m.collect(sys.argv[2],24,3,2,{})))`;
		const result = Bun.spawnSync(["python3", "-c", py, SCRIPT, dir], {
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString()).totals).toMatchObject({
			skippedLogs: 1,
			runs: 0,
			calls: 0,
		});
		expect(result.stderr.toString()).toContain("skipped unreadable or vanished run log");
	});

	test("a dangling run-log symlink is skipped and counted", () => {
		const fixture = mkdtempSync(join(dir, "dangling-"));
		const agent = join(fixture, CO, "agent");
		mkdirSync(agent, { recursive: true });
		symlinkSync(join(fixture, "gone"), join(agent, "run.ndjson"));
		const result = Bun.spawnSync(["python3", SCRIPT, "--root", fixture], {
			env: { PATH: process.env.PATH ?? "" },
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString()).totals.skippedLogs).toBe(1);
		expect(result.stderr.toString()).toContain("skipped unreadable or vanished run log");
	});

	test.each([
		["bare list", [{ id: "a", name: "Seat" }]],
		["agents list", { agents: [{ id: "a", name: "Seat" }] }],
		["data list", { data: [{ id: "a", name: "Seat" }] }],
	])("agent_names maps names from %s", (_label, body) => {
		const result = namesResponse(body);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({ a: "Seat" });
	});

	test("agent_names warns on an unsupported response shape", () => {
		const result = namesResponse({ data: "unexpected" });
		expect(JSON.parse(result.stdout.toString())).toEqual({});
		expect(result.stderr.toString()).toContain("unexpected agent names shape");
	});

	test("a bad line is counted, not fatal", () => {
		expect(out.totals.badLines).toBe(1);
		expect(out.totals.calls).toBe(12);
	});

	test("seats fall back to agent id; markdown carries seats and candidate marks", () => {
		expect(out.seats.map((s) => s.name).sort()).toEqual([
			"agent-a",
			"agent-b",
			"agent-c",
			"agent-d",
		]);
		expect(out.seats.find((s) => s.name === "agent-a")).toEqual({
			name: "agent-a",
			calls: 6,
			runs: 2,
		});
		expect(md).toContain("agent-b");
		expect(md).toMatch(/\| \* \|.*bun run …/);
	});
});
