/**
 * @module actions/rails-check
 * @description CLI over the factory rails (829c1) for the verb propose
 *   job. Runs the SAME `evaluateRails` the watcher runs before any push
 *   (src/results/proposal-pass.ts: rails, push, plan) — imported, never copied —
 *   on the YAML the verified tip changed. The rendered YAML is read out of the
 *   scratch repository at `refs/rw-verify/tip` (written by verify-bundle.ts),
 *   never from the untrusted artifact tree; the changed-path set is the one the
 *   watcher's loader uses (src/rails/artifact.ts: `*.yml`/`*.yaml`,
 *   `--diff-filter=ACMRT`, base..tip).
 *
 *   Usage:
 *     bun scripts/actions/rails-check.ts <manifest-path> <scratch-dir> <base_sha> <manifest_sha256>
 *   `<manifest-path>` is the factory-rails.yml the TRUSTED side read from
 *   rtech-infra at the pinned sha; its sha256 must equal `<manifest_sha256>`.
 *
 *   stdout: one bounded line (max 400 chars). `rails: ok`, `rails: hold:
 *   <fixed reason>` (the rendered YAML could not be read or parsed), or
 *   `rails: violated: <constraint ids>`. Exit 0 ok, 1 hold or violated,
 *   3 harness (bad args, no verified tip, git failure, manifest absent,
 *   malformed, or not the pinned bytes).
 *
 * @outputs
 *   - `runRailsCheck` -- argv in, (exit code, output line) out
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { traced } from "../../src/log";
import { evaluateRails } from "../../src/rails/enforce";
import { VERIFY_REF } from "../../src/results/bundle-inspector";

const MAX_LINE = 400;
const MAX_FILES = 500;
const MAX_BYTES = 1024 * 1024;
const SEPARATOR = "\n---\n";
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MANIFEST_FAILURES = new Set(["manifest-absent", "manifest-invalid", "manifest-stale"]);
const ARTIFACT_FAILURES = new Set(["artifact-absent", "artifact-invalid"]);

export interface RailsCheckOutcome {
	code: 0 | 1 | 3;
	line: string;
}

function done(code: 0 | 1 | 3, line: string): RailsCheckOutcome {
	return { code, line: line.replace(/[\r\n]+/g, " ").slice(0, MAX_LINE) };
}

/** One fixed-argv git call; null when git cannot be spawned or the call fails. */
function git(cwd: string, args: string[]): string | null {
	return gitBytes(cwd, args)?.toString() ?? null;
}

/** One fixed-argv git call returning raw stdout bytes; null on failure. */
function gitBytes(cwd: string, args: string[]): Buffer | null {
	try {
		const out = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: gitEnv(),
		});
		return out.exitCode === 0 && out.stdout ? Buffer.from(out.stdout) : null;
	} catch {
		return null;
	}
}

function gitEnv(): Record<string, string | undefined> {
	return { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C" };
}

const UNREADABLE = "harness: rendered file unreadable";
const STDERR_CAP = 4096;
const DETAIL_CAP = 200;

type Shown = { kind: "ok"; text: string } | { kind: "over" } | { kind: "fail"; message: string };

/** The harness message for a failed `git show`, naming its first stderr line. */
function unreadableMessage(stderr: string): string {
	const line = stderr
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return line ? `${UNREADABLE}: ${line.slice(0, DETAIL_CAP)}` : UNREADABLE;
}

/** Drain a stream, keeping only its first `cap` bytes. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
	const chunks: Uint8Array[] = [];
	let kept = 0;
	for await (const chunk of stream) {
		if (kept >= cap) continue;
		const part = chunk.subarray(0, cap - kept);
		chunks.push(part);
		kept += part.byteLength;
	}
	return Buffer.concat(chunks).toString();
}

/** Stream stdout under `budget`; the child is killed as soon as it passes. */
async function readBudget(
	child: ReturnType<typeof Bun.spawn>,
	budget: number,
): Promise<Uint8Array[] | null> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
		total += chunk.byteLength;
		if (total > budget) {
			child.kill();
			return null;
		}
		chunks.push(chunk);
	}
	return chunks;
}

/**
 * `git show <spec>` streamed with a byte budget: the child is killed as soon as
 * the output passes `budget`, so a huge blob is never buffered whole. `{ kind: "over" }`
 * past the budget (a tagged result, so no file content can collide with it),
 * `{ kind: "fail" }` carrying the harness message when git cannot be spawned or
 * the call fails. stderr is drained concurrently so neither pipe can block.
 */
async function showCappedImpl(cwd: string, spec: string, budget: number): Promise<Shown> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(["git", "show", spec], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: gitEnv(),
		});
	} catch {
		return { kind: "fail", message: UNREADABLE };
	}
	const [chunks, stderr] = await Promise.all([
		readBudget(child, budget),
		readCapped(child.stderr as ReadableStream<Uint8Array>, STDERR_CAP),
	]);
	const code = await child.exited;
	if (chunks === null) return { kind: "over" };
	if (code !== 0) return { kind: "fail", message: unreadableMessage(stderr) };
	return { kind: "ok", text: Buffer.concat(chunks).toString() };
}

export const showCapped = traced("actions.showCapped", showCappedImpl);

/**
 * Split `git diff --name-only -z` output as raw bytes. Null when any path is
 * not valid UTF-8: decoding would collapse bad bytes to U+FFFD and two
 * distinct paths could map to one (factory P1 on PR #934).
 */
function splitChangedPathsImpl(raw: Buffer): string[] | null {
	const paths: string[] = [];
	let start = 0;
	while (start < raw.length) {
		let end = raw.indexOf(0, start);
		if (end === -1) end = raw.length;
		const bytes = raw.subarray(start, end);
		start = end + 1;
		if (bytes.length === 0) continue;
		const path = bytes.toString();
		if (!Buffer.from(path).equals(bytes)) return null;
		paths.push(path);
	}
	return paths;
}

export const splitChangedPaths = traced("actions.splitChangedPaths", splitChangedPathsImpl);

/** The YAML the verified tip changed, joined as one multi-document artifact. */
async function renderedArtifact(
	scratch: string,
	baseSha: string,
	tip: string,
): Promise<string | RailsCheckOutcome> {
	const changed = gitBytes(scratch, [
		"diff",
		"--name-only",
		"-z",
		"--diff-filter=ACMRT",
		baseSha,
		tip,
		"--",
		"*.yml",
		"*.yaml",
	]);
	if (changed === null) return done(3, "harness: changed paths unreadable");
	const paths = splitChangedPaths(changed);
	if (paths === null) return done(1, "rails: hold: artifact-invalid");
	if (paths.length > MAX_FILES) return done(1, "rails: hold: artifact-file-limit");
	const documents: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		// The join separator is part of the artifact, so it spends budget too
		// (factory run 2198 on PR #934).
		if (documents.length > 0) bytes += Buffer.byteLength(SEPARATOR);
		if (bytes > MAX_BYTES) return done(1, "rails: hold: artifact-byte-limit");
		const shown = await showCapped(scratch, `${tip}:${path}`, MAX_BYTES - bytes);
		if (shown.kind === "fail") return done(3, shown.message);
		if (shown.kind === "over") return done(1, "rails: hold: artifact-byte-limit");
		// The stream cap bounds RAW git bytes; decoding invalid UTF-8 expands each
		// bad byte to a 3-byte replacement character, so the rendered size is
		// re-checked after decoding (factory verdict on PR #934).
		bytes += Buffer.byteLength(shown.text);
		if (bytes > MAX_BYTES) return done(1, "rails: hold: artifact-byte-limit");
		documents.push(shown.text);
	}
	return documents.join(SEPARATOR);
}

async function runRailsCheckImpl(argv: readonly string[]): Promise<RailsCheckOutcome> {
	const [manifestArg, scratchArg, baseSha, manifestSha] = argv;
	if (argv.length !== 4 || !manifestArg || !scratchArg || !baseSha || !manifestSha) {
		return done(
			3,
			"usage: rails-check.ts <manifest-path> <scratch-dir> <base_sha> <manifest_sha256>",
		);
	}
	if (!SHA40.test(baseSha)) return done(3, "harness: base_sha is not 40 lowercase hex");
	if (!SHA256.test(manifestSha)) return done(3, "harness: manifest_sha256 is not 64 lowercase hex");
	const scratch = resolve(scratchArg);
	if (!existsSync(scratch)) return done(3, "harness: scratch dir missing");
	const tip = git(scratch, ["rev-parse", "--verify", "--quiet", `${VERIFY_REF}^{commit}`])?.trim();
	if (!tip || !SHA40.test(tip)) return done(3, "harness: no verified tip in scratch");

	const artifact = await renderedArtifact(scratch, baseSha, tip);
	if (typeof artifact !== "string") return artifact;

	const rails = await evaluateRails({
		manifestPath: resolve(manifestArg),
		expectedSha: manifestSha,
		artifact,
	});
	const [first] = rails.violated;
	if (first !== undefined && MANIFEST_FAILURES.has(first)) {
		return done(3, `harness: rails ${first}`);
	}
	if (first !== undefined && ARTIFACT_FAILURES.has(first)) {
		return done(1, `rails: hold: ${first}`);
	}
	if (rails.violated.length > 0) return done(1, `rails: violated: ${rails.violated.join(",")}`);
	return done(0, "rails: ok");
}

export const runRailsCheck = traced("actions.runRailsCheck", runRailsCheckImpl);

if (import.meta.main) {
	process.env.GIT_CONFIG_COUNT = "1";
	process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
	process.env.GIT_CONFIG_VALUE_0 = "/dev/null";
	const outcome = await runRailsCheck(process.argv.slice(2));
	process.stdout.write(`${outcome.line}\n`);
	process.exit(outcome.code);
}
