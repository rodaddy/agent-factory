/**
 * @module tests/results/bundle-inspector
 * @description Behavior tests for the production `BundleInspector` against
 *   REAL git repositories and REAL bundles.
 *
 *   These deliberately use no fakes. `change-ingest`'s own suite injects a
 *   double that decides its own answers, which proves the gate's control flow
 *   but cannot prove that git accepts a bundle, that the prerequisite it reports
 *   is the dispatched base, or that the diff finds the escalation path. Those
 *   are the claims this module exists to make, and the only thing that can
 *   settle them is git.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalBundleInspector, VERIFY_REF } from "../../src/results/bundle-inspector";
import { verifyChangeBundle } from "../../src/results/change-ingest";
import { testTmpBase } from "../support/test-temp";

/** Every fixture created by this file, removed once at teardown. */
const fixtures: string[] = [];

afterAll(() => {
	for (const dir of fixtures) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Run git with a fixed argv, failing loudly so a broken fixture is not silent. */
function git(cwd: string, args: string[]): string {
	const out = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	if (out.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString()}`);
	}
	return out.stdout.toString().trim();
}

/**
 * A real repository with one base commit, a second commit adding `changedFiles`,
 * and a bundle of `base..HEAD`. Returns the pieces an inspection needs plus a
 * bare scratch clone pinned at the base, which is what production hands the
 * inspector.
 */
function fixture(
	changedFiles: Record<string, string> = { "src/a.ts": "b\n" },
	baseContents = "a\n",
) {
	const root = mkdtempSync(join(testTmpBase(), "bundle-inspector-"));
	fixtures.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });

	// `core.hooksPath` is neutralized so this repo's own protected-branch hooks
	// never fire on a throwaway fixture.
	//
	// `baseContents` is a parameter because two fixtures created in the same
	// second from the same content produce the SAME base sha -- identical tree,
	// author, and timestamp -- so they share history rather than being unrelated.
	// Varying the base content is what makes a genuinely foreign bundle.
	git(repo, ["init", "-q", "-b", "work"]);
	git(repo, ["config", "core.hooksPath", "/dev/null"]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	git(repo, ["config", "user.name", "test"]);
	writeFileSync(join(repo, "base.txt"), baseContents);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", "base"]);
	const baseSha = git(repo, ["rev-parse", "HEAD"]);

	for (const [path, contents] of Object.entries(changedFiles)) {
		const full = join(repo, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, contents);
	}
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-qm", "work"]);
	const headSha = git(repo, ["rev-parse", "HEAD"]);

	const bundlePath = join(root, "change.bundle");
	git(repo, ["bundle", "create", "-q", bundlePath, `${baseSha}..HEAD`]);

	// The scratch clone the inspector runs in: it holds the base but NOT the
	// bundle's new commits, which is the state production is in at ingest.
	const scratch = join(root, "scratch.git");
	git(root, ["clone", "-q", "--bare", repo, scratch]);
	git(scratch, ["update-ref", "refs/heads/work", baseSha]);

	return { root, repo, scratch, baseSha, headSha, bundlePath };
}

describe("verify", () => {
	test("accepts a real, well-formed bundle", async () => {
		const f = fixture();
		const inspector = new LocalBundleInspector(f.scratch);
		expect(await inspector.verify(f.bundlePath)).toBe(true);
	});

	test("REJECTS a corrupt bundle rather than throwing", async () => {
		const f = fixture();
		const corrupt = join(f.root, "corrupt.bundle");
		writeFileSync(corrupt, "# v2 git bundle\nnot actually a bundle\n");
		const inspector = new LocalBundleInspector(f.scratch);
		expect(await inspector.verify(corrupt)).toBe(false);
	});

	test("REJECTS a bundle whose prerequisite the repository does not have", async () => {
		// A bundle built on some other history cannot be verified here, which is
		// what stops an unrelated tree being presented as an increment on ours.
		const ours = fixture();
		const theirs = fixture({ "src/other.ts": "x\n" }, "unrelated-history\n");
		expect(theirs.baseSha).not.toBe(ours.baseSha);
		const inspector = new LocalBundleInspector(ours.scratch);
		expect(await inspector.verify(theirs.bundlePath)).toBe(false);
	});

	test("does not throw on a path that does not exist", async () => {
		const f = fixture();
		const inspector = new LocalBundleInspector(f.scratch);
		expect(await inspector.verify(join(f.root, "absent.bundle"))).toBe(false);
	});
});

describe("requiredBases", () => {
	test("reports the EXACT dispatched base, full length and lowercased", async () => {
		const f = fixture();
		const inspector = new LocalBundleInspector(f.scratch);
		const bases = await inspector.requiredBases(f.bundlePath);
		expect(bases).toEqual([f.baseSha.toLowerCase()]);
	});

	test("does NOT report the bundle's contained tip as a prerequisite", async () => {
		// `git bundle verify` prints the contained ref and the required ref in the
		// same shape. Harvesting every sha in the output would return the tip too,
		// and the tip trivially equals itself -- so the base check would pass for a
		// bundle rooted anywhere.
		const f = fixture();
		const inspector = new LocalBundleInspector(f.scratch);
		const bases = await inspector.requiredBases(f.bundlePath);
		expect(bases).not.toContain(f.headSha.toLowerCase());
		expect(bases).toHaveLength(1);
	});

	test("throws when the bundle cannot be read", async () => {
		const f = fixture();
		const inspector = new LocalBundleInspector(f.scratch);
		expect(inspector.requiredBases(join(f.root, "absent.bundle"))).rejects.toThrow();
	});
});

describe("changedPaths", () => {
	test("returns the real changed paths, relative to the repository root", async () => {
		const f = fixture({ "src/a.ts": "b\n", "docs/readme.md": "c\n" });
		const inspector = new LocalBundleInspector(f.scratch);
		const paths = await inspector.changedPaths(f.bundlePath, f.baseSha);
		expect(paths.sort()).toEqual(["docs/readme.md", "src/a.ts"]);
	});

	test("finds a CI workflow path, which is what the scope gate refuses on", async () => {
		// The end-to-end claim: a runner that edits CI produces a bundle whose real
		// diff contains the workflow path. A fake cannot demonstrate this.
		const f = fixture({ "src/a.ts": "b\n", ".github/workflows/ci.yml": "on: push\n" });
		const inspector = new LocalBundleInspector(f.scratch);
		const paths = await inspector.changedPaths(f.bundlePath, f.baseSha);
		expect(paths).toContain(".github/workflows/ci.yml");
	});

	test("reports a path ADDED THEN REVERTED inside the bundle's own history", async () => {
		// The scope gate refuses a change that TOUCHES a CI path, so the question is
		// what the commits touched -- not what survives to the tip. A base-to-tip
		// `diff-tree` answers the second question: a bundle that adds
		// `.github/workflows/ci.yml` and then removes it nets to zero, reports no
		// workflow path, and walks straight through the gate this module exists to
		// enforce. Built as a real two-commit bundle rather than asserted.
		const root = mkdtempSync(join(testTmpBase(), "bundle-inspector-revert-"));
		fixtures.push(root);
		const repo = join(root, "repo");
		mkdirSync(repo, { recursive: true });
		git(repo, ["init", "-q", "-b", "work"]);
		git(repo, ["config", "core.hooksPath", "/dev/null"]);
		git(repo, ["config", "user.email", "test@example.invalid"]);
		git(repo, ["config", "user.name", "test"]);
		writeFileSync(join(repo, "base.txt"), "a\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", "base"]);
		const baseSha = git(repo, ["rev-parse", "HEAD"]);

		mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
		writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: push\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", "add ci"]);
		git(repo, ["rm", "-q", ".github/workflows/ci.yml"]);
		writeFileSync(join(repo, "src.txt"), "x\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", "remove ci, do real work"]);

		const bundlePath = join(root, "change.bundle");
		git(repo, ["bundle", "create", "-q", bundlePath, `${baseSha}..HEAD`]);
		const scratch = join(root, "scratch.git");
		git(root, ["clone", "-q", "--bare", repo, scratch]);

		const paths = await new LocalBundleInspector(scratch).changedPaths(bundlePath, baseSha);
		expect(paths).toContain(".github/workflows/ci.yml");
		// The net diff shows only src.txt, which is exactly why this is not a net diff.
		expect(
			git(scratch, ["diff-tree", "-r", "--no-commit-id", "--name-only", baseSha, "HEAD"]),
		).toBe("src.txt");
	});

	test("quarantines the bundle under refs/rw-verify/ and touches no real branch", async () => {
		const f = fixture();
		const before = git(f.scratch, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		const inspector = new LocalBundleInspector(f.scratch);
		await inspector.changedPaths(f.bundlePath, f.baseSha);
		const after = git(f.scratch, ["for-each-ref", "--format=%(refname) %(objectname)"]);
		// Every pre-existing ref still points where it did: the untrusted bundle
		// moved no branch.
		for (const line of before.split("\n").filter(Boolean)) {
			expect(after).toContain(line);
		}
		expect(git(f.scratch, ["rev-parse", VERIFY_REF])).toBe(f.headSha);
	});

	test("is repeatable: a second inspection overwrites the verify ref", async () => {
		const f = fixture();
		const inspector = new LocalBundleInspector(f.scratch);
		const first = await inspector.changedPaths(f.bundlePath, f.baseSha);
		const second = await inspector.changedPaths(f.bundlePath, f.baseSha);
		expect(second).toEqual(first);
	});

	test("THROWS rather than returning an empty list when the bundle carries no HEAD", async () => {
		// An empty return would be read by change-ingest as "touches no files" -- a
		// rejection, so it fails closed either way, but under a reason that hides
		// the real fault. Measured: with the explicit `HEAD:` refspec git fails at
		// the fetch (exit 128), so this asserts the throw, not which guard produced
		// it. The post-fetch ref resolution behind it covers the cases git does NOT
		// fail on: a wildcard refspec matching nothing exits zero, and a ref may
		// point at a non-commit object.
		const f = fixture();
		const headless = join(f.root, "headless.bundle");
		// A bundle whose only ref is a branch name, so `HEAD:` matches nothing.
		git(f.repo, ["bundle", "create", "-q", headless, `${f.baseSha}..refs/heads/work`]);
		const inspector = new LocalBundleInspector(f.scratch);
		expect(inspector.changedPaths(headless, f.baseSha)).rejects.toThrow();
	});
});

describe("end to end through the real gate", () => {
	/** The change-ingest boundary driven by the REAL inspector, no doubles. */
	async function runGate(f: ReturnType<typeof fixture>, dispatchedBaseSha = f.baseSha) {
		// Gate 1 confines the bundle to the job's own output directory, so the
		// bundle is addressed relative to the directory it actually lives in.
		return verifyChangeBundle({
			change: { base_sha: f.baseSha, bundle_path: "change.bundle" },
			jobOutputDir: f.root,
			dispatchedBaseSha,
			snapshotPath: join(f.root, "snapshot.bundle"),
			inspector: new LocalBundleInspector(f.scratch),
		});
	}

	test("ACCEPTS a real, in-scope change built on the dispatched base", async () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const out = await runGate(f);
		expect(out.status).toBe("ok");
		if (out.status === "ok") {
			expect(out.changedFiles).toEqual(["src/a.ts"]);
		}
	});

	test("REFUSES a real change that edits a GitHub workflow", async () => {
		const f = fixture({ "src/a.ts": "b\n", ".github/workflows/ci.yml": "on: push\n" });
		const out = await runGate(f);
		expect(out.status).toBe("rejected");
		expect(out.status === "rejected" && out.reason).toContain("CI workflow");
	});

	test("REFUSES a real change that edits THIS repo's pre-push gate", async () => {
		// #18 retired Actions here, so the escalation path is the hook chain rather
		// than a workflow file. Proven against a real bundle, not a fake path list.
		const f = fixture({ "_githooks/pre-push": "#!/usr/bin/env bash\nexit 0\n" });
		const out = await runGate(f);
		expect(out.status).toBe("rejected");
		expect(out.status === "rejected" && out.reason).toContain("CI workflow");
	});

	test("REFUSES a real bundle rooted on a base the watcher did not dispatch", async () => {
		const f = fixture();
		const out = await runGate(f, "f".repeat(40));
		expect(out.status).toBe("rejected");
		// sf#709: asserting only `rejected` made this test pass for a DIFFERENT
		// reason than its name. Disabling the declared-vs-dispatched equality gate
		// in `change-ingest` left it green, because the later prerequisite-list
		// check (`bases.every(...)`) rejects the same fixture with
		// `bundle_base_not_dispatched`. Naming the reason is what binds this test
		// to the gate it claims to cover.
		expect(out.status === "rejected" && out.reason).toBe(
			"declared base does not match the dispatched base",
		);
	});

	test("REFUSES a real bundle from an unrelated history", async () => {
		// The bundle is well-formed, but its prerequisite is absent from the scratch
		// repository, so git itself refuses it at verify.
		const ours = fixture();
		const theirs = fixture({ "src/other.ts": "x\n" }, "unrelated-history\n");
		// sf#709: `baseContents` is load-bearing. Two fixtures built from IDENTICAL
		// base content in the same second produce the identical base SHA, which
		// would make "unrelated history" a lie and this whole test vacuous. The
		// twin at the top of this file already guards it; this one did not, and was
		// one careless edit from silently testing nothing.
		expect(theirs.baseSha).not.toBe(ours.baseSha);
		const out = await verifyChangeBundle({
			change: { base_sha: ours.baseSha, bundle_path: "change.bundle" },
			jobOutputDir: theirs.root,
			dispatchedBaseSha: ours.baseSha,
			snapshotPath: join(theirs.root, "snapshot.bundle"),
			inspector: new LocalBundleInspector(ours.scratch),
		});
		expect(out.status).toBe("rejected");
	});
});
