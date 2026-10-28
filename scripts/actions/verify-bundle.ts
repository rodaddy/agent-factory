/**
 * @module actions/verify-bundle
 * @description CLI over the change-ingest trust boundary for the
 *   Actions propose job. The implement lane's artifact is UNTRUSTED bytes; this
 *   runs the SAME gates the watcher runs (`verifyChangeBundle` over a
 *   `LocalBundleInspector`) — imported, never copied — before anything acts on
 *   it. No network: every git call is local to the scratch repository.
 *
 *   Usage:
 *     bun scripts/actions/verify-bundle.ts <bundle-path> <base_sha> <scratch-dir>
 *   `<scratch-dir>` is a caller-prepared git repository under $RUNNER_TEMP that
 *   contains `<base_sha>` (typically a bare clone at the dispatched base). The
 *   verified snapshot and the `refs/rw-verify/tip` ref are written there.
 *
 *   stdout: one bounded line (max 400 chars). `accepted tip=<sha> files=<n>` on
 *   success, `refused: <reason>` otherwise, where the reason is one of
 *   change-ingest's fixed strings — never a path from inside the bundle.
 *   Exit 0 accepted, 1 refused (including a symlinked, absent, or unreadable
 *   bundle: gate 2 refuses those), 3 harness (bad args, missing scratch dir,
 *   missing git, scratch repository lacking the base).
 *
 *   The scratch repository's own hooks never run: main pins
 *   `core.hooksPath=/dev/null` through `GIT_CONFIG_COUNT` (command-line scope,
 *   above any repo or global config) before any git call. 826c2 must still build
 *   scratch as a fresh `git init --bare` plus a fetch of base from the forge,
 *   never from an artifact, so no repo config it did not write is ever read.
 *
 * @outputs
 *   - `runVerifyBundle` -- argv in, (exit code, output line) out
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { traced } from "../../src/log";
import { LocalBundleInspector, VERIFY_REF } from "../../src/results/bundle-inspector";
import { quarantinePathFor, verifyChangeBundle } from "../../src/results/change-ingest";

const MAX_LINE = 400;
const SHA40 = /^[0-9a-f]{40}$/;
const SNAPSHOT_NAME = "verify-bundle.snapshot";

export interface VerifyBundleOutcome {
	code: 0 | 1 | 3;
	line: string;
}

function done(code: 0 | 1 | 3, line: string): VerifyBundleOutcome {
	return { code, line: line.replace(/[\r\n]+/g, " ").slice(0, MAX_LINE) };
}

/** One fixed-argv git call; null when git itself cannot be spawned. */
function git(cwd: string, args: string[]): { exitCode: number; stdout: string } | null {
	try {
		const out = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" },
		});
		return { exitCode: out.exitCode, stdout: out.stdout.toString().trim() };
	} catch {
		return null;
	}
}

async function runVerifyBundleImpl(argv: readonly string[]): Promise<VerifyBundleOutcome> {
	const [bundleArg, baseSha, scratchArg] = argv;
	if (argv.length !== 3 || !bundleArg || !baseSha || !scratchArg) {
		return done(3, "usage: verify-bundle.ts <bundle-path> <base_sha> <scratch-dir>");
	}
	if (!SHA40.test(baseSha)) {
		return done(3, "harness: base_sha is not 40 lowercase hex");
	}
	const scratch = resolve(scratchArg);
	if (!existsSync(scratch)) {
		return done(3, "harness: scratch dir missing");
	}
	if (git(scratch, ["--version"]) === null) {
		return done(3, "harness: git is not available");
	}
	const bundlePath = resolve(bundleArg);
	if (git(scratch, ["cat-file", "-e", `${baseSha}^{commit}`])?.exitCode !== 0) {
		return done(3, "harness: scratch repository does not contain base_sha");
	}

	// A stale snapshot from a prior run would make the `wx` copy fail forever.
	const snapshotPath = join(scratch, SNAPSHOT_NAME);
	await unlink(snapshotPath).catch(() => undefined);
	await unlink(quarantinePathFor(snapshotPath)).catch(() => undefined);

	const verdict = await verifyChangeBundle({
		change: { base_sha: baseSha, bundle_path: basename(bundlePath) },
		jobOutputDir: dirname(bundlePath),
		dispatchedBaseSha: baseSha,
		snapshotPath,
		inspector: new LocalBundleInspector(scratch),
	});
	if (verdict.status === "rejected") {
		return done(1, `refused: ${verdict.reason}`);
	}
	const tip = git(scratch, ["rev-parse", "--verify", "--quiet", `${VERIFY_REF}^{commit}`]);
	if (tip?.exitCode !== 0 || !SHA40.test(tip.stdout)) {
		return done(3, "harness: accepted bundle tip could not be resolved");
	}
	return done(0, `accepted tip=${tip.stdout} files=${verdict.changedFiles.length}`);
}

export const runVerifyBundle = traced("actions.runVerifyBundle", runVerifyBundleImpl);

if (import.meta.main) {
	// sf#826 review P2: the inspector spreads process.env, so pin hooks off here;
	// a scratch repo's reference-transaction hook must never run on fetch.
	process.env.GIT_CONFIG_COUNT = "1";
	process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
	process.env.GIT_CONFIG_VALUE_0 = "/dev/null";
	process.env.GIT_TERMINAL_PROMPT = "0";
	const outcome = await runVerifyBundle(process.argv.slice(2));
	process.stdout.write(`${outcome.line}\n`);
	process.exit(outcome.code);
}
