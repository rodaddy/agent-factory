/**
 * @module tests/fleet/spawn-helper
 * @description `fleet/skills/spawn-helper/bin/spawn-helper`, run as a real
 *   child process against a fake `pi` (passed as `PI_BIN`) that records its
 *   argv and prints canned Pi JSON events: a clean run, the per-access tool
 *   lists, an error stop, a timeout that must kill the child, and the harness
 *   refusals. `SPAWN_HELPER_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.SPAWN_HELPER_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/spawn-helper/bin/spawn-helper");

const FAKE_PI = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_ARGV"
echo $$ > "$FAKE_PID"
case "$FAKE_MODE" in
clean)
  echo '{"type":"tool_execution_start","toolName":"read"}'
  echo '{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"the final answer"}]}}'
  ;;
error)
  echo '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"provider said 500","content":[]}}'
  ;;
sleep)
  exec sleep 30
  ;;
esac
`;

let root = "";
let fakePi = "";
let brief = "";
let n = 0;

beforeAll(async () => {
	root = await mkdtemp(join(testTmpBase(), "spawn-helper-"));
	fakePi = join(root, "pi");
	writeFileSync(fakePi, FAKE_PI);
	chmodSync(fakePi, 0o755);
	brief = join(root, "brief.md");
	writeFileSync(brief, "You are a helper. Read the file and report.");
	mkdirSync(join(root, "scope"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function run(
	mode: string,
	extra: string[] = [],
	over: Record<string, string> = {},
	signalHelper?: NodeJS.Signals,
) {
	n += 1;
	const out = join(root, `out-${n}`);
	const files = { argv: join(root, `argv-${n}`), pid: join(root, `pid-${n}`) };
	const args = {
		"--model": "fleet-proxy/gpt-6-luna",
		"--thinking": "medium",
		"--access": "read-only",
		"--brief": brief,
		"--scope": join(root, "scope"),
		"--out": out,
		...over,
	};
	const argv = Object.entries(args).flat();
	const p = Bun.spawn(["python3", SCRIPT, ...argv, ...extra], {
		env: {
			PATH: process.env.PATH ?? "",
			PI_BIN: fakePi,
			FAKE_MODE: mode,
			FAKE_ARGV: files.argv,
			FAKE_PID: files.pid,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const read = (f: string) => {
		try {
			return readFileSync(f, "utf8");
		} catch {
			return "";
		}
	};
	if (signalHelper) {
		// Cancel the helper the way a cancelled parent run would, once the child is up.
		// fixed-sleep-ok: a bounded poll for the child's pid file, not a wait for background work.
		for (let i = 0; i < 100 && !read(files.pid).trim(); i++) await Bun.sleep(50);
		p.kill(signalHelper);
	}
	const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
	return {
		code,
		stderr,
		results: read(join(out, "RESULTS.md")),
		childArgv: read(files.argv).split("\n"),
		pid: Number(read(files.pid).trim()),
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("spawn-helper", () => {
	test("a clean run exits 0 and RESULTS.md carries the final text and tool count", async () => {
		const r = await run("clean");
		expect(r.code).toBe(0);
		expect(r.results).toContain("exit: 0\n");
		expect(r.results).toContain("stop_reason: stop\n");
		expect(r.results).toContain("tool_calls: 1\n");
		expect(r.results).toContain("error: none\n");
		expect(r.results).toContain("the final answer");
		expect(r.childArgv).toContain("fleet-proxy/gpt-6-luna:medium");
		expect(r.childArgv).toContain("--no-session");
	});

	test("read-only passes exactly the read tools; write adds edit, write and bash", async () => {
		const ro = await run("clean");
		expect(ro.childArgv[ro.childArgv.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
		const rw = await run("clean", [], { "--access": "write" });
		expect(rw.code).toBe(0);
		expect(rw.childArgv[rw.childArgv.indexOf("--tools") + 1]).toBe(
			"read,grep,find,ls,edit,write,bash",
		);
	});

	test("an error stop exits 1 and RESULTS.md names the error", async () => {
		const r = await run("error");
		expect(r.code).toBe(1);
		expect(r.results).toContain("exit: 1\n");
		expect(r.results).toContain("stop_reason: error\n");
		expect(r.results).toContain("error: provider said 500\n");
	});

	test("a child past --timeout 1 is killed and the run exits 1 with a timeout error", async () => {
		const r = await run("sleep", ["--timeout", "1"]);
		expect(r.code).toBe(1);
		expect(r.results).toContain("error: timeout after 1s\n");
		expect(r.pid).toBeGreaterThan(0);
		expect(alive(r.pid)).toBe(false);
	}, 15000);

	test("a TERM to the helper stops the child too, exit 143", async () => {
		const r = await run("sleep", [], {}, "SIGTERM");
		expect(r.code).toBe(143);
		expect(r.pid).toBeGreaterThan(0);
		expect(alive(r.pid)).toBe(false);
	}, 15000);

	test("a bad --access or a missing --brief is a harness error, exit 3", async () => {
		const bad = await run("clean", [], { "--access": "admin" });
		expect(bad.code).toBe(3);
		expect(bad.stderr).toContain("Usage:");
		const missing = await run("clean", [], { "--brief": join(root, "no-such-brief.md") });
		expect(missing.code).toBe(3);
		expect(missing.stderr).toContain("brief not found");
	});
});
