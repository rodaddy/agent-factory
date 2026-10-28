/**
 * @module tests/fleet/delta-check
 * @description `fleet/skills/review-pr/bin/delta-check`, run as a
 *   real child process against throwaway git repos. A head that only merges
 *   main into the approved head is `clean`; a conflict resolution or an evil
 *   merge is `resolved` and names the files to review; anything else is
 *   `not-a-main-merge`. `DELTA_CHECK_UNDER_TEST` points the suite at a mutated
 *   copy of the script.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT =
	process.env.DELTA_CHECK_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/review-pr/bin/delta-check");

let root = "";
let count = 0;

beforeAll(() => {
	// The OS temp dir, as tests/fleet/install.test.ts does: the receipt sandbox mounts the checkout read-only.
	root = mkdtempSync(join(tmpdir(), "delta-check-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Deterministic identity, no global/system config: every git subprocess in this file uses it. */
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
};

function git(repo: string, ...args: string[]): string {
	const p = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV });
	if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
	return p.stdout.trim();
}

function commitFile(repo: string, file: string, body: string, msg: string): string {
	writeFileSync(join(repo, file), body);
	git(repo, "add", file);
	git(repo, "commit", "-q", "-m", msg);
	return git(repo, "rev-parse", "HEAD");
}

/** main's base commit holds a.txt and b.txt; branch pr changes a.txt (the approved head P); origin/main tracks main. */
function setup(): { repo: string; P: string } {
	count += 1;
	const repo = join(root, `repo-${count}`);
	git(root, "init", "-q", "-b", "main", repo);
	writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
	git(repo, "add", "a.txt");
	commitFile(repo, "b.txt", "bee\n", "base");
	if (git(repo, "ls-tree", "--name-only", "HEAD") !== "a.txt\nb.txt") {
		throw new Error("base commit must hold a.txt and b.txt");
	}
	git(repo, "checkout", "-q", "-b", "pr");
	const P = commitFile(repo, "a.txt", "one\nTWO-pr\nthree\n", "pr change");
	git(repo, "checkout", "-q", "main");
	return { repo, P };
}

/** Point origin/main at main's tip, as `git fetch origin` would. */
function publishMain(repo: string): void {
	git(repo, "update-ref", "refs/remotes/origin/main", "main");
}

/**
 * Merge `other` into pr (P), let `fix` resolve it, return the merge sha. With
 * `conflicts`, the merge must stop on exactly those unmerged paths; without,
 * it must succeed. Any other merge outcome throws.
 */
function mergeInto(repo: string, other: string, fix?: () => void, conflicts?: string[]): string {
	git(repo, "checkout", "-q", "pr");
	const m = spawnSync("git", ["-C", repo, "merge", "-q", "--no-ff", "--no-commit", other], {
		encoding: "utf8",
		env: GIT_ENV,
	});
	const unmerged = git(repo, "diff", "--name-only", "--diff-filter=U");
	const want = conflicts
		? { status: 1, unmerged: conflicts.join("\n") }
		: { status: 0, unmerged: "" };
	if (m.status !== want.status || unmerged !== want.unmerged) {
		throw new Error(
			`git merge ${other}: exit ${m.status} unmerged [${unmerged}], expected exit ${want.status} unmerged [${want.unmerged}]: ${m.stdout}${m.stderr}`,
		);
	}
	fix?.();
	git(repo, "commit", "-q", "-m", `merge ${other}`);
	return git(repo, "rev-parse", "HEAD");
}

function run(...args: string[]): { code: number | null; out: unknown; stderr: string } {
	const p = spawnSync("python3", [SCRIPT, ...args], { encoding: "utf8" });
	return {
		code: p.status,
		out: p.status === 0 ? JSON.parse(p.stdout) : p.stdout,
		stderr: p.stderr,
	};
}

test("a clean merge of main into the approved head is clean", () => {
	const { repo, P } = setup();
	commitFile(repo, "c.txt", "sea\n", "main adds c");
	publishMain(repo);
	const H = mergeInto(repo, "main");
	expect(run(repo, P, H)).toEqual({
		code: 0,
		out: { kind: "clean", files: [], approved: P, verdict: "approve" },
		stderr: "",
	});
});

test("a clean delta round's verdict word is approve, even after approve-with-fixes", () => {
	// A delta round is round 2 or later, and the stop rule gives round 2+ with
	// no P0/P1 `approve`; the previous round's P2s become follow-ups.
	const { repo, P } = setup();
	commitFile(repo, "c.txt", "sea\n", "main adds c");
	publishMain(repo);
	const H = mergeInto(repo, "main");
	const r = run(repo, P, H);
	expect((r.out as { verdict?: string }).verdict).toBe("approve");
	expect((r.out as { verdict?: string }).verdict).not.toBe("approve-with-fixes");
});

test("a merge that resolves a conflict is resolved, naming the conflicted file", () => {
	const { repo, P } = setup();
	commitFile(repo, "a.txt", "one\nTWO-main\nthree\n", "main changes a");
	publishMain(repo);
	const H = mergeInto(
		repo,
		"main",
		() => {
			writeFileSync(join(repo, "a.txt"), "one\nTWO-both\nthree\n");
			git(repo, "add", "a.txt");
		},
		["a.txt"],
	);
	expect(run(repo, P, H)).toEqual({
		code: 0,
		out: { kind: "resolved", files: ["a.txt"], approved: P },
		stderr: "",
	});
});

test("a one-parent commit on the approved head is not a main merge", () => {
	const { repo, P } = setup();
	publishMain(repo);
	git(repo, "checkout", "-q", "pr");
	const H = commitFile(repo, "b.txt", "bee2\n", "more pr work");
	expect(run(repo, P, H)).toEqual({
		code: 0,
		out: { kind: "not-a-main-merge", files: [], reason: "head has 1 parent(s), not 2" },
		stderr: "",
	});
});

test("a merge of a side branch that is not on main is not a main merge", () => {
	const { repo, P } = setup();
	publishMain(repo);
	git(repo, "checkout", "-q", "-b", "side", "main");
	const side = commitFile(repo, "d.txt", "dee\n", "side work");
	const H = mergeInto(repo, "side");
	expect(run(repo, P, H)).toEqual({
		code: 0,
		out: {
			kind: "not-a-main-merge",
			files: [],
			reason: `head's second parent ${side.slice(0, 7)} is not on origin/main`,
		},
		stderr: "",
	});
});

test("a merge with the approved head as SECOND parent is not a main merge", () => {
	const { repo, P } = setup();
	const M = commitFile(repo, "c.txt", "sea\n", "main adds c");
	publishMain(repo);
	git(repo, "merge", "-q", "--no-ff", "-m", "merge pr into main", "pr");
	const H = git(repo, "rev-parse", "HEAD");
	expect(run(repo, P, H)).toEqual({
		code: 0,
		out: {
			kind: "not-a-main-merge",
			files: [],
			reason: `head's first parent ${M.slice(0, 7)} is not the approved head ${P.slice(0, 7)}`,
		},
		stderr: "",
	});
});

test("an evil merge that also edits another file is resolved, naming that file", () => {
	const { repo, P } = setup();
	commitFile(repo, "c.txt", "sea\n", "main adds c");
	publishMain(repo);
	const H = mergeInto(repo, "main", () => {
		writeFileSync(join(repo, "b.txt"), "bee-evil\n");
		git(repo, "add", "b.txt");
	});
	expect(run(repo, P, H)).toEqual({
		code: 0,
		out: { kind: "resolved", files: ["b.txt"], approved: P },
		stderr: "",
	});
});

test("a bad sha exits 2 and stderr names the git command", () => {
	const { repo, P } = setup();
	const r = run(repo, P, "f".repeat(40));
	expect(r.code).toBe(2);
	expect(r.out).toBe("");
	expect(r.stderr).toBe(
		`delta-check: git rev-parse --verify --quiet ${"f".repeat(40)}^{commit} exited 1\n`,
	);
});

test("the wrong argument count exits 1 with usage", () => {
	const r = run("only-one");
	expect(r.code).toBe(1);
	expect(r.stderr).toStartWith("Usage: delta-check <repo-dir> <approved-sha> <head-sha>");
});
