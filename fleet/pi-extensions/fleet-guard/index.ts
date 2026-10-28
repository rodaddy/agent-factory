/**
 * @module fleet/pi-extensions/fleet-guard
 * @description Pi adapter for the one fleet guard. The rules live in
 *   `fleet/hooks/bash-guard` and nowhere else; this extension only translates a
 *   Pi tool call into the Claude PreToolUse shape, runs the guard, and turns its
 *   verdict into a Pi block. Exit 2 blocks with the guard's own line; exit 0
 *   allows; anything else (spawn error, timeout, another exit) blocks: the floor
 *   fails closed. Tools other than bash/write/edit/read/grep/find/ls are left alone.
 *   Every block also writes one stderr line `fleet-guard: block seat=<seat>
 *   rule=<guard|unavailable|no-guard|bad-path> tool=<Pi tool>`.
 *
 *   The guard is found once, when the extension loads: `FLEET_GUARD`
 *   when it is set and non-empty, as `codex-guard.sh` reads it; otherwise the
 *   root-owned `/usr/local/lib/fleet/bash-guard`; otherwise
 *   `~/fleet/hooks/bash-guard`. The first that is a file wins. A set
 *   `FLEET_GUARD` is an instruction and never falls through: when it names no
 *   file, every judged tool is blocked and the reason names that path. When no
 *   candidate is a file, every judged tool is blocked and the reason lists the
 *   paths tried.
 *
 *   Load order: Pi discovers `~/.pi/agent/extensions/*` with `readdirSync`,
 *   which returns names sorted, so `fleet-guard` runs before `jev-guard`, and
 *   the first handler that blocks ends the chain.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the guard is looked for after `FLEET_GUARD`, in order. An object so a test can replace a path. */
export const GUARD_PATHS = {
	system: "/usr/local/lib/fleet/bash-guard",
	home: join(homedir(), "fleet/hooks/bash-guard"),
};
export const UNAVAILABLE = "fleet-guard: guard unavailable, refusing (sf#1230)";
const TIMEOUT_MS = 5000;

export type ClaudeCall = { tool_name: string; cwd?: string; tool_input: Record<string, string> };
export type PiToolCall = { toolName?: string; input?: Record<string, unknown> };
export type Verdict = { block: true; reason: string } | undefined;
/** Why a call was blocked, from a fixed set so the stderr line never carries free text. */
export type Rule = "guard" | "unavailable" | "no-guard" | "bad-path";
export type GuardVerdict = { block: true; reason: string; rule: Rule } | undefined;
type Handler = (event: PiToolCall, ctx?: { cwd?: string }) => Promise<Verdict>;
type PiApi = { on: (name: string, handler: Handler) => void };

/** grep/find/ls default to the cwd, as Pi's own tools do. */
const PATH_TOOLS: Record<string, string> = {
	write: "Write",
	edit: "Edit",
	read: "Read",
	grep: "Grep",
	find: "Glob",
	ls: "Glob",
};

/** A Pi tool path as Pi resolves it (`resolveToCwd`): Unicode spaces, one `@`, `~`/`~/`, `file://`. `$HOME` stays literal, as in Pi (PR 1461 pr-review P1). `~` is the HOME the guard sees. */
export function piPath(raw: string, cwd?: string): string {
	let p = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	p = p.replace(/^~(?=\/|$)/, process.env.HOME || homedir());
	if (p.startsWith("file://")) p = fileURLToPath(p);
	return cwd ? resolve(cwd, p) : p;
}

/** Map a Pi tool call to the Claude PreToolUse shape; undefined for tools the guard does not judge. */
export function toClaude(event: PiToolCall, cwd?: string): ClaudeCall | undefined {
	const name = event.toolName ?? "";
	if (name === "bash") {
		return { tool_name: "Bash", cwd, tool_input: { command: String(event.input?.command ?? "") } };
	}
	const claudeName = PATH_TOOLS[name];
	if (!claudeName) return undefined;
	const raw = String(event.input?.path ?? event.input?.file_path ?? "");
	return { tool_name: claudeName, tool_input: { file_path: piPath(raw, cwd) } };
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Find the guard: `FLEET_GUARD` if set (no fall-through), else the first of `GUARD_PATHS` that is a file. */
export function resolveGuard(
	env: Record<string, string | undefined> = process.env,
): { guard: string } | { reason: string } {
	const named = env.FLEET_GUARD;
	if (named) {
		return isFile(named)
			? { guard: named }
			: { reason: `${UNAVAILABLE}: FLEET_GUARD=${named} is not a file` };
	}
	const tried = [GUARD_PATHS.system, GUARD_PATHS.home];
	const guard = tried.find(isFile);
	return guard ? { guard } : { reason: `${UNAVAILABLE}: tried ${tried.join(", ")}` };
}

/** Arm a one-shot timer and return its cancel. Injectable so a test owns the guard's clock. */
export type Arm = (fire: () => void, ms: number) => () => void;
const realTimer: Arm = (fire, ms) => {
	const t = setTimeout(fire, ms);
	return () => clearTimeout(t);
};

/** Run the guard once. Exit 2 is a refusal carrying its stderr line; exit 0 allows; all else refuses. */
export function runGuard(
	call: ClaudeCall,
	guard: string,
	timeoutMs: number = TIMEOUT_MS,
	arm: Arm = realTimer,
): Promise<GuardVerdict> {
	const refuse: GuardVerdict = { block: true, reason: UNAVAILABLE, rule: "unavailable" };
	return new Promise((done) => {
		let settled = false;
		let cancel: (() => void) | undefined;
		const finish = (v: GuardVerdict) => {
			if (settled) return;
			settled = true;
			cancel?.();
			done(v);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(guard, [], { env: process.env, stdio: ["pipe", "ignore", "pipe"] });
		} catch {
			finish(refuse);
			return;
		}
		cancel = arm(() => {
			child.kill("SIGKILL");
			finish(refuse);
		}, timeoutMs);
		let stderr = "";
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", () => finish(refuse));
		child.on("close", (code) => {
			if (code === 0) return finish(undefined);
			const line = stderr.trim().split("\n")[0] ?? "";
			if (code === 2 && line) return finish({ block: true, reason: line, rule: "guard" });
			finish(refuse);
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(call));
	});
}

const stderrLine = (line: string) => process.stderr.write(`${line}\n`);

/**
 * One stderr line per block: seat, a fixed rule id and the Pi tool
 * name only. Never the reason, the command, the tool input or a path: the guard's reason
 * can quote the command. stderr, never stdout (stdout belongs to Pi).
 */
export function makeFleetGuard(
	opts: { guard?: string; timeoutMs?: number; log?: (line: string) => void; arm?: Arm } = {},
) {
	const log = opts.log ?? stderrLine;
	return (pi: PiApi) => {
		const found = opts.guard ? { guard: opts.guard } : resolveGuard();
		const block = (tool: string | undefined, rule: Rule, reason: string): Verdict => {
			log(
				`fleet-guard: block seat=${process.env.FLEET_EMPLOYEE || "unknown"} rule=${rule} tool=${tool ?? ""}`,
			);
			return { block: true, reason };
		};
		pi.on("tool_call", async (event, ctx) => {
			let call: ClaudeCall | undefined;
			try {
				call = toClaude(event, ctx?.cwd);
			} catch {
				return block(event.toolName, "bad-path", UNAVAILABLE); // a path Pi cannot read either
			}
			if (!call) return undefined;
			if ("reason" in found) return block(event.toolName, "no-guard", found.reason);
			const v = await runGuard(call, found.guard, opts.timeoutMs ?? TIMEOUT_MS, opts.arm);
			return v && block(event.toolName, v.rule, v.reason);
		});
	};
}

export default function (pi: PiApi) {
	makeFleetGuard()(pi);
}
