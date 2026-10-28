/**
 * @module tests/fleet/pi-employee
 * @description `fleet/bin/pi-employee`, the per-employee Pi
 *   launcher Paperclip's `pi_local` adapter runs, executed as a real child
 *   process against a fake `pi` (a shell script under `testTmpBase()` that
 *   prints `--version` and otherwise records its argv,
 *   `PI_CODING_AGENT_DIR`, `TMPDIR`, `TMP` and `TEMP`). Covers the discovery passthrough, every refusal
 *   (exit 3), and the full adapter argv rewrite. `PI_EMPLOYEE_UNDER_TEST`
 *   points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.PI_EMPLOYEE_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/pi-employee");
const PROMPT = "do the assigned task";

let scratch = "";
let fleetRoot = "";
let fakePi = "";
let outFile = "";
let counter = 0;

const FAKE_PI = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "pi coding agent \${FAKE_PI_VERSION:-1.1.0}"
  exit 0
fi
: > "$FAKE_PI_OUT"
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_PI_OUT"; done
printf 'AGENT_DIR=%s\\n' "\${PI_CODING_AGENT_DIR:-<unset>}" >> "$FAKE_PI_OUT"
printf 'TMPDIR=%s\\n' "\${TMPDIR:-<unset>}" >> "$FAKE_PI_OUT"
printf 'TMP=%s\\n' "\${TMP:-<unset>}" >> "$FAKE_PI_OUT"
printf 'TEMP=%s\\n' "\${TEMP:-<unset>}" >> "$FAKE_PI_OUT"
`;

beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "pi-employee-"));
	fleetRoot = join(scratch, "fleet");
	mkdirSync(join(fleetRoot, "pi", "profiles"), { recursive: true });
	mkdirSync(join(fleetRoot, "pi-extensions", "guard"), { recursive: true });
	writeFileSync(join(fleetRoot, "pi-extensions", "guard", "index.ts"), "export {};\n");
	mkdirSync(join(fleetRoot, "pi-extensions", "fleet-proxy-models"), {
		recursive: true,
	});
	writeFileSync(MODELS_EXT(), "export {};\n");
	writeFileSync(
		join(fleetRoot, "pi", "versions.json"),
		readFileSync(resolve(import.meta.dir, "../../fleet/pi/versions.json")),
	);
	fakePi = join(scratch, "fake-pi");
	writeFileSync(fakePi, FAKE_PI);
	chmodSync(fakePi, 0o755);
});
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function profile(name: string, body: unknown): void {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	writeFileSync(join(fleetRoot, "pi", "profiles", `${name}.json`), text);
}

async function run(args: string[], extra: Record<string, string> = {}) {
	counter += 1;
	outFile = join(scratch, `out-${counter}.txt`);
	const p = Bun.spawn([SCRIPT, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: scratch,
			PI_EMPLOYEE_FLEET_ROOT: fleetRoot,
			PI_EMPLOYEE_PI_BIN: fakePi,
			FAKE_PI_OUT: outFile,
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
	return { stdout, stderr, code };
}

function recorded(): { argv: string[]; agentDir: string; temps: string[] } {
	const lines = readFileSync(outFile, "utf8").split("\n").slice(0, -1);
	const value = (line: string | undefined) => (line ?? "").replace(/^[A-Z_]+=/, "");
	const tail = lines.splice(-4).map(value);
	return { argv: lines, agentDir: tail[0] ?? "", temps: tail.slice(1) };
}

/** The fleet-wide live-catalog extension every invocation loads. */
const MODELS_EXT = () => join(fleetRoot, "pi-extensions", "fleet-proxy-models", "index.ts");

const ADAPTER_ARGS = [
	"--mode",
	"json",
	"-p",
	"--append-system-prompt",
	"you are a seat",
	"--provider",
	"anthropic",
	"--model",
	"claude-opus",
	"--tools",
	"read,bash,edit,write,grep,find,ls",
	"--session",
	"/work/s.jsonl",
	"--skill",
	"/work/skills",
	PROMPT,
];

describe("passthrough", () => {
	test("--list-models loads the live-catalog extension, no FLEET_EMPLOYEE", async () => {
		const r = await run(["--list-models", "--provider", "x"]);
		expect(r.code).toBe(0);
		const { argv, agentDir } = recorded();
		expect(argv).toEqual(["-ne", "-e", MODELS_EXT(), "--list-models", "--provider", "x"]);
		expect(agentDir).toBe("<unset>");
	});

	test("--help runs pi with argv unchanged", async () => {
		const r = await run(["--help"]);
		expect(r.code).toBe(0);
		expect(recorded().argv).toEqual(["--help"]);
	});

	test("live-catalog extension missing: --list-models and a run both exit 3", async () => {
		const bare = join(scratch, "bare-fleet");
		mkdirSync(join(bare, "pi", "profiles"), { recursive: true });
		writeFileSync(join(bare, "pi", "profiles", "bare.json"), '{"tools":["read"],"extensions":[]}');
		for (const args of [["--list-models"], ["-p", PROMPT]]) {
			const r = await run(args, {
				PI_EMPLOYEE_FLEET_ROOT: bare,
				FLEET_EMPLOYEE: "bare",
			});
			expect(r.code).toBe(3);
			expect(r.stderr).toStartWith("pi-employee: extension not found: ");
			expect(r.stderr).toContain("fleet-proxy-models");
			expect(existsSync(outFile)).toBe(false);
		}
	});
});

describe("refusals exit 3", () => {
	test("FLEET_EMPLOYEE missing", async () => {
		const r = await run(ADAPTER_ARGS);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("pi-employee: FLEET_EMPLOYEE is missing or not a seat name");
		expect(existsSync(outFile)).toBe(false);
	});

	test("FLEET_EMPLOYEE not a seat name", async () => {
		const r = await run(ADAPTER_ARGS, { FLEET_EMPLOYEE: "../etc" });
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("FLEET_EMPLOYEE is missing or not a seat name");
	});

	test("profile missing", async () => {
		const r = await run(ADAPTER_ARGS, { FLEET_EMPLOYEE: "nobody" });
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("pi-employee: profile ");
		expect(r.stderr).toContain("nobody.json");
		expect(existsSync(outFile)).toBe(false);
	});

	for (const [name, body] of [
		["empty-tools", { tools: [], extensions: [] }],
		["bad-tool", { tools: ["read", "Bad-Tool"], extensions: [] }],
		["tools-not-list", { tools: "read,bash", extensions: [] }],
		["ext-not-list", { tools: ["read"], extensions: "x" }],
		["not-json", "{nope"],
	] as const) {
		test(`bad profile: ${name}`, async () => {
			profile(name, body);
			const r = await run(ADAPTER_ARGS, { FLEET_EMPLOYEE: name });
			expect(r.code).toBe(3);
			expect(r.stderr).toMatch(new RegExp(`^pi-employee: profile \\S+${name}\\.json: `));
			expect(r.stderr.trim().split("\n")).toHaveLength(1);
			expect(existsSync(outFile)).toBe(false);
		});
	}

	test("extension not found", async () => {
		profile("ext-missing", {
			tools: ["read"],
			extensions: ["pi-extensions/nope/index.ts"],
		});
		const r = await run(ADAPTER_ARGS, { FLEET_EMPLOYEE: "ext-missing" });
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("pi-employee: extension not found: ");
		expect(existsSync(outFile)).toBe(false);
	});

	test("version mismatch names both versions", async () => {
		profile("ver", { tools: ["read"], extensions: [] });
		const r = await run(ADAPTER_ARGS, {
			FLEET_EMPLOYEE: "ver",
			FAKE_PI_VERSION: "1.0.0",
		});
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("pi-employee: pi 1.0.0 installed, fleet pins 1.1.0");
		expect(existsSync(outFile)).toBe(false);
	});
});

describe("adapter argv rewrite", () => {
	test("tools replaced, extensions first, prompt last, agent dir set and created", async () => {
		const agentDir = join(scratch, "seats", "dev-1");
		profile("dev-1", {
			tools: ["read", "grep"],
			extensions: ["pi-extensions/guard/index.ts"],
			agentDir,
			futureKey: true,
		});
		const r = await run(ADAPTER_ARGS, {
			FLEET_EMPLOYEE: "Dev-1",
			PI_CODING_AGENT_DIR: "/inherited",
		});
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const got = recorded();
		const ext = join(fleetRoot, "pi-extensions", "guard", "index.ts");
		const want = [...ADAPTER_ARGS];
		want[want.indexOf("--tools") + 1] = "read,grep";
		expect(got.argv).toEqual(["-ne", "-e", MODELS_EXT(), "-e", ext, ...want]);
		expect(got.argv.at(-1)).toBe(PROMPT);
		expect(got.agentDir).toBe(agentDir);
		expect(statSync(agentDir).isDirectory()).toBe(true);
		expect(statSync(agentDir).mode & 0o777).toBe(0o700);
		expect(r.stdout + r.stderr).not.toContain(PROMPT);
	});

	test("--tools= form replaced; default agentDir under ~/.pi/seats", async () => {
		profile("dev-2", { tools: ["read", "bash"], extensions: [] });
		const args = ["--mode", "json", "--tools=read,write,edit", "-p", PROMPT];
		const r = await run(args, { FLEET_EMPLOYEE: "dev-2" });
		expect(r.code).toBe(0);
		const got = recorded();
		expect(got.argv).toEqual([
			"-ne",
			"-e",
			MODELS_EXT(),
			"--mode",
			"json",
			"--tools=read,bash",
			"-p",
			PROMPT,
		]);
		expect(got.agentDir).toBe(join(scratch, ".pi", "seats", "dev-2"));
		expect(existsSync(got.agentDir)).toBe(true);
	});

	test("argv with no --tools gets one", async () => {
		profile("dev-3", { tools: ["read"], extensions: [] });
		const r = await run(["--mode", "json", "-p", PROMPT], {
			FLEET_EMPLOYEE: "dev-3",
		});
		expect(r.code).toBe(0);
		const got = recorded();
		expect(got.argv.filter((a) => a.startsWith("--tools"))).toEqual(["--tools"]);
		expect(got.argv[got.argv.indexOf("--tools") + 1]).toBe("read");
		expect(got.argv.at(-1)).toBe(PROMPT);
	});
});

// the cheapest Pi compaction; each run already starts fresh.
describe("seat Pi settings", () => {
	test("no settings.json: the cheap compaction is written before pi starts", async () => {
		const agentDir = join(scratch, "seats", "set-1");
		profile("set-1", { tools: ["read"], extensions: [], agentDir });
		const r = await run(["-p", PROMPT], { FLEET_EMPLOYEE: "set-1" });
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 4000 },
		});
		expect(readdirSync(agentDir).filter((name) => name.startsWith("settings.json.tmp."))).toEqual(
			[],
		);
	});

	test("a failed settings write publishes nothing and leaves no temp file", async () => {
		const agentDir = join(scratch, "seats", "set-failed");
		profile("set-failed", { tools: ["read"], extensions: [], agentDir });
		const p = Bun.spawn(
			[
				"python3",
				"-c",
				`import json, runpy, sys
def broken_dump(value, file):
    file.write('{"compaction":')
    file.flush()
    raise OSError("injected settings write failure")
json.dump = broken_dump
runpy.run_path(sys.argv[1], run_name="__main__")
`,
				SCRIPT,
				"-p",
				PROMPT,
			],
			{
				env: {
					...process.env,
					HOME: scratch,
					PI_EMPLOYEE_FLEET_ROOT: fleetRoot,
					PI_EMPLOYEE_PI_BIN: fakePi,
					FLEET_EMPLOYEE: "set-failed",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
		expect(code).not.toBe(0);
		expect(stderr).toContain("injected settings write failure");
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		expect(readdirSync(agentDir).filter((name) => name.startsWith("settings.json.tmp."))).toEqual(
			[],
		);
	});

	test("an existing settings.json is left byte-identical", async () => {
		const agentDir = join(scratch, "seats", "set-2");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), '{"compaction":{"enabled":false}}');
		profile("set-2", { tools: ["read"], extensions: [], agentDir });
		const r = await run(["-p", PROMPT], { FLEET_EMPLOYEE: "set-2" });
		expect(r.code).toBe(0);
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(
			'{"compaction":{"enabled":false}}',
		);
		expect(readdirSync(agentDir).filter((name) => name.startsWith("settings.json.tmp."))).toEqual(
			[],
		);
	});
});

describe("seat temp dir", () => {
	test("TMPDIR, TMP, TEMP = <agentDir>/tmp, mode 700, caller's /tmp overridden", async () => {
		const agentDir = join(scratch, "seats", "tmp-1");
		profile("tmp-1", { tools: ["read"], extensions: [], agentDir });
		const r = await run(["-p", PROMPT], {
			FLEET_EMPLOYEE: "tmp-1",
			TMPDIR: "/tmp",
			TMP: "/tmp",
			TEMP: "/tmp",
		});
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const seatTmp = join(agentDir, "tmp");
		expect(recorded().temps).toEqual([seatTmp, seatTmp, seatTmp]);
		expect(statSync(seatTmp).isDirectory()).toBe(true);
		expect(statSync(seatTmp).mode & 0o777).toBe(0o700);
	});

	for (const [name, agentDir] of [
		["in-tmp", "/tmp/pi-employee-refusal-probe"],
		["in-var-tmp", "/var/tmp/pi-employee-refusal-probe"],
	] as const) {
		test(`agentDir ${agentDir} refuses before creating anything`, async () => {
			profile(name, { tools: ["read"], extensions: [], agentDir });
			const r = await run(["-p", PROMPT], { FLEET_EMPLOYEE: name });
			expect(r.code).toBe(3);
			expect(r.stderr).toStartWith("pi-employee: ");
			expect(r.stderr).toContain(agentDir);
			expect(existsSync(outFile)).toBe(false);
			expect(existsSync(agentDir)).toBe(false);
		});
	}

	test("a symlinked agentDir resolving into /tmp refuses; a plain dir passes", async () => {
		const target = "/tmp/pi-employee-symlink-probe";
		const link = join(scratch, "seats-link");
		symlinkSync(target, link);
		profile("sym", {
			tools: ["read"],
			extensions: [],
			agentDir: join(link, "sym"),
		});
		const r = await run(["-p", PROMPT], { FLEET_EMPLOYEE: "sym" });
		expect(r.code).toBe(3);
		expect(r.stderr).toStartWith("pi-employee: ");
		expect(r.stderr).toContain("pi-employee-symlink-probe");
		expect(existsSync(outFile)).toBe(false);
		expect(existsSync(target)).toBe(false);

		const plain = join(scratch, "seats", "plain");
		profile("plain", { tools: ["read"], extensions: [], agentDir: plain });
		const ok = await run(["-p", PROMPT], { FLEET_EMPLOYEE: "plain" });
		expect(ok.stderr).toBe("");
		expect(ok.code).toBe(0);
		expect(recorded().temps[0]).toBe(join(plain, "tmp"));
	});
});

describe("--mode json stream goes through pi-stdout-filter", () => {
	const DROPPED = '{"type":"turn_start"}';
	const KEPT = [
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}',
		'{"type":"agent_end","messages":[]}',
	];
	const STREAM = `${[DROPPED, ...KEPT, DROPPED].join("\n")}\n`;

	function fake(name: string, body: string): string {
		const path = join(scratch, name);
		writeFileSync(
			path,
			`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi coding agent 1.1.0"; exit 0; fi\n${body}`,
		);
		chmodSync(path, 0o755);
		return path;
	}

	beforeAll(() => {
		profile("stream", { tools: ["read"], extensions: [] });
		writeFileSync(join(scratch, "stream.txt"), STREAM);
		fake("fake-stream", `cat "${join(scratch, "stream.txt")}"\nexit 3\n`);
	});
	const STREAM_ENV = () => ({
		FLEET_EMPLOYEE: "stream",
		PI_EMPLOYEE_PI_BIN: join(scratch, "fake-stream"),
	});

	for (const mode of [["--mode", "json"], ["--mode=json"]]) {
		test(`${mode.join(" ")}: kept lines only, exit is pi's`, async () => {
			const r = await run([...mode, "-p", PROMPT], STREAM_ENV());
			expect(r.stderr).toBe("");
			expect(r.stdout).toBe(`${KEPT.join("\n")}\n`);
			expect(r.code).toBe(3);
		});
	}

	test("no --mode json: stdout byte-identical to pi's", async () => {
		const r = await run(["-p", PROMPT], STREAM_ENV());
		expect(r.stdout).toBe(STREAM);
		expect(r.code).toBe(3);
	});

	test("filter missing: unfiltered output plus one warning", async () => {
		const bin = join(scratch, "nofilter-bin");
		mkdirSync(bin, { recursive: true });
		const copy = join(bin, "pi-employee");
		writeFileSync(copy, readFileSync(SCRIPT));
		chmodSync(copy, 0o755);
		const p = Bun.spawn([copy, "--mode", "json", "-p", PROMPT], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: scratch,
				PI_EMPLOYEE_FLEET_ROOT: fleetRoot,
				...STREAM_ENV(),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		expect(stdout).toBe(STREAM);
		expect(code).toBe(3);
		expect(stderr).toStartWith("pi-employee: ");
		expect(stderr).toContain("pi-stdout-filter");
		expect(stderr).toContain("unfiltered");
		expect(stderr.trim().split("\n")).toHaveLength(1);
	});

	test("SIGTERM to pi-employee reaches pi and the run ends", async () => {
		const mark = join(scratch, "term-mark");
		const slow = fake(
			"fake-slow",
			`trap 'echo term > "${mark}"; exit 143' TERM\necho '{"type":"agent_start"}'\nwhile :; do sleep 0.1; done\n`,
		);
		const p = Bun.spawn([SCRIPT, "--mode", "json", "-p", PROMPT], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: scratch,
				PI_EMPLOYEE_FLEET_ROOT: fleetRoot,
				FLEET_EMPLOYEE: "stream",
				PI_EMPLOYEE_PI_BIN: slow,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = p.stdout.getReader();
		let seen = "";
		while (!seen.includes("agent_start")) {
			const { value, done } = await reader.read();
			if (done) break;
			seen += new TextDecoder().decode(value);
		}
		expect(seen).toContain("agent_start");
		// A hung run is SIGKILLed by this watchdog, so it exits 137, not 143.
		const watchdog = setTimeout(() => p.kill("SIGKILL"), 4000);
		p.kill("SIGTERM");
		const code = await p.exited;
		clearTimeout(watchdog);
		expect(code).toBe(143);
		expect(readFileSync(mark, "utf8")).toBe("term\n");
	});

	/** A copy of pi-employee whose sibling pi-stdout-filter is `filterBody`. */
	function withFilter(dir: string, filterBody: string): string {
		const bin = join(scratch, dir);
		mkdirSync(bin, { recursive: true });
		const copy = join(bin, "pi-employee");
		writeFileSync(copy, readFileSync(SCRIPT));
		chmodSync(copy, 0o755);
		writeFileSync(join(bin, "pi-stdout-filter"), `#!/bin/sh\n${filterBody}`);
		chmodSync(join(bin, "pi-stdout-filter"), 0o755);
		return copy;
	}

	async function runCopy(copy: string, pi: string) {
		const p = Bun.spawn([copy, "--mode", "json", "-p", PROMPT], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: scratch,
				PI_EMPLOYEE_FLEET_ROOT: fleetRoot,
				FLEET_EMPLOYEE: "stream",
				PI_EMPLOYEE_PI_BIN: pi,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		// A hung run is SIGKILLed by this watchdog, so it exits 137.
		const watchdog = setTimeout(() => p.kill("SIGKILL"), 8000);
		const [stdout, stderr, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		clearTimeout(watchdog);
		return { stdout, stderr, code };
	}

	test("filter reaped before pi finishes: pi runs on, its exit code is kept", async () => {
		// Event-coordinated: pi closes stdout (the filter sees EOF and exits 0),
		// learns the filter's pid over a FIFO, and exits only once that pid is
		// gone, i.e. after pi-employee has reaped the filter while pi was pending.
		const fifo = join(scratch, "filter-pid.fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const copy = withFilter("reaped-first-bin", `echo $$ > "${fifo}"\ncat > /dev/null\nexit 0\n`);
		const pi = fake(
			"fake-outlives-filter",
			`echo '{"type":"agent_end","messages":[]}'\nexec >&-\nread fpid < "${fifo}"\nwhile kill -0 "$fpid" 2>/dev/null; do :; done\nexit 5\n`,
		);
		const r = await runCopy(copy, pi);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(5);
	});

	test("filter fails while pi still runs: pi is killed, run exits 1", async () => {
		const copy = withFilter("early-exit-bin", "exit 7\n");
		const pi = fake("fake-hangs", "exec sleep 30\n");
		const r = await runCopy(copy, pi);
		expect(r.code).toBe(1);
		expect(r.stderr).toBe(
			"pi-employee: stopped on pi-stdout-filter exited 7; 1 run processes stopped; no run id\n",
		);
	});
});

describe("run evidence names the adapter's model and thinking", () => {
	test("argv --model and --thinking override a stale FLEET_MODEL in pi's env", async () => {
		profile("ev-1", { tools: ["read"], extensions: [] });
		const envPi = join(scratch, "env-pi");
		writeFileSync(
			envPi,
			`#!/bin/sh
if [ "$1" = "--version" ]; then echo "pi coding agent \${FAKE_PI_VERSION:-1.1.0}"; exit 0; fi
printf '%s|%s\\n' "\${FLEET_MODEL:-<unset>}" "\${FLEET_EFFORT:-<unset>}" > "$FAKE_PI_OUT"
`,
		);
		chmodSync(envPi, 0o755);
		const args = ["--model", "fleet-proxy/claude-sonnet-5-5", "--thinking", "medium", "-p", PROMPT];
		const r = await run(args, {
			FLEET_EMPLOYEE: "ev-1",
			FLEET_MODEL: "claude-opus-5-5",
			PI_EMPLOYEE_PI_BIN: envPi,
		});
		expect(r.code).toBe(0);
		expect(readFileSync(outFile, "utf8")).toBe("claude-sonnet-5-5|medium\n");
	});

	test("argv --model with no level clears a stale FLEET_EFFORT", async () => {
		profile("ev-2", { tools: ["read"], extensions: [] });
		const envPi = join(scratch, "env-pi-2");
		writeFileSync(
			envPi,
			`#!/bin/sh
if [ "$1" = "--version" ]; then echo "pi coding agent \${FAKE_PI_VERSION:-1.1.0}"; exit 0; fi
printf '%s|%s\\n' "\${FLEET_MODEL:-<unset>}" "\${FLEET_EFFORT:-<unset>}" > "$FAKE_PI_OUT"
`,
		);
		chmodSync(envPi, 0o755);
		const r = await run(["--model", "fleet-proxy/claude-sonnet-5-5", "-p", PROMPT], {
			FLEET_EMPLOYEE: "ev-2",
			FLEET_EFFORT: "high",
			PI_EMPLOYEE_PI_BIN: envPi,
		});
		expect(r.code).toBe(0);
		expect(readFileSync(outFile, "utf8")).toBe("claude-sonnet-5-5|<unset>\n");
	});
});
