/**
 * The #170 emitter is constructed inside `createIngestAndPublish` and nothing
 * else holds a reference to it, so `TraceEmitter.shutdown()` is reachable from
 * production ONLY through the seam this file asserts. Before PR #176 that seam
 * did not exist: `shutdown()` had no production caller anywhere, `index.ts` did
 * `handle.stop(); process.exit(0)`, and every trace inside the SDK's ~10s
 * batching window was dropped on each restart while the PR body described a
 * "one console line at shutdown" path that could not run.
 *
 * These are WIRING tests. `AttemptObserver.shutdown`'s own behavior (flushes,
 * never throws, no-op when unconfigured) is proved in `attempt-observer.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WatcherConfig } from "../../src/config/schema";
import type { ForgeRegistry } from "../../src/forge/registry";
import type { GitRunner } from "../../src/results/branch-publisher";
import { startService } from "../../src/service";
import { createIngestAndPublish } from "../../src/service-ingest";
import { withTestDb } from "../db/helpers";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

/**
 * Run `fn` capturing the NDJSON log lines it emits.
 *
 * Captured at the DESCRIPTOR level (the idiom `tests/kboard/pass.test.ts` uses):
 * post-#88 pino writes synchronously to fd 2 via `fs.writeSync`, NOT through
 * `process.stderr.write`, so a `process.stderr` spy sees nothing and every
 * assertion on log content passes vacuously.
 */
async function withCapturedLogs<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; lines: Record<string, unknown>[] }> {
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
		const value = await fn();
		const lines = raw
			.join("")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		return { value, lines };
	} finally {
		(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
	}
}

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

/**
 * The minimum inputs `createIngestAndPublish` needs.
 *
 * `config` and `registry` are STORED, never dereferenced at construction (read
 * from `src/service-ingest.ts`, not assumed), so a cast placeholder is honest
 * here — this test asserts the shutdown seam, not the publication wiring.
 */
function inputs(db: Db) {
	return {
		db,
		config: {} as WatcherConfig,
		registry: {} as ForgeRegistry,
		shadow: true,
		collabRoot: "/nonexistent/collab",
		changeWorkRoot: "/nonexistent/work",
		shareRootOverride: undefined,
		git: (() => {}) as unknown as GitRunner,
		remoteFor: () => null,
		credentialFor: async () => null,
		triageAllowlistFor: () => [],
		clientFor: async () => null,
		onError: () => {},
	};
}

describe("the observability flush is REACHABLE from the service stop path", () => {
	test("THE IMPORTANT ONE: createIngestAndPublish returns a shutdown seam", async () => {
		await withTestDb(async (db) => {
			const wiring = createIngestAndPublish(inputs(db));
			// Without this the emitter is constructed, its reference discarded, and
			// `TraceEmitter.shutdown()` is dead code.
			expect(typeof wiring.shutdownObserver).toBe("function");
			// Langfuse is unconfigured in the test environment (no LANGFUSE_* vars), so
			// the emitter is null and the flush is a no-op — but it RESOLVES, which is
			// what `stop()` awaits.
			expect(wiring.shutdownObserver()).resolves.toBeUndefined();
		});
	});

	test("the seam never rejects, so a stop path cannot fail on observability", async () => {
		await withTestDb(async (db) => {
			const wiring = createIngestAndPublish(inputs(db));
			// Called twice: shutdown is idempotent from the caller's side, because a
			// stop path may be reached from both a signal handler and an unwind.
			await wiring.shutdownObserver();
			await wiring.shutdownObserver();
		});
	});
});

/**
 * The end-to-end half: drive the REAL `startService` and prove its `stop()`
 * actually reaches the flush.
 *
 * The seam test above proves `createIngestAndPublish` RETURNS a shutdown
 * function; this proves `service.ts` CALLS it. Both are needed — deleting the
 * `await shutdownObserver()` line from `stop()` leaves the seam test green and
 * produces no type error (verified by mutation), so without this the P1 fix
 * could be silently removed.
 *
 * Langfuse is pointed at a refused localhost port, so the flush is OBSERVABLE:
 * it emits `observability.langfuse.emit_failed`. With the flush absent, no such
 * line exists.
 */
describe("service stop() actually calls the flush (end to end)", () => {
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"LANGFUSE_BASE_URL",
		"LANGFUSE_PUBLIC_KEY",
		"LANGFUSE_SECRET_KEY",
	] as const;
	const savedEnv: Record<string, string | undefined> = {};

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("THE IMPORTANT ONE: stop() emits the flush attempt, so traces are not dropped", async () => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		// Same posture `tests/service.test.ts` uses: a token satisfies credential
		// resolution without the gh CLI, and a valid-protocol URL at a refused port
		// builds a LAZY sql client (no connect on construct).
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "obs-shutdown-work");
		// PLACEHOLDER keys, never a real credential. Port 7199 is in this repo's
		// local dev range and nothing listens on it.
		process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:7199";
		process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-placeholder";
		process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-placeholder";

		const configPath = join(testTmpBase(), "_scratch", `obs-shutdown-${crypto.randomUUID()}.yml`);
		await Bun.write(
			configPath,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"",
			].join("\n"),
		);

		const { lines } = await withCapturedLogs(async () => {
			const handle = await startService({
				configPath,
				statusPort: 0,
				// A scheduler that neither arms a timer nor runs a pass: this test is
				// about the STOP path, not the cycle.
				createScheduler: () =>
					({ start: async () => {}, stop: async () => {}, trigger: () => {} }) as never,
			});
			await handle.stop();
		});
		// The flush RAN. Deleting `await shutdownObserver()` from stop() removes this
		// line entirely — and produces no type error, so this assertion is the only
		// thing standing between the P1 fix and a silent regression.
		expect(lines.some((l) => l.msg === "observability.langfuse.flushed")).toBe(true);
		// And the enable line proves the emitter was really constructed, so the
		// assertion above is not passing for the disabled-emitter reason.
		expect(lines.some((l) => l.msg === "observability.langfuse.enabled")).toBe(true);

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
	});
});

/**
 * The failed-boot half.
 *
 * `scheduler.start()` runs a pass IMMEDIATELY, so a startup that throws after
 * that pass has already ingested attempts leaves traces sitting in the SDK's
 * ~10s batching window — and the process is about to die on the rethrown error,
 * so nothing else will ever flush them. `stop()` is never reached on this path:
 * `startService` rethrows instead of returning a handle. The failed boot is the
 * run most worth having a trace of, and it was the one run guaranteed to lose
 * its traces.
 */
describe("a FAILED startup still flushes observability (P1)", () => {
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"LANGFUSE_BASE_URL",
		"LANGFUSE_PUBLIC_KEY",
		"LANGFUSE_SECRET_KEY",
	] as const;
	const savedEnv: Record<string, string | undefined> = {};

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("THE IMPORTANT ONE: the flush is awaited on the unwind path, AFTER the drain", async () => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "obs-unwind-work");
		// PLACEHOLDER keys, never a real credential. Port 7199 is in this repo's
		// local dev range and nothing listens on it, so the flush is OBSERVABLE.
		process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:7199";
		process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-placeholder";
		process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-placeholder";

		const configPath = join(testTmpBase(), "_scratch", `obs-unwind-${crypto.randomUUID()}.yml`);
		await Bun.write(
			configPath,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"",
			].join("\n"),
		);

		// Order is the second half of the contract: the scheduler drain can queue
		// the final traces, so flushing before it would miss exactly those.
		const order: string[] = [];
		const bootFailure = new Error("scheduler refused to start");

		const { value, lines } = await withCapturedLogs(async () => {
			// Installed INSIDE the capture, so it layers over `withCapturedLogs`'s own
			// fd-2 hook rather than being replaced by it. The flush emits its log line
			// synchronously inside `shutdownObserver`, so watching fd 2 stamps the
			// flush into the SAME ordered list the scheduler stub writes to — which
			// makes drain-before-flush a real ordering assertion rather than two
			// existence checks that would hold in either sequence.
			const outerWriteSync = fs.writeSync;
			(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
				fd: number,
				data: string | NodeJS.ArrayBufferView,
				...rest: unknown[]
			) => {
				if (fd === 2) {
					const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
					if (text.includes("observability.langfuse.flushed")) order.push("observer.flushed");
				}
				return (outerWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
			}) as typeof fs.writeSync;
			try {
				await startService({
					configPath,
					statusPort: 0,
					// A pass ran, THEN start rejected — the interleaving that loses traces.
					createScheduler: () =>
						({
							start: async () => {
								throw bootFailure;
							},
							stop: async () => {
								order.push("scheduler.stop");
							},
							trigger: () => {},
						}) as never,
				});
				return "returned-a-handle" as const;
			} catch (err) {
				return err;
			} finally {
				// Hand fd 2 back to `withCapturedLogs`, which restores the real one.
				(fs as { writeSync: typeof fs.writeSync }).writeSync = outerWriteSync;
			}
		});

		// The AUTHORITATIVE startup error still wins: the flush must not mask it.
		expect(value).toBe(bootFailure);
		// THE FLUSH RAN. Without the `shutdownObserver` argument on the unwind path
		// this line does not exist and every queued trace dies with the process.
		expect(lines.some((l) => l.msg === "observability.langfuse.flushed")).toBe(true);
		// ...and the emitter really was constructed, so the assertion above is not
		// passing for the disabled-emitter reason.
		expect(lines.some((l) => l.msg === "observability.langfuse.enabled")).toBe(true);
		// LAST: the scheduler really drained, and it drained BEFORE the flush. Both
		// are recorded on the same `order` list so the comparison is a real
		// ordering, not two independent existence checks that could hold in either
		// sequence. `withCapturedLogs` cannot supply this — it sees the flush line
		// but not the scheduler call — so the flush timestamp is stamped into
		// `order` by the log capture's own view of when it appeared.
		expect(order).toEqual(["scheduler.stop", "observer.flushed"]);

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
	});
});
