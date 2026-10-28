/**
 * @module tests/fleet/fleet-guard-pi
 * @description The Pi adapter for the one fleet guard, driven through
 *   its `tool_call` handler exactly as Pi calls it. A fake guard script built
 *   at runtime stands in for `bash-guard` to pin the verdict contract (exit 2
 *   blocks with the guard's line, exit 0 allows, everything else blocks); the
 *   real `bash-guard` pins one end-to-end refusal. The last block pins where
 *   the adapter looks for the guard when no path is handed to it:
 *   `FLEET_GUARD`, then the root-owned path, then the home path.
 *   `FLEET_GUARD_PI_UNDER_TEST` points the suite at a mutated copy of the
 *   extension.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

type Verdict = { block: true; reason: string } | undefined;
type Event = { toolName?: string; input?: Record<string, unknown> };
type Handler = (event: Event, ctx?: { cwd?: string }) => Promise<Verdict>;
type Mod = {
	UNAVAILABLE: string;
	GUARD_PATHS: { system: string; home: string };
	makeFleetGuard: (o?: {
		guard?: string;
		timeoutMs?: number;
		log?: (line: string) => void;
		arm?: (fire: () => void, ms: number) => () => void;
	}) => (pi: { on: (n: string, h: Handler) => void }) => void;
};

const MODULE =
	process.env.FLEET_GUARD_PI_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/pi-extensions/fleet-guard/index.ts");
const mod = (await import(MODULE)) as Mod;
const REAL_GUARD = resolve(import.meta.dir, "../../fleet/hooks/bash-guard");

const dir = mkdtempSync(join(testTmpBase(), "fleet-guard-pi-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake guard: records its stdin and FLEET_EMPLOYEE, then runs `body`. */
function fakeGuard(name: string, body: string): { path: string; seen: () => string } {
	const path = join(dir, name);
	const log = join(dir, `${name}.log`);
	writeFileSync(
		path,
		`#!/bin/sh\ncat > "${log}"\necho >> "${log}"\necho "emp=$FLEET_EMPLOYEE" >> "${log}"\n${body}\n`,
	);
	chmodSync(path, 0o755);
	return { path, seen: () => readFileSync(log, "utf8") };
}

function handler(
	guard: string,
	timeoutMs?: number,
	log?: (line: string) => void,
	arm?: (fire: () => void, ms: number) => () => void,
): Handler {
	let h: Handler | undefined;
	mod.makeFleetGuard({ guard, timeoutMs, log: log ?? (() => {}), arm })({
		on: (n, fn) => {
			if (n === "tool_call") h = fn;
		},
	});
	if (!h) throw new Error("no tool_call handler registered");
	return h;
}

const deny = fakeGuard(
	"deny",
	'echo "bash-guard: refused (ssh-infra-only): ssh is Nagatha\'s alone." >&2\nexit 2',
);
const allow = fakeGuard("allow", "exit 0");
const other = fakeGuard("other", 'echo "Traceback" >&2\nexit 1');
const hang = fakeGuard("hang", "sleep 10\nexit 0");

describe("verdicts", () => {
	test("exit 2 blocks, and the guard's line is the reason", async () => {
		const out = await handler(deny.path)({
			toolName: "bash",
			input: { command: "ssh host01 true" },
		});
		expect(out).toEqual({
			block: true,
			reason: "bash-guard: refused (ssh-infra-only): ssh is Nagatha's alone.",
		});
	});

	test("exit 0 allows", async () => {
		expect(
			await handler(allow.path)({ toolName: "bash", input: { command: "ls" } }),
		).toBeUndefined();
	});

	test("spawn failure blocks (fails closed)", async () => {
		const out = await handler(join(dir, "no-such-guard"))({
			toolName: "bash",
			input: { command: "ls" },
		});
		expect(out).toEqual({ block: true, reason: mod.UNAVAILABLE });
	});

	test("timeout blocks (fails closed)", async () => {
		const t0 = Date.now();
		const out = await handler(hang.path, 300)({ toolName: "bash", input: { command: "ls" } });
		expect(out).toEqual({ block: true, reason: mod.UNAVAILABLE });
		expect(Date.now() - t0).toBeLessThan(5000);
	});

	test("any other exit blocks (fails closed)", async () => {
		const out = await handler(other.path)({ toolName: "bash", input: { command: "ls" } });
		expect(out).toEqual({ block: true, reason: mod.UNAVAILABLE });
	});
});

describe("one stderr line per block", () => {
	async function asSeat<T>(seat: string, fn: () => Promise<T>): Promise<T> {
		const prev = process.env.FLEET_EMPLOYEE;
		process.env.FLEET_EMPLOYEE = seat;
		try {
			return await fn();
		} finally {
			if (prev === undefined) delete process.env.FLEET_EMPLOYEE;
			else process.env.FLEET_EMPLOYEE = prev;
		}
	}
	const leaky = fakeGuard("leaky", 'echo "blocked: rm -rf /secret-token-abc" >&2\nexit 2');

	test("a guard refusal: seat, rule=guard and the tool only, never the reason or command", async () => {
		const lines: string[] = [];
		const out = await asSeat("bishop", () =>
			handler(leaky.path, undefined, (l) => lines.push(l))({
				toolName: "bash",
				input: { command: "rm -rf /secret-token-abc" },
			}),
		);
		expect(out).toEqual({ block: true, reason: "blocked: rm -rf /secret-token-abc" });
		expect(lines).toEqual(["fleet-guard: block seat=bishop rule=guard tool=bash"]);
		expect(lines.join("\n")).not.toContain("secret-token-abc");
		expect(lines.join("\n")).not.toContain("rm -rf");
	});

	test("guard unavailable (exit 1, timeout): rule=unavailable", async () => {
		const lines: string[] = [];
		// The test owns the timeout clock: the guard arms it once started, the test fires it.
		const armed: { fire: () => void; ms: number }[] = [];
		const arm = (fire: () => void, ms: number) => {
			armed.push({ fire, ms });
			return () => {};
		};
		await asSeat("bishop", async () => {
			await handler(other.path, undefined, (l) => lines.push(l))({
				toolName: "bash",
				input: { command: "ls" },
			});
			const pending = handler(
				hang.path,
				300,
				(l) => lines.push(l),
				arm,
			)({
				toolName: "write",
				input: { path: "/x/a.md" },
			});
			expect(armed.map((a) => a.ms)).toEqual([300]);
			armed[0]?.fire();
			expect(await pending).toEqual({ block: true, reason: mod.UNAVAILABLE });
		});
		expect(lines).toEqual([
			"fleet-guard: block seat=bishop rule=unavailable tool=bash",
			"fleet-guard: block seat=bishop rule=unavailable tool=write",
		]);
	});

	test("a path Pi cannot read: rule=bad-path, and the path is not printed", async () => {
		const lines: string[] = [];
		const out = await asSeat("bishop", () =>
			handler(allow.path, undefined, (l) => lines.push(l))({
				toolName: "read",
				input: { path: "file://evil-host/secret-token-abc" },
			}),
		);
		expect(out).toEqual({ block: true, reason: mod.UNAVAILABLE });
		expect(lines).toEqual(["fleet-guard: block seat=bishop rule=bad-path tool=read"]);
	});

	test("an allow and an unjudged tool print nothing; no seat prints unknown", async () => {
		const lines: string[] = [];
		const log = (l: string) => lines.push(l);
		await handler(allow.path, undefined, log)({ toolName: "bash", input: { command: "ls" } });
		await handler(deny.path, undefined, log)({ toolName: "todo", input: {} });
		expect(lines).toEqual([]);
		const prev = process.env.FLEET_EMPLOYEE;
		delete process.env.FLEET_EMPLOYEE;
		try {
			await handler(deny.path, undefined, log)({ toolName: "bash", input: { command: "ls" } });
		} finally {
			if (prev !== undefined) process.env.FLEET_EMPLOYEE = prev;
		}
		expect(lines).toEqual(["fleet-guard: block seat=unknown rule=guard tool=bash"]);
	});
});

describe("mapping to the Claude PreToolUse shape", () => {
	const seenJson = () => JSON.parse(allow.seen().split("\n")[0] ?? "{}");

	test("bash -> Bash {command}, with FLEET_EMPLOYEE passed through", async () => {
		const prev = process.env.FLEET_EMPLOYEE;
		process.env.FLEET_EMPLOYEE = "reviewer";
		try {
			await handler(allow.path)({ toolName: "bash", input: { command: "ls -la" } });
		} finally {
			if (prev === undefined) delete process.env.FLEET_EMPLOYEE;
			else process.env.FLEET_EMPLOYEE = prev;
		}
		expect(seenJson()).toEqual({ tool_name: "Bash", tool_input: { command: "ls -la" } });
		expect(allow.seen()).toContain("emp=reviewer");
	});

	for (const [pi, claude] of [
		["write", "Write"],
		["edit", "Edit"],
		["read", "Read"],
	] as const) {
		test(`${pi} -> ${claude} {file_path}`, async () => {
			await handler(allow.path)({
				toolName: pi,
				input: { path: "/home/operator/fleet-work/x/a.md" },
			});
			expect(seenJson()).toEqual({
				tool_name: claude,
				tool_input: { file_path: "/home/operator/fleet-work/x/a.md" },
			});
		});
	}

	test("a relative path is resolved against the session cwd", async () => {
		await handler(allow.path)(
			{ toolName: "write", input: { path: "notes/a.md" } },
			{ cwd: "/home/operator/fleet-work/p" },
		);
		expect(seenJson().tool_input.file_path).toBe("/home/operator/fleet-work/p/notes/a.md");
	});

	test("other tools are allowed without running the guard", async () => {
		expect(await handler(deny.path)({ toolName: "todo", input: { pattern: "x" } })).toBeUndefined();
	});
});

describe("end to end with the real bash-guard", () => {
	test("a non-infra employee is refused ssh by rule name; ls is allowed", async () => {
		const prev = process.env.FLEET_EMPLOYEE;
		const prevHome = process.env.HOME;
		process.env.FLEET_EMPLOYEE = "reviewer";
		process.env.HOME = "/home/operator";
		try {
			const h = handler(REAL_GUARD);
			const out = await h({ toolName: "bash", input: { command: "ssh host01 true" } });
			expect(out?.block).toBe(true);
			expect(out?.reason).toContain("bash-guard: refused (ssh-infra-only)");
			expect(
				await h({ toolName: "bash", input: { command: "ls /home/operator/fleet-work" } }),
			).toBeUndefined();
			const write = await h({ toolName: "write", input: { path: "/home/operator/.ssh/config" } });
			expect(write?.reason).toContain("ssh-infra-only");
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			if (prev === undefined) delete process.env.FLEET_EMPLOYEE;
			else process.env.FLEET_EMPLOYEE = prev;
		}
	});
});

describe("where the guard is found", () => {
	const absent = (name: string) => join(dir, "absent", name);
	const ran = (guard: { path: string }) => existsSync(`${guard.path}.log`);
	const ls = { toolName: "bash", input: { command: "ls" } };

	/** The handler Pi gets when no guard path is handed in, under one FLEET_GUARD and one set of candidate paths. */
	function resolved(
		env: string | undefined,
		paths: { system: string; home: string },
		log: (line: string) => void = () => {},
	): Handler {
		const prevEnv = process.env.FLEET_GUARD;
		const prevPaths = { ...mod.GUARD_PATHS };
		if (env === undefined) delete process.env.FLEET_GUARD;
		else process.env.FLEET_GUARD = env;
		Object.assign(mod.GUARD_PATHS, paths);
		try {
			let h: Handler | undefined;
			mod.makeFleetGuard({ log })({
				on: (n, fn) => {
					if (n === "tool_call") h = fn;
				},
			});
			if (!h) throw new Error("no tool_call handler registered");
			return h;
		} finally {
			Object.assign(mod.GUARD_PATHS, prevPaths);
			if (prevEnv === undefined) delete process.env.FLEET_GUARD;
			else process.env.FLEET_GUARD = prevEnv;
		}
	}

	test("FLEET_GUARD names the guard that runs, even when the home guard exists", async () => {
		const named = fakeGuard("env-named", "exit 0");
		const home = fakeGuard("env-home", "exit 0");
		const h = resolved(named.path, { system: absent("system"), home: home.path });
		expect(await h(ls)).toBeUndefined();
		expect(JSON.parse(named.seen().split("\n")[0] ?? "{}")).toEqual({
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(ran(home)).toBe(false);
	});

	test("FLEET_GUARD set to a missing path blocks every judged tool and names the path", async () => {
		const home = fakeGuard("missing-home", "exit 0");
		const missing = absent("named-guard");
		const h = resolved(missing, { system: absent("system"), home: home.path });
		for (const event of [
			ls,
			{ toolName: "write", input: { path: "/home/operator/fleet-work/x/a.md" } },
			{ toolName: "edit", input: { path: "/home/operator/fleet-work/x/a.md" } },
			{ toolName: "read", input: { path: "/home/operator/fleet-work/x/a.md" } },
		]) {
			const out = await h(event);
			expect(out?.block).toBe(true);
			expect(out?.reason).toStartWith(mod.UNAVAILABLE);
			expect(out?.reason).toContain(missing);
		}
		expect(ran(home)).toBe(false);
	});

	test("an empty FLEET_GUARD counts as unset", async () => {
		const home = fakeGuard("empty-home", "exit 0");
		const h = resolved("", { system: absent("system"), home: home.path });
		expect(await h(ls)).toBeUndefined();
		expect(ran(home)).toBe(true);
	});

	test("the root-owned path wins over the home path", async () => {
		const system = fakeGuard("order-system", "exit 0");
		const home = fakeGuard("order-home", "exit 0");
		const h = resolved(undefined, { system: system.path, home: home.path });
		expect(await h(ls)).toBeUndefined();
		expect(ran(system)).toBe(true);
		expect(ran(home)).toBe(false);
	});

	test("with neither FLEET_GUARD nor the root-owned guard, the home guard runs", async () => {
		const home = fakeGuard("fallback-home", "exit 0");
		const h = resolved(undefined, { system: absent("system"), home: home.path });
		expect(await h(ls)).toBeUndefined();
		expect(ran(home)).toBe(true);
	});

	test("no guard anywhere blocks, and the message lists the paths tried", async () => {
		const paths = { system: absent("system"), home: absent("home") };
		const lines: string[] = [];
		const prevEmp = process.env.FLEET_EMPLOYEE;
		process.env.FLEET_EMPLOYEE = "bishop";
		let out: Verdict;
		try {
			out = await resolved(undefined, paths, (l) => lines.push(l))(ls);
		} finally {
			if (prevEmp === undefined) delete process.env.FLEET_EMPLOYEE;
			else process.env.FLEET_EMPLOYEE = prevEmp;
		}
		expect(out?.block).toBe(true);
		expect(out?.reason).toStartWith(mod.UNAVAILABLE);
		expect(out?.reason).toContain(paths.system);
		expect(out?.reason).toContain(paths.home);
		// the stderr line carries the rule, never the paths tried
		expect(lines).toEqual(["fleet-guard: block seat=bishop rule=no-guard tool=bash"]);
	});
});

describe("review round 1 (PR 1461)", () => {
	async function asReviewer(fn: (h: Handler) => Promise<void>) {
		const prev = { emp: process.env.FLEET_EMPLOYEE, home: process.env.HOME };
		process.env.FLEET_EMPLOYEE = "reviewer";
		process.env.HOME = "/home/operator";
		try {
			await fn(handler(REAL_GUARD));
		} finally {
			for (const [k, v] of [
				["FLEET_EMPLOYEE", prev.emp],
				["HOME", prev.home],
			] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}
	const ctx = { cwd: "/home/operator/fleet-work/p" };

	for (const [tool, path] of [
		["write", "@~/.claude/settings.json"],
		["edit", "@~/.pi/agent/extensions/fleet-guard/index.ts"],
		["read", "@~/.ssh/id_ed25519"],
		["read", "@/home/operator/.ssh/id_ed25519"],
		["read", "file:///home/operator/.ssh/id_ed25519"],
		["read", "../../.ssh/id_ed25519"],
	] as const) {
		test(`P1: ${tool} ${path} is blocked`, () =>
			asReviewer(async (h) => {
				expect((await h({ toolName: tool, input: { path } }, ctx))?.block).toBe(true);
			}));
	}

	for (const tool of ["grep", "find", "ls"]) {
		test(`P2: ${tool} into ~/.ssh is blocked; into the work dir is allowed`, () =>
			asReviewer(async (h) => {
				const out = await h({ toolName: tool, input: { pattern: ".", path: "~/.ssh" } }, ctx);
				expect(out?.reason).toContain("ssh-infra-only");
				expect(await h({ toolName: tool, input: { pattern: "." } }, ctx)).toBeUndefined();
			}));
	}

	test("P2: bash is judged from the session cwd", () =>
		asReviewer(async (h) => {
			const out = await h(
				{ toolName: "bash", input: { command: "cat id_ed25519" } },
				{ cwd: "/home/operator/.ssh" },
			);
			expect(out?.reason).toContain("ssh-infra-only");
		}));
});

describe("pr-review P1 (PR 1461): the guard checks the path Pi opens", () => {
	// Pi's resolveToCwd expands only `~`/`~/`; `$HOME` is a literal directory name.
	const target = "$HOME/../.codex/hooks.json";
	const ctx = { cwd: "/home/operator" };

	async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
		const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
		Object.assign(process.env, env);
		try {
			await fn();
		} finally {
			for (const [k, v] of Object.entries(prev)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}

	test("$HOME/../.codex/hooks.json from /home/operator is /home/operator/.codex/hooks.json", () =>
		withEnv({ HOME: "/home/operator" }, async () => {
			await handler(allow.path)({ toolName: "write", input: { path: target } }, ctx);
			const call = JSON.parse(allow.seen().split("\n")[0] ?? "");
			expect(call.tool_input.file_path).toBe("/home/operator/.codex/hooks.json");
		}));

	test("a protected target reached that way is refused by the real guard", () =>
		withEnv({ HOME: "/home/operator", FLEET_EMPLOYEE: "reviewer" }, async () => {
			const out = await handler(REAL_GUARD)({ toolName: "write", input: { path: target } }, ctx);
			expect(out?.block).toBe(true);
			expect(out?.reason).not.toBe(mod.UNAVAILABLE);
		}));
});
