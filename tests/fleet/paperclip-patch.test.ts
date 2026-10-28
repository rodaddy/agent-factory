/**
 * @module tests/fleet/paperclip-patch
 * @description `fleet/bin/paperclip-patch`, run as a real child
 *   process against a fixture Paperclip home (the managed-install layout:
 *   `cli/current -> installs/npm/<version>`, packages under
 *   `node_modules/@paperclipai/`) and a fixture fleet root carrying
 *   `paperclip-patches/<version>/`. No network, no real install.
 *   Mutation runs: `PAPERCLIP_PATCH_UNDER_TEST=<copy> bun test tests/fleet/paperclip-patch.test.ts`.
 *   Dropping the reverse dry-run turns the re-run case red; applying inside the
 *   dry-run loop turns the conflict case red; treating a missing version dir as
 *   "nothing to do" turns the version case red; ignoring --check turns the
 *   check case red; skipping the apply turns the fresh case red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.PAPERCLIP_PATCH_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/bin/paperclip-patch");
const VERSION = "2026.916.1";
const ORIGINAL = "export const a = 1;\nexport const limit = 10;\nexport const c = 3;\n";
const PATCHED = "export const a = 1;\nexport const limit = 20;\nexport const c = 3;\n";
const GOOD = `diff --git a/server/dist/limits.js b/server/dist/limits.js
--- a/server/dist/limits.js
+++ b/server/dist/limits.js
@@ -1,3 +1,3 @@
 export const a = 1;
-export const limit = 10;
+export const limit = 20;
 export const c = 3;
`;
// Written against the result of GOOD: limit 20 is its context (a stacked series).
const STACKED = `diff --git a/server/dist/limits.js b/server/dist/limits.js
--- a/server/dist/limits.js
+++ b/server/dist/limits.js
@@ -1,3 +1,3 @@
 export const a = 1;
 export const limit = 20;
-export const c = 3;
+export const c = 4;
`;
const STACKED_RESULT = "export const a = 1;\nexport const limit = 20;\nexport const c = 4;\n";
// Applies to the original on its own, but its context (limit 10) is gone once
// GOOD is in: each passes a dry-run alone, the ordered pair does not.
const OVERLAP = `diff --git a/server/dist/limits.js b/server/dist/limits.js
--- a/server/dist/limits.js
+++ b/server/dist/limits.js
@@ -1,3 +1,3 @@
 export const a = 1;
 export const limit = 10;
-export const c = 3;
+export const c = 4;
`;
// Context that is in neither the original nor the patched file.
const CONFLICT = `diff --git a/server/dist/limits.js b/server/dist/limits.js
--- a/server/dist/limits.js
+++ b/server/dist/limits.js
@@ -1,3 +1,3 @@
 export const a = 1;
-export const limit = 99;
+export const limit = 100;
 export const c = 3;
`;

let root = "";
let count = 0;

beforeAll(() => {
	root = mkdtempSync(join(testTmpBase(), "paperclip-patch-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fresh Paperclip home running `version`, and a fleet root with the given patches. */
function fixture(
	patches: Record<string, string>,
	opts: { version?: string; patchVersion?: string } = {},
): { home: string; fleet: string; file: string } {
	count += 1;
	const base = join(root, `case-${count}`);
	const version = opts.version ?? VERSION;
	const home = join(base, "paperclip");
	const install = join(home, "cli/installs/npm", version);
	const file = join(install, "node_modules/@paperclipai/server/dist/limits.js");
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, ORIGINAL);
	symlinkSync(`installs/npm/${version}`, join(home, "cli/current"));
	const fleet = join(base, "fleet");
	const dir = join(fleet, "paperclip-patches", opts.patchVersion ?? VERSION);
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(patches)) writeFileSync(join(dir, name), body);
	return { home, fleet, file };
}

function run(f: { home: string; fleet: string }, extra: string[] = []) {
	return exec([SCRIPT, "--root", f.fleet, "--home", f.home, ...extra]);
}

function exec(args: string[], cwd?: string) {
	const r = Bun.spawnSync([Bun.which("bash") ?? "/bin/bash", ...args], {
		cwd,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("paperclip-patch", () => {
	test("a fresh install is patched and asks for a restart", () => {
		const f = fixture({ "01-limit.patch": GOOD });
		const r = run(f);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("patched 01-limit.patch");
		expect(r.out).toContain("restart paperclipai to load");
		expect(readFileSync(f.file, "utf8")).toBe(PATCHED);
	});

	test("a re-run is idempotent: applied, unchanged, no restart", () => {
		const f = fixture({ "01-limit.patch": GOOD });
		expect(run(f).code).toBe(0);
		const r = run(f);
		expect(r.code).toBe(0);
		expect(r.out).toContain("applied 01-limit.patch");
		expect(r.out).not.toContain("patched");
		expect(r.out).not.toContain("restart");
		expect(readFileSync(f.file, "utf8")).toBe(PATCHED);
	});

	test("a conflicting patch refuses by name and changes nothing, not even earlier patches", () => {
		const f = fixture({ "01-limit.patch": GOOD, "02-bad.patch": CONFLICT });
		const r = run(f);
		expect(r.code).toBe(1);
		expect(r.out + r.err).toContain("02-bad.patch");
		expect(r.out).not.toContain("patched");
		expect(readFileSync(f.file, "utf8")).toBe(ORIGINAL);
	});

	test("no patch dir for the running version refuses and names the version", () => {
		const f = fixture({ "01-limit.patch": GOOD }, { version: "2026.999.0" });
		const r = run(f);
		expect(r.code).toBe(1);
		expect(r.out + r.err).toContain("2026.999.0");
		expect(readFileSync(f.file, "utf8")).toBe(ORIGINAL);
	});

	test("--check reports what it would do and changes nothing", () => {
		const f = fixture({ "01-limit.patch": GOOD });
		const r = run(f, ["--check"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("01-limit.patch");
		expect(r.out).not.toContain("restart");
		expect(readFileSync(f.file, "utf8")).toBe(ORIGINAL);
	});

	test("a bad argument is usage, exit 2", () => {
		const f = fixture({ "01-limit.patch": GOOD });
		expect(run(f, ["--bogus"]).code).toBe(2);
		expect(readFileSync(f.file, "utf8")).toBe(ORIGINAL);
	});

	test("installed as fleet/install.sh links it, the default root is the fleet dir", () => {
		const f = fixture({ "01-limit.patch": GOOD });
		const bin = join(f.fleet, "bin");
		mkdirSync(bin, { recursive: true });
		copyFileSync(SCRIPT, join(bin, "paperclip-patch"));
		chmodSync(join(bin, "paperclip-patch"), 0o755);
		const local = join(f.home, "..", "user/.local/bin");
		mkdirSync(local, { recursive: true });
		symlinkSync(join(bin, "paperclip-patch"), join(local, "paperclip-patch"));
		const r = exec([join(local, "paperclip-patch"), "--home", f.home]);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("patched 01-limit.patch");
		expect(readFileSync(f.file, "utf8")).toBe(PATCHED);
	});

	test("a relative --root is resolved before the patch is read", () => {
		const f = fixture({ "01-limit.patch": GOOD });
		const r = exec([SCRIPT, "--root", "fleet", "--home", f.home], join(f.fleet, ".."));
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("patched 01-limit.patch");
		expect(readFileSync(f.file, "utf8")).toBe(PATCHED);
	});

	test("a stacked series (02 written against 01's result) applies in order, then re-runs clean", () => {
		const f = fixture({ "01-limit.patch": GOOD, "02-c.patch": STACKED });
		const r = run(f);
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
		expect(r.out).toContain("patched 01-limit.patch");
		expect(r.out).toContain("patched 02-c.patch");
		expect(readFileSync(f.file, "utf8")).toBe(STACKED_RESULT);
		const again = run(f);
		expect(again.code).toBe(0);
		expect(again.out).toContain("applied 01-limit.patch");
		expect(again.out).toContain("applied 02-c.patch");
		expect(again.out).not.toContain("patched");
		expect(readFileSync(f.file, "utf8")).toBe(STACKED_RESULT);
	});

	test("patches that pass alone but not in order refuse in --check and change nothing in a real run", () => {
		const f = fixture({ "01-limit.patch": GOOD, "02-c.patch": OVERLAP });
		const check = run(f, ["--check"]);
		expect(check.code).toBe(1);
		expect(check.err).toContain("02-c.patch");
		const r = run(f);
		expect(r.code).toBe(1);
		expect(r.err).toContain("02-c.patch");
		expect(r.out).not.toContain("patched");
		expect(readFileSync(f.file, "utf8")).toBe(ORIGINAL);
	});
});
