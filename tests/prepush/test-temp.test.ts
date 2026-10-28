/**
 * @module tests/prepush/test-temp
 * @description Pins the portable test-temp contract that lets the fixed pre-push
 *   job run on a clean Linux runner. The observed real failure was a hardcoded
 *   `/opt/_tmp/...` fixture root that does not exist off the
 *   Development Mac, so fixture creation faulted before the two fixed commands
 *   could run. The shared resolver must honor the runner's
 *   `RODADDY_WATCHER_TEST_TMP` override (writable, job-local) while defaulting to
 *   the Mac path so local runs and archive behavior are unchanged.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	DEFAULT_MAC_TMP,
	defaultBoxTmp,
	resolveTestTmpBase,
	TEST_TMP_ENV,
	testArchiveDir,
	testTmpBase,
} from "../support/test-temp";

const created: string[] = [];
const original = process.env[TEST_TMP_ENV];

afterEach(async () => {
	if (original === undefined) delete process.env[TEST_TMP_ENV];
	else process.env[TEST_TMP_ENV] = original;
	for (const dir of created.splice(0)) {
		await rename(dir, join(testArchiveDir(), `${basename(dir)}-${crypto.randomUUID()}`));
	}
});

describe("portable test-temp resolver", () => {
	test("the override env var name is the fixed author-owned name", () => {
		// The runner body and the resolver must agree on the exact variable name.
		expect(TEST_TMP_ENV).toBe("RODADDY_WATCHER_TEST_TMP");
	});

	test("honors the runner override and creates a writable base + archive", async () => {
		// A clean-runner-style writable directory that is NOT the absent Mac path.
		const override = await mkdtemp(join(testTmpBase(), "rw-runner-testtmp-"));
		created.push(override);
		process.env[TEST_TMP_ENV] = override;

		const base = testTmpBase();
		expect(base).toBe(override);
		expect(base).not.toBe("/opt/_tmp/software-factory");
		expect(existsSync(base)).toBe(true);

		const archive = testArchiveDir();
		expect(archive).toBe(join(override, "_archive"));
		expect(existsSync(archive)).toBe(true);
	});

	test("falls back to the Development Mac default on macOS when the override is unset", () => {
		// Resolve only (no directory creation): the Mac path may be absent on a
		// clean runner, but the resolved value must still be the Development default.
		delete process.env[TEST_TMP_ENV];
		expect(DEFAULT_MAC_TMP).toBe(join(homedir(), "_tmp", "software-factory"));
		expect(resolveTestTmpBase("darwin")).toBe(DEFAULT_MAC_TMP);
	});

	test("falls back to the box temp workspace off macOS, never /Volumes (SOF-1742)", () => {
		// sf-fleet-01 ran 545 tests red on EACCES mkdir '/Volumes' with no override.
		delete process.env[TEST_TMP_ENV];
		expect(defaultBoxTmp("/home/operator")).toBe("/home/operator/_tmp/software-factory");
		expect(resolveTestTmpBase("linux")).toBe(defaultBoxTmp(homedir()));
		expect(resolveTestTmpBase("linux").startsWith("/Volumes")).toBe(false);
	});

	test("treats a blank override as unset (platform default)", () => {
		process.env[TEST_TMP_ENV] = "   ";
		expect(resolveTestTmpBase("darwin")).toBe(DEFAULT_MAC_TMP);
		expect(resolveTestTmpBase("linux")).toBe(defaultBoxTmp(homedir()));
	});
});
