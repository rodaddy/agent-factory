// Select the tests a change can reach.
//
// "If you didn't change anything that's affecting any of the
// tests, what is the point of running all of the tests?" The pre-push receipt
// and factory/prepush run only these; main runs the full suite after merge
// (.forgejo/workflows/main-full-suite.yml), so a miss here is caught there.
//
// The selection is deterministic: the changed paths (`git diff --name-only
// <base>...HEAD`) and the bytes of the tracked files decide it, nothing else.
// FULL is the answer to every doubt: a toolchain or shared-harness path, more
// than MAX_CHANGED paths, a deleted module, a base that does not resolve, or
// any error.
//
// Otherwise a test is selected when (a) it changed and still exists, (b) it
// imports a changed module directly or transitively (static relative
// `import`/`export ... from`, `import()`, `require()` over tests/, src/,
// scripts/, fleet/), or (c) it, or a module it reaches, names the basename (no extension, at
// least 4 characters) of a changed non-test, non-doc file. (c) is how tests
// reach shell scripts, data and spawned entrypoints by path, so it applies to
// every changed path outside the doc trees; over-selecting is the safe error.
//
// Usage: bun scripts/affected-tests.ts <base>
//   prints `FULL <reason>`, `NONE`, or one test path per line; exits 0.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

export type Affected =
	| { kind: "full"; reason: string }
	| { kind: "none"; changed: number }
	| { kind: "list"; tests: string[]; changed: number };

/** More changed paths than this is a sweep, not a change: run everything. */
export const MAX_CHANGED = 200;

const FULL_EXACT = new Set([
	"package.json",
	"bunfig.toml",
	"biome.json",
	".oxlintrc.json",
	"drizzle.config.ts",
	"scripts/test-run.ts",
	"scripts/affected-tests.ts",
	".forgejo/workflows/prepush.yml",
]);
const FULL_PREFIXES = ["tests/support/", "tests/helpers/", "drizzle/", "src/db/", "specs/"];
const FULL_PATTERNS = [/^bun\.lock/, /^tsconfig[^/]*\.json$/];

/** Trees whose files no test reads: a change confined to them selects nothing. */
const DOC_PREFIXES = ["_DOCS/", "_reports/", "_tasks/", ".prd/", "planning/", "k3s-era/"];

/** The trees the import graph is built over. */
export const GRAPH_ROOTS = ["tests", "src", "scripts", "fleet"];

const MODULE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /(\.test|_test|\.spec|_spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/g;

function fullReason(path: string): string | null {
	if (FULL_EXACT.has(path)) return `${path} changed`;
	if (FULL_PREFIXES.some((p) => path.startsWith(p))) return `${path} changed`;
	if (FULL_PATTERNS.some((p) => p.test(path))) return `${path} changed`;
	return null;
}

function isDoc(path: string): boolean {
	if (DOC_PREFIXES.some((p) => path.startsWith(p))) return true;
	return !path.includes("/") && path.endsWith(".md");
}

/** Resolve a relative specifier the way bun does for this repo's sources. */
function resolveSpecifier(
	from: string,
	spec: string,
	files: Record<string, string>,
): string | null {
	const p = posix.normalize(posix.join(posix.dirname(from), spec));
	const candidates = [p, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}/index.ts`, `${p}/index.js`];
	if (p.endsWith(".js")) candidates.push(`${p.slice(0, -3)}.ts`);
	return candidates.find((c) => c in files) ?? null;
}

/** importer lists keyed by the imported module. */
function reverseGraph(files: Record<string, string>): Map<string, string[]> {
	const rev = new Map<string, string[]>();
	for (const [path, source] of Object.entries(files)) {
		if (!MODULE.test(path)) continue;
		for (const m of source.matchAll(SPECIFIER)) {
			const target = resolveSpecifier(path, m[1] as string, files);
			if (target === null || target === path) continue;
			const list = rev.get(target) ?? [];
			list.push(path);
			rev.set(target, list);
		}
	}
	return rev;
}

function basenameKey(path: string): string | null {
	const base = posix.basename(path);
	const dot = base.lastIndexOf(".");
	const key = dot > 0 ? base.slice(0, dot) : base;
	return key.length >= 4 ? key : null;
}

/**
 * Pure selection: `changed` is the diff's path list, `files` maps every tracked
 * file under GRAPH_ROOTS (repo-relative) to its source text.
 */
export function selectAffected(changed: string[], files: Record<string, string>): Affected {
	for (const path of changed) {
		const reason = fullReason(path);
		if (reason !== null) return { kind: "full", reason };
	}
	if (changed.length > MAX_CHANGED) {
		return { kind: "full", reason: `${changed.length} changed files (more than ${MAX_CHANGED})` };
	}
	// A deleted module's importers are invisible from HEAD, so its reach is unknown.
	for (const path of changed) {
		const root = path.split("/")[0] as string;
		if (GRAPH_ROOTS.includes(root) && MODULE.test(path) && !TEST.test(path) && !(path in files)) {
			return { kind: "full", reason: `${path} deleted` };
		}
	}
	const selected = new Set<string>();
	const queue = changed.filter((p) => p in files && MODULE.test(p));
	// (c): any source naming a changed file's basename, test or module; a module
	// hit seeds the import walk so the tests that reach it are selected too.
	for (const path of changed) {
		if (TEST.test(path) || isDoc(path)) continue;
		const key = basenameKey(path);
		if (key === null) continue;
		for (const [file, source] of Object.entries(files)) {
			if (file !== path && source.includes(key)) queue.push(file);
		}
	}
	const rev = reverseGraph(files);
	const seen = new Set<string>();
	while (queue.length > 0) {
		const path = queue.pop() as string;
		if (seen.has(path)) continue;
		seen.add(path);
		if (TEST.test(path)) selected.add(path);
		for (const importer of rev.get(path) ?? []) queue.push(importer);
	}
	if (selected.size === 0) return { kind: "none", changed: changed.length };
	return { kind: "list", tests: [...selected].sort(), changed: changed.length };
}

function git(root: string, args: string[]): string {
	const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
	if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim()}`);
	return r.stdout;
}

/** Read the diff and the tracked graph sources at `root`; FULL on any failure. */
export function affectedTests(root: string, base: string): Affected {
	try {
		const resolved = spawnSync(
			"git",
			["-C", root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`],
			{ encoding: "utf8" },
		);
		if (resolved.status !== 0) return { kind: "full", reason: `base ${base} does not resolve` };
		const changed = git(root, ["diff", "--no-renames", "--name-only", "-z", `${base}...HEAD`])
			.split("\0")
			.filter((p) => p !== "");
		const files: Record<string, string> = {};
		for (const path of git(root, ["ls-files", "-z", "--", ...GRAPH_ROOTS]).split("\0")) {
			if (path === "" || !(MODULE.test(path) || TEST.test(path))) continue;
			const abs = resolve(root, path);
			if (existsSync(abs)) files[path] = readFileSync(abs, "utf8");
		}
		return selectAffected(changed, files);
	} catch (error) {
		return { kind: "full", reason: `selection failed: ${(error as Error).message}` };
	}
}

/** The one-line-per-answer CLI rendering. */
export function renderAffected(result: Affected): string {
	if (result.kind === "full") return `FULL ${result.reason}`;
	if (result.kind === "none") return "NONE";
	return result.tests.join("\n");
}

if (import.meta.main) {
	const base = process.argv[2];
	const result: Affected = base
		? affectedTests(process.cwd(), base)
		: { kind: "full", reason: "no base given" };
	process.stdout.write(`${renderAffected(result)}\n`);
}
