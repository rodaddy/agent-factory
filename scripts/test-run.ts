// Run the test suite with a persistent record of every run.
//
// A test run's only output used to be whatever stdout the caller kept; one
// `| tail` erased a real failure with no way to recover it. Every run
// now writes three files under SF_TEST_RUN_DIR (default `_reports/test-runs/`,
// gitignored): the full console stream, bun's junit report, and a summary
// with the exit code. Console output still streams live, and the exit code
// passes through unchanged so callers and hooks see the real result.
//
// Usage: bun scripts/test-run.ts [--affected <base>] [--shards <n> | --shard <i>/<n>] [bun test args...]
//
// --affected <base> runs only the tests scripts/affected-tests.ts
// selects against <base>: NONE runs no `bun test` and exits 0, a list runs
// those files, FULL runs the whole suite sharded (4 unless --shards says).
// --shards <n> (or SF_TEST_SHARDS) splits a FULL run's test files round-robin
// in sorted path order into n `bun test` processes run at once; each writes its
// own log and junit, each log is printed whole when its shard ends, and the
// exit code is non-zero when any shard fails. DB tests need no change for
// this: every scratch database name carries the process pid
// (tests/db/helpers.ts) and the template build is serialized by an advisory
// lock in the cluster.
//
// --shard <i>/<n> (one CI matrix job of n) runs only slice i of the selected
// files (the named files, else the --affected selection, else the whole
// suite) in ONE `bun test` process; scripts/test-shard.ts deals the files by
// size so each slice gets a heavy one. An empty slice exits 0.
//
// Record directory, first match wins: SF_TEST_RUN_DIR; then
// RODADDY_WATCHER_TEST_TMP/test-runs (the pre-push receipt sandbox binds the
// checkout READ-ONLY and exports that variable as its only writable tree, see
// src/prepush/body-sections.ts); then _reports/test-runs in the checkout.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { affectedTests } from "./affected-tests";
import { parseShard, shardSlice, splitTestArgs, testFileArg } from "./test-shard";

/** An env var is set only when it is non-empty after trimming, as tests/support/test-temp.ts rules. */
function envDir(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

/** A FULL fallback of --affected runs this many shards unless told otherwise. */
const AFFECTED_FULL_SHARDS = 4;
const TEST_FILE = /(\.test|_test|\.spec|_spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

const repoRoot = resolve(import.meta.dir, "..");
const dir =
	envDir("SF_TEST_RUN_DIR") ??
	(envDir("RODADDY_WATCHER_TEST_TMP")
		? join(envDir("RODADDY_WATCHER_TEST_TMP") as string, "test-runs")
		: join(repoRoot, "_reports", "test-runs"));
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = join(dir, stamp);
const started = Date.now();

function bunTestArgv(junitPath: string, args: string[]): string[] {
	return [
		"bun",
		"test",
		// The per-test bound. It exists because a test's wall time here is
		// dominated by HOST latency — a CREATE DATABASE, a drizzle-kit push, a
		// spawned bash/node/bun — not by the candidate under test, and bun's own
		// default is 5000 ms (tests/db/helpers.ts, TIMEOUT CONTRACT; issue #47).
		//
		// Raised 30000 -> 120000 for sf#1082. Under runner load on 2026-09-29 two
		// tests whose own work is a few dozen milliseconds crossed 30 s inside a
		// `prepush validate` that had already passed them in its own `bun run check`
		// step: pr-review-chunks-shell's "a failed chunk fails the step 22" at
		// 34793 ms, and renderVerbScriptBody's "executes end to end against fixture
		// checkouts" at 30061 ms. Each false failure costs a whole second validate
		// cycle on a capacity-1 runner. 120 s is 4x the bound that broke and ~13x
		// the slowest honest test (9.1 s idle), and still surfaces a hung test
		// inside two minutes. The FLOOR is pinned by
		// tests/support/test-run-timeout.test.ts; raising it further needs no
		// permission, lowering it below the floor is a regression.
		//
		// It must stay a FLAG: bun does not honor `[test] timeout` from
		// bunfig.toml, so a config-file bound would be silently ineffective. It is
		// first in argv so a caller's own `--timeout` still wins.
		"--timeout=120000",
		"--reporter=junit",
		`--reporter-outfile=${junitPath}`,
		...args,
	];
}

interface Run {
	exitCode: number;
	logPath: string;
	junitPath: string | null;
}

/** One `bun test` process; `live` streams to the console, otherwise the log is printed whole at the end. */
async function runBunTest(prefix: string, args: string[], live: boolean): Promise<Run> {
	const logPath = `${prefix}.log`;
	const junitPath = `${prefix}.junit.xml`;
	const proc = Bun.spawn(bunTestArgv(junitPath, args), {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const sink = Bun.file(logPath).writer();
	async function tee(
		stream: ReadableStream<Uint8Array>,
		out: { write(chunk: Uint8Array): unknown },
	): Promise<void> {
		for await (const chunk of stream) {
			if (live) out.write(chunk);
			sink.write(chunk);
		}
	}
	await Promise.all([tee(proc.stdout, process.stdout), tee(proc.stderr, process.stderr)]);
	const exitCode = await proc.exited;
	await sink.end();
	if (!live) process.stdout.write(readFileSync(logPath));
	// bun writes no junit file when it never reaches a test file; do not point at one.
	return { exitCode, logPath, junitPath: existsSync(junitPath) ? junitPath : null };
}

/** The files bun would collect: tracked and untracked-not-ignored test files, sorted. */
function allTestFiles(): string[] {
	const out = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "-co", "--exclude-standard"], {
		encoding: "utf8",
		maxBuffer: 64 << 20,
	});
	if (out.status !== 0) throw new Error(`git ls-files failed: ${out.stderr}`);
	return out.stdout
		.split("\0")
		.filter((p) => TEST_FILE.test(p) && !p.split("/").includes("node_modules"))
		.filter((p) => existsSync(join(repoRoot, p)))
		.sort();
}

/** Round-robin split of sorted paths into `n` groups, dropping empty groups. */
function shardFiles(files: string[], n: number): string[][] {
	const groups: string[][] = Array.from({ length: n }, () => []);
	for (const [i, file] of files.entries()) groups[i % n]?.push(file);
	return groups.filter((g) => g.length > 0);
}

/** Test files with at least one failure in a bun junit report. */
function failingFiles(junitPath: string | null): string[] {
	if (junitPath === null) return [];
	const xml = readFileSync(junitPath, "utf8");
	return [...xml.matchAll(/<testsuite name="([^"]+)" file="[^"]*"[^>]*\sfailures="(\d+)"/g)]
		.filter((m) => Number(m[2]) > 0)
		.map((m) => m[1] as string);
}

async function writeSummary(summary: Record<string, unknown>): Promise<void> {
	await Bun.write(
		`${base}.summary.json`,
		`${JSON.stringify({ started: new Date(started).toISOString(), ms: Date.now() - started, ...summary }, null, 2)}\n`,
	);
}

async function runSharded(n: number, args: string[]): Promise<number> {
	const groups = shardFiles(allTestFiles(), n);
	process.stderr.write(
		`test-run: ${groups.length} shards over ${groups.flat().length} test files\n`,
	);
	const runs = await Promise.all(
		groups.map((files, i) =>
			runBunTest(`${base}.shard-${i + 1}`, [...args, ...files.map((f) => `./${f}`)], false),
		),
	);
	const shards = runs.map((run, i) => ({
		shard: i + 1,
		files: groups[i]?.length ?? 0,
		...run,
		failing: run.exitCode === 0 ? [] : failingFiles(run.junitPath),
	}));
	const failed = shards.filter((s) => s.exitCode !== 0);
	const exitCode = failed.length === 0 ? 0 : (failed[0]?.exitCode ?? 1);
	await writeSummary({ exitCode, args, shards });
	for (const s of failed) {
		process.stderr.write(
			`test-run: shard ${s.shard} exit ${s.exitCode}, log ${s.logPath}, failing: ${s.failing.join(" ") || "(no failing file in junit; read the log)"}\n`,
		);
	}
	process.stderr.write(
		`test-run: exit ${exitCode}, ${shards.length} shards, summary ${base}.summary.json\n`,
	);
	return exitCode;
}

async function runSingle(args: string[]): Promise<number> {
	const run = await runBunTest(base, args, true);
	await writeSummary({
		exitCode: run.exitCode,
		args,
		logPath: run.logPath,
		junitPath: run.junitPath,
	});
	process.stderr.write(
		`test-run: exit ${run.exitCode}, log ${run.logPath}, junit ${run.junitPath}\n`,
	);
	return run.exitCode;
}

/** Strip a leading `--flag value` pair from args. */
function takeFlag(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i < 0) return undefined;
	const value = args[i + 1];
	if (value === undefined || value.startsWith("--")) {
		throw new Error(`test-run: ${flag} needs a value`);
	}
	args.splice(i, 2);
	return value;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const affectedBase = takeFlag(args, "--affected");
	const slice = takeFlag(args, "--shard");
	if (slice !== undefined) return runSlice(slice, affectedBase, args);
	const shardFlag = takeFlag(args, "--shards") ?? envDir("SF_TEST_SHARDS");
	let shards = shardFlag === undefined ? 1 : Number(shardFlag);
	if (!Number.isInteger(shards) || shards < 1)
		throw new Error(`test-run: bad shard count ${shardFlag}`);
	if (affectedBase !== undefined) {
		const affected = affectedTests(repoRoot, affectedBase);
		if (affected.kind === "none") {
			const note = `no affected tests (${affected.changed} changed files)`;
			await writeSummary({ exitCode: 0, args, affectedBase, note });
			process.stderr.write(`test-run: ${note}, exit 0\n`);
			return 0;
		}
		if (affected.kind === "list") {
			process.stderr.write(
				`test-run: ${affected.tests.length} affected test files (${affected.changed} changed files)\n`,
			);
			return runSingle([...args, ...affected.tests.map((f) => `./${f}`)]);
		}
		process.stderr.write(`test-run: FULL (${affected.reason})\n`);
		if (shardFlag === undefined) shards = AFFECTED_FULL_SHARDS;
	}
	const positional = args.some((a) => !a.startsWith("-") && !/^\d+$/.test(a));
	return shards > 1 && !positional ? runSharded(shards, args) : runSingle(args);
}

/** --shard <i>/<n>: one slice of the selection, one `bun test` process (this job is one of n). */
async function runSlice(spec: string, affectedBase: string | undefined, args: string[]) {
	const { index, total } = parseShard(spec);
	const { options: flags, files: named } = splitTestArgs(args);
	let selection: string[];
	if (named.length > 0) selection = named;
	else if (affectedBase === undefined) selection = allTestFiles();
	else {
		const affected = affectedTests(repoRoot, affectedBase);
		selection =
			affected.kind === "none" ? [] : affected.kind === "list" ? affected.tests : allTestFiles();
	}
	const slice = shardSlice(
		selection.map((path) => ({ path, size: statSync(testFileArg(repoRoot, path).stat).size })),
		index,
		total,
	);
	if (slice.length === 0) {
		const note = `shard ${spec}: empty slice of ${selection.length} test files`;
		await writeSummary({ exitCode: 0, args, affectedBase, shard: spec, note });
		process.stderr.write(`test-run: ${note}, exit 0\n`);
		return 0;
	}
	process.stderr.write(
		`test-run: shard ${spec}: ${slice.length} of ${selection.length} test files\n`,
	);
	return runSingle([...flags, ...slice.map((f) => testFileArg(repoRoot, f).arg)]);
}

if (import.meta.main) {
	process.exitCode = await main();
}
