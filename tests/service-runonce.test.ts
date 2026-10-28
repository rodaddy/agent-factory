/**
 * `runOnce` composition regressions. The one-shot command must reuse the
 * SAME wiring as the daemon (`composeService`) but run a single cycle and return,
 * starting NEITHER the status server NOR the interval scheduler. These drive the
 * real `runOnce` with injected fakes: a fake config loader, token resolver,
 * GitHub client, and runner transport, over a real scratch database, so the full
 * pass -> dispatch -> result-reconcile -> publish cycle runs exactly once.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../src/config/schema";
import { githubItems, jobs, repositories } from "../src/db/schema";
import type { ForgeClient } from "../src/forge/boundary";
import { ForgeRegistry } from "../src/forge/registry";
import type { GitHubClient, GitHubResponse } from "../src/github/client";
import type { JobIdentity } from "../src/github/publication";
import { persistPublicationPlans } from "../src/github/publish-plan";
import { RESULT_VERSION, type RunnerResult } from "../src/results/schema";
import type { RunnerAllocation, RunnerRunParams, RunnerTransport } from "../src/runner/transport";
import { runOnceExitCode } from "../src/index";
import { runOnce } from "../src/service";
import { withTestDb } from "./db/helpers";
import { testTmpBase } from "./support/test-temp";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/x", provider: "github", checks: "standard", gate_selection: "full" },
		],
		job_templates: [{ id: "pr-review", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
		...overrides,
	};
}

/** A GitHub client whose reads are empty (no changed issues) and writes throw. */
function fakeClient(): GitHubClient {
	const resp = <T>(data: T): GitHubResponse<T> => ({
		status: 200,
		data,
		link: null,
		rateRemaining: null,
	});
	return {
		async get<T>(): Promise<GitHubResponse<T>> {
			return resp([] as unknown as T);
		},
		async paginate<T>(): Promise<T[]> {
			return [];
		},
		async getPage<T>(): Promise<{ body: T; next: string | null }> {
			return { body: [] as unknown as T, next: null };
		},
		async write<T>(): Promise<GitHubResponse<T>> {
			throw new Error("unexpected write");
		},
	} as unknown as GitHubClient;
}

/**
 * Run `fn` capturing the NDJSON log lines it emits.
 *
 * Captured at the DESCRIPTOR level, the way `tests/reconcile/dispatch-pass.test.ts`
 * and `tests/kboard/client.test.ts` do: post-#88 the logger (pino) writes
 * synchronously to fd 2 via `fs.writeSync`, NOT through `process.stderr.write`,
 * so a `process.stderr` spy sees nothing and any assertion on log content passes
 * vacuously.
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

function fakeTransport(): RunnerTransport & { ran: RunnerRunParams[] } {
	const ran: RunnerRunParams[] = [];
	return {
		startBandMember: async () => {
			throw new Error("not implemented");
		},
		stopBandMember: async () => {
			throw new Error("not implemented");
		},
		listBand: async () => {
			throw new Error("not implemented");
		},
		ran,
		needed: async (): Promise<RunnerAllocation> => ({
			ok: true,
			boxes: [{ vmid: 9001, size: "medium" }],
		}),
		run: async (p: RunnerRunParams) => {
			ran.push(p);
		},
		list: async () => [],
		done: async () => {},
	};
}

/**
 * Build the injected `deps` for `runOnce`: a config loader, token resolver, and
 * GitHub client, all fakes, plus the real scratch db handed in as `createDb`.
 */
function deps(db: TestDb, transport: RunnerTransport, cfg: WatcherConfig) {
	return {
		loadConfig: async () => ({ ok: true as const, config: cfg }),
		resolveGitHubToken: async () => ({ ok: true as const, token: "t" }),
		createDb: () => ({ db, client: { end: async () => {} } }),
		createGitHubClient: () => fakeClient(),
		// A writable work root under the portable test temp base. The boot probes this
		// for real; without an override it would resolve the production default
		// `/var/lib/software-factory/work`, which no test user may write — the probe
		// working exactly as intended, on a path these tests never meant to touch.
		changeWorkRoot: join(testTmpBase(), "_scratch", "runonce-work"),
		transport,
	};
}

describe("runOnce", () => {
	test("composes the shared deps and runs exactly one pass, then returns", async () => {
		await withTestDb(async (db) => {
			const transport = fakeTransport();
			const results: unknown[] = [];

			// Inject the lifecycle seams the DAEMON binds through. runOnce must NEVER
			// touch either: no status server bound, no interval scheduler constructed.
			// This assertion fails the instant a future change starts one in runOnce.
			let statusServerStarts = 0;
			let schedulerCreations = 0;

			const result = await runOnce({
				onResult: (r) => results.push(r),
				startStatusServer: ((..._args: unknown[]) => {
					statusServerStarts++;
					throw new Error("runOnce must not start the status server");
				}) as never,
				createScheduler: ((..._args: unknown[]) => {
					schedulerCreations++;
					throw new Error("runOnce must not construct the interval scheduler");
				}) as never,
				...deps(db, transport, config()),
			});

			// It returned a single PassResult and delivered it to onResult exactly once.
			expect(results.length).toBe(1);
			expect(result.repositories.length).toBe(1); // the one configured repo
			expect(result.okCount).toBe(1);

			// The load-bearing single-shot property: neither long-lived resource was
			// bound. runOnce reached neither seam, so no listener and no timer survive.
			expect(statusServerStarts).toBe(0);
			expect(schedulerCreations).toBe(0);
		});
	});

	test("a malformed packet FAILS THE BOOT with a named error, before any pass runs", async () => {
		await withTestDb(async (db) => {
			const transport = fakeTransport();
			let passesRan = 0;

			// Inject the packet boot gate returning a failure, exactly as the real gate
			// does for a malformed packet on disk. The boot must reject before wiring the
			// db/transport into a cycle — so no pass runs and the named error surfaces.
			await expect(
				runOnce({
					onResult: () => {
						passesRan++;
					},
					assertPacketsBootable: async () => ({
						ok: false as const,
						error: "packet issue-triage: missing 'Goals' section",
					}),
					...deps(db, transport, config()),
				}),
			).rejects.toThrow(
				"packet boot validation failed: packet issue-triage: missing 'Goals' section",
			);

			// The boot rejected before any cycle: no pass result was delivered, and the
			// runner transport was never driven.
			expect(passesRan).toBe(0);
			expect(transport.ran.length).toBe(0);
		});
	});

	test("a clean packet directory lets the boot proceed to the pass", async () => {
		await withTestDb(async (db) => {
			const transport = fakeTransport();
			const results: unknown[] = [];
			// The real gate against the shipped packets/ directory: it loads clean, so the
			// boot proceeds and the single pass runs. This is the inverse of the failure
			// case above — proving the gate is a real gate, not an always-pass.
			const result = await runOnce({
				onResult: (r) => results.push(r),
				assertPacketsBootable: async () => ({ ok: true as const }),
				...deps(db, transport, config()),
			});
			expect(results.length).toBe(1);
			expect(result.okCount).toBe(1);
		});
	});

	test("composes a mixed GitHub and Forgejo service without requiring unrelated credentials", async () => {
		await withTestDb(async (db) => {
			let githubResolves = 0;
			let forgejoResolves = 0;
			const github = fakeClient() as unknown as ForgeClient;
			const forgejo = {
				...fakeClient(),
				provider: "forgejo" as const,
			} as unknown as ForgeClient;
			const forgeRegistry = new ForgeRegistry({
				forgejoDeployment: {
					apiUrl: "https://forge.example.internal/api/v1",
					webUrl: "https://forge.example.internal",
					cloneBase: "https://forge.example.internal",
				},
				resolveGitHubToken: async () => {
					githubResolves++;
					return { ok: true, token: "github-token" };
				},
				resolveForgejoToken: () => {
					forgejoResolves++;
					return { ok: true, token: "forgejo-token" };
				},
				createGitHubClient: () => github,
				createForgejoClient: () => forgejo,
			});
			const mixed = config({
				repositories: [
					{
						name: "rodaddy/github-x",
						provider: "github",
						checks: "standard",
						gate_selection: "full",
					},
					{
						name: "rodaddy/forgejo-x",
						provider: "forgejo",
						checks: "standard",
						gate_selection: "full",
					},
				],
			});
			const result = await runOnce({
				...deps(db, fakeTransport(), mixed),
				forgeRegistry,
			});
			expect(result.okCount).toBe(2);
			expect(githubResolves).toBe(1);
			expect(forgejoResolves).toBe(1);
		});
	});

	test("a Forgejo-first missing token is bounded while the GitHub repository succeeds", async () => {
		await withTestDb(async (db) => {
			let githubResolves = 0;
			let forgejoResolves = 0;
			const forgeRegistry = new ForgeRegistry({
				forgejoDeployment: {
					apiUrl: "https://forge.example.internal/api/v1",
					webUrl: "https://forge.example.internal",
					cloneBase: "https://forge.example.internal",
				},
				resolveGitHubToken: async () => {
					githubResolves++;
					return { ok: true, token: "github-token" };
				},
				resolveForgejoToken: () => {
					forgejoResolves++;
					return { ok: false, error: "FORGEJO_TOKEN is required" };
				},
				createGitHubClient: () => fakeClient() as unknown as ForgeClient,
			});
			const mixed = config({
				repositories: [
					{
						name: "rodaddy/forgejo-first",
						provider: "forgejo",
						checks: "standard",
						gate_selection: "full",
					},
					{
						name: "rodaddy/github-second",
						provider: "github",
						checks: "standard",
						gate_selection: "full",
					},
				],
			});

			const result = await runOnce({
				...deps(db, fakeTransport(), mixed),
				forgeRegistry,
			});

			expect(result.repositories.map(({ repository, ok }) => ({ repository, ok }))).toEqual([
				{ repository: "rodaddy/forgejo-first", ok: false },
				{ repository: "rodaddy/github-second", ok: true },
			]);
			expect(result.okCount).toBe(1);
			expect(result.failCount).toBe(1);
			expect(forgejoResolves).toBe(1);
			expect(githubResolves).toBe(1);
		});
	});

	test("Forgejo-only composition never resolves a GitHub token", async () => {
		await withTestDb(async (db) => {
			let githubResolves = 0;
			let forgejoResolves = 0;
			const forgejo = {
				...fakeClient(),
				provider: "forgejo" as const,
			} as unknown as ForgeClient;
			const forgeRegistry = new ForgeRegistry({
				forgejoDeployment: {
					apiUrl: "https://forge.example.internal/api/v1",
					webUrl: "https://forge.example.internal",
					cloneBase: "https://forge.example.internal",
				},
				resolveGitHubToken: async () => {
					githubResolves++;
					return { ok: false, error: "must not resolve GitHub" };
				},
				resolveForgejoToken: () => {
					forgejoResolves++;
					return { ok: true, token: "forgejo-token" };
				},
				createForgejoClient: () => forgejo,
			});
			const forgejoOnly = config({
				repositories: [
					{
						name: "rodaddy/forgejo-x",
						provider: "forgejo",
						checks: "standard",
						gate_selection: "full",
					},
				],
			});

			const result = await runOnce({
				...deps(db, fakeTransport(), forgejoOnly),
				forgeRegistry,
			});
			expect(result.okCount).toBe(1);
			expect(githubResolves).toBe(0);
			expect(forgejoResolves).toBe(1);
		});
	});

	test("dispatches the pending jobs a pass creates, as part of the one cycle", async () => {
		await withTestDb(async (db) => {
			// Pre-seed a pending job (as a prior pass would have) so the dispatch step of
			// runOnce's single cycle claims and dispatches it.
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");
			const [item] = await db
				.insert(githubItems)
				.values({ repositoryId: repo.id, kind: "pull", number: 9, state: "open", headSha: "sha9" })
				.returning();
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repo.id,
					itemId: item?.id,
					sha: "sha9",
					jobType: "pr-review",
					status: "pending",
				})
				.returning();
			if (!job) throw new Error("seed failed");

			const transport = fakeTransport();
			await runOnce(deps(db, transport, config()));

			// The pre-seeded pending job was dispatched exactly once and is now running.
			expect(transport.ran.length).toBe(1);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("running");
		});
	});

	test("the sweep REPORTS its dispatch pass instead of dropping the summary", async () => {
		await withTestDb(async (db) => {
			// `DispatchPassSummary` is documented "safe to log as-is" and was returned to
			// `runSweepPhase` and discarded, so the counters that answer "did the
			// dispatcher do anything this cycle" were computed every pass and never
			// recorded. Seed one dispatchable job so `selected > 0` and the line fires.
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");
			const [item] = await db
				.insert(githubItems)
				.values({ repositoryId: repo.id, kind: "pull", number: 9, state: "open", headSha: "sha9" })
				.returning();
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repo.id,
					itemId: item?.id,
					sha: "sha9",
					jobType: "pr-review",
					status: "pending",
				})
				.returning();
			if (!job) throw new Error("seed failed");

			const transport = fakeTransport();
			const { lines } = await withCapturedLogs(() => runOnce(deps(db, transport, config())));

			// MUTATION TARGET: delete the log call and this reds.
			const summary = lines.find((l) => l.msg === "dispatch.summary");
			expect(summary).toBeDefined();
			expect(summary?.level).toBe("info");
			expect(summary?.selected).toBe("1");
			expect(summary?.dispatched).toBe("1");
			expect(summary?.queued).toBe("0");
			expect(summary?.skipped).toBe("0");
			expect(summary?.errored).toBe("0");
		});
	});

	test("an idle sweep emits NO dispatch.summary line", async () => {
		await withTestDb(async (db) => {
			// Gated on `selected > 0` deliberately: every other `info` line in this
			// service is event-triggered, and at the default 15-minute cadence an
			// unconditional line would emit 96 all-zero records a day — the journal noise
			// that #144/#147 exist to remove.
			const transport = fakeTransport();
			const { lines } = await withCapturedLogs(() => runOnce(deps(db, transport, config())));

			expect(lines.find((l) => l.msg === "dispatch.summary")).toBeUndefined();
		});
	});

	test("a shadow one-shot renders the compare report; a real one does not", async () => {
		await withTestDb(async (db) => {
			// Seed a running job and its persisted publication plans (as a prior result
			// reconcile would), so the publisher inside the one cycle records the intended
			// writes to the shadow ledger and the report has something to render.
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");
			const [item] = await db
				.insert(githubItems)
				.values({ repositoryId: repo.id, kind: "pull", number: 7, state: "open", headSha: "sha7" })
				.returning();
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repo.id,
					itemId: item?.id,
					sha: "sha7",
					jobType: "pr-review",
					status: "running",
				})
				.returning();
			if (!job) throw new Error("seed failed");
			const identity: JobIdentity = {
				jobId: job.id,
				repository: "rodaddy/x",
				itemNumber: 7,
				sha: "sha7",
				jobType: "pr-review",
			};
			const runnerResult: RunnerResult = {
				result_version: RESULT_VERSION,
				repository: "rodaddy/x",
				job_type: "pr-review",
				item_number: 7,
				sha: "sha7",
				status: "passed",
				checks: [],
				findings: [],
			};
			await persistPublicationPlans({
				tx: db,
				identity,
				result: runnerResult,
				now: new Date("2026-07-20T12:00:00.000Z"),
			});

			// Shadow run: the report sink fires exactly once with a rendered block that
			// names the intended writes for this pass's job.
			const reports: string[] = [];
			await runOnce({
				shadow: true,
				onReport: (r) => reports.push(r),
				...deps(db, fakeTransport(), config()),
			});
			expect(reports.length).toBe(1);
			const rendered = reports[0] ?? "";
			expect(rendered).toContain("shadow report:");
			expect(rendered).toContain("rodaddy/x");
			expect(rendered).toContain("#7");
		});
	});

	test("a real (non-shadow) one-shot emits NO compare report", async () => {
		await withTestDb(async (db) => {
			const reports: string[] = [];
			// No plans seeded and, more importantly, shadow is off: the report sink must
			// never be invoked on a real run — a non-shadow one-shot prints no compare block.
			await runOnce({
				onReport: (r) => reports.push(r),
				...deps(db, fakeTransport(), config()),
			});
			expect(reports.length).toBe(0);
		});
	});

	test("a failing config load throws before any db/client is built", async () => {
		await withTestDb(async (db) => {
			let dbBuilt = false;
			await expect(
				runOnce({
					loadConfig: async () => ({ ok: false as const, error: "bad config" }),
					resolveGitHubToken: async () => ({ ok: true as const, token: "t" }),
					createDb: () => {
						dbBuilt = true;
						return { db, client: { end: async () => {} } };
					},
					createGitHubClient: () => fakeClient(),
					transport: fakeTransport(),
				}),
			).rejects.toThrow("bad config");
			expect(dbBuilt).toBe(false);
		});
	});
});

describe("runOnce flushes observability before it returns", () => {
	const LANGFUSE_KEYS = [
		"LANGFUSE_BASE_URL",
		"LANGFUSE_PUBLIC_KEY",
		"LANGFUSE_SECRET_KEY",
	] as const;

	test("THE IMPORTANT ONE: the one-shot path flushes queued traces", async () => {
		// The one-shot path exits the process right after returning, so the SDK's
		// ~10s batching timer NEVER fires: without an explicit flush a
		// `reconcile once` emitted nothing to Langfuse at all. `stop()` covers the
		// daemon; this covers the other exit.
		const saved: Record<string, string | undefined> = {};
		for (const key of LANGFUSE_KEYS) saved[key] = process.env[key];
		// PLACEHOLDER keys, never a real credential. Port 7199 is in this repo's
		// local dev range and nothing listens on it.
		process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:7199";
		process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test-placeholder";
		process.env.LANGFUSE_SECRET_KEY = "sk-lf-test-placeholder";
		try {
			await withTestDb(async (db) => {
				const transport = fakeTransport();
				const { lines } = await withCapturedLogs(() => runOnce(deps(db, transport, config())));
				// MUTATION TARGET: delete `await composed.shutdownObserver()` from
				// runOnce and this reds. Nothing else catches it — it produces no type
				// error and every other runOnce assertion stays green.
				expect(lines.some((l) => l.msg === "observability.langfuse.flushed")).toBe(true);
				// Proves the emitter was really built, so the line above is not passing
				// for the emitter-disabled reason.
				expect(lines.some((l) => l.msg === "observability.langfuse.enabled")).toBe(true);
			});
		} finally {
			for (const key of LANGFUSE_KEYS) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});
});

describe("runOnceExitCode maps the one-shot cycle to the CLI exit code", () => {
	/** A client whose every read throws, so the repository's sweep fails. */
	function throwingClient(): GitHubClient {
		const boom = async (): Promise<never> => {
			throw new Error("sweep exploded");
		};
		return { get: boom, paginate: boom, getPage: boom, write: boom } as unknown as GitHubClient;
	}

	test("a repository whose sweep throws exits 1 and logs the counts", async () => {
		await withTestDb(async (db) => {
			const { value, lines } = await withCapturedLogs(() =>
				runOnceExitCode({
					onResult: () => {},
					...deps(db, fakeTransport(), config()),
					createGitHubClient: () => throwingClient(),
				}),
			);
			expect(value).toBe(1);
			const summary = lines.find((l) => l.msg === "reconcile.once.failed");
			expect(summary?.fail_count).toBe("1");
			expect(summary?.error_count).toBe("0");
		});
	});

	test("a clean cycle exits 0", async () => {
		await withTestDb(async (db) => {
			const code = await runOnceExitCode({
				onResult: () => {},
				...deps(db, fakeTransport(), config()),
			});
			expect(code).toBe(0);
		});
	});
});
