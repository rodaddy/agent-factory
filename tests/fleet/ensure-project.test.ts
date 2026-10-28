/**
 * @module tests/fleet/ensure-project
 * @description `fleet/bin/ensure-project`, which makes a repo a board
 *   project the first time the company works on it, run as a real child process
 *   against a fake Forge, a fake `paperclipai`, and a fake `git`.
 *   `ENSURE_PROJECT_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { until } from "../support/wait-until";

const SCRIPT =
	process.env.ENSURE_PROJECT_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/bin/ensure-project");

/** Fake board CLI: state in `<home>/board.json`, every argv in `<home>/calls.jsonl`. */
const PAPERCLIPAI = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const home = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
appendFileSync(join(home, "calls.jsonl"), JSON.stringify(argv) + "\n");
const boardPath = join(home, "board.json");
const board = JSON.parse(readFileSync(boardPath, "utf8"));
const opt = (name) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const verb = argv[0] + " " + argv[1];

if (verb === "company list") reply(board.companies);
else if (verb === "agent list") reply(board.agents);
else if (verb === "project list") reply(board.projects);
else if (verb === "project update") {
	const project = board.projects.find((p) => p.id === argv[2]);
	project.executionWorkspacePolicy = JSON.parse(opt("--execution-workspace-policy-json"));
	writeFileSync(boardPath, JSON.stringify(board));
	reply(project);
}
else if (verb === "project create") {
	const project = { id: "proj-" + (board.projects.length + 1), name: opt("--name") };
	board.projects.push(project);
	writeFileSync(boardPath, JSON.stringify(board));
	reply(project);
} else if (verb === "project-workspace list") {
	reply(board.workspaces.filter((w) => w.projectId === argv[2]).map((w) => w.payload));
} else if (verb === "project-workspace create") {
	const workspace = { projectId: argv[2], payload: JSON.parse(opt("--payload-json")) };
	board.workspaces.push(workspace);
	writeFileSync(boardPath, JSON.stringify(board));
	reply(workspace);
} else {
	process.stderr.write("fake paperclipai: unknown verb " + verb + "\n");
	process.exit(64);
}
`;

/** The policy every repo project carries, here for repo o/r. */
const POLICY = {
	enabled: true,
	defaultMode: "isolated_workspace",
	allowIssueOverride: true,
	workspaceStrategy: {
		type: "git_worktree",
		branchTemplate: "{{issue.identifier}}-{{slug}}",
		worktreeParentDir: "/home/operator/fleet-work/.worktrees/o/r",
	},
};

/**
 * Fake git: `clone <url> <dir>` makes `<dir>/.git`; a `failclone` url exits 1.
 * With FAKE_GIT_HOLD=<path> a clone writes `<path>.started` and does not
 * finish until `<path>` exists: a holder the test keeps inside the lock.
 */
const GIT = String.raw`
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const home = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
appendFileSync(join(home, "git.jsonl"), JSON.stringify(argv) + "\n");
if (argv[0] !== "clone" || argv[1].includes("failclone")) process.exit(1);
const hold = process.env.FAKE_GIT_HOLD;
if (hold) {
	writeFileSync(hold + ".started", String(process.pid));
	const tick = new Int32Array(new SharedArrayBuffer(4));
	while (!existsSync(hold)) Atomics.wait(tick, 0, 0, 20);
}
mkdirSync(join(argv[2], ".git"), { recursive: true });
`;

interface Board {
	companies: { id: string; name: string }[];
	agents: { id: string; name: string }[];
	projects: { id: string; name: string; executionWorkspacePolicy?: unknown }[];
	workspaces: { projectId: string; payload: Record<string, unknown> }[];
}

interface Seen {
	path: string;
	authorization: string | null;
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let api = "";
let root = "";
let homes = 0;

/** Whether `port` can be bound on loopback right now. */
function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

/** First free port in 7100-7119. */
async function freePort(): Promise<number> {
	for (let port = 7100; port <= 7119; port++) {
		if (await isFree(port)) return port;
	}
	throw new Error("no free port in 7100-7119");
}

/** A fresh home: the two fakes on `bin/`, an empty board, no checkout. */
function makeHome(projects: Board["projects"] = [], workspaces: Board["workspaces"] = []): string {
	homes += 1;
	const home = join(root, `home-${homes}`);
	mkdirSync(join(home, "bin"), { recursive: true });
	for (const [name, source] of [
		["paperclipai", PAPERCLIPAI],
		["git", GIT],
	] as const) {
		const script = join(home, "bin", `${name}.mjs`);
		writeFileSync(script, source);
		const bin = join(home, "bin", name);
		writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
		chmodSync(bin, 0o755);
	}
	const board: Board = {
		companies: [
			{ id: "co-0", name: "Other" },
			{ id: "co-1", name: "Software Factory" },
		],
		agents: [
			{ id: "agent-3", name: "Builder" },
			{ id: "agent-7", name: "Triage" },
		],
		projects,
		workspaces,
	};
	writeFileSync(join(home, "board.json"), JSON.stringify(board));
	return home;
}

function writeOverrides(home: string, overrides: unknown): void {
	writeFileSync(join(home, "projects.json"), JSON.stringify(overrides));
}

function jsonl(path: string): string[][] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** Board invocations whose first two words are `verb`, e.g. `project create`. */
function calls(home: string, verb: string): string[][] {
	return jsonl(join(home, "calls.jsonl")).filter((argv) => `${argv[0]} ${argv[1]}` === verb);
}

function clones(home: string): string[][] {
	return jsonl(join(home, "git.jsonl"));
}

function board(home: string): Board {
	return JSON.parse(readFileSync(join(home, "board.json"), "utf8"));
}

function flag(argv: string[] | undefined, name: string): string | undefined {
	const at = argv?.indexOf(name) ?? -1;
	return at < 0 ? undefined : argv?.[at + 1];
}

/**
 * Start the script as a child in its own process group, as a harness runs it.
 * `stderr()` is what it has written so far; `done` is its full result.
 */
function start(
	home: string,
	args: string[],
	overrides: Record<string, string | undefined> = {},
	script: string = SCRIPT,
) {
	const base: Record<string, string | undefined> = {
		// The fakes first; then the real PATH, because jq and curl are not in
		// /usr/bin on every machine that runs this.
		PATH: `${join(home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		HOME: home,
		FORGEJO_API_URL: api,
		FORGEJO_TOKEN: "t-1",
		FLEET_SRC_DIR: join(home, "src"),
		FLEET_PROJECTS_FILE: join(home, "projects.json"),
		...overrides,
	};
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) env[key] = value;
	}
	// The bash on PATH: Homebrew's on the Mac, the system one on the fleet box
	// and in CI. Apple's /bin/bash 3.2 is not a supported runtime here.
	const child = Bun.spawn([Bun.which("bash") ?? "/bin/bash", script, ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
	});
	let stderr = "";
	const decoder = new TextDecoder();
	const readErr = (async () => {
		for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
	})();
	const done = Promise.all([new Response(child.stdout).text(), readErr, child.exited]).then(
		([stdout, , code]) => ({ stdout, stderr, code }),
	);
	return { pid: child.pid, stderr: () => stderr, done };
}

function run(
	home: string,
	args: string[],
	overrides: Record<string, string | undefined> = {},
	script: string = SCRIPT,
) {
	return start(home, args, overrides, script).done;
}

let shared = "";

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ensure-project-"));
	shared = makeHome();
	server = Bun.serve({
		port: await freePort(),
		hostname: "127.0.0.1",
		fetch(request) {
			const path = new URL(request.url).pathname;
			seen.push({ path, authorization: request.headers.get("authorization") });
			if (path === "/repos/o/r") {
				return Response.json({ clone_url: "http://fake/o/r.git", default_branch: "main" });
			}
			return Response.json({ message: "not found" }, { status: 404 });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
});

describe("ensure-project", () => {
	test("the first call clones the repo and creates the project and its workspace", async () => {
		const result = await run(shared, ["o/r"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("project=proj-1 repo=o/r state=created\n");
		const checkout = join(shared, "src", "o", "r");
		expect(clones(shared)).toEqual([["clone", "http://fake/o/r.git", checkout]]);
		const creates = calls(shared, "project create");
		expect(creates).toHaveLength(1);
		expect(flag(creates[0], "--name")).toBe("o/r");
		expect(flag(creates[0], "-C")).toBe("co-1");
		expect(flag(creates[0], "--description")).toBe("Forge repo o/r");
		expect(creates[0]).not.toContain("--lead-agent-id");
		expect(calls(shared, "project-workspace create")).toHaveLength(1);
		expect(board(shared).workspaces).toEqual([
			{
				projectId: "proj-1",
				payload: {
					name: "r",
					sourceType: "git_repo",
					cwd: checkout,
					repoUrl: "http://fake/o/r.git",
					defaultRef: "main",
					isPrimary: true,
				},
			},
		]);
		expect(seen).toEqual([{ path: "/repos/o/r", authorization: "token t-1" }]);
	});

	test("the second call changes nothing and reports the same project", async () => {
		const result = await run(shared, ["o/r"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("project=proj-1 repo=o/r state=unchanged\n");
		expect(clones(shared)).toHaveLength(1);
		expect(calls(shared, "project create")).toHaveLength(1);
		expect(calls(shared, "project-workspace create")).toHaveLength(1);
	});

	test("a repo Forge will not show is exit 1 and nothing is cloned or created", async () => {
		const home = makeHome();
		const result = await run(home, ["o/secret"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("cannot read o/secret on Forge (HTTP 404)");
		expect(result.stdout).toBe("");
		expect(clones(home)).toHaveLength(0);
		expect(calls(home, "project create")).toHaveLength(0);
		expect(calls(home, "project-workspace create")).toHaveLength(0);
	});

	test("a bad argument is exit 2 and Forge is never asked", async () => {
		const home = makeHome();
		const result = await run(home, ["o/r;x"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("usage: ensure-project [--no-worktrees] <owner/repo>");
		expect(seen).toHaveLength(0);
		expect(clones(home)).toHaveLength(0);
	});

	test("overrides set the ref, the setup command, and the lead", async () => {
		const home = makeHome();
		writeOverrides(home, {
			"o/r": { defaultRef: "develop", setupCommand: "bun install", lead: "Triage" },
		});
		const result = await run(home, ["o/r"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("project=proj-1 repo=o/r state=created\n");
		const payload = board(home).workspaces[0]?.payload;
		expect(payload?.defaultRef).toBe("develop");
		expect(payload?.setupCommand).toBe("bun install");
		const creates = calls(home, "project create");
		expect(creates).toHaveLength(1);
		expect(flag(creates[0], "--lead-agent-id")).toBe("agent-7");
	});

	test("an unknown lead is exit 3 before anything is cloned or created", async () => {
		const home = makeHome();
		writeOverrides(home, { "o/r": { lead: "Nobody" } });
		const result = await run(home, ["o/r"]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("Nobody");
		expect(clones(home)).toHaveLength(0);
		expect(calls(home, "project create")).toHaveLength(0);
		expect(calls(home, "project-workspace create")).toHaveLength(0);
	});

	test("an existing project left without a primary workspace is repaired", async () => {
		const home = makeHome([{ id: "proj-9", name: "o/r" }]);
		const result = await run(home, ["o/r"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("project=proj-9 repo=o/r state=repaired\n");
		expect(calls(home, "project create")).toHaveLength(0);
		expect(calls(home, "project-workspace create")).toHaveLength(1);
		expect(board(home).workspaces[0]?.payload).toMatchObject({
			isPrimary: true,
			defaultRef: "main",
		});
		// A second call finds the workspace and changes nothing.
		const again = await run(home, ["o/r"]);
		expect(again.stdout).toBe("project=proj-9 repo=o/r state=unchanged\n");
		expect(calls(home, "project-workspace create")).toHaveLength(1);
	});

	test("an existing project with a missing checkout is cloned and left unchanged", async () => {
		const home = makeHome(
			[{ id: "proj-9", name: "o/r" }],
			[{ projectId: "proj-9", payload: { isPrimary: true } }],
		);
		const result = await run(home, ["o/r"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("project=proj-9 repo=o/r state=unchanged\n");
		expect(clones(home)).toEqual([["clone", "http://fake/o/r.git", join(home, "src", "o", "r")]]);
		expect(calls(home, "project create")).toHaveLength(0);
		expect(calls(home, "project-workspace create")).toHaveLength(0);
	});

	test("run through an installed symlink, it still finds its overrides file", async () => {
		const home = makeHome();
		// The layout install.sh makes: the script and its board/ beside it, and a
		// link to the script somewhere else on PATH.
		mkdirSync(join(home, "install/fleet/bin"), { recursive: true });
		mkdirSync(join(home, "install/fleet/board"), { recursive: true });
		mkdirSync(join(home, "link"), { recursive: true });
		const installed = join(home, "install/fleet/bin/ensure-project");
		copyFileSync(SCRIPT, installed);
		writeFileSync(
			join(home, "install/fleet/board/projects.json"),
			JSON.stringify({ "o/r": { defaultRef: "develop" } }),
		);
		const link = join(home, "link/ensure-project");
		symlinkSync(installed, link);
		const result = await run(home, ["o/r"], { FLEET_PROJECTS_FILE: undefined }, link);
		expect(result.code).toBe(0);
		expect(board(home).workspaces[0]?.payload).toMatchObject({ defaultRef: "develop" });
	});

	test("two callers at once for a new repo create one project", async () => {
		const home = makeHome();
		const [a, b] = await Promise.all([run(home, ["o/r"]), run(home, ["o/r"])]);
		expect(a.code).toBe(0);
		expect(b.code).toBe(0);
		expect(calls(home, "project create")).toHaveLength(1);
		expect(calls(home, "project-workspace create")).toHaveLength(1);
		expect([a.stdout, b.stdout].sort()).toEqual([
			"project=proj-1 repo=o/r state=created\n",
			"project=proj-1 repo=o/r state=unchanged\n",
		]);
	});

	/** The lock file a call takes for repo o/r in `home`. */
	function lockFile(home: string): string {
		return join(home, "src", "o", ".r.ensure-project.flock");
	}

	/** A clone that stays inside the lock until `release()`. */
	function heldClone(home: string) {
		const hold = join(home, "hold");
		return {
			env: { FAKE_GIT_HOLD: hold },
			started: () => existsSync(`${hold}.started`),
			release: () => writeFileSync(hold, ""),
		};
	}

	test("a caller killed inside the lock does not block the next call (SOF-10932)", async () => {
		const home = makeHome();
		const clone = heldClone(home);
		const killed = start(home, ["o/r"], clone.env);
		await until(clone.started, 10_000, "first caller inside the lock");
		// What a harness timeout does: SIGKILL the whole group, so no EXIT trap runs.
		process.kill(-killed.pid, "SIGKILL");
		expect((await killed.done).code).toBe(137);
		// The killed clone may exit a moment after bash, so the next call may wait
		// briefly; with a 5 s wait a lock that outlived its holder is exit 1.
		const result = await run(home, ["o/r"], { ENSURE_PROJECT_LOCK_WAIT: "5" });
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("project=proj-1 repo=o/r state=created\n");
		expect(calls(home, "project create")).toHaveLength(1);
	}, 20_000);

	test("a live holder still serialises, and a waiter says what it waits on (SOF-10932)", async () => {
		const home = makeHome();
		const clone = heldClone(home);
		const holder = start(home, ["o/r"], clone.env);
		try {
			await until(clone.started, 10_000, "holder inside the lock");
			const waiter = start(home, ["o/r"]);
			await until(() => waiter.stderr().includes("waiting on lock"), 10_000, "waiter at the lock");
			expect(waiter.stderr()).toBe(
				`ensure-project: waiting on lock ${lockFile(home)} (holder pid ${holder.pid})\n`,
			);
			// The waiter is past its board reads and blocked: it has cloned and created nothing.
			expect(clones(home)).toHaveLength(1);
			expect(calls(home, "project list")).toHaveLength(0);
			// A caller whose wait runs out gives up with exit 1 and leaves the holder alone.
			const impatient = await run(home, ["o/r"], { ENSURE_PROJECT_LOCK_WAIT: "1" });
			expect(impatient.code).toBe(1);
			expect(impatient.stderr).toContain(
				`another call (pid ${holder.pid}) has held ${lockFile(home)} for 1 s`,
			);
			clone.release();
			const [first, second] = await Promise.all([holder.done, waiter.done]);
			expect(first.code).toBe(0);
			expect(first.stdout).toBe("project=proj-1 repo=o/r state=created\n");
			expect(second.code).toBe(0);
			expect(second.stdout).toBe("project=proj-1 repo=o/r state=unchanged\n");
			expect(clones(home)).toHaveLength(1);
			expect(calls(home, "project create")).toHaveLength(1);
		} finally {
			clone.release();
		}
	}, 20_000);

	test("a missing FORGEJO_TOKEN is exit 3 and Forge is never asked", async () => {
		const home = makeHome();
		const result = await run(home, ["o/r"], { FORGEJO_TOKEN: undefined });
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("FORGEJO_TOKEN");
		expect(seen).toHaveLength(0);
		expect(clones(home)).toHaveLength(0);
	});

	test("a new project gets the git-worktree execution policy, exactly once", async () => {
		const home = makeHome();
		const result = await run(home, ["o/r"]);
		expect(result.code).toBe(0);
		const updates = calls(home, "project update");
		expect(updates).toHaveLength(1);
		expect(updates[0]?.[2]).toBe("proj-1");
		expect(JSON.parse(flag(updates[0], "--execution-workspace-policy-json") ?? "")).toEqual(POLICY);
		// A second call finds the policy already set and does not write it again.
		const again = await run(home, ["o/r"]);
		expect(again.stdout).toBe("project=proj-1 repo=o/r state=unchanged\n");
		expect(calls(home, "project update")).toHaveLength(1);
	});

	test("an existing project without the policy gets it; --no-worktrees leaves it alone", async () => {
		const workspaces = [{ projectId: "proj-9", payload: { isPrimary: true } }];
		const home = makeHome([{ id: "proj-9", name: "o/r" }], workspaces);
		mkdirSync(join(home, "src", "o", "r", ".git"), { recursive: true });
		const skipped = await run(home, ["--no-worktrees", "o/r"]);
		expect(skipped.code).toBe(0);
		expect(skipped.stdout).toBe("project=proj-9 repo=o/r state=unchanged\n");
		expect(calls(home, "project update")).toHaveLength(0);
		const result = await run(home, ["o/r"]);
		expect(result.code).toBe(0);
		expect(board(home).projects[0]?.executionWorkspacePolicy).toEqual(POLICY);
	});

	test("the token never appears in argv", () => {
		const text = readFileSync(SCRIPT, "utf8");
		expect(text).not.toContain('-H "Authorization');
		expect(text).toContain('--config <(printf \'header = "Authorization: token %s"');
	});
});
