/**
 * The installed pre-push hook after the runner-box receipt retired (
 * L-114): git-read refusals only, no candidate code, no receipt, no runner,
 * no test run. `bun` is a recording fake on PATH so each test proves the hook
 * never executed it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const REPO_ROOT = (() => {
	const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe" });
	return proc.stdout.toString().trim();
})();
const REVIEWED_HOOK = join(REPO_ROOT, "_githooks", "pre-push");
const REMOTE_URL = "https://forge.example.internal/rodaddy/software-factory.git";
const ZERO = "0".repeat(40);

const tmpBase = testTmpBase();
const archive = testArchiveDir();
const created: string[] = [];

afterAll(() => {
	for (const dir of created.splice(0)) {
		renameSync(dir, join(archive, `${basename(dir)}-${Date.now()}`));
	}
});

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
	return proc.stdout.toString().trim();
}

interface Fixture {
	dir: string;
	head: string;
	hook: string;
	fakeBin: string;
	calls: string;
}

/** A fresh repo with the reviewed hook installed and a recording fake `bun`. */
function makeRepo(): Fixture {
	const dir = mkdtempSync(join(tmpBase, "rw-hook-repo-"));
	created.push(dir);
	git(dir, ["init", "-q"]);
	writeFileSync(join(dir, "file.txt"), "content\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "initial"]);
	let commonDir = git(dir, ["rev-parse", "--git-common-dir"]);
	if (!commonDir.startsWith("/")) commonDir = join(dir, commonDir);
	const hook = join(commonDir, "hooks", "pre-push");
	mkdirSync(dirname(hook), { recursive: true });
	writeFileSync(hook, readFileSync(REVIEWED_HOOK));
	chmodSync(hook, 0o755);
	const fakeBin = join(commonDir, "fake-bin");
	mkdirSync(fakeBin, { recursive: true });
	const calls = join(commonDir, "bun-calls.log");
	writeFileSync(
		join(fakeBin, "bun"),
		`#!/bin/sh\necho "$*" >> "${calls}"\n[ "$*" = "run \${FAIL_STEP:-none}" ] && exit 1\nexit 0\n`,
	);
	chmodSync(join(fakeBin, "bun"), 0o755);
	return { dir, head: git(dir, ["rev-parse", "HEAD"]), hook, fakeBin, calls };
}

function runHook(f: Fixture, stdin: string, env: Record<string, string> = {}) {
	const childEnv = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, ...env } as Record<
		string,
		string
	>;
	delete childEnv.RODADDY_WATCHER_PREPUSH_ACTIVE;
	writeFileSync(f.calls, "");
	return Bun.spawnSync([f.hook, "origin", REMOTE_URL], {
		cwd: f.dir,
		env: childEnv,
		stdin: Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("pre-push hook without the runner-box receipt", () => {
	let f: Fixture;
	beforeAll(() => {
		f = makeRepo();
	});

	test("refuses a ref deletion before any check runs", () => {
		const result = runHook(f, `(delete) ${ZERO} refs/heads/stale ${f.head}\n`);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("ref deletion is not authorized");
		expect(readFileSync(f.calls, "utf8")).toBe("");
	});

	test("passes a clean exact-HEAD push without running bun, a receipt or a runner", () => {
		const result = runHook(f, `refs/heads/main ${f.head} refs/heads/main ${ZERO}\n`);
		expect(result.stderr.toString()).not.toContain("blocked");
		expect(result.exitCode).toBe(0);
		expect(readFileSync(f.calls, "utf8")).toBe("");
	});
});

describe("pre-push hook refuses retry-named new branches", () => {
	let f: Fixture;
	beforeAll(() => {
		f = makeRepo();
		const origin = join(f.dir, "..", `${basename(f.dir)}-origin.git`);
		created.push(origin);
		git(f.dir, ["init", "-q", "--bare", origin]);
		git(f.dir, ["remote", "add", "origin", origin]);
		git(f.dir, [
			"push",
			"-q",
			"--no-verify",
			"origin",
			"HEAD:refs/heads/feat/x",
			"HEAD:refs/heads/fix/y",
		]);
	});

	test("refuses a new -v2 branch and names its stem", () => {
		const result = runHook(f, `refs/heads/feat/x-v2 ${f.head} refs/heads/feat/x-v2 ${ZERO}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("new branch 'feat/x-v2' is a retry of 'feat/x'");
	});

	test("refuses a stacked -v2-v2 branch and strips every suffix from the stem", () => {
		const result = runHook(
			f,
			`refs/heads/feat/x-v2-v2 ${f.head} refs/heads/feat/x-v2-v2 ${ZERO}\n`,
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("new branch 'feat/x-v2-v2' is a retry of 'feat/x'");
	});

	test("refuses a new -recut branch", () => {
		const result = runHook(f, `refs/heads/fix/y-recut ${f.head} refs/heads/fix/y-recut ${ZERO}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("new branch 'fix/y-recut' is a retry of 'fix/y'");
	});

	test("does not refuse a new branch without a retry suffix", () => {
		const result = runHook(f, `refs/heads/feat/x ${f.head} refs/heads/feat/x ${ZERO}\n`);
		expect(result.stderr.toString()).not.toContain("is a retry of");
	});

	test("does not refuse an update to an existing retry-named branch", () => {
		const result = runHook(
			f,
			`refs/heads/feat/x-v2 ${f.head} refs/heads/feat/x-v2 ${"1".repeat(40)}\n`,
		);
		expect(result.stderr.toString()).not.toContain("is a retry of");
	});

	test("does not refuse a retry-named branch whose stem is not on the remote", () => {
		const result = runHook(f, `refs/heads/feat/api-v2 ${f.head} refs/heads/feat/api-v2 ${ZERO}\n`);
		expect(result.stderr.toString()).not.toContain("is a retry of");
	});

	test("refuses an upper-case retry suffix case-insensitively", () => {
		const result = runHook(f, `refs/heads/feat/x-V2 ${f.head} refs/heads/feat/x-V2 ${ZERO}\n`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("new branch 'feat/x-V2' is a retry of 'feat/x'");
	});
});
