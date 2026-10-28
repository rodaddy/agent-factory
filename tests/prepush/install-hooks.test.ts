/**
 * @module tests/prepush/install-hooks
 * @description Exercises scripts/install-hooks.sh against REAL isolated Git
 *   repositories. It proves the reviewed hook is installed into the Git COMMON
 *   hooks directory (so it fires from linked worktrees), that any prior
 *   `core.hooksPath` pointing at the mutable checkout is cleared, and that no
 *   `core.hooksPath` remains after install. The script copies a self-contained
 *   hook and runs no candidate code, so these tests never build the checkout.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const REPO_ROOT = (() => {
	const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe" });
	return proc.stdout.toString().trim();
})();
const INSTALL_SCRIPT = join(REPO_ROOT, "scripts", "install-hooks.sh");
const REVIEWED_HOOK = join(REPO_ROOT, "_githooks", "pre-push");
const VERIFY_SPEC = join(REPO_ROOT, "specs", "software-factory.verify.sh");

const tmpBase = testTmpBase();
const archive = testArchiveDir();
const created: string[] = [];

afterAll(() => {
	for (const dir of created.splice(0)) {
		renameSync(dir, join(archive, `${basename(dir)}-${Date.now()}`));
	}
});

/**
 * Isolate every git invocation from the operator's real global/system config so
 * a global `core.hooksPath` on the developer's machine cannot leak into these
 * tests. Each case controls the global config explicitly where it needs to.
 */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		...extra,
	};
}

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: gitEnv(),
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
	}
	return proc.stdout.toString().trim();
}

/**
 * A fresh isolated repo whose `_githooks/pre-push`, `scripts/install-hooks.sh`,
 * and `specs/software-factory.verify.sh` are copies of the reviewed artifacts, so
 * the script installs from within a normal repo layout.
 */
function makeRepo(): { dir: string } {
	const dir = mkdtempSync(join(tmpBase, "rw-install-repo-"));
	created.push(dir);
	git(dir, ["init", "-q"]);
	git(dir, ["remote", "add", "origin", "git@github.com:rodaddy/software-factory.git"]);
	// Reproduce the paths the script reads.
	Bun.spawnSync(["mkdir", "-p", join(dir, "_githooks"), join(dir, "scripts"), join(dir, "specs")]);
	Bun.spawnSync(["cp", REVIEWED_HOOK, join(dir, "_githooks", "pre-push")]);
	Bun.spawnSync(["cp", INSTALL_SCRIPT, join(dir, "scripts", "install-hooks.sh")]);
	Bun.spawnSync(["cp", VERIFY_SPEC, join(dir, "specs", "software-factory.verify.sh")]);
	Bun.spawnSync(["chmod", "+x", join(dir, "scripts", "install-hooks.sh")]);
	git(dir, ["add", "."]);
	git(dir, ["commit", "-q", "-m", "initial"]);
	return { dir };
}

function runInstall(
	cwd: string,
	extraEnv: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync([join(cwd, "scripts", "install-hooks.sh")], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: gitEnv(extraEnv),
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

/** The LOCAL core.hooksPath value, or "" when unset in this repo. */
function localHooksPath(dir: string): { value: string; exitCode: number } {
	const proc = Bun.spawnSync(["git", "config", "--local", "--get", "core.hooksPath"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: gitEnv(),
	});
	return { value: proc.stdout.toString().trim(), exitCode: proc.exitCode ?? 1 };
}

function commonDir(dir: string): string {
	let common = git(dir, ["rev-parse", "--git-common-dir"]);
	if (!common.startsWith("/")) common = join(dir, common);
	return common;
}

/** The shared local config file every `git --local` write actually lands in. */
function commonConfig(dir: string): string {
	return join(commonDir(dir), "config");
}

/**
 * Assert the install FAILED CLOSED: nonzero exit, an install-hooks diagnostic on
 * stderr, and — critically — no success claim on stdout. A fail-closed installer
 * must never print the "Installed" or "Pinned" lines when it aborts.
 */
function expectFailClosed(result: { exitCode: number; stdout: string; stderr: string }): void {
	expect(result.exitCode).not.toBe(0);
	expect(result.stdout).not.toContain("Installed standalone pre-push hook");
	expect(result.stdout).not.toContain("Pinned local core.hooksPath");
}

describe("install-hooks.sh installs into the Git common dir", () => {
	test("installs the hook into <git-common-dir>/hooks/pre-push and makes it executable", () => {
		const { dir } = makeRepo();
		const result = runInstall(dir);
		expect(result.exitCode).toBe(0);

		const installed = join(commonDir(dir), "hooks", "pre-push");
		expect(existsSync(installed)).toBe(true);
		// Owner-executable bit set.
		expect(statSync(installed).mode & 0o100).toBe(0o100);
		expect(result.stdout).toContain(installed);
	});

	test("fails closed when the common hooks directory is a symlink", () => {
		const { dir } = makeRepo();
		const hooksDir = join(commonDir(dir), "hooks");
		const realHooksDir = join(commonDir(dir), "hooks.real");
		renameSync(hooksDir, realHooksDir);
		symlinkSync(realHooksDir, hooksDir);

		const result = runInstall(dir);
		expectFailClosed(result);
		expect(result.stderr).toContain("hooks directory is a symlink");
	});

	test("does not follow or overwrite a planted hook-install temp symlink", async () => {
		const { dir } = makeRepo();
		const hooksDir = join(commonDir(dir), "hooks");
		const decoy = join(hooksDir, "planted-target");
		const planted = join(hooksDir, ".pre-push.install.planted");
		writeFileSync(decoy, "do not overwrite\n");
		symlinkSync(decoy, planted);

		const result = runInstall(dir);
		expect(result.exitCode).toBe(0);
		expect(lstatSync(planted).isSymbolicLink()).toBe(true);
		expect(await Bun.file(decoy).text()).toBe("do not overwrite\n");
		expect(lstatSync(join(hooksDir, "pre-push")).isFile()).toBe(true);
	});

	test("atomically replaces an existing regular pre-push with the reviewed executable", async () => {
		const { dir } = makeRepo();
		const installed = join(commonDir(dir), "hooks", "pre-push");
		writeFileSync(installed, "#!/usr/bin/env bash\nexit 99\n");
		chmodSync(installed, 0o755);

		const result = runInstall(dir);
		expect(result.exitCode).toBe(0);
		expect(lstatSync(installed).isFile()).toBe(true);
		expect(lstatSync(installed).isSymbolicLink()).toBe(false);
		expect(statSync(installed).mode & 0o100).toBe(0o100);
		expect(await Bun.file(installed).text()).toBe(await Bun.file(REVIEWED_HOOK).text());
	});

	test("leaves NO core.hooksPath when none is configured (common-dir hooks used)", () => {
		const { dir } = makeRepo();
		runInstall(dir);
		// With no global/system core.hooksPath, git uses <git-common-dir>/hooks by
		// default, so no core.hooksPath must remain at any scope.
		const local = localHooksPath(dir);
		expect(local.value).toBe("");
		expect(local.exitCode).not.toBe(0);
	});

	test("clears a PRE-EXISTING local core.hooksPath pointing at the mutable checkout", () => {
		const { dir } = makeRepo();
		// Simulate a prior insecure install that pointed the hook path at the checkout.
		git(dir, ["config", "--local", "core.hooksPath", join(dir, "_githooks")]);
		expect(localHooksPath(dir).value).toContain("_githooks");

		runInstall(dir);
		// No global exists here, so the local override is cleared and none remains.
		const local = localHooksPath(dir);
		expect(local.value).toBe("");
		expect(local.exitCode).not.toBe(0);
	});

	test("neutralizes a GLOBAL core.hooksPath so the common-dir hook still fires", () => {
		const { dir } = makeRepo();
		// A global core.hooksPath would otherwise make git ignore <common-dir>/hooks
		// entirely, silently disabling the reviewed pre-push hook. Point a real global
		// config at an unrelated directory and prove install neutralizes it.
		const globalDir = mkdtempSync(join(tmpBase, "rw-install-glob-"));
		created.push(globalDir);
		const globalCfg = join(globalDir, "gitconfig");
		Bun.spawnSync(["git", "config", "--file", globalCfg, "core.hooksPath", "/tmp/somewhere-else"]);

		const result = runInstall(dir, { GIT_CONFIG_GLOBAL: globalCfg });
		expect(result.exitCode).toBe(0);

		// The install pins a LOCAL core.hooksPath to the common-dir hooks directory,
		// which is exactly where the reviewed hook was installed — so it runs, and the
		// global no longer diverts hook resolution for this repo.
		const installedDir = join(commonDir(dir), "hooks");
		const proc = Bun.spawnSync(["git", "config", "--local", "--get", "core.hooksPath"], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
			env: gitEnv({ GIT_CONFIG_GLOBAL: globalCfg }),
		});
		expect(proc.stdout.toString().trim()).toBe(installedDir);
		expect(existsSync(join(installedDir, "pre-push"))).toBe(true);
	});

	test("installs a hook shared by linked worktrees (common dir, not per-worktree)", () => {
		const { dir } = makeRepo();
		runInstall(dir);

		// Add a linked worktree; its git-common-dir is the MAIN repo's git dir, so the
		// installed common-dir hook is visible from the worktree too.
		const worktree = mkdtempSync(join(tmpBase, "rw-install-wt-"));
		created.push(worktree);
		git(dir, ["worktree", "add", "-q", worktree, "HEAD"]);

		const installedFromMain = join(commonDir(dir), "hooks", "pre-push");
		const installedFromWorktree = join(commonDir(worktree), "hooks", "pre-push");
		// Both resolve to the SAME common-dir hook path.
		expect(installedFromWorktree).toBe(installedFromMain);
		expect(existsSync(installedFromWorktree)).toBe(true);
	});

	test("clears a worktree-scoped mutable hooks path and resolves the reviewed common hook", () => {
		const { dir } = makeRepo();
		const worktree = mkdtempSync(join(tmpBase, "rw install wt "));
		created.push(worktree);
		git(dir, ["worktree", "add", "-q", worktree, "HEAD"]);
		git(dir, ["config", "extensions.worktreeConfig", "true"]);

		const mutableHooks = join(worktree, "mutable hooks");
		mkdirSync(mutableHooks);
		writeFileSync(join(mutableHooks, "pre-push"), "#!/usr/bin/env bash\nexit 99\n");
		git(worktree, ["config", "--worktree", "core.hooksPath", mutableHooks]);
		expect(git(worktree, ["rev-parse", "--git-path", "hooks/pre-push"])).toBe(
			join(mutableHooks, "pre-push"),
		);

		const result = runInstall(dir);
		expect(result.exitCode).toBe(0);
		const worktreeScoped = Bun.spawnSync(
			["git", "config", "--worktree", "--get", "core.hooksPath"],
			{ cwd: worktree, stdout: "pipe", stderr: "pipe", env: gitEnv() },
		);
		expect(worktreeScoped.exitCode).not.toBe(0);

		const reviewedHook = join(commonDir(dir), "hooks", "pre-push");
		expect(git(worktree, ["rev-parse", "--git-path", "hooks/pre-push"])).toBe(reviewedHook);
		expect(existsSync(reviewedHook)).toBe(true);
	});

	test("clears a missing linked worktree's administrative hooks path", () => {
		const { dir } = makeRepo();
		const worktree = mkdtempSync(join(tmpBase, "rw archived wt "));
		created.push(worktree);
		git(dir, ["worktree", "add", "-q", worktree, "HEAD"]);
		git(dir, ["config", "extensions.worktreeConfig", "true"]);

		const mutableHooks = join(worktree, "mutable hooks");
		mkdirSync(mutableHooks);
		git(worktree, ["config", "--worktree", "core.hooksPath", mutableHooks]);
		const administrativeConfig = git(worktree, ["rev-parse", "--git-path", "config.worktree"]);
		expect(git(dir, ["config", "--file", administrativeConfig, "--get", "core.hooksPath"])).toBe(
			mutableHooks,
		);

		// Keep Git's worktree registration intact, but move its checkout away so
		// `git worktree list --porcelain` reports a missing/prunable worktree.
		const archivedCheckout = join(archive, `${basename(worktree)}-archived`);
		renameSync(worktree, archivedCheckout);
		created.splice(created.indexOf(worktree), 1);
		expect(existsSync(worktree)).toBe(false);
		expect(existsSync(administrativeConfig)).toBe(true);
		const registeredWorktrees = git(dir, ["worktree", "list", "--porcelain"]);
		expect(registeredWorktrees).toContain(`worktree ${worktree}`);
		expect(registeredWorktrees).toContain("prunable");

		const result = runInstall(dir);
		expect(result.exitCode).toBe(0);

		const scoped = Bun.spawnSync(
			["git", "config", "--file", administrativeConfig, "--get", "core.hooksPath"],
			{ cwd: dir, stdout: "pipe", stderr: "pipe", env: gitEnv() },
		);
		expect(scoped.exitCode).not.toBe(0);
	});

	test("fails closed when a missing worktree includes a diverted hooks path", () => {
		const { dir } = makeRepo();
		const worktree = mkdtempSync(join(tmpBase, "rw included archived wt "));
		created.push(worktree);
		git(dir, ["worktree", "add", "-q", worktree, "HEAD"]);
		git(dir, ["config", "extensions.worktreeConfig", "true"]);

		const administrativeConfig = git(worktree, ["rev-parse", "--git-path", "config.worktree"]);
		const administrativeDir = git(worktree, ["rev-parse", "--git-dir"]);
		const externalConfig = join(tmpBase, `rw-install-included-${basename(worktree)}.config`);
		created.push(externalConfig);
		const divertedHooks = join(worktree, "diverted hooks");
		writeFileSync(externalConfig, `[core]\n\thooksPath = ${divertedHooks}\n`);
		writeFileSync(
			administrativeConfig,
			`[includeIf "gitdir:${administrativeDir}"]\n\tpath = ${externalConfig}\n`,
		);
		expect(git(dir, ["--git-dir", administrativeDir, "config", "--get", "core.hooksPath"])).toBe(
			divertedHooks,
		);

		// Keep the registration and config.worktree, but make the checkout prunable.
		const archivedCheckout = join(archive, `${basename(worktree)}-included-archived`);
		renameSync(worktree, archivedCheckout);
		created.splice(created.indexOf(worktree), 1);
		expect(existsSync(worktree)).toBe(false);

		const result = runInstall(dir);
		expectFailClosed(result);
		expect(result.stderr).toContain("administrative git dir");
		// The installer may clear only the direct config.worktree; its include target
		// remains untouched and is caught by effective-config verification.
		expect(git(dir, ["config", "--file", externalConfig, "--get", "core.hooksPath"])).toBe(
			divertedHooks,
		);
	});

	test("fails closed when the reviewed hook source is absent", () => {
		const { dir } = makeRepo();
		renameSync(join(dir, "_githooks", "pre-push"), join(dir, "_githooks", "pre-push.archived"));
		const result = runInstall(dir);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("reviewed hook not found");
	});

	test("fails closed when the reviewed hook source is a symlink", () => {
		const { dir } = makeRepo();
		// Replace the real hook source with a symlink to an unrelated file. Following
		// it would let a crafted checkout redirect the install; the installer refuses.
		const source = join(dir, "_githooks", "pre-push");
		const decoy = join(dir, "_githooks", "pre-push.real");
		renameSync(source, decoy);
		symlinkSync(decoy, source);
		const result = runInstall(dir);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).not.toContain("Installed standalone pre-push hook");
		expect(result.stderr).toContain("symlink");
	});

	test("fails closed when the installed pre-push destination is a symlink", () => {
		const { dir } = makeRepo();
		// Pre-plant a symlinked pre-push at the common-dir destination. Installing over
		// it with cp/mv could follow the link and clobber an arbitrary target, so the
		// installer must refuse before writing.
		const hooksDir = join(commonDir(dir), "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const decoy = join(hooksDir, "pre-push.evil-target");
		writeFileSync(decoy, "#!/usr/bin/env bash\nexit 7\n");
		symlinkSync(decoy, join(hooksDir, "pre-push"));
		const result = runInstall(dir);
		expectFailClosed(result);
		expect(result.stderr).toContain("symlink");
		// The link target was never overwritten by the reviewed hook body.
		expect(Bun.file(decoy).text()).resolves.toContain("exit 7");
	});

	test("fails closed when the shared local config is a symlink", () => {
		const { dir } = makeRepo();
		const config = commonConfig(dir);
		// Replace the real common-dir config with a symlink to an unrelated target.
		// `git --local` would silently follow it; the installer must refuse to.
		const decoy = join(commonDir(dir), "config.real");
		renameSync(config, decoy);
		symlinkSync(decoy, config);
		expect(statSync(config, { throwIfNoEntry: true }).isFile()).toBe(true); // follows link
		expect(existsSync(config)).toBe(true);

		const result = runInstall(dir);
		expectFailClosed(result);
		expect(result.stderr).toContain("install-hooks:");
		expect(result.stderr).toContain("symlink");
		// The symlink target was never rewritten with a pinned hooks path.
		const targetHooksPath = Bun.spawnSync(
			["git", "config", "--file", decoy, "--get", "core.hooksPath"],
			{ cwd: dir, stdout: "pipe", stderr: "pipe", env: gitEnv() },
		);
		expect(targetHooksPath.exitCode).not.toBe(0);
	});

	test("fails closed when the shared local config is write-resistant and has no hooksPath", () => {
		const { dir } = makeRepo();
		// A readable but NON-writable common config with NO core.hooksPath must not
		// be treated as safe: `git --local` reads it as "absent" (exit 1) and would
		// happily claim success without ever proving the file is mutable.
		const config = commonConfig(dir);
		const before = Bun.file(config).size;
		expect(before).toBeGreaterThan(0);
		chmodSync(config, 0o444);
		try {
			// Force the pin path (global present) so a naive installer would attempt
			// a write it cannot perform; the strict pre-check must catch it first.
			const globalDir = mkdtempSync(join(tmpBase, "rw-install-wrz-glob-"));
			created.push(globalDir);
			const globalCfg = join(globalDir, "gitconfig");
			Bun.spawnSync([
				"git",
				"config",
				"--file",
				globalCfg,
				"core.hooksPath",
				"/tmp/somewhere-else",
			]);

			const result = runInstall(dir, { GIT_CONFIG_GLOBAL: globalCfg });
			expectFailClosed(result);
			expect(result.stderr).toContain("install-hooks:");
			expect(result.stderr).toContain("not writable");
		} finally {
			chmodSync(config, 0o644);
		}
	});

	test("fails closed on a malformed GLOBAL config instead of treating it as absent", () => {
		const { dir } = makeRepo();
		// A malformed global config makes every `git config` read fail with a FATAL
		// status (not exit 1). The installer must abort — never conflate the parse
		// failure with "no core.hooksPath set" and never pin from a bad lookup.
		const globalDir = mkdtempSync(join(tmpBase, "rw-install-badglob-"));
		created.push(globalDir);
		const globalCfg = join(globalDir, "gitconfig");
		// Unterminated section header -> git config parse failure.
		writeFileSync(globalCfg, "[core\n\thooksPath = /tmp/whatever\n");

		const result = runInstall(dir, { GIT_CONFIG_GLOBAL: globalCfg });
		expectFailClosed(result);
		// git's own parse fatal is surfaced, not swallowed.
		expect(result.stderr).toContain("bad config");
		// No local core.hooksPath was pinned from a malformed lookup.
		const local = localHooksPath(dir);
		expect(local.value).toBe("");
		expect(local.exitCode).not.toBe(0);
	});

	test("fails closed when an accessible worktree's effective lookup errors in the final sweep", () => {
		const { dir } = makeRepo();
		const worktree = mkdtempSync(join(tmpBase, "rw-install-wt-err-"));
		created.push(worktree);
		git(dir, ["worktree", "add", "-q", worktree, "HEAD"]);
		git(dir, ["config", "extensions.worktreeConfig", "true"]);

		// The worktree's scoped config is itself syntactically valid (so the earlier
		// administrative clear passes) but pulls in a MALFORMED include. Effective
		// resolution of core.hooksPath from the accessible checkout then fails with a
		// fatal (non-1) status during the final worktree sweep. The installer must
		// treat that as fatal — never as a benign "absent" default that would let a
		// diverted worktree slip through — and must NOT claim success.
		const badInclude = join(tmpBase, `rw-install-badinc-${basename(worktree)}`);
		created.push(badInclude);
		writeFileSync(badInclude, "[core\n");
		const administrativeConfig = git(worktree, ["rev-parse", "--git-path", "config.worktree"]);
		writeFileSync(administrativeConfig, `[include]\n\tpath = ${badInclude}\n`);
		expect(existsSync(worktree)).toBe(true);

		const result = runInstall(dir);
		expectFailClosed(result);
		expect(result.stderr).toContain("install-hooks:");
		// The strict administrative-dir resolution surfaces the error rather than defaulting.
		expect(result.stderr).toContain("effective core.hooksPath from administrative git dir");
	});

	test("defers global-pin success output when worktree listing fails", () => {
		const { dir } = makeRepo();
		const shimDir = mkdtempSync(join(tmpBase, "rw-install-git-shim-"));
		created.push(shimDir);
		const realGit = Bun.which("git");
		if (!realGit) throw new Error("git was not found on PATH");
		const shim = join(shimDir, "git");
		writeFileSync(
			shim,
			`#!/usr/bin/env bash
if [[ "$#" -eq 5 && "$1" == "-C" && "$3" == "worktree" && "$4" == "list" && "$5" == "--porcelain" ]]; then
  echo "forced worktree-list failure" >&2
  exit 86
fi
exec "${realGit}" "$@"
`,
		);
		chmodSync(shim, 0o755);

		const globalCfg = join(shimDir, "global.gitconfig");
		const configured = Bun.spawnSync([
			realGit,
			"config",
			"--file",
			globalCfg,
			"core.hooksPath",
			"/tmp/global-hooks",
		]);
		expect(configured.exitCode).toBe(0);

		const result = runInstall(dir, {
			PATH: `${shimDir}:${process.env.PATH ?? ""}`,
			GIT_CONFIG_GLOBAL: globalCfg,
		});
		expectFailClosed(result);
		expect(result.stderr).toContain("listing Git worktrees failed");
	});
});
