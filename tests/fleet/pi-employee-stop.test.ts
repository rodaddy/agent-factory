/**
 * @module tests/fleet/pi-employee-stop
 * @description `fleet/bin/pi-employee` stops everything its run started
 *   (cut R1). The launcher runs as a real child beside the real
 *   `pi-stdout-filter`, against a fake `pi` and stand-in tool children that
 *   are only ever `/bin/sh` or `/bin/sleep`: `ps -E` shows no environment for
 *   an Apple system binary, so a stand-in of any other kind would be found by
 *   its run id and the cases would pass for the wrong reason. Each stand-in
 *   appends its pid to `pids-<case>.txt`; "remaining" is the pids in that file
 *   still running, where a zombie counts as gone. Every stand-in sleeps a
 *   bounded time and is SIGKILLed by recorded pid after its case.
 *   `PI_EMPLOYEE_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";
import { until } from "../support/wait-until";

const LAUNCHER =
	process.env.PI_EMPLOYEE_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/pi-employee");
const FILTER =
	process.env.PI_STDOUT_FILTER_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/bin/pi-stdout-filter");
const ARGS = ["--mode", "json", "-p", "do the assigned task"];
const EVENT = `echo '{"type":"agent_start"}'\n`;
const READY = `: > "$READY"\n`;
const IDLE = "while :; do /bin/sleep 0.1; done\n";
/** A `/bin/sleep 60` in pi's process group, with nothing of pi's open. */
const IN_GROUP = `/bin/sleep 60 >/dev/null 2>&1 </dev/null &\necho $! >> "$PIDS"\n`;
/**
 * A `/bin/sleep 60` in its own session, in `/`, with an EMPTY environment: a
 * system binary nothing but the launcher's own record ties to the run.
 */
const OWN_SESSION = `python3 -c 'import os; os.setsid(); os.chdir("/"); os.execve("/bin/sleep", ["sleep", "60"], {})' >/dev/null 2>&1 </dev/null &\necho $! >> "$PIDS"\n`;
/** At most 60 s of idling for a `/bin/sh` stand-in (T15, T16). */
const BOUNDED_IDLE = "i=0\nwhile [ $i -lt 600 ]; do /bin/sleep 0.1; i=$((i+1)); done\n";
/**
 * Fake-pi lines that start `/bin/sh <file> <args>` in its own session with an
 * EMPTY environment and record its pid (T15, T16). setsid comes before the
 * exec, so anything the script writes is written outside pi's group.
 */
function ownSessionSh(file: string, ...args: string[]): string {
	const argv = [file, ...args].map((arg) => `"${arg}"`).join(" ");
	return `python3 -c 'import os, sys; os.setsid(); os.execve("/bin/sh", ["/bin/sh", *sys.argv[1:]], {})' ${argv} >/dev/null 2>&1 </dev/null &\necho $! >> "$PIDS"\n`;
}
/** Let the test freeze discovery before the child can briefly join pi's group. */
const PREPARED_OWN_SESSION = `echo "$PPID" > "$MID"\n: > "$READY.prepare"\nwhile [ ! -e "$READY.spawn" ]; do /bin/sleep 0.01; done\n${OWN_SESSION}`;
/** Longest wait for a launcher to exit; a hung one is SIGKILLed (exit 137). */
const WATCHDOG_MS = 15_000;
const CASE_MS = 45_000;

let scratch = "";
let fleetRoot = "";
let copy = "";
let counter = 0;
/** Pids this file started itself (launchers, bridges, readers, strangers). */
const started: number[] = [];

beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "pi-employee-stop-"));
	fleetRoot = join(scratch, "fleet");
	mkdirSync(join(fleetRoot, "pi", "profiles"), { recursive: true });
	mkdirSync(join(fleetRoot, "pi-extensions", "fleet-proxy-models"), { recursive: true });
	writeFileSync(join(fleetRoot, "pi-extensions", "fleet-proxy-models", "index.ts"), "export {};\n");
	writeFileSync(
		join(fleetRoot, "pi", "versions.json"),
		readFileSync(resolve(import.meta.dir, "../../fleet/pi/versions.json")),
	);
	writeFileSync(
		join(fleetRoot, "pi", "profiles", "stop.json"),
		'{"tools":["read"],"extensions":[]}',
	);
	// A copy beside the real filter, so a mutated launcher still finds one.
	const bin = join(scratch, "bin");
	mkdirSync(bin);
	copy = join(bin, "pi-employee");
	writeFileSync(copy, readFileSync(LAUNCHER));
	chmodSync(copy, 0o755);
	writeFileSync(join(bin, "pi-stdout-filter"), readFileSync(FILTER));
	chmodSync(join(bin, "pi-stdout-filter"), 0o755);
});
afterEach(() => killOwn(recordedPids()));
afterAll(() => {
	killOwn(recordedPids());
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function script(name: string, body: string): string {
	const path = join(scratch, name);
	writeFileSync(path, `#!/bin/sh\n${body}`);
	chmodSync(path, 0o755);
	return path;
}

/** A fake pi: answers `--version`, records its own pid, keeps stderr quiet. */
function fakePi(name: string, body: string): string {
	return script(
		name,
		`if [ "$1" = "--version" ]; then echo "pi coding agent 1.1.0"; exit 0; fi\nexec 2>/dev/null\necho $$ >> "$PIDS"\n${body}`,
	);
}

function pidsOf(file: string): number[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 1);
}

function recordedPids(): number[] {
	if (!scratch || !existsSync(scratch)) return [...started];
	const files = readdirSync(scratch).filter((name) => name.startsWith("pids-"));
	return [...started, ...files.flatMap((name) => pidsOf(join(scratch, name)))];
}

/** state and command of one pid; null when it is gone. */
function look(pid: number): { zombie: boolean; stopped: boolean; command: string } | null {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
			const state = stat.slice(stat.lastIndexOf(")") + 2);
			return { zombie: state.startsWith("Z"), stopped: state.startsWith("T"), command };
		} catch {
			return null;
		}
	}
	const ps = Bun.spawnSync(["/bin/ps", "-ww", "-o", "stat=", "-o", "command=", "-p", String(pid)]);
	const row = ps.stdout.toString().trim();
	if (row === "") return null;
	return {
		zombie: row.startsWith("Z"),
		stopped: row.startsWith("T"),
		command: row.replace(/^\S+\s+/, ""),
	};
}

/** Signal 0 succeeds on a zombie, so "running" is: listed and not a zombie. */
function alive(pids: number[]): number[] {
	return pids.filter((pid) => look(pid)?.zombie === false);
}

/** Wait for the detached child to exec, so its run id cannot hide a broken ledger. */
async function ownSessionReady(file: string, readyPath: string, mid: string): Promise<void> {
	await until(() => existsSync(`${readyPath}.prepare`), 10_000, "pi to await detached-child setup");
	const launcherPid = pidsOf(mid)[0] ?? 0;
	expect(launcherPid).toBeGreaterThan(1);
	process.kill(launcherPid, "SIGSTOP");
	try {
		await until(() => look(launcherPid)?.stopped === true, 10_000, "launcher discovery to stop");
		writeFileSync(`${readyPath}.spawn`, "");
		await until(() => pidsOf(file).length >= 2, 10_000, "the detached child pid");
		const pid = pidsOf(file)[1] ?? 0;
		const ready = Bun.spawn(
			[
				"python3",
				"-c",
				`import os, subprocess, sys, time
pid = int(sys.argv[1])
end = time.monotonic() + 8
while time.monotonic() < end:
    command = subprocess.check_output(["/bin/ps", "-ww", "-o", "command=", "-p", str(pid)], timeout=1).decode().strip()
    if command in ("sleep 60", "/bin/sleep 60") and os.getpgid(pid) == pid and os.getsid(pid) == pid:
        sys.exit(0)
    time.sleep(0.01) # fixed-sleep-ok: poll for exec and session readiness
sys.exit("detached child never execed sleep in its own session")`,
				String(pid),
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const error = await new Response(ready.stderr).text();
		expect({ code: await ready.exited, error }).toEqual({ code: 0, error: "" });
	} finally {
		process.kill(launcherPid, "SIGCONT");
	}
}

/** The pids of `file` still running, after at most 10 s for them to go. */
async function remaining(file: string): Promise<number[]> {
	try {
		await until(() => alive(pidsOf(file)).length === 0, 10_000);
	} catch {
		// reported by the caller's assertion on the returned list
	}
	return alive(pidsOf(file));
}

/** SIGKILL by recorded pid, and only a process that is still this file's. */
function killOwn(pids: number[]): void {
	for (const pid of pids) {
		const row = look(pid);
		if (!row || row.zombie) continue;
		if (!row.command.includes(scratch) && !/^(\/bin\/)?sleep 60$/.test(row.command)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone between the look and the kill
		}
	}
}

type Run = {
	p: ReturnType<typeof Bun.spawn>;
	pids: string;
	ready: string;
	err: string;
	id: string;
	env: Record<string, string>;
};

/** A run id no other test process on this host shares. */
function runId(run: "a" | "b"): string {
	counter += 1;
	return `run-${run}-${process.pid}-${counter}`;
}

function caseEnv(tag: string, pi: string, id: string | null): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: scratch,
		PI_EMPLOYEE_FLEET_ROOT: fleetRoot,
		FLEET_EMPLOYEE: "stop",
		PI_EMPLOYEE_PI_BIN: pi,
		PI_EMPLOYEE_STOP_GRACE: "1",
		PIDS: join(scratch, `pids-${tag}.txt`),
		READY: join(scratch, `ready-${tag}`),
		MID: join(scratch, `mid-${tag}`),
		// Only the launcher's env holds the run id; the bun process never does.
		...(id === null ? {} : { PAPERCLIP_RUN_ID: id }),
	};
}

/** Start the launcher with stdout and stderr in files, so nothing can block on a pipe. */
function launch(
	tag: string,
	piBody: string,
	opts: { id?: string | null; env?: Record<string, string> } = {},
): Run {
	const id = opts.id === undefined ? runId("a") : opts.id;
	const env = { ...caseEnv(tag, fakePi(`pi-${tag}`, piBody), id), ...opts.env };
	const err = join(scratch, `err-${tag}.txt`);
	const p = Bun.spawn([copy, ...ARGS], {
		env,
		stdin: "ignore",
		stdout: Bun.file(join(scratch, `out-${tag}.txt`)),
		stderr: Bun.file(err),
	});
	started.push(p.pid);
	return { p, pids: env.PIDS ?? "", ready: env.READY ?? "", err, id: id ?? "", env };
}

async function exitOf(p: ReturnType<typeof Bun.spawn>): Promise<number> {
	const watchdog = setTimeout(() => p.kill("SIGKILL"), WATCHDOG_MS);
	const code = await p.exited;
	clearTimeout(watchdog);
	return code;
}

/** Signal the launcher once its fake pi is up; its exit code, stderr and timing. */
async function stop(run: Run, sig: NodeJS.Signals = "SIGTERM") {
	await until(() => existsSync(run.ready), 10_000, "the fake pi to be ready");
	const at = performance.now();
	run.p.kill(sig);
	const code = await exitOf(run.p);
	const exitedAt = Date.now();
	return { code, stderr: readFileSync(run.err, "utf8"), ms: performance.now() - at, exitedAt };
}

/** The one last line: `<n>` is capture 1, the optional parts are `tail`. */
function lastLine(cause: string, tail = ""): RegExp {
	return new RegExp(`^pi-employee: stopped on ${cause}; (\\d+) run processes stopped${tail}\\n$`);
}

function stoppedCount(stderr: string): number {
	return Number(/; (\d+) run processes stopped/.exec(stderr)?.[1] ?? "-1");
}

describe("pi-employee stops what its run started", () => {
	const IGNORES_TERM = `trap '' TERM\n${EVENT}${READY}${IDLE}`;

	test(
		"T1 a pi that ignores SIGTERM is killed after the grace; one last line",
		async () => {
			// pi outlives SIGTERM and records the moment it arrived: the launcher
			// sees its own signal up to one tick late, so the grace is measured
			// from the SIGTERM pi got, and the whole stop from the test's signal.
			const termed = join(scratch, "termed-t1");
			const run = launch(
				"t1",
				`trap '[ -e "${termed}" ] || : > "${termed}"' TERM\n${EVENT}${READY}${IDLE}`,
			);
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(await remaining(run.pids)).toEqual([]);
			expect(r.stderr).toMatch(lastLine("SIGTERM"));
			// GRACE is 1 s here and the deadline 6 s. The SIGKILL waited the grace:
			expect(r.exitedAt - statSync(termed).mtimeMs).toBeGreaterThanOrEqual(900);
			// and the group SIGKILL of step 3 did the work, not a later step.
			expect(r.ms).toBeLessThan(4000);
		},
		CASE_MS,
	);

	test(
		"T1 SIGHUP stops the run too: exit 129",
		async () => {
			const run = launch("t1-hup", IGNORES_TERM);
			const r = await stop(run, "SIGHUP");
			expect(r.code).toBe(129);
			expect(r.stderr).toMatch(lastLine("SIGHUP"));
			expect(await remaining(run.pids)).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T2 a child in pi's group whose parent died before any walk is stopped",
		async () => {
			// 0.5 s first, so the launcher's walk at pi's start is over.
			const mid = script("mid-t2.sh", `env -i ${IN_GROUP}`);
			const run = launch("t2", `/bin/sleep 0.5\n/bin/sh "${mid}"\n${EVENT}${READY}${IDLE}`);
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(pidsOf(run.pids)).toHaveLength(2);
			expect(await remaining(run.pids)).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T3 a child in its own session is stopped while its parent lives",
		async () => {
			const run = launch("t3", `${PREPARED_OWN_SESSION}${EVENT}${READY}${IDLE}`);
			await ownSessionReady(run.pids, run.ready, run.env.MID ?? "");
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(pidsOf(run.pids)).toHaveLength(2);
			expect(await remaining(run.pids)).toEqual([]);
			expect(r.stderr).toMatch(lastLine("SIGTERM"));
			expect(stoppedCount(r.stderr)).toBeGreaterThanOrEqual(2);
		},
		CASE_MS,
	);

	test(
		"T4 a child in its own session is stopped after its parent died: a tick recorded it",
		async () => {
			// The intermediate lives 3 s (more than two ticks) and pi reaps it.
			const mid = script("mid-t4.sh", `echo $$ > "$MID"\n${OWN_SESSION}/bin/sleep 3\n`);
			const run = launch("t4", `/bin/sleep 0.5\n/bin/sh "${mid}"\n${EVENT}${READY}${IDLE}`);
			await until(() => existsSync(run.ready), 15_000, "the intermediate to exit");
			expect(alive(pidsOf(run.env.MID ?? ""))).toEqual([]);
			expect(alive(pidsOf(run.pids))).toHaveLength(2);
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(await remaining(run.pids)).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T5 the run's bridge is stopped and its pid file removed",
		async () => {
			const id = runId("a");
			const queue = join(scratch, "queue-t5");
			const dir = join(scratch, ".paperclip-runtime", "runs", id, "x");
			mkdirSync(queue);
			mkdirSync(dir, { recursive: true });
			const entry = join(dir, "paperclip-bridge-server.mjs");
			writeFileSync(entry, "while :; do /bin/sleep 0.2; done\n");
			const bridge = Bun.spawn(["/bin/sh", entry], {
				env: {},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			started.push(bridge.pid);
			const pidFile = join(queue, "server.pid");
			writeFileSync(pidFile, `${bridge.pid}\n`);
			const run = launch("t5", `${EVENT}${READY}${IDLE}`, {
				id,
				env: { PAPERCLIP_BRIDGE_QUEUE_DIR: queue },
			});
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(alive([bridge.pid])).toEqual([]);
			expect(existsSync(pidFile)).toBe(false);
			expect(await remaining(run.pids)).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T6 a pid file naming a process that is not the run's bridge is left alone",
		async () => {
			const queue = join(scratch, "queue-t6");
			mkdirSync(queue);
			const stranger = Bun.spawn(["/bin/sleep", "60"], {
				env: {},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			started.push(stranger.pid);
			const pidFile = join(queue, "server.pid");
			writeFileSync(pidFile, `${stranger.pid}\n`);
			// pi is one process, so the count is exactly 1 when the stranger is left out.
			const run = launch("t6", `${EVENT}${READY}exec /bin/sleep 60\n`, {
				env: { PAPERCLIP_BRIDGE_QUEUE_DIR: queue },
			});
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(r.stderr).toMatch(lastLine("SIGTERM"));
			expect(stoppedCount(r.stderr)).toBe(1);
			expect(alive([stranger.pid])).toEqual([stranger.pid]);
			expect(existsSync(pidFile)).toBe(true);
		},
		CASE_MS,
	);

	test(
		"T7 stopping run a leaves run b running",
		async () => {
			const body = `${IN_GROUP}${EVENT}${READY}${IDLE}`;
			const b = launch("t7b", body, { id: runId("b") });
			const a = launch("t7a", body);
			await until(() => existsSync(b.ready), 10_000, "run b's fake pi to be ready");
			const r = await stop(a);
			expect(r.code).toBe(143);
			expect(await remaining(a.pids)).toEqual([]);
			expect(pidsOf(b.pids)).toHaveLength(2);
			expect(alive([b.p.pid, ...pidsOf(b.pids)])).toHaveLength(3);
		},
		CASE_MS,
	);

	// The one case that needs the run id read from a process's environment:
	// not readable for a system binary on darwin, so it runs on Linux only.
	test.skipIf(process.platform === "darwin")(
		"T8 a process outside pi's tree that carries the run id is stopped",
		async () => {
			const id = runId("a");
			const tagged = nodeSpawn("/bin/sleep", ["60"], {
				detached: true,
				env: { PAPERCLIP_RUN_ID: id },
				stdio: "ignore",
			});
			tagged.unref();
			const pid = tagged.pid ?? 0;
			started.push(pid);
			const run = launch("t8", `${EVENT}${READY}${IDLE}`, { id });
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(alive([pid])).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T10 a reader that goes away stops a silent run: exit 1 with stdout and stderr both dead",
		async () => {
			const tag = "t10";
			const code = join(scratch, `code-${tag}`);
			const readerReady = join(scratch, `reader-ready-${tag}`);
			// Reads pi's one event, says so, then holds the pipe as /bin/sleep.
			const reader = script(
				`reader-${tag}.sh`,
				`read line\necho $$ > "${readerReady}.tmp"\nmv "${readerReady}.tmp" "${readerReady}"\nexec /bin/sleep 60\n`,
			);
			const pi = fakePi(`pi-${tag}`, `${PREPARED_OWN_SESSION}${EVENT}${READY}${IDLE}`);
			const pids = join(scratch, `pids-${tag}.txt`);
			const env: Record<string, string> = {
				...caseEnv(tag, pi, runId("a")),
				CODE: code,
				READER: reader,
			};
			// A shell pipeline: a real pipe on fd 1 and fd 2, and a reader the test can kill.
			const p = Bun.spawn(
				["/bin/sh", "-c", '{ "$0" "$@"; echo $? > "$CODE"; } 2>&1 | "$READER"', copy, ...ARGS],
				{ env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			started.push(p.pid);
			await ownSessionReady(pids, env.READY ?? "", env.MID ?? "");
			await until(() => existsSync(readerReady), 10_000, "the reader to take pi's event");
			const readerPid = pidsOf(readerReady)[0] ?? 0;
			started.push(readerPid);
			expect(alive(pidsOf(pids))).toHaveLength(2);
			process.kill(readerPid, "SIGKILL");
			// One tick, then 2 x GRACE + 4 s with GRACE 1, plus margin.
			try {
				await until(() => existsSync(code) && readFileSync(code, "utf8").endsWith("\n"), 12_000);
			} catch {
				// reported by the assertion below
			}
			expect(existsSync(code) ? readFileSync(code, "utf8") : "launcher still running").toBe("1\n");
			expect(await remaining(pids)).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T11 without a run id the group and the ledger still stop the run",
		async () => {
			const run = launch("t11", `${PREPARED_OWN_SESSION}${IN_GROUP}${EVENT}${READY}${IDLE}`, {
				id: null,
			});
			await ownSessionReady(run.pids, run.ready, run.env.MID ?? "");
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(pidsOf(run.pids)).toHaveLength(3);
			expect(await remaining(run.pids)).toEqual([]);
			expect(r.stderr).toMatch(lastLine("SIGTERM", "; no run id"));
		},
		CASE_MS,
	);

	test(
		"T12 a healthy run is not stopped when stdout is /dev/null or a regular file",
		async () => {
			// poll() answers POLLNVAL for /dev/null and nothing for a regular file.
			for (const [tag, sink] of [
				["t12-null", "/dev/null"],
				["t12-file", join(scratch, "sink-t12.txt")],
			] as const) {
				const pi = fakePi(`pi-${tag}`, `${EVENT}/bin/sleep 2.5\nexit 0\n`);
				const err = join(scratch, `err-${tag}.txt`);
				const p = Bun.spawn(["/bin/sh", "-c", 'exec "$0" "$@" > "$SINK"', copy, ...ARGS], {
					env: { ...caseEnv(tag, pi, runId("a")), SINK: sink },
					stdin: "ignore",
					stdout: "ignore",
					stderr: Bun.file(err),
				});
				started.push(p.pid);
				expect(await exitOf(p)).toBe(0);
				expect(readFileSync(err, "utf8")).toBe("");
			}
		},
		CASE_MS,
	);

	test(
		"T13 pi has exited and a child still holds its stdout: SIGTERM stops the child",
		async () => {
			// The child keeps pi's stdout, so the filter sees no end of input. It
			// starts 0.5 s in, after the walk at pi's start, and pi exits at once:
			// only a walk of pi's group while pi is an unreaped zombie records it.
			// Its environment is empty, so no run id is what finds it.
			const run = launch(
				"t13",
				`/bin/sleep 0.5\nenv -i /bin/sleep 60 2>/dev/null </dev/null &\necho $! >> "$PIDS"\n${EVENT}${READY}exit 0\n`,
			);
			await until(() => existsSync(run.ready), 10_000, "the fake pi to exit");
			await Bun.sleep(2000); // fixed-sleep-ok: the case is that the launcher is STILL running 2 s after pi exited
			expect(run.p.exitCode).toBeNull();
			expect(alive(pidsOf(run.pids))).toHaveLength(1);
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(await remaining(run.pids)).toEqual([]);
			expect(r.stderr).toMatch(lastLine("SIGTERM"));
		},
		CASE_MS,
	);

	test(
		"T14 a wrapper above the launcher that carries the run id is not stopped",
		async () => {
			const tag = "t14";
			const id = runId("a");
			const file = (name: string) => join(scratch, `${name}-${tag}`);
			// Neither level execs the next: the wrapper has to exist as a process.
			// The parent records its own pid, and the launcher's as soon as it has
			// one, in the pids file the clean-up hooks read.
			const parent = script(
				`parent-${tag}.sh`,
				`echo $$ >> "$PIDS"\n"$LAUNCHER" "$@" > "$OUT" 2> "$ERR" </dev/null &\necho $! >> "$PIDS"\necho $! > "$LPID.tmp"\nmv "$LPID.tmp" "$LPID"\nwait $!\necho $? > "$CODE"\necho parent >> "$SURVIVED"\n`,
			);
			const grandparent = script(
				`grandparent-${tag}.sh`,
				`shift\n/bin/sh "${parent}" "$@"\necho grandparent >> "$SURVIVED"\n`,
			);
			const pi = fakePi(`pi-${tag}`, `${EVENT}${READY}${IDLE}`);
			const pids = join(scratch, `pids-${tag}.txt`);
			const ready = join(scratch, `ready-${tag}`);
			const env = {
				...caseEnv(tag, pi, id),
				LAUNCHER: copy,
				OUT: file("out"),
				ERR: file("err"),
				LPID: file("lpid"),
				CODE: file("code"),
				SURVIVED: file("survived"),
			};
			// Both wrappers hold the run id in their environment. Only the
			// grandparent carries it on its command line: its `shift` drops it
			// before the parent.
			const p = Bun.spawn(["/bin/sh", grandparent, `PAPERCLIP_RUN_ID=${id}`, ...ARGS], {
				env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			started.push(p.pid);
			await until(
				() => existsSync(ready) && existsSync(env.LPID),
				10_000,
				"the fake pi to be ready",
			);
			// No fallback pid: 0 would signal this test's own process group.
			const launcher = Number(readFileSync(env.LPID, "utf8").trim());
			expect(launcher).toBeGreaterThan(1);
			started.push(launcher);
			process.kill(launcher, "SIGTERM");
			try {
				await until(
					() => existsSync(env.CODE) && readFileSync(env.CODE, "utf8").endsWith("\n"),
					12_000,
				);
			} catch {
				// reported by the assertion below
			}
			await exitOf(p);
			expect(existsSync(env.CODE) ? readFileSync(env.CODE, "utf8") : "launcher still running").toBe(
				"143\n",
			);
			expect(readFileSync(env.SURVIVED, "utf8")).toBe("parent\ngrandparent\n");
			expect(await remaining(pids)).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T15 a garbage bridge pid file does not cut the stop short",
		async () => {
			const queue = join(scratch, "queue-t15");
			mkdirSync(queue);
			const pidFile = join(queue, "server.pid");
			writeFileSync(pidFile, `${"7".repeat(5000)}\n`);
			// Outside pi's group, at most 60 s: the first SIGTERM is only counted,
			// the second leaves the marker and exits 0. The stop's normal path sends
			// SIGTERM by pid again after the bridge step; a stop that fails there
			// goes to SIGKILL instead, and the marker is never written.
			const clean = join(scratch, "clean-t15");
			const twiceReady = join(scratch, "twice-ready-t15");
			const twice = script(
				"twice-t15.sh",
				`CLEAN="$1"\nn=0\ntrap 'n=$((n+1)); if [ $n -ge 2 ]; then : > "$CLEAN"; exit 0; fi' TERM\n: > "$2"\n${BOUNDED_IDLE}`,
			);
			const run = launch(
				"t15",
				`${ownSessionSh(twice, clean, twiceReady)}${EVENT}${READY}exec /bin/sleep 60\n`,
				{ env: { PAPERCLIP_BRIDGE_QUEUE_DIR: queue } },
			);
			await until(() => existsSync(twiceReady), 10_000, "the child to set its trap");
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(r.stderr).toMatch(lastLine("SIGTERM"));
			expect(existsSync(pidFile)).toBe(true);
			expect(existsSync(clean)).toBe(true);
			expect(await remaining(run.pids)).toEqual([]);
		},
		CASE_MS,
	);

	test(
		"T16 a child outside the group that ignores SIGTERM is killed before the deadline",
		async () => {
			// Own session, empty environment, at most 60 s: only a SIGKILL by pid ends it.
			// It reports ready once it is out of pi's group and its trap is set.
			const stubbornReady = join(scratch, "stubborn-ready-t16");
			const stubborn = script("stubborn-t16.sh", `trap '' TERM\n: > "$1"\n${BOUNDED_IDLE}`);
			const run = launch("t16", `${ownSessionSh(stubborn, stubbornReady)}${EVENT}${READY}${IDLE}`);
			await until(() => existsSync(stubbornReady), 10_000, "the stubborn child to set its trap");
			const r = await stop(run);
			expect(r.code).toBe(143);
			expect(pidsOf(run.pids)).toHaveLength(2);
			expect(await remaining(run.pids)).toEqual([]);
			// GRACE is 1 s, the deadline 6 s: the SIGKILL by pid of step 7 did it.
			expect(r.ms).toBeLessThan(5000);
		},
		CASE_MS,
	);
});
