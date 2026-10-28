/**
 * @module tests/scripts/test-shard
 * @description `scripts/test-run.ts --shard <i>/<n>`: the
 *   slices of a selection are disjoint and cover it, and an empty slice exits 0
 *   without running `bun test`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseShard, shardSlice, splitTestArgs, testFileArg } from "../../scripts/test-shard";
import { testTmpBase } from "../support/test-temp";

const ROOT = join(import.meta.dir, "..", "..");

describe("test-run --shard", () => {
	test("the slices of a file list are disjoint, cover it, and each gets a heavy file", () => {
		const files = Array.from({ length: 11 }, (_, k) => ({ path: `t${k}.test.ts`, size: k * 100 }));
		const slices = [1, 2, 3, 4].map((i) => shardSlice(files, i, 4));
		const all = slices.flat();
		expect(new Set(all).size).toBe(all.length);
		expect([...all].sort()).toEqual(files.map((f) => f.path).sort());
		// Snake deal: the four biggest (t10..t7) land one per slice.
		expect(slices.map((s) => s[0])).toEqual([
			"t10.test.ts",
			"t9.test.ts",
			"t8.test.ts",
			"t7.test.ts",
		]);
	});

	test("--shard refuses a number past Number.MAX_SAFE_INTEGER (PR 1657 review)", () => {
		expect(() => parseShard(`1/${"9".repeat(400)}`)).toThrow("bad --shard");
	});

	test("an option's value is never a test file (PR 1657 review)", () => {
		expect(
			splitTestArgs(["--timeout", "30000", "-t", "slow one", "--bail", "./a.test.ts"]),
		).toEqual({
			options: ["--timeout", "30000", "-t", "slow one", "--bail"],
			files: ["a.test.ts"],
		});
	});

	test("--bail takes an optional numeric value, never a following file (PR 1657 review)", () => {
		expect(splitTestArgs(["--bail", "1", "./a.test.ts"])).toEqual({
			options: ["--bail", "1"],
			files: ["a.test.ts"],
		});
	});

	test("an absolute test path is stat-ed and passed to bun unchanged (PR 1657 review)", () => {
		expect(testFileArg("/repo", "/elsewhere/a.test.ts")).toEqual({
			stat: "/elsewhere/a.test.ts",
			arg: "/elsewhere/a.test.ts",
		});
		expect(testFileArg("/repo", "tests/a.test.ts")).toEqual({
			stat: "/repo/tests/a.test.ts",
			arg: "./tests/a.test.ts",
		});
	});

	test("--shard 3/4 of a one-file selection is empty and exits 0", () => {
		const dir = mkdtempSync(join(testTmpBase(), "test-shard-"));
		try {
			const run = Bun.spawnSync(
				["bun", "scripts/test-run.ts", "--shard", "3/4", "./tests/scripts/test-shard.test.ts"],
				{ cwd: ROOT, env: { ...process.env, SF_TEST_RUN_DIR: dir } },
			);
			expect(run.stderr.toString()).toContain("shard 3/4: empty slice of 1 test files");
			expect(run.exitCode).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
