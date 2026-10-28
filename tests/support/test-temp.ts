/**
 * @module tests/support/test-temp
 * @description One shared, portable temp-root resolver for test fixtures. The
 *   Development Mac policy places temp work under
 *   `~/_tmp/<repo>/` with a sibling `_archive/`; that path is
 *   the default here so Mac runs and the archive-on-teardown behavior are
 *   preserved unchanged. A clean Linux runner has no such path, so the fixed
 *   pre-push job exports `RODADDY_WATCHER_TEST_TMP` to a job-local writable
 *   directory; when that override is set, fixtures live there instead. Any other
 *   non-Mac host with no override (sf-fleet-01, SOF-1742) uses
 *   `~/_tmp/<repo>/` on local disk: `/Volumes` cannot be created there, the OS
 *   temp dir is banned, and the NFS-backed `/mnt/share/tmp_space` is slow
 *   enough that git-fixture tests hit the 5s timeout. The base directory (and
 *   its `_archive/`) is created on demand so callers can write immediately on
 *   either platform.
 *
 * @outputs
 *   - `TEST_TMP_ENV` -- the fixed override environment variable name
 *   - `DEFAULT_MAC_TMP` / `defaultBoxTmp` -- the macOS and other-host defaults
 *   - `resolveTestTmpBase` -- resolve the portable temp base path (no I/O)
 *   - `testTmpBase` -- resolve (and create) the portable temp base directory
 *   - `testArchiveDir` -- resolve (and create) the base's `_archive/` sibling
 *
 * @dependencies
 *   - node:fs -- create the base and archive directories on demand
 *   - node:os -- the home directory for the non-Mac default
 *   - node:path -- join the archive path beneath the base
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The fixed environment variable a clean runner sets to redirect test fixtures
 * to a job-local writable directory. Author-owned and read only here; it never
 * carries a repository- or config-selected value into production code paths.
 */
export const TEST_TMP_ENV = "RODADDY_WATCHER_TEST_TMP" as const;

/** The Development Mac default temp workspace for this repo. Preserved as-is. */
export const DEFAULT_MAC_TMP = join(homedir(), "_tmp", "software-factory");

/**
 * The temp workspace for this repo on any non-Mac host, on local disk. `/Volumes`
 * cannot be created there (EACCES), and the OS temp dir is banned
 * (STANDARDS-core.md).
 */
export function defaultBoxTmp(home: string = homedir()): string {
	return join(home, "_tmp", "software-factory");
}

/**
 * Resolve the portable temp base path WITHOUT creating it. Uses the
 * `RODADDY_WATCHER_TEST_TMP` override when a non-empty value is set (the runner
 * lane), otherwise the Development Mac default on macOS and the box temp
 * workspace elsewhere. Pure so callers can assert the resolution on any platform
 * without touching the (possibly absent) default path.
 */
export function resolveTestTmpBase(platform: NodeJS.Platform = process.platform): string {
	const override = process.env[TEST_TMP_ENV]?.trim();
	if (override && override.length > 0) return override;
	return platform === "darwin" ? DEFAULT_MAC_TMP : defaultBoxTmp();
}

/**
 * Resolve the portable temp base and ensure it exists. Creating the directory is
 * safe and idempotent on both platforms.
 */
export function testTmpBase(): string {
	const base = resolveTestTmpBase();
	mkdirSync(base, { recursive: true });
	return base;
}

/**
 * Resolve the base's `_archive/` sibling and ensure it exists, preserving the
 * Development archive-on-teardown behavior on either platform.
 */
export function testArchiveDir(): string {
	const archive = join(testTmpBase(), "_archive");
	mkdirSync(archive, { recursive: true });
	return archive;
}
