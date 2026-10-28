/**
 * @module tests/actions/rails-check
 * @description The rails-check CLI (829c1) against a REAL git
 *   repository whose `refs/rw-verify/tip` carries the rendered YAML, run as a
 *   subprocess so the exit code is the one the verb propose job would see.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTmpBase } from "../support/test-temp";

const CLI = join(import.meta.dir, "../../scripts/actions/rails-check.ts");
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

const OK_MANIFEST = "constraints:\n  - id: no-new-lxc\n";
const UNKNOWN_MANIFEST = "constraints:\n  - id: no-new-lxc\n  - id: not-a-known-rail\n";
const MALFORMED_MANIFEST = "constraints: []\n";
const DEPLOYMENT = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: demo\n";
const LXC = "kind: lxc\nmetadata:\n  name: demo\n";

/** base (README) -> tip (apps/demo.yaml); refs/rw-verify/tip points at tip. */
function fixture(appYaml: string | Buffer, manifest: string, appPath = "apps/demo.yaml") {
	const root = mkdtempSync(join(testTmpBase(), "rails-check-"));
	fixtures.push(root);
	const repo = join(root, "repo");
	mkdirSync(join(repo, "apps"), { recursive: true });
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "core.hooksPath", "/dev/null"]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	git(repo, ["config", "user.name", "test"]);
	writeFileSync(join(repo, "README"), "k3s-deploy\n");
	git(repo, ["add", "README"]);
	git(repo, ["commit", "-qm", "base"]);
	const baseSha = git(repo, ["rev-parse", "HEAD"]);
	writeFileSync(join(repo, appPath), appYaml);
	git(repo, ["add", appPath]);
	git(repo, ["commit", "-qm", "tip"]);
	git(repo, ["update-ref", "refs/rw-verify/tip", "HEAD"]);
	// The working tree must never be what is checked: overwrite it after the commit.
	writeFileSync(join(repo, "apps/demo.yaml"), LXC);
	const manifestPath = join(root, "factory-rails.yml");
	writeFileSync(manifestPath, manifest);
	const manifestSha = createHash("sha256").update(manifest).digest("hex");
	return { repo, baseSha, manifestPath, manifestSha };
}

function run(args: string[]): { code: number; stdout: string } {
	const out = Bun.spawnSync(["bun", CLI, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	return { code: out.exitCode, stdout: out.stdout.toString().trim() };
}

describe("rails-check CLI", () => {
	test("rails hold on the verified tip: exit 0, `rails: ok`", () => {
		const f = fixture(DEPLOYMENT, OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 0, stdout: "rails: ok" });
	});

	test("a violated rail: exit 1, one bounded `rails: violated:` line naming it", () => {
		const f = fixture(LXC, OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 1, stdout: "rails: violated: no-new-lxc" });
	});

	test("a rail the factory cannot check is violated, never silently passed", () => {
		const f = fixture(DEPLOYMENT, UNKNOWN_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 1, stdout: "rails: violated: not-a-known-rail" });
	});

	test("unparseable rendered YAML at the tip: exit 1, `rails: hold: artifact-invalid`", () => {
		const f = fixture("kind: [unclosed\n", OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 1, stdout: "rails: hold: artifact-invalid" });
	});

	test("a malformed manifest is a harness failure: exit 3", () => {
		const f = fixture(DEPLOYMENT, MALFORMED_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out.code).toBe(3);
		expect(out.stdout).toBe("harness: rails manifest-invalid");
	});

	test("a manifest whose sha256 differs from the pinned one: exit 3", () => {
		const f = fixture(DEPLOYMENT, OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, "0".repeat(64)]);
		expect(out).toEqual({ code: 3, stdout: "harness: rails manifest-stale" });
	});

	test("a non-ASCII path git would C-quote is read verbatim (NUL-delimited)", () => {
		const f = fixture(LXC, OK_MANIFEST, "apps/démo.yaml");
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 1, stdout: "rails: violated: no-new-lxc" });
	});

	test("a rendered file past the byte cap: exit 1, `rails: hold: artifact-byte-limit`", () => {
		const big = `${DEPLOYMENT}${"# pad\n".repeat(200_000)}`;
		const f = fixture(big, OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 1, stdout: "rails: hold: artifact-byte-limit" });
	});

	test("a rendered file of exactly the byte cap (1 MiB) is inside it: exit 0, `rails: ok`", () => {
		const cap = 1024 * 1024;
		const exact = `${DEPLOYMENT}${"#".repeat(cap - DEPLOYMENT.length - 1)}\n`;
		expect(Buffer.byteLength(exact)).toBe(cap);
		const f = fixture(exact, OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 0, stdout: "rails: ok" });
	});

	test("two files summing to exactly the byte cap, pushed past it by the join separator: exit 1, `rails: hold: artifact-byte-limit` (factory run 2198)", () => {
		const half = (1024 * 1024) / 2;
		const first = `${DEPLOYMENT}${"#".repeat(half - DEPLOYMENT.length - 1)}\n`;
		const second = `${"#".repeat(half - 1)}\n`;
		expect(Buffer.byteLength(first) + Buffer.byteLength(second)).toBe(2 * half);
		const f = fixture(first, OK_MANIFEST);
		writeFileSync(join(f.repo, "apps/other.yaml"), second);
		git(f.repo, ["add", "apps/other.yaml"]);
		git(f.repo, ["commit", "-qm", "tip2"]);
		git(f.repo, ["update-ref", "refs/rw-verify/tip", "HEAD"]);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 1, stdout: "rails: hold: artifact-byte-limit" });
	});

	test("invalid UTF-8 under the raw cap that decodes past it: exit 1, `rails: hold: artifact-byte-limit` (factory verdict on #934)", () => {
		// 0xFF bytes decode to U+FFFD (3 bytes each): raw size is under 1 MiB, decoded is 3x over.
		const raw = Buffer.concat([Buffer.from(DEPLOYMENT), Buffer.alloc(900_000, 0xff)]);
		const f = fixture(raw, OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out).toEqual({ code: 1, stdout: "rails: hold: artifact-byte-limit" });
	});

	test("a rendered file whose whole content is `over` is judged as YAML, not as the byte-limit sentinel (factory P1 on #934)", () => {
		const f = fixture("over", OK_MANIFEST);
		const out = run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]);
		expect(out.stdout).not.toBe("rails: hold: artifact-byte-limit");
		expect(out).toEqual({ code: 0, stdout: "rails: ok" });
	});

	test("no refs/rw-verify/tip or bad args: exit 3", () => {
		const f = fixture(DEPLOYMENT, OK_MANIFEST);
		git(f.repo, ["update-ref", "-d", "refs/rw-verify/tip"]);
		expect(run([f.manifestPath, f.repo, f.baseSha, f.manifestSha]).code).toBe(3);
		expect(run([f.manifestPath, f.repo, "not-a-sha", f.manifestSha]).code).toBe(3);
		expect(run([f.manifestPath, f.repo]).code).toBe(3);
	});
});

// Changed-path splitting over raw bytes (factory P1 on PR #934). APFS refuses
// a filename containing 0xFF, so the check is driven with a hand-built Buffer.
describe("splitChangedPaths", () => {
	test("a path that is not valid UTF-8 is refused, not decoded to U+FFFD", async () => {
		const { splitChangedPaths } = await import("../../scripts/actions/rails-check");
		const raw = Buffer.concat([
			Buffer.from("apps/a.yml\0apps/"),
			Buffer.from([0xff]),
			Buffer.from(".yml\0"),
		]);
		expect(splitChangedPaths(raw)).toBeNull();
	});
	test("valid UTF-8 paths split on NUL", async () => {
		const { splitChangedPaths } = await import("../../scripts/actions/rails-check");
		expect(splitChangedPaths(Buffer.from("apps/a.yml\0apps/é.yaml\0"))).toEqual([
			"apps/a.yml",
			"apps/é.yaml",
		]);
	});
});

describe("showCapped", () => {
	test("a failing git show names its first stderr line on one bounded line", async () => {
		const { showCapped } = await import("../../scripts/actions/rails-check");
		const { repo } = fixture(DEPLOYMENT, OK_MANIFEST);
		const shown = await showCapped(repo, "refs/rw-verify/tip:apps/missing.yaml", 1024);
		expect(shown.kind).toBe("fail");
		const message = shown.kind === "fail" ? shown.message : "";
		const prefix = "harness: rendered file unreadable: ";
		expect(message.startsWith(prefix)).toBe(true);
		const detail = message.slice(prefix.length);
		expect(detail).toMatch(/^fatal: /);
		expect(detail.length).toBeLessThanOrEqual(200);
		expect(message).not.toContain("\n");
	});
});
