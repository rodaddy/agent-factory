/**
 * Service-composition regressions. These do NOT boot the full service (which
 * needs config, a DB, and GitHub credentials); they pin the shutdown-ordering
 * *contract* that `startService` wires between the status server's doorbell and
 * the reconciliation scheduler.
 *
 * Finding P2 (shutdown acknowledgement): the doorbell must stop accepting
 * requests BEFORE the scheduler is marked stopped and drained, so no caller ever
 * receives an accepted 202 whose wake has already become a no-op. We reconstruct
 * the exact wiring `service.ts` uses — a shared `accepting` flag flipped first in
 * stop(), a real Scheduler as the wake target — and assert the ordering holds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WatcherConfig } from "../src/config/schema";
import { bindCriticalAlert } from "../src/observability/critical-alert";
import type { PassResult } from "../src/reconcile/pass";
import { Scheduler } from "../src/reconcile/scheduler";
import { redactBusUrl, startService } from "../src/service";
import type { StatusSnapshot } from "../src/status/query";
import { createStatusHandler, startStatusServer } from "../src/status/server";
import { testArchiveDir, testTmpBase } from "./support/test-temp";

const SNAPSHOT: StatusSnapshot = {
	generatedAt: "2026-07-19T18:00:00Z",
	repositories: [],
	heldBoxes: [],
	unconfirmedAllocations: [],
	tracedAttempts: [],
};

function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: "rodaddy/open-brain",
				provider: "github",
				checks: "standard",
				gate_selection: "full",
			},
		],
		job_templates: [],
		doorbell_enabled: true,
		shadow_publish: false,
	};
}

function emptyResult(): PassResult {
	return {
		startedAt: "2026-07-19T18:00:00Z",
		durationMs: 1,
		repositories: [],
		okCount: 0,
		failCount: 0,
	};
}

function doorbellReq(): Request {
	return new Request("http://localhost/doorbell", {
		method: "POST",
		headers: { "content-type": "application/json", host: "localhost" },
		body: JSON.stringify({ repository: "rodaddy/open-brain" }),
	});
}

/**
 * Reconstruct the service wiring: a shared `accepting` flag, a real scheduler
 * whose `trigger()` is the doorbell wake, and the stop() order service.ts uses.
 */
function wireService() {
	let accepting = true;
	let triggers = 0;
	const scheduler = new Scheduler({
		intervalMinutes: 15,
		run: async () => {
			return emptyResult();
		},
		setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
		clearInterval: () => {},
	});
	// Count how many triggers actually reach a live (non-stopped) scheduler.
	const originalTrigger = scheduler.trigger.bind(scheduler);
	const wake = () => {
		triggers++;
		return originalTrigger();
	};
	const handler = createStatusHandler({
		source: async () => SNAPSHOT,
		pollIntervalMinutes: 15,
		accepting: () => accepting,
		doorbell: { config: config(), wake },
	});
	const stop = async () => {
		// The exact service.ts order.
		accepting = false;
		await scheduler.stop();
	};
	return {
		handler,
		scheduler,
		stop,
		start: () => scheduler.start(),
		triggers: () => triggers,
		acceptingNow: () => accepting,
	};
}

describe("service shutdown ordering (finding P2)", () => {
	test("a doorbell landing after stop begins gets 503, never an accepted 202", async () => {
		const svc = wireService();
		await svc.start();

		// Before shutdown: the doorbell accepts and wakes.
		const before = await svc.handler(doorbellReq());
		expect(before.status).toBe(202);
		expect(svc.triggers()).toBe(1);

		// Begin shutdown; the accepting flag flips false FIRST.
		const stopping = svc.stop();

		// A request arriving during shutdown must be refused with 503, not 202 —
		// its wake would be a no-op on a stopped scheduler.
		const during = await svc.handler(doorbellReq());
		expect(during.status).toBe(503);
		expect(await during.json()).toEqual({ accepted: false, error: "server is shutting down" });

		await stopping;
		// The refused request never fired a wake.
		expect(svc.triggers()).toBe(1);
	});

	test("stop flips accepting to false before the scheduler stops draining", async () => {
		// Ordering invariant: accepting is already false by the time stop() awaits
		// the scheduler. If it were reversed, a request could be accepted (202) while
		// the scheduler is already a no-op.
		const svc = wireService();
		await svc.start();
		await svc.stop();
		expect(svc.acceptingNow()).toBe(false);

		// After a completed stop, any late doorbell is refused with 503 and never
		// reaches the (now stopped) scheduler.
		const late = await svc.handler(doorbellReq());
		expect(late.status).toBe(503);
		expect(svc.triggers()).toBe(0);
	});

	test("without the accepting gate a post-stop request would wake a no-op scheduler (guards against regression)", async () => {
		// This proves the gate is load-bearing: with NO accepting gate, the same
		// stopped scheduler happily 'accepts' (202) a request whose trigger is a
		// no-op. The gate is exactly what prevents that false acknowledgement.
		const scheduler = new Scheduler({
			intervalMinutes: 15,
			run: async () => emptyResult(),
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: () => {},
		});
		let triggers = 0;
		const handler = createStatusHandler({
			source: async () => SNAPSHOT,
			pollIntervalMinutes: 15,
			// No accepting gate.
			doorbell: {
				config: config(),
				wake: () => {
					triggers++;
					return scheduler.trigger();
				},
			},
		});
		await scheduler.start();
		await scheduler.stop();
		const res = await handler(doorbellReq());
		// Ungated: returns 202 even though the scheduler is stopped — the wake fires
		// but the scheduler's trigger is a no-op. This is the false acknowledgement
		// the accepting gate eliminates in the wired service.
		expect(res.status).toBe(202);
		expect(triggers).toBe(1);
	});
});

/**
 * Finding P2 (startup-failure cleanup): `startService` binds the status server —
 * which begins accepting doorbells — BEFORE `await scheduler.start()`. If
 * scheduler startup rejects, the accepting status/doorbell listener must not leak
 * and the scheduler lifecycle must be drained. These tests drive the *real*
 * `startService` body (not a reconstructed contract). Startup rejection is
 * injected through the supported `createScheduler` seam — a real `Scheduler`
 * whose `start()` is made to reject — the exact terminal-audit failure scenario.
 * (A faulty `onError` sink can no longer force this: a throwing sink is swallowed
 * by design so it cannot abort the tick/drain loop — see #36.)
 *
 * We prove cleanup end-to-end at the socket level: the status server is bound to
 * a real, pre-reserved localhost port, and after the failure a live HTTP request
 * to that port is refused — if the listener had leaked, the request would
 * connect. Pointing the DB URL at a refused port keeps the startup failure fast
 * and deterministic.
 */
describe("startService startup-failure cleanup (finding P2)", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "DATABASE_URL", "WATCHER_WORK_ROOT"] as const;

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	function stubEnv(): void {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		// A token satisfies credential resolution without touching the gh CLI. A
		// valid-protocol URL pointed at a refused port constructs a lazy SQL client
		// (no connection on construct) and makes the startup pass fail fast rather
		// than hang; that pass error is swallowed by the scheduler's onError.
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		// The boot write-probes the change work root for real. Point it at the
		// portable test temp base; the production default `/var/lib/software-factory/work`
		// is not writable by a test user, and the probe correctly refuses to boot on it.
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-startup-work");
	}

	/** Reserve then release a localhost port so we can assert nothing listens later. */
	async function reserveLocalhostPort(): Promise<number> {
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
		const port = probe.port;
		await probe.stop(true);
		if (port === undefined) {
			throw new Error("failed to reserve a localhost port");
		}
		return port;
	}

	/** True if a localhost TCP listener answers on `port`, false if the connect is refused. */
	async function isListening(port: number): Promise<boolean> {
		try {
			await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(1000),
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Write a minimal valid config to a temp path and return it. */
	async function writeTempConfig(): Promise<string> {
		const path = join(testTmpBase(), `p2-startup-${crypto.randomUUID()}.yml`);
		const yaml = [
			"poll_interval_minutes: 15",
			"repositories:",
			"  - name: rodaddy/open-brain",
			"    provider: github",
			"    checks: standard",
			"job_templates: []",
			"doorbell_enabled: true",
			"",
		].join("\n");
		await Bun.write(path, yaml);
		return path;
	}

	test("a rejecting scheduler.start() stops the status listener and rethrows the original error", async () => {
		stubEnv();
		const configPath = await writeTempConfig();
		const port = await reserveLocalhostPort();
		const startupError = new Error("boom: startup error callback failed");

		// Sanity: the reserved port is free before we start.
		expect(await isListening(port)).toBe(false);

		// The bound status-page URL (sf#526: now a JSON log line, not stdout), recorded
		// by wrapping the real server at the seam. Set only once the socket is bound.
		let boundUrl = "";
		let promiseRejection: unknown;
		// Observe that startService's cleanup path actually drains the scheduler.
		// Because start() rejects before any interval is armed, the real stop() is a
		// no-op for observable state, so a spy is the only way to prove the drain ran.
		// If startService's `await scheduler.stop()` cleanup line were deleted, this
		// stays 0 and the assertion below fails.
		let stopCalls = 0;
		try {
			await startService({
				configPath,
				statusPort: port,
				startStatusServer: (serverOpts) => {
					const server = startStatusServer(serverOpts);
					boundUrl = `http://${server.hostname}:${server.port}/`;
					return server;
				},
				// Inject startup rejection through the supported `createScheduler` seam:
				// a real Scheduler whose `start()` rejects. This drives startService's
				// real cleanup path (stop the bound listener, drain the scheduler, rethrow
				// the original error) — the exact terminal-audit scenario — without relying
				// on a throwing onError sink, which #36 now (correctly) swallows.
				createScheduler: (schedulerOpts) => {
					const real = new Scheduler(schedulerOpts);
					return new Proxy(real, {
						get(target, prop, receiver) {
							if (prop === "start") {
								return () => Promise.reject(startupError);
							}
							if (prop === "stop") {
								// Record the cleanup drain, then delegate to the real
								// scheduler's stop() (which resolves cleanly for a
								// never-started scheduler) to preserve real teardown.
								return () => {
									stopCalls += 1;
									return Reflect.apply(Reflect.get(target, prop, receiver), target, []);
								};
							}
							return Reflect.get(target, prop, receiver);
						},
					});
				},
			});
		} catch (err) {
			promiseRejection = err;
		}

		// The original startup error is preserved and rethrown to the caller.
		expect(promiseRejection).toBe(startupError);

		// The status listener really bound (its URL was printed) before the failure —
		// so the refused connect below is genuine teardown, not a pre-bind bail-out.
		expect(boundUrl).toBe(`http://127.0.0.1:${port}/`);

		// No accepting status/doorbell listener remains: the pre-reserved port is
		// refused. If cleanup had leaked the listener, this connect would succeed.
		expect(await isListening(port)).toBe(false);

		// The startup-failure cleanup drained the scheduler exactly once. This is the
		// original P2 finding: on startup failure the scheduler lifecycle must be
		// DRAINED. Deleting startService's `await scheduler.stop()` cleanup line would
		// leave stopCalls at 0 and fail here.
		expect(stopCalls).toBe(1);

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
	});
});

/**
 * Forge webhook wiring. `statusServerWiring` is private, so it is
 * observed where the service actually uses it: the object handed to the injected
 * `startStatusServer` seam. Presence of `FORGE_WEBHOOK_SECRET` is the ONLY switch
 * — with it the server must bind beyond loopback and carry a `forgeHook` whose
 * wake is the scheduler's coalescing trigger; without it neither field is set, so
 * a watcher that has not been given a secret keeps its loopback-only bind.
 */
describe("startService forge webhook wiring", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
	] as const;

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	function stubEnv(): void {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-hook-work");
		delete process.env.FORGE_WEBHOOK_SECRET;
		delete process.env.NATS_URL;
		delete process.env.NATS_NKEY_FILE;
	}

	/** Write a minimal valid config the boot accepts. */
	async function writeConfig(): Promise<string> {
		const path = join(testTmpBase(), `hook-wiring-${crypto.randomUUID()}.yml`);
		await Bun.write(
			path,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"doorbell_enabled: true",
				"",
			].join("\n"),
		);
		return path;
	}

	/**
	 * Boot the service with the status server replaced by a capture. The scheduler
	 * is a real one whose interval never arms, so nothing long-lived survives; the
	 * returned handle is stopped by the caller.
	 */
	async function captureWiring(configPath: string): Promise<{
		wiring: Parameters<typeof startStatusServer>[0];
		triggers: () => number;
		stop: () => Promise<void>;
	}> {
		let captured: Parameters<typeof startStatusServer>[0] | undefined;
		let triggers = 0;
		const handle = await startService({
			configPath,
			startStatusServer: ((opts: Parameters<typeof startStatusServer>[0]) => {
				captured = opts;
				return {
					hostname: "127.0.0.1",
					port: 0,
					stop: async () => {},
				};
			}) as never,
			createScheduler: ((schedulerOpts: ConstructorParameters<typeof Scheduler>[0]) => {
				const real = new Scheduler({
					...schedulerOpts,
					setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
					clearInterval: () => {},
				});
				const originalTrigger = real.trigger.bind(real);
				real.trigger = () => {
					triggers += 1;
					return originalTrigger();
				};
				return real;
			}) as never,
		});
		if (captured === undefined) {
			throw new Error("startStatusServer seam was never called");
		}
		return { wiring: captured, triggers: () => triggers, stop: handle.stop };
	}

	test("FORGE_WEBHOOK_SECRET set binds 0.0.0.0 and wires the hook to the scheduler", async () => {
		stubEnv();
		process.env.FORGE_WEBHOOK_SECRET = "  s3cr3t-hook-key  ";
		const configPath = await writeConfig();
		const captured = await captureWiring(configPath);
		try {
			expect(captured.wiring.hostname).toBe("0.0.0.0");
			expect(captured.wiring.forgeHook).toBeDefined();
			// Trimmed, so a trailing newline in an env file cannot break every signature.
			expect(captured.wiring.forgeHook?.secret).toBe("s3cr3t-hook-key");
			await captured.wiring.forgeHook?.wake();
			expect(captured.triggers()).toBe(1);
		} finally {
			await captured.stop();
			await rename(
				configPath,
				join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
			);
		}
	});

	test("FORGE_WEBHOOK_SECRET unset leaves the loopback default and no hook", async () => {
		stubEnv();
		const configPath = await writeConfig();
		const captured = await captureWiring(configPath);
		try {
			expect(captured.wiring.hostname).toBeUndefined();
			expect(captured.wiring.forgeHook).toBeUndefined();
		} finally {
			await captured.stop();
			await rename(
				configPath,
				join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
			);
		}
	});
});

/**
 * NATS bus wiring. The bus is switched by BOTH `NATS_URL` and
 * `NATS_NKEY_FILE`; either absent leaves it off with a stated reason, because a
 * half-configured bus that silently does nothing is the failure mode this log
 * line exists to prevent. Observed through the boot log rather than the private
 * `statusServerWiring`, and captured at the DESCRIPTOR level — pino writes to
 * fd 2 with `fs.writeSync`, so a `process.stderr` spy sees nothing and every
 * assertion would pass vacuously (the idiom is
 * `tests/service-pass-visibility.test.ts`).
 */
describe("startService NATS bus wiring", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
	] as const;

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	function stubEnv(): void {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-nats-work");
		delete process.env.FORGE_WEBHOOK_SECRET;
		delete process.env.NATS_URL;
		delete process.env.NATS_NKEY_FILE;
	}

	async function writeConfig(): Promise<string> {
		const path = join(testTmpBase(), `nats-wiring-${crypto.randomUUID()}.yml`);
		await Bun.write(
			path,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"doorbell_enabled: true",
				"",
			].join("\n"),
		);
		return path;
	}

	/** Capture NDJSON log lines at fd 2 while `run` executes. */
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

	/** Boot with the status server and scheduler stubbed, returning the log lines. */
	async function bootAndCapture(configPath: string): Promise<Record<string, unknown>[]> {
		let stop: (() => Promise<void>) | undefined;
		const lines = await captureLogs(async () => {
			const handle = await startService({
				configPath,
				startStatusServer: (() => ({
					hostname: "127.0.0.1",
					port: 0,
					stop: async () => {},
				})) as never,
				createScheduler: ((schedulerOpts: ConstructorParameters<typeof Scheduler>[0]) =>
					new Scheduler({
						...schedulerOpts,
						setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
						clearInterval: () => {},
					})) as never,
			});
			stop = handle.stop;
		});
		await stop?.();
		return lines;
	}

	function busLines(lines: Record<string, unknown>[]): Record<string, unknown>[] {
		return lines.filter((line) => String(line.msg ?? "").startsWith("bus.nats."));
	}

	test("NATS_URL without NATS_NKEY_FILE leaves the bus disabled with a reason", async () => {
		stubEnv();
		process.env.NATS_URL = "nats://10.0.20.160:4222";
		const configPath = await writeConfig();
		try {
			const lines = busLines(await bootAndCapture(configPath));
			expect(lines.length).toBe(1);
			expect(lines[0]?.msg).toBe("bus.nats.disabled");
			expect(typeof lines[0]?.reason).toBe("string");
			expect(String(lines[0]?.reason)).toContain("NATS_NKEY_FILE");
		} finally {
			await rename(
				configPath,
				join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
			);
		}
	});

	test("both unset leaves the bus disabled with a reason", async () => {
		stubEnv();
		const configPath = await writeConfig();
		try {
			const lines = busLines(await bootAndCapture(configPath));
			expect(lines.length).toBe(1);
			expect(lines[0]?.msg).toBe("bus.nats.disabled");
			expect(String(lines[0]?.reason).length).toBeGreaterThan(0);
			// Never the seed, never a path's contents.
			expect(lines[0]?.seed).toBeUndefined();
		} finally {
			await rename(
				configPath,
				join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
			);
		}
	});

	test("NATS_NKEY_FILE without NATS_URL leaves the bus disabled with a reason", async () => {
		stubEnv();
		process.env.NATS_NKEY_FILE = join(testTmpBase(), "_scratch", "nonexistent-seed");
		const configPath = await writeConfig();
		try {
			const lines = busLines(await bootAndCapture(configPath));
			expect(lines.length).toBe(1);
			expect(lines[0]?.msg).toBe("bus.nats.disabled");
			expect(String(lines[0]?.reason)).toContain("NATS_URL");
		} finally {
			await rename(
				configPath,
				join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
			);
		}
	});
});

/**
 * The connect-failure path. A bus that cannot be reached at boot must
 * NOT stop the service: the webhook receiver's job is to store deliveries
 * durably, and it has to keep doing that with the cluster down. Driven against a
 * closed port so the client's own `CONNECTION_REFUSED` is the real failure —
 * probed at 4ms, so this costs nothing.
 */
describe("startService NATS connect failure", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
	] as const;

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	test("an unreachable cluster logs connect_failed and the service still starts", async () => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-nats-fail-work");
		delete process.env.FORGE_WEBHOOK_SECRET;
		// A closed port on loopback: the client refuses immediately.
		process.env.NATS_URL = "nats://127.0.0.1:59999";
		const seedPath = join(testTmpBase(), `nats-seed-${crypto.randomUUID()}`);
		// Not a real credential — a syntactically wrong seed never leaves this box,
		// and the connection is refused before authentication is ever attempted.
		await Bun.write(seedPath, "SUANOTAREALSEEDVALUE\n");
		process.env.NATS_NKEY_FILE = seedPath;

		const configPath = join(testTmpBase(), `nats-fail-${crypto.randomUUID()}.yml`);
		await Bun.write(
			configPath,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"doorbell_enabled: true",
				"",
			].join("\n"),
		);

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

		let stop: (() => Promise<void>) | undefined;
		try {
			// The service STARTS — this resolving at all is the assertion.
			const handle = await startService({
				configPath,
				startStatusServer: (() => ({
					hostname: "127.0.0.1",
					port: 0,
					stop: async () => {},
				})) as never,
				createScheduler: ((schedulerOpts: ConstructorParameters<typeof Scheduler>[0]) =>
					new Scheduler({
						...schedulerOpts,
						setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
						clearInterval: () => {},
					})) as never,
			});
			stop = handle.stop;
		} finally {
			(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
		}
		await stop?.();

		const lines = raw
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
		const failed = lines.filter((line) => line.msg === "bus.nats.connect_failed");
		expect(failed.length).toBe(1);
		expect(failed[0]?.error_class).toBe("NatsError");
		// The bus never came up, so it must not claim it did.
		expect(lines.filter((line) => line.msg === "bus.nats.enabled").length).toBe(0);
		// And the seed's contents never reach a log line.
		expect(raw.join("")).not.toContain("SUANOTAREALSEEDVALUE");

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
		await rename(seedPath, join(testArchiveDir(), `${basename(seedPath)}-${crypto.randomUUID()}`));
	});
});

/**
 * Failed-startup unwind ORDER. `stopService` declares one
 * order — HTTP stop, bus close, scheduler drain, observability flush — and the
 * failed-startup path must use the SAME one. It did not: `startService` called
 * `closeBus(bus)` before `unwindFailedStartup()` stopped the listener, so a boot
 * that failed closed the bus while the listener was still accepting doorbells
 * and in-flight deliveries could still be mid-publish.
 *
 * The order is observed through a recorded call log rather than an exit code,
 * because both orders "succeed" — only the sequence differs. The bus is a real
 * one built through `createNatsBus`'s injected `connect` seam, so the recorded
 * `bus.close` is the service's genuine close path, not a stand-in.
 */
describe("startService failed-startup unwind order", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
	] as const;

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	test("the HTTP listener stops BEFORE the bus closes on a failed boot", async () => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-unwind-order-work");
		delete process.env.FORGE_WEBHOOK_SECRET;
		// No env-driven bus: the `bus` seam below supplies one directly, so this
		// test needs no cluster and `createBusFromEnv` is never consulted.
		delete process.env.NATS_URL;
		delete process.env.NATS_NKEY_FILE;

		const configPath = join(testTmpBase(), `unwind-order-${crypto.randomUUID()}.yml`);
		await Bun.write(
			configPath,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"doorbell_enabled: true",
				"",
			].join("\n"),
		);

		const order: string[] = [];
		const startupError = new Error("boom: scheduler start rejected");
		let rejection: unknown;
		try {
			await startService({
				configPath,
				// A bus injected through the supported seam, recording its close. It
				// carries a `connection`, so the results consumer genuinely STARTS and
				// the consumer-stop step in the unwind is real rather than vacuous — a
				// bus without one made the consumer undefined and the order assertion
				// below could never have seen it.
				bus: {
					publishForgeDelivery: async () => {},
					close: async () => {
						order.push("bus.close");
					},
					connection: {
						jetstreamManager: async () => ({
							consumers: {
								add: async (_stream: string, cfg: Record<string, unknown>) => ({ config: cfg }),
							},
						}),
						jetstream: () => ({
							consumers: {
								get: async () => ({
									fetch: async () => {
										// Each pull window is recorded, so the LAST one is observable
										// relative to `bus.close`: the consumer must already be stopped
										// when the bus drains, or the loop is holding a fetch on a
										// connection being closed underneath it.
										order.push("consumer.fetch");
										await new Promise((resolve) => setTimeout(resolve, 5)); // fixed-sleep-ok: simulated latency in a fake
										return { [Symbol.asyncIterator]: async function* () {} };
									},
								}),
							},
						}),
					},
				} as never,
				startStatusServer: (() => ({
					hostname: "127.0.0.1",
					port: 0,
					stop: async () => {
						order.push("http.stop");
					},
				})) as never,
				createScheduler: ((schedulerOpts: ConstructorParameters<typeof Scheduler>[0]) => {
					const real = new Scheduler({
						...schedulerOpts,
						setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
						clearInterval: () => {},
					});
					return new Proxy(real, {
						get(target, prop, receiver) {
							if (prop === "start") {
								return () => Promise.reject(startupError);
							}
							if (prop === "stop") {
								return () => {
									order.push("scheduler.stop");
									return Reflect.apply(Reflect.get(target, prop, receiver), target, []);
								};
							}
							return Reflect.get(target, prop, receiver);
						},
					});
				}) as never,
			});
		} catch (err) {
			rejection = err;
		}

		expect(rejection).toBe(startupError);
		// Every step ran exactly once...
		expect(order.filter((step) => step === "http.stop").length).toBe(1);
		expect(order.filter((step) => step === "bus.close").length).toBe(1);
		expect(order.filter((step) => step === "scheduler.stop").length).toBe(1);
		// ...and in the ONE declared order. Swapping the two calls back (the F2
		// defect) puts bus.close at index 0 and fails here.
		expect(order.indexOf("http.stop")).toBeLessThan(order.indexOf("bus.close"));
		expect(order.indexOf("bus.close")).toBeLessThan(order.indexOf("scheduler.stop"));
		// The consumer really ran (the bus fake carries a connection), and its loop
		// was drained BEFORE the bus closed: no fetch window opens after the close.
		expect(order).toContain("consumer.fetch");
		expect(order.lastIndexOf("consumer.fetch")).toBeLessThan(order.indexOf("bus.close"));

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
	});
});

/**
 * `NATS_URL` redaction. The nats client ACCEPTS a
 * `nats://user:pass@host:4222` url, and the boot line logged that string
 * verbatim — putting a password in stderr and in every log shipper downstream
 * of it. Only the host and port are ever needed to answer "which cluster", so
 * only those are emitted.
 *
 * Captured at fd 2 with `fs.writeSync`: pino writes there directly, so a
 * `process.stderr` spy sees nothing and this assertion would pass vacuously
 * whether or not the credential leaked.
 */
describe("startService NATS_URL redaction", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
	] as const;

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	test("a userinfo-bearing NATS_URL never reaches a log line", async () => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-nats-redact-work");
		delete process.env.FORGE_WEBHOOK_SECRET;
		// Port 1 on loopback is refused immediately; the userinfo is never sent
		// anywhere, and these are not real credentials.
		process.env.NATS_URL = "nats://natsuser:natspassword@127.0.0.1:1/";
		const seedPath = join(testTmpBase(), `nats-redact-seed-${crypto.randomUUID()}`);
		await Bun.write(seedPath, "SUANOTAREALSEEDVALUE\n");
		process.env.NATS_NKEY_FILE = seedPath;

		const configPath = join(testTmpBase(), `nats-redact-${crypto.randomUUID()}.yml`);
		await Bun.write(
			configPath,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"doorbell_enabled: true",
				"",
			].join("\n"),
		);

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

		let stop: (() => Promise<void>) | undefined;
		try {
			const handle = await startService({
				configPath,
				startStatusServer: (() => ({
					hostname: "127.0.0.1",
					port: 0,
					stop: async () => {},
				})) as never,
				createScheduler: ((schedulerOpts: ConstructorParameters<typeof Scheduler>[0]) =>
					new Scheduler({
						...schedulerOpts,
						setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
						clearInterval: () => {},
					})) as never,
			});
			stop = handle.stop;
		} finally {
			(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
		}
		await stop?.();

		const text = raw.join("");
		// The password never appears, in any framing the raw string would produce.
		expect(text).not.toContain("natspassword");
		expect(text).not.toContain("natsuser");
		expect(text).not.toContain("@127.0.0.1");

		// ...and the line still identifies WHICH cluster, or the redaction has
		// simply deleted the observability the line exists for.
		const lines = text
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as Record<string, unknown>];
				} catch {
					return [];
				}
			});
		const busLine = lines.find(
			(line) => line.msg === "bus.nats.enabled" || line.msg === "bus.nats.connect_failed",
		);
		expect(busLine).toBeDefined();
		expect(JSON.stringify(busLine)).toContain("127.0.0.1");
		expect(JSON.stringify(busLine)).toContain("1");

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
		await rename(seedPath, join(testArchiveDir(), `${basename(seedPath)}-${crypto.randomUUID()}`));
	});
});

/**
 * `redactBusUrl` directly. The service-level test above can
 * only drive the CONNECT-FAILURE line, because a successful `bus.nats.enabled`
 * needs a live cluster — mutating the `enabled` call site alone left that test
 * green, which is a genuine coverage gap in it. Pinning the shared helper is
 * what covers BOTH call sites: neither can leak unless this returns the raw
 * string, and this asserts it never does.
 */
describe("redactBusUrl", () => {
	test("keeps host and port and drops userinfo entirely", () => {
		const fields = redactBusUrl("nats://natsuser:natspassword@10.0.20.160:4222/");
		expect(fields).toEqual({ host: "10.0.20.160", port: "4222" });
		// Not masked — absent. A mask still announces a credential was configured.
		expect(JSON.stringify(fields)).not.toContain("natspassword");
		expect(JSON.stringify(fields)).not.toContain("natsuser");
	});

	test("a credential-free url is unchanged in the fields that matter", () => {
		expect(redactBusUrl("nats://10.0.20.160:4222")).toEqual({
			host: "10.0.20.160",
			port: "4222",
		});
	});

	test("an unparseable url yields a constant rather than echoing the input", () => {
		// Echoing the raw string on a parse failure would put the leak straight back.
		expect(redactBusUrl("nats://[natspassword")).toEqual({ url: "unparseable" });
		expect(JSON.stringify(redactBusUrl("nats://[natspassword"))).not.toContain("natspassword");
		expect(redactBusUrl("")).toEqual({ url: "unparseable" });
	});

	test("a url that PARSES but carries no host still leaks nothing", () => {
		// `new URL` accepts this (scheme `natsuser:`, empty host) rather than
		// throwing, so it takes the parsed branch — the branch must be safe too, not
		// just the throwing one.
		const fields = redactBusUrl("natsuser:natspassword@not-a-url");
		expect(JSON.stringify(fields)).not.toContain("natspassword");
		expect(JSON.stringify(fields)).not.toContain("natsuser");
	});
});

/**
 * Startup-stage guard.
 *
 * The bus is connected BEFORE `composeService()` and the results consumer starts
 * BEFORE the status server binds, but cleanup existed only in the
 * `scheduler.start()` catch. A throw anywhere in between — composition,
 * scheduler construction, consumer start, status bind — therefore left the bus
 * connected, and with `maxReconnectAttempts: -1` its reconnect loop keeps the
 * process alive after `startService` rejected. One guard now spans every stage
 * after the connect: it stops the consumer (if it started) and closes the bus,
 * then rethrows the ORIGINAL error. The post-bind failure keeps using
 * `unwindFailedStartup`, so nothing is closed twice.
 *
 * The bus fake carries a `connection`, so the consumer genuinely starts and the
 * consumer-stop step is real rather than vacuous.
 */
function fakeConsumerBus(order: string[]): Record<string, unknown> {
	return {
		publishForgeDelivery: async () => {},
		close: async () => {
			order.push("bus.close");
		},
		connection: {
			jetstreamManager: async () => ({
				consumers: {
					add: async (_stream: string, cfg: Record<string, unknown>) => ({ config: cfg }),
				},
			}),
			jetstream: () => ({
				consumers: {
					get: async () => ({
						fetch: async () => {
							order.push("consumer.fetch");
							await new Promise((resolve) => setTimeout(resolve, 5)); // fixed-sleep-ok: simulated latency in a fake
							return { [Symbol.asyncIterator]: async function* () {} };
						},
					}),
				},
			}),
		},
	};
}

describe("startService startup-stage guard", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
	] as const;

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-stage-guard-work");
		delete process.env.FORGE_WEBHOOK_SECRET;
		delete process.env.NATS_URL;
		delete process.env.NATS_NKEY_FILE;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	test("a composition failure closes the bus before rethrowing", async () => {
		const order: string[] = [];
		const composeError = new Error("boom: config load rejected");
		let rejection: unknown;
		try {
			await startService({
				bus: fakeConsumerBus(order) as never,
				loadConfig: (() => {
					throw composeError;
				}) as never,
			});
		} catch (err) {
			rejection = err;
		}
		expect(rejection).toBe(composeError);
		expect(order.filter((step) => step === "bus.close").length).toBe(1);
	});

	test("a status-bind failure stops the consumer before closing the bus, exactly once", async () => {
		const configPath = join(testTmpBase(), `stage-guard-${crypto.randomUUID()}.yml`);
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

		const order: string[] = [];
		const bindError = new Error("boom: status bind rejected");
		let rejection: unknown;
		try {
			await startService({
				configPath,
				bus: fakeConsumerBus(order) as never,
				startStatusServer: (() => {
					order.push("http.bind_failed");
					throw bindError;
				}) as never,
				createScheduler: ((schedulerOpts: ConstructorParameters<typeof Scheduler>[0]) =>
					new Scheduler({
						...schedulerOpts,
						setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
						clearInterval: () => {},
					})) as never,
			});
		} catch (err) {
			rejection = err;
		}

		expect(rejection).toBe(bindError);
		// The consumer really started, so its stop is a real step.
		expect(order).toContain("consumer.fetch");
		expect(order.filter((step) => step === "bus.close").length).toBe(1);
		// No listener was ever bound, so nothing may claim to stop one.
		expect(order).not.toContain("http.stop");

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
	});
});

/**
 * The two boot-time seams the build-bump lane's observability rides on (§8).
 *
 * `criticalAlertTarget` reaches the stuck-pair pass through the CYCLE deps,
 * which `composeService` builds and never exposes — there is no seam to capture
 * it and adding one would be a wider change than the wiring it tests. What is
 * observable, and what the wiring is entirely made of, is `bindCriticalAlert`'s
 * RETURN: `service.ts` captures exactly that value and spreads it into the deps
 * object, so a return that matches the config is the whole of the contract on
 * this side of the boundary. The pass's own behaviour given a target is already
 * pinned by `tests/observability/build-bump-alert.test.ts`.
 *
 * `buildBumpRepositories` reaches `/status.json` through the STATUS-SERVER
 * wiring, which the `startStatusServer` seam does expose, so that half is
 * asserted end to end against a real boot.
 */
describe("build-bump observability wiring (§8)", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"FORGE_WEBHOOK_SECRET",
		"NATS_URL",
		"NATS_NKEY_FILE",
	] as const;

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	function stubEnv(): void {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "service-buildbump-work");
		delete process.env.FORGE_WEBHOOK_SECRET;
		delete process.env.NATS_URL;
		delete process.env.NATS_NKEY_FILE;
	}

	/** A config whose one managed repository is enrolled in the build-bump lane. */
	async function writeEnrolledConfig(): Promise<string> {
		const path = join(testTmpBase(), `buildbump-wiring-${crypto.randomUUID()}.yml`);
		await Bun.write(
			path,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"    build_bump:",
				"      environments:",
				"        - name: staging",
				"          app_dirs:",
				"            - open-brain-staging",
				"  - name: rodaddy/rtech-mcps",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"",
			].join("\n"),
		);
		return path;
	}

	/** Boot with the status server captured and the scheduler's interval disarmed. */
	async function captureStatusWiring(configPath: string): Promise<{
		wiring: Parameters<typeof startStatusServer>[0];
		stop: () => Promise<void>;
	}> {
		let captured: Parameters<typeof startStatusServer>[0] | undefined;
		const handle = await startService({
			configPath,
			startStatusServer: ((opts: Parameters<typeof startStatusServer>[0]) => {
				captured = opts;
				return { hostname: "127.0.0.1", port: 0, stop: async () => {} };
			}) as never,
			createScheduler: ((schedulerOpts: ConstructorParameters<typeof Scheduler>[0]) =>
				new Scheduler({
					...schedulerOpts,
					setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
					clearInterval: () => {},
				})) as never,
		});
		if (captured === undefined) throw new Error("startStatusServer seam was never called");
		return { wiring: captured, stop: handle.stop };
	}

	test("bindCriticalAlert RETURNS the target it binds, so the cycle deps can carry it", () => {
		const registry = {
			clientFor: () => {
				throw new Error("clientFor must not be called while merely resolving the target");
			},
		};
		const bound = bindCriticalAlert({
			config: {
				...config(),
				critical_alert: { provider: "forgejo", repository: "rodaddy/software-factory" },
			},
			registry: registry as never,
		});
		// The value `service.ts` spreads into the cycle deps as `criticalAlertTarget`.
		// Defined and pointed at the configured repository; the client stays a lazy
		// closure, so resolving the target resolves no credential.
		expect(bound?.repository).toBe("rodaddy/software-factory");
		expect(typeof bound?.client).toBe("function");
	});

	test("an unconfigured critical_alert returns undefined, the off-by-default posture", () => {
		const bound = bindCriticalAlert({
			config: config(),
			registry: { clientFor: () => Promise.resolve({ ok: false, error: "n/a" }) } as never,
		});
		expect(bound).toBeUndefined();
	});

	test("the status wiring forwards metrics_scrape_allow to the status server", async () => {
		stubEnv();
		const configPath = await writeEnrolledConfig();
		const body = await Bun.file(configPath).text();
		await Bun.write(configPath, `${body}metrics_scrape_allow:\n  - 10.0.20.50\n`);
		const captured = await captureStatusWiring(configPath);
		try {
			// A validated allowlist that never reaches the server leaves a listed peer refused.
			expect(captured.wiring.metricsScrapeAllow).toEqual(["10.0.20.50"]);
		} finally {
			await captured.stop();
			await rename(
				configPath,
				join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
			);
		}
	});

	test("the status wiring carries only the repositories enrolled in build_bump", async () => {
		stubEnv();
		const configPath = await writeEnrolledConfig();
		const captured = await captureStatusWiring(configPath);
		try {
			// The unenrolled `rodaddy/rtech-mcps` is filtered out, and the enrolled
			// entry arrives with its environment block intact — the status query
			// reads `build_bump` off exactly this value.
			expect(captured.wiring.buildBumpRepositories?.map((repo) => repo.name)).toEqual([
				"rodaddy/open-brain",
			]);
			expect(captured.wiring.buildBumpRepositories?.[0]?.build_bump?.environments?.[0]?.name).toBe(
				"staging",
			);
		} finally {
			await captured.stop();
			await rename(
				configPath,
				join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
			);
		}
	});
});
