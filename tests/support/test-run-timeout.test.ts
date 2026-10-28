/**
 * @module tests/support/test-run-timeout
 * @description Pins the per-test timeout the suite actually runs under.
 *
 *   WHY THE BOUND HAS A FLOOR. Two tests whose own work is a few dozen
 *   milliseconds failed at the 30 s bound under runner load on 2026-09-29, each
 *   in a `prepush validate` whose `bun run check` step had already passed them
 *   in the same run: `pr-review-chunks-shell` "a failed chunk fails the step 22
 *   and names its cause" took 34793 ms (job rw-repo-validate-c40f54d9), and
 *   `renderVerbScriptBody` "executes end to end against fixture checkouts" took
 *   30061 ms (job rw-repo-validate-6fa7a4f7). Both drive real subprocesses, so
 *   their wall time is host latency, not candidate logic — the same reason
 *   `tests/db/helpers.ts` documents for its own bound. The cost of a false
 *   failure is a whole second validate cycle on a capacity-1 runner.
 *
 *   WHY THE FLOOR IS ASSERTED HERE, in the suite, rather than trusted. The bound
 *   is a FLAG, and it has to be: bun 1.3.13 does not honor `[test] timeout` from
 *   `bunfig.toml` (verified in `tests/db/helpers.ts` — a 6 s test still died at
 *   5000 ms with it set), so the only working place is the argv of the spawn in
 *   `scripts/test-run.ts`. A flag silently dropped in an edit puts bun's 5000 ms
 *   default back and flakes every database-backed test at once, which has
 *   happened before (issue #47, "Unhandled error between tests" cascading into a
 *   nondeterministic failure count for one unchanged SHA). Nothing else in the
 *   repository reads this value, so nothing else would notice.
 *
 *   This test asserts the FLOOR, not the exact number: raising the bound is
 *   always allowed, dropping it below the floor is the regression.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTmpBase } from "./test-temp";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The floor. 120 s is four times the bound that failed and ~13x the slowest
 * honest test in the suite (9.1 s on an idle host), while still surfacing a
 * genuinely hung test inside two minutes.
 */
const FLOOR_MS = 120_000;

/** The `--timeout=<ms>` the runner script passes to `bun test`. */
function configuredTimeoutMs(): number {
	const source = readFileSync(join(ROOT, "scripts/test-run.ts"), "utf8");
	const flags = [...source.matchAll(/"--timeout=(\d+)"/g)].map((m) => Number(m[1]));
	// One site, so "the last flag wins" never has to be reasoned about.
	expect(flags).toHaveLength(1);
	return flags[0] as number;
}

describe("the suite's per-test timeout", () => {
	test("scripts/test-run.ts passes a --timeout at or above the floor", () => {
		expect(configuredTimeoutMs()).toBeGreaterThanOrEqual(FLOOR_MS);
	});

	// Probed 2026-10-01: with two `--timeout` flags, the LAST one wins
	// (`--timeout=500 --timeout=30000` passes a 2 s test; the reverse order fails
	// it). So the hardcoded flag has to come BEFORE the caller's own args for
	// `bun run test --timeout=...` to remain possible.
	test("the hardcoded flag precedes the caller's args, so a caller can still override", () => {
		const source = readFileSync(join(ROOT, "scripts/test-run.ts"), "utf8");
		const flagAt = source.indexOf('"--timeout=');
		const argsAt = source.indexOf("...args");
		expect(flagAt).toBeGreaterThan(0);
		expect(argsAt).toBeGreaterThan(flagAt);
	});

	test("package.json's test script is the one that applies it", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		// `bun test` run directly inherits bun's 5000 ms default; the bound only
		// reaches the suite through this script (tests/db/helpers.ts, TIMEOUT
		// CONTRACT).
		expect(pkg.scripts.test).toBe("bun scripts/test-run.ts");
		expect(pkg.scripts.check).toContain("bun run test");
	});

	// The mechanism this bound relies on, probed rather than assumed: bun applies
	// a timeout to a test body that BLOCKS in a synchronous subprocess call, and
	// a per-test third argument overrides the global flag. Both matter — the two
	// tests in sf#1082 are `Bun.spawnSync` bodies, and a future per-test opt-out
	// would be the next fix if the global bound is ever lowered again.
	test("a blocking sync body is bounded, and a per-test timeout overrides the flag", () => {
		// `bun test` takes FILES, not `-e`: an inline script runs the whole suite
		// instead (observed while writing this). The fixture is a real file under
		// the portable test temp root, never /tmp (AGENTS.md).
		//
		// The blocking body is `Bun.sleepSync`, not a spawned `sleep`: this file
		// should depend on nothing but bun (PR #1120 reviewer note; the sibling
		// finalize test paid for a GNU `timeout` dependency the same day). Probed —
		// bun bounds a `Bun.sleepSync` body exactly as it bounds a `Bun.spawnSync`
		// one, reporting the timeout once the body returns.
		const dir = mkdtempSync(`${testTmpBase()}/test-run-timeout-`);
		const file = join(dir, "bound.test.ts");
		writeFileSync(
			file,
			[
				'import { expect, test } from "bun:test";',
				'test("blocking body, global bound applies", () => {',
				"\tBun.sleepSync(2000);",
				"\texpect(1).toBe(1);",
				"});",
				'test("blocking body, per-test override wins", () => {',
				"\tBun.sleepSync(2000);",
				"\texpect(1).toBe(1);",
				// The override is generated from FLOOR_MS, not hardcoded. A fixed
				// 30000 here would be the very flake this PR exists to remove: under
				// the runner latency that made sf#1082, a 2 s sleep can cross 30 s and
				// this case would fail for the reason it is meant to disprove
				// (factory/pr-review P2 on PR #1120).
				`}, ${FLOOR_MS});`,
				"",
			].join("\n"),
		);
		try {
			const p = Bun.spawnSync(["bun", "test", "--timeout=500", file], { cwd: dir });
			const out = p.stdout.toString() + p.stderr.toString();
			expect(out).toContain("1 pass");
			expect(out).toContain("1 fail");
			expect(out).toContain("timed out after 500ms");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
