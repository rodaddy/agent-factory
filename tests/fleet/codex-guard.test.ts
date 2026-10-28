/**
 * @module tests/fleet/codex-guard
 * @description The Codex adapter for the one fleet guard:
 *   `fleet/hooks/codex-guard.sh` run as Codex runs a PreToolUse hook, with the
 *   payload Codex 0.159 sends on stdin (shape captured live on sf-fleet-01).
 *   A fake guard built at runtime pins the translation and the verdict
 *   contract (exit 2 passes the guard's line through, exit 0 allows, anything
 *   else refuses); the real `bash-guard` pins end-to-end refusals.
 *   `CODEX_GUARD_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.CODEX_GUARD_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/hooks/codex-guard.sh");
const REAL_GUARD = resolve(import.meta.dir, "../../fleet/hooks/bash-guard");
const UNAVAILABLE = "fleet-guard: guard unavailable, refusing (sf#1230)";

const dir = mkdtempSync(join(testTmpBase(), "codex-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake guard: appends each stdin it gets as one line to its log, then runs `body`. */
function fakeGuard(name: string, body: string): { path: string; seen: () => unknown[] } {
	const path = join(dir, name);
	const log = join(dir, `${name}.log`);
	// One append per call: the adapter runs guards in parallel, so two writes would interleave.
	writeFileSync(path, `#!/bin/sh\nline="$(cat)"\nprintf '%s\\n' "$line" >> "${log}"\n${body}\n`);
	chmodSync(path, 0o755);
	writeFileSync(log, "");
	return {
		path,
		seen: () => {
			const text = readFileSync(log, "utf8");
			writeFileSync(log, "");
			return text
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		},
	};
}

/** A guard bound short enough that a hung-guard case costs under a second. */
const SHORT = { FLEET_GUARD_TIMEOUT_S: "0.3", FLEET_GUARD_KILL_S: "0.3" };

function run(
	payload: unknown,
	guard: string,
	employee = "reviewer",
	extraEnv: Record<string, string> = {},
) {
	const r = Bun.spawnSync(["bash", SCRIPT], {
		stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
		env: {
			PATH: process.env.PATH ?? "",
			FLEET_EMPLOYEE: employee,
			FLEET_GUARD: guard,
			HOME: "/home/operator",
			...extraEnv,
		},
	});
	return { code: r.exitCode ?? -1, stderr: r.stderr.toString() };
}

const bash = (command: unknown) => ({
	cwd: "/home/operator/fleet-work/p",
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command },
	tool_use_id: "call_1",
});
const patch = (text: string) => ({
	cwd: "/home/operator/fleet-work/p",
	hook_event_name: "PreToolUse",
	tool_name: "apply_patch",
	tool_input: { command: text },
});

const LINE = "bash-guard: refused (ssh-infra-only): ssh is Nagatha's alone.";
const deny = fakeGuard("deny", `echo "${LINE}" >&2\nexit 2`);
const allow = fakeGuard("allow", "exit 0");
const other = fakeGuard("other", 'echo "Traceback" >&2\nexit 1');

describe("verdicts", () => {
	test("guard exit 2 blocks with the guard's line", () => {
		const r = run(bash("ssh host01 true"), deny.path);
		expect(r.code).toBe(2);
		expect(r.stderr.trim()).toBe(LINE);
	});

	test("guard exit 0 allows", () => {
		const r = run(bash("ls"), allow.path);
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	test("a missing guard refuses (fails closed)", () => {
		const r = run(bash("ls"), join(dir, "no-such-guard"));
		expect(r.code).toBe(2);
		expect(r.stderr.trim()).toBe(UNAVAILABLE);
	});

	test("any other guard exit refuses (fails closed)", () => {
		const r = run(bash("ls"), other.path);
		expect(r.code).toBe(2);
		expect(r.stderr.trim()).toBe(UNAVAILABLE);
	});

	test("a guard that hangs past its timeout refuses (fails closed)", () => {
		const hang = fakeGuard("hang", "sleep 20\nexit 0");
		const start = Date.now();
		const r = run(bash("ls"), hang.path, "reviewer", SHORT);
		expect(r.code).toBe(2);
		expect(r.stderr.trim()).toBe(UNAVAILABLE);
		expect(Date.now() - start).toBeLessThan(5000);
	});

	test("a zero guard timeout refuses before any guard runs (timeout 0 would never fire)", () => {
		allow.seen();
		const r = run(bash("ls"), allow.path, "reviewer", { FLEET_GUARD_TIMEOUT_S: "0" });
		expect(r.code).toBe(2);
		expect(r.stderr.trim()).toBe(UNAVAILABLE);
		expect(allow.seen()).toEqual([]);
	});
});

describe("translation to the Claude PreToolUse shape", () => {
	const CWD = "/home/operator/fleet-work/p";

	test("Bash passes as Bash {command} with the session cwd", () => {
		allow.seen();
		run(bash("ls -la"), allow.path);
		expect(allow.seen()).toEqual([
			{ tool_name: "Bash", cwd: CWD, tool_input: { command: "ls -la" } },
		]);
	});

	test("an argv-array command is passed whole, shell-quoted", () => {
		allow.seen();
		run(bash(["bash", "-lc", "ssh host01 true"]), allow.path);
		expect(allow.seen()).toEqual([
			{ tool_name: "Bash", cwd: CWD, tool_input: { command: "'bash' '-lc' 'ssh host01 true'" } },
		]);
	});

	test("apply_patch judges every target as a Write of its path from cwd", () => {
		allow.seen();
		const r = run(
			patch(
				"*** Begin Patch\n*** Add File: notes/a.md\n+hi\n*** Update File: /home/operator/fleet-work/p/b.md\n@@\n-x\n+y\n*** Move to: d e.md \r\n*** Delete File: c.md\n*** End Patch\n",
			),
			allow.path,
		);
		expect(r.code).toBe(0);
		const seen = allow.seen();
		expect(seen).toHaveLength(4);
		expect(new Set(seen)).toEqual(
			new Set(
				["notes/a.md", "b.md", "d e.md", "c.md"].map((p) => ({
					tool_name: "Write",
					cwd: CWD,
					tool_input: { file_path: `${CWD}/${p}` },
				})),
			),
		);
	});

	test("apply_patch with no readable target refuses", () => {
		const r = run(patch("garbage"), allow.path);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("could not read an apply_patch target");
	});

	test("any other tool goes to the guard unchanged", () => {
		allow.seen();
		const payload = { tool_name: "mcp__x__y", tool_input: { q: 1 } };
		run(payload, allow.path);
		expect(allow.seen()).toEqual([payload]);
	});
});

describe("end to end with the real bash-guard", () => {
	test("ssh is refused by rule name for a non-infra employee; allowed for infra", () => {
		const r = run(bash("ssh host01 true"), REAL_GUARD);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("bash-guard: refused (ssh-infra-only)");
		expect(run(bash("ssh host01 true"), REAL_GUARD, "infra").code).toBe(0);
	});

	test("ls is allowed", () => {
		expect(run(bash("ls /home/operator/fleet-work"), REAL_GUARD).code).toBe(0);
	});

	test("an apply_patch into ~/.ssh is refused; one into fleet-work is allowed", () => {
		const bad = run(
			patch("*** Begin Patch\n*** Add File: /home/operator/.ssh/config\n+x\n*** End Patch"),
			REAL_GUARD,
		);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain("ssh-infra-only");
		const ok = run(patch("*** Begin Patch\n*** Add File: notes.md\n+x\n*** End Patch"), REAL_GUARD);
		expect(ok.code).toBe(0);
	});
});

describe("review round 1 (PR 1461)", () => {
	test("P1: an indented apply_patch header is still judged", () => {
		const r = run(
			patch(
				"*** Begin Patch\n*** Add File: a.md\n+x\n  *** Update File: /home/operator/.claude/settings.json\n@@\n-a\n+b\n*** End Patch\n",
			),
			REAL_GUARD,
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("guard-files");
	});

	test("P2: a patch at the 8-file cap is judged in one wave, protected path last", () => {
		const hunks = Array.from({ length: 7 }, (_, i) => `*** Add File: f${i}.md\n+x\n`).join("");
		allow.seen();
		expect(
			run(patch(`*** Begin Patch\n${hunks}*** Add File: f7.md\n+x\n*** End Patch\n`), allow.path)
				.code,
		).toBe(0);
		expect(allow.seen()).toHaveLength(8);
		const t0 = Date.now();
		const bad = run(
			patch(`*** Begin Patch\n${hunks}*** Add File: ~/.ssh/config\n+x\n*** End Patch\n`),
			REAL_GUARD,
		);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain("ssh-infra-only");
		expect(Date.now() - t0).toBeLessThan(5000);
	}, 60000);

	test("round 3b: a patch touching 9 files is refused before any guard run", () => {
		const hunks = Array.from({ length: 9 }, (_, i) => `*** Add File: f${i}.md\n+x\n`).join("");
		allow.seen();
		const r = run(patch(`*** Begin Patch\n${hunks}*** End Patch\n`), allow.path);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("apply_patch touches 9 files (max 8); split it");
		expect(allow.seen()).toHaveLength(0);
	});

	test("P2: the shell call's cwd and workdir reach the guard", () => {
		expect(run({ ...bash("cat id_ed25519"), cwd: "/home/operator/.ssh" }, REAL_GUARD).code).toBe(2);
		const exec = {
			cwd: "/home/operator/fleet-work/p",
			tool_name: "exec_command",
			tool_input: { cmd: "printf {} > settings.json", workdir: "/home/operator/.claude" },
		};
		expect(run(exec, REAL_GUARD).code).toBe(2);
	});

	test("P2: a non-shell argv with -c is judged whole; shells still unwrap", () => {
		expect(run(bash(["ssh", "-c", "aes128-ctr", "host01", "true"]), REAL_GUARD).code).toBe(2);
		expect(run(bash(["psql", "-c", "DROP TABLE users"]), REAL_GUARD).code).toBe(2);
		expect(run(bash(["bash", "-lc", "ssh host01 true"]), REAL_GUARD).code).toBe(2);
		expect(run(bash(["sh", "-c", "ls"]), REAL_GUARD).code).toBe(0);
	});
});

describe("review round 3 (PR 1461, N1): apply_patch targets are Write paths from cwd", () => {
	const at = (cwd: string, ...targets: string[]) => ({
		cwd,
		hook_event_name: "PreToolUse",
		tool_name: "apply_patch",
		tool_input: {
			command: `*** Begin Patch\n${targets.map((t) => `*** Add File: ${t}\n+x\n`).join("")}*** End Patch\n`,
		},
	});

	test("N1: a redirect-looking target that climbs into ~/.ssh is refused", () => {
		const r = run(at("/home/operator/fleet-work/p", ">/../../../.ssh/authorized_keys"), REAL_GUARD);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("ssh-infra-only");
	});

	test("N1: targets spelling `; cd sub ;` do not move the cwd a later target resolves from", () => {
		const r = run(
			at("/home/operator/fleet-work/p", "x", ";", "cd", "sub", ";", "y", "../../.codex/hooks.json"),
			REAL_GUARD,
		);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("guard-files");
	});

	test("N1: a target `& hooks.json` in ~/.codex is judged as the path Codex writes", () => {
		allow.seen();
		expect(run(at("/home/operator/.codex", "& hooks.json"), allow.path).code).toBe(0);
		expect(allow.seen()).toEqual([
			{
				tool_name: "Write",
				cwd: "/home/operator/.codex",
				tool_input: { file_path: "/home/operator/.codex/& hooks.json" },
			},
		]);
		// A `~` cwd is resolved by the guard as home, so its hooks.json is the guard file.
		const r = run(at("~/.codex", "& hooks.json", "hooks.json"), REAL_GUARD);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("guard-files");
	});

	test("N1: probe 3 as reviewed, targets `&` then `hooks.json` with cwd ~/.codex, is refused", () => {
		const r = run(at("/home/operator/.codex", "&", "hooks.json"), REAL_GUARD);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("guard-files");
	});

	test("N1: a relative target with no cwd is refused", () => {
		const r = run(at("", "notes.md"), allow.path);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("no cwd");
	});

	test("N1: each target reaches the guard as a Write of its absolute path", () => {
		allow.seen();
		expect(
			run(at("/home/operator/fleet-work/p", "a.md", "/abs/b.md", "& c.md"), allow.path).code,
		).toBe(0);
		const seen = allow.seen() as { tool_input: { file_path: string } }[];
		expect(seen.map((s) => s.tool_input.file_path).sort()).toEqual([
			"/abs/b.md",
			"/home/operator/fleet-work/p/& c.md",
			"/home/operator/fleet-work/p/a.md",
		]);
		for (const s of seen)
			expect(s).toMatchObject({ tool_name: "Write", cwd: "/home/operator/fleet-work/p" });
	});
});

describe("pr-review P2 (PR 1461): a guard that ignores SIGTERM", () => {
	// `trap '' TERM` is inherited by `sleep`, so only the kill-after ends the run.
	const stubborn = fakeGuard("stubborn", "trap '' TERM\nsleep 30\nexit 0");

	for (const [name, payload] of [
		["Bash", bash("ls")],
		["apply_patch", patch("*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch")],
	] as const) {
		test(`${name}: still refuses with exit 2 once the kill-after fires, not after its 30 s sleep`, () => {
			const start = Date.now();
			const r = run(payload, stubborn.path, "reviewer", SHORT);
			const ms = Date.now() - start;
			expect(r.code).toBe(2);
			expect(r.stderr.trim()).toBe(UNAVAILABLE);
			expect(ms).toBeLessThan(5000);
		});
	}
});
