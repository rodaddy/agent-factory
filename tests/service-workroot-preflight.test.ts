/**
 * @module tests/service-workroot-preflight
 * @description The boot-gate half of #151: composition must write-probe the change
 *   work root and REFUSE TO BOOT when it is unwritable.
 *
 *   The claim is an ORDERING claim, not just a throwing one. An unwritable work
 *   root must stop the boot before any runner work is dispatched, so the operator
 *   reads the path and the env var in a startup error instead of paying a full
 *   runner run per ingest to discover it (job 715, 2026-08-02, two runs burned).
 *   The transport therefore records whether it was ever driven.
 *
 *   Driven through the real `runOnce`, not `bootService`, because the EFFECTIVE
 *   work root is bound in composition (`opts.changeWorkRoot ?? defaultChangeWorkRoot()`)
 *   and that binding is exactly what the probe must follow.
 *
 *   MUTATIONS PROVEN (each made the named test go red before being restored):
 *   - Deleting the `await assertWorkRoot(...)` call from `bootAndBindRoots` ->
 *     "refuses to boot on an unwritable change work root" red (runOnce resolved
 *     and the pass ran).
 *   - Probing `defaultChangeWorkRoot()` instead of the bound `changeWorkRoot` ->
 *     "probes the work root the composition actually bound" red (the override was
 *     ignored and the production default was probed).
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { WatcherConfig } from "../src/config/schema";
import { runOnce } from "../src/service";
import { withTestDb } from "./db/helpers";
import { testTmpBase } from "./support/test-temp";

const CONFIG: WatcherConfig = {
	poll_interval_minutes: 15,
	repositories: [{ name: "rodaddy/software-factory", provider: "github", checks: "standard" }],
	job_templates: [],
	doorbell_enabled: false,
	shadow_publish: false,
} as unknown as WatcherConfig;

/** A transport that records whether composition ever reached the dispatch surface. */
function recordingTransport(reached: { dispatched: boolean }) {
	return {
		needed: async () => {
			reached.dispatched = true;
			throw new Error("no runner in this test");
		},
		run: async () => {
			reached.dispatched = true;
			throw new Error("no runner in this test");
		},
		done: async () => {},
	} as never;
}

describe("boot-time change work-root preflight", () => {
	test("refuses to boot on an unwritable change work root, naming the path and the env var", async () => {
		await withTestDb(async (db) => {
			// A REAL unwritable directory: it exists and can be stat-ed, but no file can
			// be created in it — the fleet host `ProtectSystem=strict` shape.
			const parent = mkdtempSync(join(testTmpBase(), "rw-boot-ro-"));
			const workRoot = join(parent, "work");
			mkdirSync(workRoot);
			chmodSync(workRoot, 0o500);

			const reached = { dispatched: false };
			const failure = await runOnce({
				loadConfig: async () => ({ ok: true as const, config: CONFIG }),
				resolveGitHubToken: async () => ({ ok: true as const, token: "t" }),
				createDb: () => ({ db, client: { end: async () => {} } }),
				transport: recordingTransport(reached),
				changeWorkRoot: workRoot,
			}).then(
				() => null,
				(err: unknown) => err,
			);

			chmodSync(workRoot, 0o700);

			expect(failure).toBeInstanceOf(Error);
			const message = (failure as Error).message;
			expect(message).toContain(workRoot);
			expect(message).toContain("WATCHER_WORK_ROOT");
			// The ordering claim: the boot stopped before any runner work was dispatched.
			expect(reached.dispatched).toBe(false);
		});
	});

	test("probes the work root the composition actually bound, not the env default", async () => {
		await withTestDb(async (db) => {
			// The OVERRIDE is unwritable while the env default would be writable. A probe
			// that read the env instead of the bound root would pass and boot.
			const parent = mkdtempSync(join(testTmpBase(), "rw-boot-bound-"));
			const workRoot = join(parent, "work");
			mkdirSync(workRoot);
			chmodSync(workRoot, 0o500);

			const saved = process.env.WATCHER_WORK_ROOT;
			process.env.WATCHER_WORK_ROOT = join(parent, "writable-elsewhere");
			try {
				const failure = await runOnce({
					loadConfig: async () => ({ ok: true as const, config: CONFIG }),
					resolveGitHubToken: async () => ({ ok: true as const, token: "t" }),
					createDb: () => ({ db, client: { end: async () => {} } }),
					transport: recordingTransport({ dispatched: false }),
					changeWorkRoot: workRoot,
				}).then(
					() => null,
					(err: unknown) => err,
				);

				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toContain(workRoot);
			} finally {
				chmodSync(workRoot, 0o700);
				if (saved === undefined) {
					delete process.env.WATCHER_WORK_ROOT;
				} else {
					process.env.WATCHER_WORK_ROOT = saved;
				}
			}
		});
	});
});
