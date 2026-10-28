/**
 * @module tests/jobs/verb-manifest-refresh
 * @description Behavioral cover for `refreshManifestCheckout` over REAL git
 *   fixtures — an origin plus a clone that is behind it, a clone that has DIVERGED
 *   from it, and a plain directory that is no checkout at all. The defect this guards
 *   is a silent one: reset #5 sat unseen through two reconcile passes on 2026-08-17
 *   because the share checkout was parked at an old commit and nothing pulled it, so
 *   the assertion that matters is on the FILE CONTENT the next read would see, not on
 *   an exit code or a spy count.
 *
 * @dependencies
 *   - ../../src/jobs/verb-manifest-refresh -- the exported helper under test
 *   - ../support/test-temp -- the portable temp base; never `/tmp`
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs, { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshManifestCheckout } from "../../src/jobs/verb-manifest-refresh";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const fixtures: string[] = [];

afterAll(() => {
	// Archive rather than delete: an agent never runs a recursive delete.
	for (const dir of fixtures) {
		const dest = join(testArchiveDir(), `manifest-refresh-${Date.now()}-${Math.random()}`);
		try {
			fs.renameSync(dir, dest);
		} catch {
			// A fixture that cannot be archived is not a test failure.
		}
	}
});

/**
 * Run git with a fixed argv and fully isolated identity/config, failing loudly so a
 * broken fixture is never silent. `GIT_CONFIG_GLOBAL=/dev/null` plus the author env
 * vars are the sf#315 pattern: without them these calls read (and can pollute) the
 * operator's real `~/.gitconfig`.
 */
function git(cwd: string, args: readonly string[]): string {
	const out = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			LC_ALL: "C",
			LANG: "C",
		},
	});
	if (out.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString()}`);
	}
	return out.stdout.toString().trim();
}

/** The manifest path inside a checkout, matching how production nests the file. */
const MANIFEST_RELATIVE = join("rails", "manifest.yml");

/**
 * A real origin repository carrying a manifest at `rails/manifest.yml`, plus a clone
 * of it. The clone is what production reads; the origin is what a tuple reset lands on.
 */
function fixture(baseContent: string): { origin: string; clone: string; manifest: string } {
	const root = mkdtempSync(join(testTmpBase(), "manifest-refresh-"));
	fixtures.push(root);
	const origin = join(root, "origin");
	fs.mkdirSync(join(origin, "rails"), { recursive: true });
	git(origin, ["init", "--quiet", "--initial-branch=main"]);
	writeFileSync(join(origin, MANIFEST_RELATIVE), baseContent);
	git(origin, ["add", "."]);
	git(origin, ["commit", "--quiet", "-m", "base manifest"]);

	const clone = join(root, "clone");
	git(root, ["clone", "--quiet", origin, clone]);
	return { origin, clone, manifest: join(clone, MANIFEST_RELATIVE) };
}

/** Land a new manifest revision on the origin, the way a tuple reset does. */
function advanceOrigin(origin: string, content: string, message: string): void {
	writeFileSync(join(origin, MANIFEST_RELATIVE), content);
	git(origin, ["add", "."]);
	git(origin, ["commit", "--quiet", "-m", message]);
}

/**
 * Capture the NDJSON log lines an async `run` emits, at the DESCRIPTOR level. pino
 * writes synchronously to fd 2 via `fs.writeSync`, NOT through `process.stderr.write`,
 * so a `process.stderr` spy sees nothing and every assertion passes VACUOUSLY — this
 * is the idiom `tests/service-pass-visibility.test.ts` already uses.
 */
async function captureLogs(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
	const raw: string[] = [];
	const realWriteSync = fs.writeSync;
	(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
		fd: number,
		data: string | NodeJS.ArrayBufferView,
		...rest: unknown[]
	) => {
		if (fd === 2) {
			const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
			raw.push(text);
			return typeof data === "string" ? Buffer.byteLength(text) : (data as Uint8Array).length;
		}
		return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
	}) as typeof fs.writeSync;
	try {
		await run();
	} finally {
		(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
	}
	return raw
		.join("")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}

describe("refreshManifestCheckout", () => {
	test("a BEHIND checkout is fast-forwarded, so the next read sees the new manifest", async () => {
		const { origin, clone, manifest } = fixture("tuple: terminal\n");
		advanceOrigin(origin, "tuple: reset-5\n", "tuple reset #5");

		// Precondition: without a refresh this is exactly the 03:47/04:02Z blindness.
		expect(readFileSync(manifest, "utf8")).toBe("tuple: terminal\n");

		const lines = await captureLogs(async () => {
			await refreshManifestCheckout(manifest);
		});

		// THE assertion the ticket owns: the bytes the manifest read will now see.
		expect(readFileSync(manifest, "utf8")).toBe("tuple: reset-5\n");
		expect(git(clone, ["rev-parse", "HEAD"])).toBe(git(origin, ["rev-parse", "HEAD"]));
		expect(lines.some((line) => line.msg === "verb.manifest.refreshed")).toBe(true);
	});

	test("a DIVERGED checkout is reported and left alone — no merge, no rebase, no reset", async () => {
		const { origin, clone, manifest } = fixture("tuple: terminal\n");
		advanceOrigin(origin, "tuple: origin-side\n", "origin commit");
		writeFileSync(manifest, "tuple: local-side\n");
		git(clone, ["add", "."]);
		git(clone, ["commit", "--quiet", "-m", "local divergent commit"]);

		const headBefore = git(clone, ["rev-parse", "HEAD"]);
		const countBefore = git(clone, ["rev-list", "--count", "HEAD"]);

		const lines = await captureLogs(async () => {
			// Never throws, by contract.
			await refreshManifestCheckout(manifest);
		});

		expect(git(clone, ["rev-parse", "HEAD"])).toBe(headBefore);
		// A merge commit would raise the count; --ff-only must never create one.
		expect(git(clone, ["rev-list", "--count", "HEAD"])).toBe(countBefore);
		expect(readFileSync(manifest, "utf8")).toBe("tuple: local-side\n");
		const failed = lines.filter((line) => line.msg === "verb.manifest.refresh_failed");
		expect(failed.length).toBe(1);
		const cause = failed[0]?.cause;
		// The stderr slice IS the divergence report, so it must be present AND bounded.
		expect(typeof cause).toBe("string");
		expect(String(cause).length).toBeLessThanOrEqual(300);
		expect(String(cause).length).toBeGreaterThan(0);
	});

	test("an ALREADY-CURRENT checkout stays current and still reports a refresh", async () => {
		const { clone, manifest } = fixture("tuple: current\n");
		const headBefore = git(clone, ["rev-parse", "HEAD"]);

		const lines = await captureLogs(async () => {
			await refreshManifestCheckout(manifest);
		});

		expect(git(clone, ["rev-parse", "HEAD"])).toBe(headBefore);
		expect(readFileSync(manifest, "utf8")).toBe("tuple: current\n");
		expect(lines.some((line) => line.msg === "verb.manifest.refreshed")).toBe(true);
	});

	test("a NON-GIT directory returns without throwing and logs the skip", async () => {
		const root = mkdtempSync(join(testTmpBase(), "manifest-refresh-nogit-"));
		fixtures.push(root);
		const manifest = join(root, "manifest.yml");
		writeFileSync(manifest, "tuple: loose\n");

		const lines = await captureLogs(async () => {
			await refreshManifestCheckout(manifest);
		});

		expect(readFileSync(manifest, "utf8")).toBe("tuple: loose\n");
		const skipped = lines.filter((line) => line.msg === "verb.manifest.refresh_skipped");
		expect(skipped.length).toBe(1);
		const cause = skipped[0]?.cause;
		expect(typeof cause).toBe("string");
		expect(String(cause).length).toBeLessThanOrEqual(300);
	});

	/**
	 * sf#348. RUNNING evidence, the watcher host 2026-08-17 07:32:47Z: every refresh skipped with
	 * `fatal: detected dubious ownership in repository at '/mnt/share/checkouts/
	 * rtech-infra'`, because the service user does not own the collab share checkout.
	 *
	 * **Why this is an ARGV assertion and not a behavioral one.** Ownership cannot be
	 * faked cheaply: making it genuinely dubious needs a second uid, and an agent does
	 * not `chown` or `sudo` to get one. A behavioral version WAS written first, driving
	 * the refusal with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` — it passed locally and FAILED
	 * on the pre-push runner, because that variable is a git BUILD-TIME test hook and the
	 * runner's packaged git ignores it. That is the "a check can silently measure its own
	 * harness" trap: the test's verdict tracked which git binary compiled it, not the
	 * behavior under test. It was removed rather than skipped, because a check whose
	 * outcome depends on the toolchain is not evidence in either direction.
	 *
	 * The argv level is the honest one, and it is strict about the VALUE, which is where
	 * the real mistake lives. Probed against git 2.55.0: naming a SUBDIRECTORY is refused
	 * while the repository root is accepted. Production reads a manifest nested under
	 * `scripts/done-means`, so `safe.directory=<cwd>` — the obvious fix — would be a
	 * silent no-op. This test is mutation-proven against exactly that wrong value.
	 */
	test("the git argv names safe.directory=<repo ROOT> before -C, for a NESTED manifest", async () => {
		const { clone } = fixture("tuple: nested\n");
		// Production reads a manifest in a SUBDIRECTORY (live: .../rtech-infra/scripts/
		// done-means). git rejects a subdirectory as the safe.directory value, so the
		// root — not the cwd — is the only value that works.
		const nestedDir = join(clone, "scripts", "done-means");
		fs.mkdirSync(nestedDir, { recursive: true });
		const manifest = join(nestedDir, "manifest.yml");
		writeFileSync(manifest, "tuple: nested\n");

		const argvs: string[][] = [];
		const realSpawn = Bun.spawn;
		(Bun as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[], opts: unknown) => {
			argvs.push([...cmd]);
			return (realSpawn as (...a: unknown[]) => unknown)(cmd, opts);
		}) as typeof Bun.spawn;
		try {
			await captureLogs(async () => {
				await refreshManifestCheckout(manifest);
			});
		} finally {
			(Bun as { spawn: typeof Bun.spawn }).spawn = realSpawn;
		}

		expect(argvs.length).toBeGreaterThan(0);
		for (const argv of argvs) {
			expect(argv[0]).toBe("git");
			expect(argv[1]).toBe("-c");
			// The repository ROOT, never the nested cwd git would refuse.
			expect(argv[2]).toBe(`safe.directory=${clone}`);
			// Ordering is load-bearing: -c must precede -C.
			expect(argv[3]).toBe("-C");
			expect(argv.indexOf("-c")).toBeLessThan(argv.indexOf("-C"));
		}
	});

	test("a MISSING directory returns without throwing", async () => {
		const root = mkdtempSync(join(testTmpBase(), "manifest-refresh-absent-"));
		fixtures.push(root);
		const manifest = join(root, "does-not-exist", "manifest.yml");

		await captureLogs(async () => {
			await refreshManifestCheckout(manifest);
		});
		// Reaching here at all is the assertion: the helper never throws.
		expect(fs.existsSync(manifest)).toBe(false);
	});

	test("EXTERNAL mode never pulls: a BEHIND checkout stays behind and the log names the on-disk HEAD", async () => {
		const f = fixture("base: 1\n");
		advanceOrigin(f.origin, "base: 2\n", "tuple reset");
		const headBefore = git(f.clone, ["rev-parse", "HEAD"]);

		const logs = await captureLogs(async () => {
			await refreshManifestCheckout(f.manifest, { mode: "external" });
		});

		expect(readFileSync(f.manifest, "utf8")).toBe("base: 1\n");
		expect(git(f.clone, ["rev-parse", "HEAD"])).toBe(headBefore);
		const line = logs.find((l) => l.msg === "verb.manifest.refresh_external");
		expect(line).toBeDefined();
		expect(line?.head).toBe(headBefore);
		expect(line?.path).toBe(f.clone);
		expect(
			logs.some(
				(l) => l.msg === "verb.manifest.refreshed" || l.msg === "verb.manifest.refresh_failed",
			),
		).toBe(false);
	});

	test("EXTERNAL mode on a NON-GIT directory returns without throwing and logs the skip", async () => {
		const root = mkdtempSync(join(testTmpBase(), "manifest-refresh-external-nogit-"));
		fixtures.push(root);
		fs.mkdirSync(join(root, "rails"), { recursive: true });
		const manifest = join(root, MANIFEST_RELATIVE);
		writeFileSync(manifest, "tuple: loose\n");

		const logs = await captureLogs(async () => {
			await refreshManifestCheckout(manifest, { mode: "external" });
		});

		expect(logs.some((l) => l.msg === "verb.manifest.refresh_skipped")).toBe(true);
		expect(logs.some((l) => l.msg === "verb.manifest.refresh_external")).toBe(false);
	});
});
