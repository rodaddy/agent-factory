/**
 * @module tests/actions/verify-bundle
 * @description The verify-bundle CLI against REAL git repositories and
 *   REAL bundles, run as a subprocess so the exit code is the one the Actions
 *   propose job would see.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { testTmpBase } from "../support/test-temp";

const CLI = join(import.meta.dir, "../../scripts/actions/verify-bundle.ts");
const fixtures: string[] = [];

afterAll(() => {
	for (const dir of fixtures) {
		rmSync(dir, { recursive: true, force: true });
	}
});

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

function commit(repo: string, files: Record<string, string>, msg: string): string {
	for (const [path, contents] of Object.entries(files)) {
		const full = join(repo, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, contents);
	}
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--allow-empty", "-qm", msg]);
	return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * base -> mid -> work. The bundle is `<from>..HEAD` where `from` is base by
 * default; the scratch bare clone holds base and mid but not work.
 */
function fixture(work: Record<string, string>, from: "base" | "mid" = "base") {
	const root = mkdtempSync(join(testTmpBase(), "verify-bundle-"));
	fixtures.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q", "-b", "work"]);
	git(repo, ["config", "core.hooksPath", "/dev/null"]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	git(repo, ["config", "user.name", "test"]);
	const baseSha = commit(repo, { "base.txt": "a\n" }, "base");
	const midSha = commit(repo, { "mid.txt": "m\n" }, "mid");
	const scratch = join(root, "scratch.git");
	git(root, ["clone", "-q", "--bare", repo, scratch]);
	const headSha = commit(repo, work, "work");
	const chg = join(root, "chg");
	mkdirSync(chg);
	const bundlePath = join(chg, "changes.bundle");
	git(repo, ["bundle", "create", "-q", bundlePath, `${from === "base" ? baseSha : midSha}..HEAD`]);
	return { root, scratch, baseSha, midSha, headSha, bundlePath };
}

function run(args: string[]): { code: number; stdout: string } {
	// Hermetic: a host-global core.hooksPath would hide the scratch repo's own hooks.
	const out = Bun.spawnSync([process.execPath, CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	return { code: out.exitCode, stdout: out.stdout.toString() };
}

describe("verify-bundle CLI", () => {
	test("a good bundle exits 0 and prints the tip", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const out = run([f.bundlePath, f.baseSha, f.scratch]);
		expect(out.stdout).toBe(`accepted tip=${f.headSha} files=2\n`);
		expect(out.code).toBe(0);
	});

	test("a bundle touching .forgejo/workflows exits 1", () => {
		const f = fixture({ ".forgejo/workflows/x.yml": "on: push\n" });
		const out = run([f.bundlePath, f.baseSha, f.scratch]);
		expect(out.stdout).toBe("refused: change modifies a CI workflow path\n");
		expect(out.code).toBe(1);
	});

	test("a bundle whose base is not base_sha exits 1", () => {
		const f = fixture({ "src/a.ts": "b\n" }, "mid");
		const out = run([f.bundlePath, f.baseSha, f.scratch]);
		expect(out.stdout).toBe("refused: bundle is not rooted on the dispatched base\n");
		expect(out.code).toBe(1);
	});

	test("a truncated bundle exits 1", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const whole = readFileSync(f.bundlePath);
		writeFileSync(f.bundlePath, whole.subarray(0, Math.floor(whole.length / 2)));
		const out = run([f.bundlePath, f.baseSha, f.scratch]);
		expect(out.stdout.startsWith("refused: ")).toBe(true);
		expect(out.code).toBe(1);
	});

	test("a missing arg exits 3", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const out = run([f.bundlePath, f.baseSha]);
		expect(out.stdout.startsWith("usage: ")).toBe(true);
		expect(out.code).toBe(3);
	});
});

/** A bundle whose header names `baseSha` as its prerequisite but whose HEAD is an orphan. */
function forgedOrphanBundle(f: ReturnType<typeof fixture>): string {
	const repo = join(f.root, "repo");
	const tree = git(repo, ["rev-parse", `${f.baseSha}^{tree}`]);
	const orphan = git(repo, ["commit-tree", tree, "-m", "orphan"]);
	const pack = Bun.spawnSync(["git", "pack-objects", "--revs", "--stdout"], {
		cwd: repo,
		stdin: new TextEncoder().encode(`${orphan}\n`),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (pack.exitCode !== 0) {
		throw new Error(`pack-objects failed: ${pack.stderr.toString()}`);
	}
	const header = `# v2 git bundle\n-${f.baseSha} base\n${orphan} HEAD\n\n`;
	const path = join(f.root, "chg", "forged.bundle");
	writeFileSync(path, Buffer.concat([Buffer.from(header), pack.stdout]));
	return path;
}

describe("verify-bundle CLI — review repairs", () => {
	test("a forged bundle whose tip does not descend from base_sha exits 1", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const forged = forgedOrphanBundle(f);
		const out = run([forged, f.baseSha, f.scratch]);
		expect(out.stdout).toBe("refused: bundle tip does not descend from the dispatched base\n");
		expect(out.code).toBe(1);
	});

	test("the scratch repository's own hooks never run", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const marker = join(f.root, "hook-ran");
		const hook = join(f.scratch, "hooks", "reference-transaction");
		mkdirSync(join(f.scratch, "hooks"), { recursive: true });
		writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\n`);
		chmodSync(hook, 0o755);
		const out = run([f.bundlePath, f.baseSha, f.scratch]);
		expect(out.code).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	test("a symlinked bundle path exits 1", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const link = join(f.root, "chg", "link.bundle");
		symlinkSync(f.bundlePath, link);
		const out = run([link, f.baseSha, f.scratch]);
		expect(out.stdout.startsWith("refused: ")).toBe(true);
		expect(out.code).toBe(1);
	});

	test("an absent bundle exits 1", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const out = run([join(f.root, "chg", "absent.bundle"), f.baseSha, f.scratch]);
		expect(out.stdout.startsWith("refused: ")).toBe(true);
		expect(out.code).toBe(1);
	});

	test("a missing scratch dir exits 3 naming the scratch dir", () => {
		const f = fixture({ "src/a.ts": "b\n" });
		const out = run([f.bundlePath, f.baseSha, join(f.root, "no-such-scratch")]);
		expect(out.stdout).toBe("harness: scratch dir missing\n");
		expect(out.code).toBe(3);
	});

	test("a bundle touching 0 files exits 1", () => {
		const f = fixture({}, "mid");
		const out = run([f.bundlePath, f.midSha, f.scratch]);
		expect(out.stdout).toBe("refused: change touches no files\n");
		expect(out.code).toBe(1);
	});

	test("a bundle touching 501 files exits 1", () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 501; i++) {
			many[`src/f${i}.ts`] = `${i}\n`;
		}
		const f = fixture(many, "mid");
		const out = run([f.bundlePath, f.midSha, f.scratch]);
		expect(out.stdout).toBe("refused: change touches too many files\n");
		expect(out.code).toBe(1);
	});
});
