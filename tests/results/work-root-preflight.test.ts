/**
 * @module tests/results/work-root-preflight
 * @description Behavior tests for the boot-time work-root write probe.
 *
 *   These use a REAL filesystem, not a mocked one. The defect being defended
 *   against is precisely that a directory can exist and still be unwritable to
 *   this process, and a fake `mkdir` decides its own answer — it cannot prove the
 *   probe notices. The unwritable case is therefore a real `0o500` directory.
 *
 *   MUTATIONS PROVEN (each made the named test go red before being restored):
 *   - Dropping the `try/catch` re-throw in `assertChangeWorkRootWritable` (letting
 *     the raw error escape) -> "fails naming the path and the env var" red: the
 *     raw EACCES message names neither `WATCHER_WORK_ROOT` nor the resolved root.
 *   - Replacing the write-probe with a bare `mkdir` (the stat-only shape this
 *     module exists to reject) -> "fails ... unwritable" red: `mkdir -p` on an
 *     already-existing unwritable directory SUCCEEDS, so the probe passes.
 *   - Removing the `unlink` -> "leaves no probe file behind" red.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertChangeWorkRootWritable } from "../../src/results/work-root-preflight";
import { testTmpBase } from "../support/test-temp";

/** Every fixture created by this file, removed once at teardown. */
const fixtures: string[] = [];

afterAll(() => {
	for (const dir of fixtures) {
		// Restore write permission first, or the unwritable fixture cannot be cleaned.
		try {
			chmodSync(dir, 0o700);
		} catch {
			// Already gone or already writable; teardown continues either way.
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

function fixtureDir(prefix: string): string {
	const dir = mkdtempSync(join(testTmpBase(), prefix));
	fixtures.push(dir);
	return dir;
}

describe("assertChangeWorkRootWritable", () => {
	test("succeeds on a writable root and returns it", async () => {
		const root = join(fixtureDir("rw-workroot-ok-"), "work");

		const resolved = await assertChangeWorkRootWritable({}, { workRoot: root });

		expect(resolved).toBe(root);
		expect(existsSync(root)).toBe(true);
	});

	test("leaves no probe file behind", async () => {
		const root = join(fixtureDir("rw-workroot-clean-"), "work");

		await assertChangeWorkRootWritable({}, { workRoot: root });
		// A second probe must also pass. The probe writes with `wx`, which refuses to
		// overwrite, so a leaked probe file from the first call would fail this.
		await assertChangeWorkRootWritable({}, { workRoot: root });

		expect(existsSync(join(root, ".workroot-probe"))).toBe(false);
	});

	test("fails on an existing but unwritable root, naming the path and the env var", async () => {
		const parent = fixtureDir("rw-workroot-ro-");
		const root = join(parent, "work");
		mkdirSync(root);
		// Read+execute only: the directory EXISTS and can be stat-ed, but no file can
		// be created in it. This is the fleet host shape (`ProtectSystem=strict`) that a
		// stat-only check would report as healthy.
		chmodSync(root, 0o500);
		fixtures.push(root);

		const failure = await assertChangeWorkRootWritable({}, { workRoot: root }).then(
			() => null,
			(err: unknown) => err,
		);

		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain(root);
		expect(message).toContain("WATCHER_WORK_ROOT");
	});

	test("resolves the root from WATCHER_WORK_ROOT when no override is given", async () => {
		const root = join(fixtureDir("rw-workroot-env-"), "from-env");

		const resolved = await assertChangeWorkRootWritable({ WATCHER_WORK_ROOT: root });

		expect(resolved).toBe(root);
		expect(existsSync(root)).toBe(true);
	});
});
