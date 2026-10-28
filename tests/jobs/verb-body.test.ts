import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchedBaseForJob, VERB_CHANGE_BASE_REPOSITORY } from "../../src/jobs/verb-base";
import { isSafeAppName, renderVerbScriptBody } from "../../src/jobs/verb-body";
import { resultSchema } from "../../src/results/schema";
import { CHANGE_BUNDLE_NAME, WATCHER_RESULT_NAME } from "../../src/templates/agent-lane";
import { testTmpBase } from "../support/test-temp";

const MANIFEST = "rails:\n  - id: cnpg-implies-backup\n    severity: high\n";
const MANIFEST_SHA = createHash("sha256").update(MANIFEST).digest("hex");
const BASE = "a".repeat(40);

/**
 * Fixture scratch, resolved through the repo's PORTABLE temp helper.
 *
 * Hardcoding the Development Mac path (`/opt/_tmp/...`) is what
 * the first version of this file did, and the pre-push receipt gate caught it:
 * on a clean Linux runner box that path does not exist and is not creatable, so
 * both execution tests died `EACCES: permission denied, mkdir '/Volumes'` while
 * passing locally. `testTmpBase()` reads the runner's `RODADDY_WATCHER_TEST_TMP`
 * override and falls back to the Mac path — the solved problem this repo already
 * has a helper for.
 */
function scratchDir(prefix: string): string {
	const base = join(testTmpBase(), "_scratch");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, prefix));
}

/**
 * Git for fixture repositories, with the ambient environment CLEARED.
 *
 * Not defensive boilerplate: without it the operator's global `core.hooksPath`
 * applies to the fixture and its protected-branch hook refuses a commit to
 * `main`, which then makes `git bundle create` refuse an empty bundle — a test
 * failing for a reason that has nothing to do with the code under test.
 */
function git(args: string[], cwd: string) {
	return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

/**
 * The body's EXECUTABLE lines: comments stripped, heredoc interiors dropped.
 *
 * Every "the body must not contain X" assertion runs over this view rather than
 * the raw string, because the body EXPLAINS in its own comments why it avoids
 * `zsh`, `$HOSTNAME`, and a recursive delete — a raw scan flags the explanation
 * and reports a defect that is not there.
 */
function executableOnly(body: string): string {
	const kept: string[] = [];
	let delimiter: string | null = null;
	for (const line of body.split("\n")) {
		if (delimiter !== null) {
			if (line.trim() === delimiter) delimiter = null;
			continue;
		}
		const opener = line.match(/<<\s*'?([A-Za-z0-9_]+)'?/);
		if (opener?.[1] !== undefined) {
			delimiter = opener[1];
			kept.push(line);
			continue;
		}
		if (!line.trimStart().startsWith("#")) kept.push(line);
	}
	return kept.join("\n");
}

function render(overrides: Partial<Parameters<typeof renderVerbScriptBody>[0]> = {}) {
	return renderVerbScriptBody({
		verb: "newapp",
		repository: "rodaddy/software-factory",
		itemNumber: 301,
		app: "hello",
		manifest: { content: MANIFEST, sha256: MANIFEST_SHA },
		k3sBaseSha: BASE,
		enginePath: "/mnt/share/checkouts/rtech-infra",
		k3sCheckoutPath: "/mnt/share/checkouts/k3s-deploy",
		...overrides,
	});
}

/**
 * A fixture rtech-infra checkout whose `service-catalog` is a stub.
 *
 * `compiledApp` is the app the compiled tree carries. `null` models the state
 * `_DOCS/control-surface.md` requires before a spindown: the app is gone from the
 * service catalog, so compile emits nothing for it. The up-verb suite always
 * wants "hello" present, which stays the default.
 */
function seedEngine(dir: string, opts: { compiledApp?: string | null } = {}): string {
	const compiledApp = opts.compiledApp === undefined ? "hello" : opts.compiledApp;
	const engine = join(dir, "engine-src");
	mkdirSync(join(engine, "scripts"), { recursive: true });
	writeFileSync(
		join(engine, "scripts", "service-catalog"),
		'#!/bin/bash\n[ -z "${SF_COMPILE_MARKER:-}" ] || printf "invoked\\n" > "$SF_COMPILE_MARKER"\nexit 0\n',
		{ mode: 0o755 },
	);
	const compiled = join(engine, "gitops", "k3s-deploy");
	mkdirSync(join(compiled, "apps"), { recursive: true });
	mkdirSync(join(compiled, "manifests", "apps"), { recursive: true });
	if (compiledApp !== null) {
		writeFileSync(join(compiled, "apps", `${compiledApp}.yaml`), `name: ${compiledApp}\n`);
		mkdirSync(join(compiled, "manifests", "apps", compiledApp), { recursive: true });
		writeFileSync(join(compiled, "manifests", "apps", compiledApp, "deployment.yaml"), "kind: D\n");
	}
	return engine;
}

function seedK3s(dir: string, includeRenderedOutput = false): { path: string; baseSha: string } {
	const path = join(dir, "k3s-src");
	mkdirSync(path, { recursive: true });
	git(["init", "--quiet", "-b", "fixture-main"], path);
	git(["config", "user.email", "t@example.invalid"], path);
	git(["config", "user.name", "t"], path);
	writeFileSync(join(path, "README.md"), "base\n");
	if (includeRenderedOutput) {
		mkdirSync(join(path, "apps"), { recursive: true });
		writeFileSync(join(path, "apps", "hello.yaml"), "name: hello\n");
		mkdirSync(join(path, "manifests", "apps", "hello"), { recursive: true });
		writeFileSync(join(path, "manifests", "apps", "hello", "deployment.yaml"), "kind: D\n");
	}
	git(["add", "."], path);
	git(["commit", "--quiet", "-m", "base"], path);
	return { path, baseSha: git(["rev-parse", "HEAD"], path).stdout.trim() };
}

function executeBody(dir: string, body: string, jobId: string, env: Record<string, string> = {}) {
	const file = join(dir, `${jobId}.sh`);
	writeFileSync(file, body);
	const share = join(dir, "share");
	mkdirSync(share, { recursive: true });
	const run = spawnSync("bash", [file], {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			// The rendered body runs `git config --global`; without this it writes the OPERATOR'S real ~/.gitconfig (sf#315 — 30+ stale safe.directory entries observed).
			GIT_CONFIG_GLOBAL: join(dir, "gitconfig-global.test"),
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			RUNNER_JOB_ID: jobId,
			SF_SHARE_ROOT: share,
			SF_WORK_ROOT: dir,
			...env,
		},
	});
	const host = spawnSync("hostname", [], { encoding: "utf8" }).stdout.trim();
	return { run, outDir: join(share, "runners", "jobs", jobId, host) };
}

describe("renderVerbScriptBody — the body is executable shell", () => {
	test("parses under bash -n", () => {
		const body = render();
		expect(body).not.toBeNull();
		const dir = scratchDir("verbbody-syntax-");
		const file = join(dir, "job.sh");
		writeFileSync(file, body as string);
		const parsed = spawnSync("bash", ["-n", file], { encoding: "utf8" });
		expect(parsed.status).toBe(0);
	});

	/**
	 * The clause `bash -n` CANNOT reach. The pre-sf#301 body parsed fine — prose
	 * like "Run the fixed `newapp` job..." is syntactically a command invocation —
	 * and died at RUNTIME on the first line under `set -e`. Only executing it
	 * distinguishes the two, which is why this test stands beside the parse test
	 * rather than replacing it.
	 */
	test("executes end to end against fixture checkouts, dying on no prose or manifest line", () => {
		const dir = scratchDir("verbbody-exec-");
		const engine = seedEngine(dir);
		const k3s = seedK3s(dir);

		const body = render({
			k3sBaseSha: k3s.baseSha,
			enginePath: engine,
			k3sCheckoutPath: k3s.path,
		});
		expect(body).not.toBeNull();
		const { run, outDir } = executeBody(dir, body as string, "rw-test");
		expect(`${run.stdout}${run.stderr}`).not.toContain("command not found");
		expect(run.status).toBe(0);

		// The two artifacts land in the job's own share directory, which is what the
		// reconciler and `change-ingest` read.
		const result = JSON.parse(readFileSync(join(outDir, WATCHER_RESULT_NAME), "utf8"));
		expect(result.job_type).toBe("newapp");
		expect(result.result_version).toBe(2);
		expect(result.repository).toBe("rodaddy/software-factory");
		expect(result.sha).toBe(MANIFEST_SHA);
		expect(result.checks).toEqual([
			{ name: "service-catalog compile", status: "pass" },
			{ name: "secrets", status: "skip" },
			{ name: "test", status: "skip" },
		]);
		expect(result.change.base_sha).toBe(k3s.baseSha);
		expect(result.change.bundle_path).toBe(CHANGE_BUNDLE_NAME);

		// The bundle must carry HEAD, or the watcher's inspector (`git fetch
		// HEAD:<ref>`) rejects it changed_paths_error.
		const listed = git(["bundle", "list-heads", join(outDir, CHANGE_BUNDLE_NAME)], dir);
		expect(listed.status).toBe(0);
		expect(listed.stdout).toContain("HEAD");

		const gitconfigPath = join(dir, "gitconfig-global.test");
		const gitconfig = readFileSync(gitconfigPath, "utf8");
		expect(gitconfig).toContain("[safe]");
		expect(gitconfig).toContain("directory = ");
	});

	test("fails before compile when the dispatched base is stale in the share clone", () => {
		const dir = scratchDir("verbbody-stale-base-");
		const engine = seedEngine(dir);
		const k3s = seedK3s(dir);
		const staleBase = "f".repeat(40);
		const compileMarker = join(dir, "compile-invoked");
		const body = render({
			k3sBaseSha: staleBase,
			enginePath: engine,
			k3sCheckoutPath: k3s.path,
		});
		expect(body).not.toBeNull();

		const { run, outDir } = executeBody(dir, body as string, "rw-stale-base", {
			SF_COMPILE_MARKER: compileMarker,
		});
		// sf#596: the failure is a RESULT, not a bare exit. Nothing retries a verb
		// row (the requeue sweep skips them), so the body names the phase and
		// the recovery instead of promising a requeue and dying with no artifact.
		expect(run.status).toBe(0);
		expect(run.stderr.trim().split("\n")).toEqual([
			`verb newapp: k3s-deploy base ${staleBase} not present in share checkout clone — share refresh required (pull --ff-only)`,
		]);
		const result = JSON.parse(readFileSync(join(outDir, WATCHER_RESULT_NAME), "utf8"));
		expect(resultSchema.safeParse(result).success).toBe(true);
		expect(result.status).toBe("error");
		expect(result.checks).toEqual([
			{
				name: "k3s-deploy base",
				status: "error",
				summary: `dispatched base ${staleBase} is absent from the share checkout clone; refresh the share (pull --ff-only), then re-run with redeploy:hello`,
			},
		]);
		expect(existsSync(join(outDir, CHANGE_BUNDLE_NAME))).toBe(false);
		expect(existsSync(compileMarker)).toBe(false);
	});

	test("returns a passed changeless result when compiled output matches the base", () => {
		const dir = scratchDir("verbbody-no-change-");
		const engine = seedEngine(dir);
		const k3s = seedK3s(dir, true);
		const body = render({
			k3sBaseSha: k3s.baseSha,
			enginePath: engine,
			k3sCheckoutPath: k3s.path,
		});
		expect(body).not.toBeNull();
		const { run, outDir } = executeBody(dir, body as string, "rw-no-change");
		expect(run.status).toBe(0);
		const result = JSON.parse(readFileSync(join(outDir, WATCHER_RESULT_NAME), "utf8"));
		expect(resultSchema.safeParse(result).success).toBe(true);
		expect(result.status).toBe("passed");
		expect(result.change).toBeUndefined();
		expect(result.checks).toContainEqual({
			name: "service-catalog render",
			status: "pass",
			summary: "render produced no changes",
		});
		expect(existsSync(join(outDir, CHANGE_BUNDLE_NAME))).toBe(false);
	});

	test("delivers the manifest as quoted-heredoc DATA, never as script lines", () => {
		const body = render() as string;
		// A quoted delimiter: no expansion, no substitution, nothing executes.
		expect(body).toMatch(/<<\s*'[A-Z0-9_]+'/);
		expect(body).toContain(MANIFEST.trimEnd());
		// And the executable view — comments and heredoc interiors removed — must
		// not carry the manifest's first line as a bare statement, which is exactly
		// what the pre-sf#301 body did.
		const executable: string[] = [];
		let delimiter: string | null = null;
		for (const line of body.split("\n")) {
			if (delimiter !== null) {
				if (line.trim() === delimiter) delimiter = null;
				continue;
			}
			const opener = line.match(/<<\s*'?([A-Za-z0-9_]+)'?/);
			if (opener?.[1] !== undefined) {
				delimiter = opener[1];
				continue;
			}
			if (!line.trimStart().startsWith("#")) executable.push(line);
		}
		expect(executable.some((l) => l.trim() === "rails:")).toBe(false);
	});

	test("integrity-binds the manifest digest before render work begins", () => {
		const body = render() as string;
		// The digest is of the ON-BOX bytes (the heredoc always terminates its last
		// line), not of the caller's string. MANIFEST already ends in "\n", so the
		// two coincide here; the dedicated normalization test below proves the
		// renderer computes it rather than echoing the caller's value.
		expect(body).toContain(`manifest_sha256=${MANIFEST_SHA}`);
		const guardIdx = body.indexOf('"$observed_sha256" != "$manifest_sha256"');
		const compileIdx = body.indexOf("service-catalog");
		expect(guardIdx).toBeGreaterThan(-1);
		expect(compileIdx).toBeGreaterThan(guardIdx);
	});

	/**
	 * The digest the body asserts must describe the bytes the heredoc WRITES, not
	 * the caller's string. This was a real defect: content already ending in "\n"
	 * was spliced with another one, so the on-box file was a byte longer than the
	 * digest and the body's own guard refused EVERY dispatch with "rails manifest
	 * digest mismatch". Two inputs differing only in trailing newlines must
	 * therefore produce the SAME asserted digest — and a value-equality check
	 * alone could not tell a computed digest from an echoed one, so the second
	 * fixture has a different derivation (README rule 18).
	 */
	test("asserts the digest of the ON-BOX bytes, normalizing trailing newlines", () => {
		const withNewline = render({
			manifest: { content: "rails: []\n", sha256: MANIFEST_SHA },
		}) as string;
		const withoutNewline = render({
			manifest: { content: "rails: []", sha256: MANIFEST_SHA },
		}) as string;
		const expected = createHash("sha256").update("rails: []\n").digest("hex");
		expect(withNewline).toContain(`manifest_sha256=${expected}`);
		expect(withoutNewline).toContain(`manifest_sha256=${expected}`);
		// And it is NOT simply the caller-supplied sha256 echoed back.
		expect(withNewline).not.toContain(`manifest_sha256=${MANIFEST_SHA}`);
	});

	test("refuses a manifest that would break out of its own heredoc", () => {
		expect(
			render({
				manifest: {
					content: "rails:\nSF_RAILS_MANIFEST_EOF\nrm -rf /\n",
					sha256: MANIFEST_SHA,
				},
			}),
		).toBeNull();
	});

	test("refuses a NUL-smuggled heredoc delimiter before bash can discard the NUL", () => {
		expect(
			render({
				manifest: {
					content: "rails:\nSF_RAILS_MANIFEST_\0EOF\nprintf 'injected\\n'\n",
					sha256: MANIFEST_SHA,
				},
			}),
		).toBeNull();
	});

	test("invokes no zsh in any executable line", () => {
		const body = render() as string;
		const executable = body
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");
		expect(executable).not.toMatch(/\bzsh\b/);
	});

	/**
	 * The share checkout is owned by a different uid than the box job user, so an
	 * unflagged clone dies "detected dubious ownership" — proven on a live runner
	 * box (receipt run 1). BOTH paths are pinned because run 2
	 * proved the checkout path alone is insufficient: git's local clone transport
	 * checks the source's `.git` path separately. Run 3 passed with both.
	 *
	 * The trust MUST be written to GLOBAL config, not passed as `-c`. git honors
	 * `safe.directory` only from protected (system/global) config and silently
	 * ignores `-c` and `GIT_CONFIG_*` for it — probed on the golden image itself
	 * (git 2.47.3, box run sf-safedir-mechanism-probe-20260816): `-c` → exit 128,
	 * env → exit 128, `--global --add` → exit 0. The `-c` form shipped in sf#301
	 * looked correct, passed every test, and killed the first staged live dispatch
	 * exit 128.
	 *
	 * Pinned as ONE ordered slice rather than three independent substring hits:
	 * the config lines are worthless AFTER the clone, so a reordering must fail.
	 */
	test("writes BOTH safe.directory paths to GLOBAL config before a plain clone", () => {
		const executable = executableOnly(render() as string);
		expect(executable).toContain(
			[
				'git config --global --add safe.directory "$k3s_src"',
				'git config --global --add safe.directory "$k3s_src/.git"',
				'git clone --quiet --no-checkout "$k3s_src" "$repo_dir"',
			].join("\n"),
		);
		// Regression pin against reintroducing the form git ignores. Not redundant
		// with the slice above: a body carrying BOTH would satisfy it and still
		// suggest the `-c` values do something.
		expect(executable).not.toContain("-c safe.directory");
	});

	/**
	 * `cp -a` implies `-p`, and the box's /work filesystem REFUSES mode
	 * preservation: every file logged `cp: preserving permissions for
	 * '/work/engine-…': Operation not supported`, cp exited 1, and `set -euo
	 * pipefail` killed the body before compile ever ran — live on
	 * rw-newapp-676470d8, the first run to get past clone + base-check.
	 * The tree content copied fine; only the chmod was refused, and all four
	 * pre-flight runs had copied share→/work with plain `cp -R`.
	 *
	 * Both copies are pinned, and `-a` is pinned ABSENT from every executable
	 * line: a body carrying one `-R` and one surviving `-a` would satisfy the
	 * positive assertions alone and still die on the box.
	 */
	test("copies with -R, never -a, so /work's refusal to preserve modes cannot kill the body", () => {
		const executable = executableOnly(render() as string);
		expect(executable).toContain('cp -R "$engine_src/." "$engine_dir/"');
		expect(executable).toContain(
			'cp -R "$engine_dir/gitops/k3s-deploy/manifests/apps/${app}/." "$repo_dir/manifests/apps/${app}/"',
		);
		expect(executable).not.toMatch(/\bcp\s+-\S*a/);
	});

	/**
	 * The consequence of dropping `-a`: `-R` does not guarantee the x-bit survives
	 * the copy off the share, and the next line executes the copied
	 * `scripts/service-catalog` by path. Rather than gamble on the mode, the call
	 * names the interpreter the script's own shebang names — `#!/usr/bin/env bash`
	 * in the rtech-infra checkout — so it runs whether or not the bit came across.
	 * A WRONG interpreter would be worse than the gamble, so the exact form is
	 * pinned, and the bare-path form is pinned absent.
	 */
	test("invokes the compiler through explicit bash, not a path whose x-bit the copy may have dropped", () => {
		const executable = executableOnly(render() as string);
		expect(executable).toContain(
			'bash "$engine_dir/scripts/service-catalog" compile --all --repo "$engine_dir"',
		);
		expect(executable).not.toMatch(/^"\$engine_dir\/scripts\/service-catalog"/m);
	});

	test("writes the bundle BEFORE the result artifact", () => {
		const body = render() as string;
		const bundleIdx = body.indexOf(`mv -f "$out_dir/.${CHANGE_BUNDLE_NAME}.tmp"`);
		const changedResultIdx = body.lastIndexOf(`mv -f "$out_dir/.${WATCHER_RESULT_NAME}.tmp"`);
		expect(bundleIdx).toBeGreaterThan(-1);
		// On the changed path, the result artifact is the completion signal the
		// reconciler acts on, so it must land only after the bundle is complete.
		expect(changedResultIdx).toBeGreaterThan(bundleIdx);
	});

	test("derives the share path from RUNNER_JOB_ID and the hostname COMMAND", () => {
		const body = render() as string;
		expect(body).toContain('host="$(hostname)"');
		expect(body).toContain("${RUNNER_JOB_ID}");
		// NOT $HOSTNAME — a live agent twice expanded that to a guessed number.
		// Scanned over EXECUTABLE lines: the body's own comment explains why
		// $HOSTNAME is wrong, and a whole-body scan flags that explanation.
		expect(executableOnly(body)).not.toContain("$HOSTNAME");
	});

	test("contacts no forge and issues no recursive delete", () => {
		const executable = executableOnly(render() as string);
		for (const forbidden of ["git push", "curl", "wget", "gh ", "GH_TOKEN", "rm -rf", "rm -r "]) {
			expect(executable).not.toContain(forbidden);
		}
	});

	test("renders all six allowlisted verbs and nothing else", () => {
		for (const verb of [
			"newroute",
			"newapp",
			"newdb",
			"newroute-down",
			"newapp-down",
			"newdb-down",
		]) {
			expect(render({ verb })).not.toBeNull();
		}
		for (const verb of ["rm-cluster", "newapp-sideways", "down", ""]) {
			expect(render({ verb })).toBeNull();
		}
	});

	describe("every interpolation is allowlisted", () => {
		test.each([
			["a non-allowlisted verb", { verb: "rm-cluster" }],
			["a repository carrying shell syntax", { repository: "rodaddy/x; touch bad" }],
			["a zero item number", { itemNumber: 0 }],
			["a non-integer item number", { itemNumber: 1.5 }],
			["an app name carrying a shell metacharacter", { app: "hello; rm -rf /" }],
			["an app name carrying a path separator", { app: "../../etc" }],
			["an abbreviated base sha", { k3sBaseSha: "abc1234" }],
			["a non-hex base sha", { k3sBaseSha: "z".repeat(40) }],
			["a relative engine path", { enginePath: "relative/path" }],
			["a traversing checkout path", { k3sCheckoutPath: "/mnt/../etc" }],
		])("refuses %s", (_label, override) => {
			expect(render(override as Record<string, unknown>)).toBeNull();
		});
	});

	test("accepts exactly the DNS-label app names", () => {
		expect(isSafeAppName("hello")).toBe(true);
		expect(isSafeAppName("my-app-2")).toBe(true);
		expect(isSafeAppName("Hello")).toBe(false);
		expect(isSafeAppName("-lead")).toBe(false);
		expect(isSafeAppName("trail-")).toBe(false);
		expect(isSafeAppName("")).toBe(false);
	});
});

/**
 * The PRUNE body. The up body copies compiled output IN; the down body
 * must take it OUT, and the two differ only in the assemble section — preamble,
 * manifest, base preparation, the no-change guard and the hand-back are shared
 * code and are pinned unchanged by the regression clause at the end.
 */
describe("renderVerbScriptBody — the down verbs prune", () => {
	const DOWN_VERBS: string[] = ["newroute-down", "newapp-down", "newdb-down"];

	function renderDown(overrides: Partial<Parameters<typeof renderVerbScriptBody>[0]> = {}) {
		return render({ verb: "newapp-down", ...overrides });
	}

	test.each(DOWN_VERBS)("%s parses under bash -n", (verb) => {
		const body = renderDown({ verb });
		expect(body).not.toBeNull();
		const dir = scratchDir("verbbody-down-syntax-");
		const file = join(dir, "job.sh");
		writeFileSync(file, body as string);
		expect(spawnSync("bash", ["-n", file], { encoding: "utf8" }).status).toBe(0);
	});

	/**
	 * The removal is a GIT-TRACKED removal, and the exact form is pinned because
	 * the alternatives are each wrong in a way that reads fine: a raw `rm -r`
	 * violates AGENTS.md and leaves nothing staged; `git rm` without
	 * `--ignore-unmatch` dies exit 128 when the base never carried the app (a
	 * spin-down of something already gone is a legitimate no-change, not a
	 * failure); and `git rm` without `-r` cannot take the manifests directory.
	 *
	 * MUTATION: replace the `git rm` line with `rm -r` and this clause plus
	 * C-down-no-raw-delete both go RED.
	 */
	test.each(DOWN_VERBS)("%s stages a git-tracked removal of both paths", (verb) => {
		const folded = executableOnly(renderDown({ verb }) as string)
			.replace(/\s*\\\n\s*/g, " ")
			.replace(/[ \t]+/g, " ");
		expect(folded).toContain(
			'git -C "$repo_dir" -c user.email=factory@example.internal -c user.name="software-factory" rm -r --quiet --ignore-unmatch -- "apps/${app}.yaml" "manifests/apps/${app}"',
		);
	});

	/**
	 * MUTATION for the no-raw-delete clause: the down body's whole job is deletion,
	 * so a raw recursive delete is the natural wrong implementation here in a way it
	 * never was in the up body. Scanned over executable lines only — the body's own
	 * comments explain why it avoids one.
	 */
	test.each(DOWN_VERBS)("%s issues no raw recursive delete and contacts no forge", (verb) => {
		const executable = executableOnly(renderDown({ verb }) as string);
		for (const forbidden of ["git push", "curl", "wget", "gh ", "GH_TOKEN"]) {
			expect(executable).not.toContain(forbidden);
		}
		// `rm` as its OWN command — the raw delete AGENTS.md forbids. `git rm` is a
		// DIFFERENT program and is this body's entire purpose, so a bare substring
		// scan for "rm -r" flags the correct implementation; the command position is
		// what distinguishes them. Backslash continuations are folded first, because
		// the body splits `git -C … \` from its `rm -r …` argument across two lines
		// and an unfolded per-line scan reads that second line as a bare `rm`.
		const folded = executable.replace(/\s*\\\n\s*/g, " ");
		for (const statement of folded.split(/\n|;|&&|\|\||\|/)) {
			expect(statement.trim()).not.toMatch(/^(\/bin\/|sudo\s+)?rm\b/);
		}
		expect(folded).not.toMatch(/\bfind\b[^\n]*-delete/);
		// And the removal that IS present is git's, staged into the index.
		expect(folded).toMatch(/\bgit\b[^\n]*\brm -r --quiet --ignore-unmatch\b/);
	});

	/**
	 * THE FAIL-CLOSED GUARD (controller ruling). `_DOCS/control-surface.md`
	 * says `spindown:<app>` runs the reverse projection AFTER catalog removal. If it
	 * runs BEFORE, the compile still emits the app's output, the prune stages a
	 * deletion of files the next up-verb compile will re-add, and the spin-down
	 * silently un-does itself one cycle later. The body cannot see the catalog, but
	 * it CAN see its own compiled output — so it refuses when the compiled tree
	 * still carries the app, naming the un-removed catalog entry.
	 *
	 * MUTATION: delete the guard block and the execution test below goes RED (the
	 * body exits 0 and stages a doomed deletion instead of exiting 1).
	 */
	test.each(DOWN_VERBS)(
		"%s fails closed when the compiled catalog still carries the app",
		(verb) => {
			const executable = executableOnly(renderDown({ verb }) as string);
			expect(executable).toContain(
				'if [ -e "$engine_dir/gitops/k3s-deploy/apps/${app}.yaml" ]; then',
			);
			expect(executable).toContain(
				'echo "verb ${verb}: catalog entry gitops/k3s-deploy/apps/${app}.yaml is still present after compile — the app was not removed from the service catalog; a prune before catalog removal is re-added by the next up-verb" >&2',
			);
			// AFTER compile, or it can never observe the compiled tree at all.
			const compileIdx = executable.indexOf('bash "$engine_dir/scripts/service-catalog"');
			const guardIdx = executable.indexOf(
				'if [ -e "$engine_dir/gitops/k3s-deploy/apps/${app}.yaml" ]',
			);
			expect(compileIdx).toBeGreaterThan(-1);
			expect(guardIdx).toBeGreaterThan(compileIdx);
		},
	);

	test("executes end to end, returning a bundle whose change DELETES the app's output", () => {
		const dir = scratchDir("verbbody-down-exec-");
		// The engine compiles nothing for `hello` — catalog removal already happened,
		// which is the precondition `control-surface.md` states for a spindown.
		const engine = seedEngine(dir, { compiledApp: null });
		const k3s = seedK3s(dir, true);

		const body = renderDown({
			k3sBaseSha: k3s.baseSha,
			enginePath: engine,
			k3sCheckoutPath: k3s.path,
		});
		expect(body).not.toBeNull();
		const { run, outDir } = executeBody(dir, body as string, "rw-down");
		expect(`${run.stdout}${run.stderr}`).not.toContain("command not found");
		expect(run.status).toBe(0);

		const result = JSON.parse(readFileSync(join(outDir, WATCHER_RESULT_NAME), "utf8"));
		expect(resultSchema.safeParse(result).success).toBe(true);
		expect(result.job_type).toBe("newapp-down");
		expect(result.status).toBe("passed");
		expect(result.change.base_sha).toBe(k3s.baseSha);

		// The bundle carries HEAD (the inspector's `git fetch HEAD:<ref>` needs it)
		// and its commit REMOVES both paths — the property the whole ticket is about.
		const bundlePath = join(outDir, CHANGE_BUNDLE_NAME);
		expect(git(["bundle", "list-heads", bundlePath], dir).stdout).toContain("HEAD");
		// Fetched into a CLONE of the base, not an empty repo: the bundle carries the
		// prerequisite `^base`, so a repo lacking that commit refuses it — which is
		// the same ancestry property `LocalBundleInspector` relies on.
		const fetched = join(scratchDir("verbbody-down-verify-"), "clone");
		expect(git(["clone", "--quiet", k3s.path, fetched], dir).status).toBe(0);
		expect(git(["fetch", "--quiet", bundlePath, "HEAD:refs/heads/proposed"], fetched).status).toBe(
			0,
		);
		const changed = git(
			["diff", "--name-status", `${k3s.baseSha}`, "refs/heads/proposed"],
			fetched,
		);
		expect(changed.status).toBe(0);
		const lines = changed.stdout.trim().split("\n").sort();
		expect(lines).toEqual(["D\tapps/hello.yaml", "D\tmanifests/apps/hello/deployment.yaml"]);
	});

	/**
	 * The mutation for the fail-closed guard, run as behavior rather than as a
	 * string match: an engine that STILL compiles the app is exactly the
	 * prune-before-catalog-removal ordering error, and the body must refuse it
	 * rather than stage a deletion the next up-verb re-adds.
	 */
	test("refuses to prune when the compiled tree still contains the app", () => {
		const dir = scratchDir("verbbody-down-still-present-");
		const engine = seedEngine(dir);
		const k3s = seedK3s(dir, true);
		const body = renderDown({
			k3sBaseSha: k3s.baseSha,
			enginePath: engine,
			k3sCheckoutPath: k3s.path,
		});
		const { run, outDir } = executeBody(dir, body as string, "rw-down-present");
		expect(run.status).toBe(1);
		expect(run.stderr).toContain(
			"gitops/k3s-deploy/apps/hello.yaml is still present after compile",
		);
		expect(existsSync(join(outDir, CHANGE_BUNDLE_NAME))).toBe(false);
		expect(existsSync(join(outDir, WATCHER_RESULT_NAME))).toBe(false);
	});

	test("returns a passed changeless result when the base never carried the app", () => {
		const dir = scratchDir("verbbody-down-absent-");
		const engine = seedEngine(dir, { compiledApp: null });
		const k3s = seedK3s(dir, false);
		const body = renderDown({
			k3sBaseSha: k3s.baseSha,
			enginePath: engine,
			k3sCheckoutPath: k3s.path,
		});
		const { run, outDir } = executeBody(dir, body as string, "rw-down-absent");
		expect(run.status).toBe(0);
		const result = JSON.parse(readFileSync(join(outDir, WATCHER_RESULT_NAME), "utf8"));
		expect(result.status).toBe("passed");
		expect(result.change).toBeUndefined();
		expect(existsSync(join(outDir, CHANGE_BUNDLE_NAME))).toBe(false);
	});

	test("commits with a prune message naming the app and the validated item", () => {
		const executable = executableOnly(renderDown() as string);
		expect(executable).toContain('commit --quiet -m "${verb}: prune ${app} (item ${item_number})"');
		expect(executable).not.toContain("render ${app}");
	});

	/**
	 * REGRESSION PIN. sf#304's non-goal is "no changes to the up-verb body", and
	 * the two bodies share four of their five sections — so a refactor that
	 * accidentally reshapes the shared code shows up here as a byte diff rather
	 * than as a silent live failure on the next deploy:<app>.
	 */
	test("leaves every up-verb body byte-identical", () => {
		const expected: Record<string, string> = {
			newroute: createHash("sha256")
				.update(render({ verb: "newroute" }) as string)
				.digest("hex"),
			newapp: createHash("sha256")
				.update(render({ verb: "newapp" }) as string)
				.digest("hex"),
			newdb: createHash("sha256")
				.update(render({ verb: "newdb" }) as string)
				.digest("hex"),
		};
		// The up body still copies IN and stages an add; it must carry no removal.
		for (const verb of ["newroute", "newapp", "newdb"]) {
			const executable = executableOnly(render({ verb }) as string);
			expect(executable).toContain(
				'cp "$engine_dir/gitops/k3s-deploy/apps/${app}.yaml" "$repo_dir/apps/${app}.yaml"',
			);
			expect(executable).not.toContain("rm -r --quiet --ignore-unmatch");
			expect(executable).toContain(
				'commit --quiet -m "${verb}: render ${app} (item ${item_number})"',
			);
			// Re-rendering is deterministic, so the digest is a stable identity for
			// the body rather than a frozen golden string this test has to carry.
			expect(
				createHash("sha256")
					.update(render({ verb }) as string)
					.digest("hex"),
			).toBe(expected[verb] as string);
		}
	});
});

describe("dispatchedBaseForJob — the change base", () => {
	test("a verb job answers with the recorded k3s-deploy base, not its dispatch identity", () => {
		expect(
			dispatchedBaseForJob({
				jobType: "newapp",
				jobSha: MANIFEST_SHA,
				repositoryFullName: "rodaddy/software-factory",
				changeBaseRepository: VERB_CHANGE_BASE_REPOSITORY,
				changeBaseSha: BASE,
			}),
		).toEqual({ repository: VERB_CHANGE_BASE_REPOSITORY, sha: BASE });
	});

	/**
	 * The FAIL-CLOSED property, and the one that actually matters. Falling back to
	 * the dispatch identity would compare a k3s render against a rails-manifest
	 * digest — sf#301 itself — and every correct bundle would be rejected
	 * `base_sha_mismatch`, which reads as a runner defect rather than a missing
	 * watcher precondition.
	 */
	test.each([
		["no recorded base at all", { changeBaseRepository: null, changeBaseSha: null }],
		["a base sha but no repository", { changeBaseRepository: null, changeBaseSha: BASE }],
		["the wrong target repository", { changeBaseRepository: "rtech/other", changeBaseSha: BASE }],
		[
			"an abbreviated base sha",
			{ changeBaseRepository: VERB_CHANGE_BASE_REPOSITORY, changeBaseSha: "abc1234" },
		],
	])("a verb job with %s yields no base", (_label, override) => {
		expect(
			dispatchedBaseForJob({
				jobType: "newapp",
				jobSha: MANIFEST_SHA,
				repositoryFullName: "rodaddy/software-factory",
				...override,
			}),
		).toBeNull();
	});

	test("a non-verb job with no recorded base keeps its pre-sf#301 answer", () => {
		expect(
			dispatchedBaseForJob({
				jobType: "implement-issue",
				jobSha: BASE,
				repositoryFullName: "rodaddy/software-factory",
			}),
		).toEqual({ repository: "rodaddy/software-factory", sha: BASE });
	});

	test("a job with an empty sha and no recorded base yields no base", () => {
		expect(
			dispatchedBaseForJob({
				jobType: "implement-issue",
				jobSha: "",
				repositoryFullName: "rodaddy/software-factory",
			}),
		).toBeNull();
	});
});

/**
 * The preamble's EXIT trap (verb half).
 *
 * Bash for the execution test, resolved the same way `tests/prepush/body.test.ts`
 * does it: macOS `/bin/bash` is 3.2 and is not ours.
 */
const TRAP_BASH =
	["/opt/homebrew/bin/bash", "/usr/bin/bash", "/bin/bash"].find((p) => existsSync(p)) ?? "bash";

describe("verb body preamble EXIT trap", () => {
	test("the trap is armed before the first command that can fail", () => {
		const body = render();
		if (body === null) throw new Error("fixture did not render");
		expect(body.indexOf("trap on_exit EXIT")).toBeGreaterThan(-1);
		expect(body.indexOf("trap on_exit EXIT")).toBeLessThan(body.indexOf('host="$(hostname)"'));
	});

	test("preamble trap writes an error watcher-result under work_root/out and exits 0 when RUNNER_JOB_ID is unset", () => {
		const body = render();
		if (body === null) throw new Error("fixture did not render");
		const marker = "# --- the rails manifest, as DATA";
		const cut = body.indexOf(marker);
		expect(cut).toBeGreaterThan(-1);
		const preambleText = body.slice(0, cut);

		const dir = scratchDir("verb-trap-");
		const scriptPath = join(dir, "preamble.sh");
		writeFileSync(scriptPath, preambleText);

		const env = { ...process.env, SF_WORK_ROOT: dir, SF_SHARE_ROOT: join(dir, "share") };
		delete (env as Record<string, string | undefined>).RUNNER_JOB_ID;

		const proc = Bun.spawnSync([TRAP_BASH, "-c", `unset RUNNER_JOB_ID; source ${scriptPath}`], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(proc.exitCode).toBe(0);

		const resultPath = join(dir, "out", WATCHER_RESULT_NAME);
		expect(existsSync(resultPath)).toBe(true);
		const parsed = resultSchema.safeParse(JSON.parse(readFileSync(resultPath, "utf8")));
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.status).toBe("error");
		expect(parsed.data.job_type).toBe("newapp");
		expect(parsed.data.item_number).toBe(301);
	});
});
