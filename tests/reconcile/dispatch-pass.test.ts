/**
 * Dispatch-wiring regressions for the reconcile pass. After `runPass`
 * creates pending jobs, `dispatchPendingJobs` claims and dispatches them exactly
 * once. These pin the load-bearing invariants: a pending job is dispatched once;
 * a job already running is skipped (never re-dispatched); a dispatch failure is
 * isolated — it marks that job errored and released without aborting the batch —
 * and a job whose type has no allowlisted template is never dispatched.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, githubPostings, jobAttempts, jobs, repositories } from "../../src/db/schema";
import {
	TERMINAL_CHECK_NAME,
	TERMINAL_CHECK_TARGET,
	TERMINAL_CHECK_TITLE,
} from "../../src/github/publication";
import {
	dispatchPendingJobs,
	MAX_DISPATCH_PER_PASS,
	parseMaxDispatchPerPass,
} from "../../src/reconcile/dispatch-pass";
import { MAX_SHORTLIST_PAGES } from "../../src/reconcile/dispatch-shortlist";
import { DEFAULT_RETRY_MINUTES } from "../../src/runner/dispatch";
import { createPassBudget } from "../../src/runner/pass-budget";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** A config whose allowlist maps pr-review + repo-validate to fixed templates. */
function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/x", provider: "github", checks: "standard", gate_selection: "full" },
		],
		job_templates: [
			{ id: "pr-review", runner_size: "medium", return_mode: "patch" },
			{ id: "repo-validate", runner_size: "small", return_mode: "patch" },
		],
		doorbell_enabled: false,
		shadow_publish: false,
		...overrides,
	};
}

/**
 * Run `fn` capturing the NDJSON log lines it emits.
 *
 * Captured at the DESCRIPTOR level, the way `tests/kboard/client.test.ts` does:
 * post-#88 the logger (pino) writes synchronously to fd 2 via `fs.writeSync`, NOT
 * through `process.stderr.write`, so a `process.stderr` spy sees nothing and any
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

/** Fake transport recording every allocate/run/reap. */
function fakeTransport(overrides: Partial<RunnerTransport> = {}): RunnerTransport & {
	ran: RunnerRunParams[];
	reaped: number[];
} {
	const ran: RunnerRunParams[] = [];
	const reaped: number[] = [];
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
		reaped,
		needed:
			overrides.needed ??
			(async (): Promise<RunnerAllocation> => ({
				ok: true,
				boxes: [{ vmid: 9001, size: "medium" }],
			})),
		run:
			overrides.run ??
			(async (p: RunnerRunParams) => {
				ran.push(p);
			}),
		list: async () => [],
		done:
			overrides.done ??
			(async (vmid: number) => {
				reaped.push(vmid);
			}),
	};
}

/** Seed a repo + one pending job with a joined open-PR item. */
async function seedPendingJob(
	db: TestDb,
	opts: {
		status?: string;
		jobType?: string;
		checks?: string;
		repository?: string;
		sha?: string;
		/** The joined item's state; default `open`, as every pre-#429 test assumed. */
		itemState?: string;
		/** The joined item's live head SHA; default the job's own `sha`. */
		itemHeadSha?: string | null;
		/** The joined item's kind; default `pull`. */
		itemKind?: string;
		/** Seed the job with NO joined item (repo-validate / audit shape). */
		withoutItem?: boolean;
	} = {},
): Promise<number> {
	const sha = opts.sha ?? "abc123";
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: opts.repository ?? "rodaddy/x", checks: opts.checks ?? "standard" })
		.returning();
	if (!repo) throw new Error("seed failed");
	const [item] = opts.withoutItem
		? [undefined]
		: await db
				.insert(githubItems)
				.values({
					repositoryId: repo.id,
					kind: opts.itemKind ?? "pull",
					number: 42,
					state: opts.itemState ?? "open",
					headSha: opts.itemHeadSha === undefined ? sha : opts.itemHeadSha,
				})
				.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha,
			jobType: opts.jobType ?? "pr-review",
			status: opts.status ?? "pending",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return job.id;
}

/** A recording body-landing stager: captures the exact-SHA contract landed. */
function recordingLandingStager(): {
	stager: {
		land: (
			jobId: string,
			body: string,
		) => Promise<{ jobBodyPath: string; runnerJobBodyPath: string }>;
	};
	landed: { jobId: string; body: string }[];
} {
	const landed: { jobId: string; body: string }[] = [];
	return {
		landed,
		stager: {
			land: async (jobId: string, body: string) => {
				landed.push({ jobId, body });
				return {
					jobBodyPath: `/collab/runners/jobs/${jobId}/input/job.md`,
					runnerJobBodyPath: `/mnt/share/runners/jobs/${jobId}/input/job.md`,
				};
			},
		},
	};
}

describe("MAX_DISPATCH_PER_PASS", () => {
	test("reads the operator cap and leaves later due jobs pending", async () => {
		await withTestDb(async (db) => {
			const env = { MAX_DISPATCH_PER_PASS: "3" };
			const repositoryNames = Array.from({ length: 5 }, (_, i) => `rodaddy/x-${i}`);
			for (const [i, repository] of repositoryNames.entries()) {
				await seedPendingJob(db, { repository, sha: `cap${i}` });
			}
			const cfg = config({
				repositories: repositoryNames.map((name) => ({
					name,
					provider: "github",
					checks: "standard",
					gate_selection: "full",
				})),
			});

			let nextVmid = 9001;
			const transport = fakeTransport({
				needed: async () => ({
					ok: true,
					boxes: [{ vmid: nextVmid++, size: "medium" }],
				}),
			});
			const summary = await dispatchPendingJobs(db, transport, cfg, {
				now: new Date("2026-08-28T00:00:00.000Z"),
				maxPerPass: parseMaxDispatchPerPass(env),
			});

			expect(summary.selected).toBe(3);
			expect(summary.dispatched).toBe(3);
			const pending = await db.select().from(jobs).where(eq(jobs.status, "pending"));
			expect(pending).toHaveLength(2);
		});
	});

	test("uses the unchanged default when the environment is unset", () => {
		expect(parseMaxDispatchPerPass({})).toBe(MAX_DISPATCH_PER_PASS);
	});

	test("parses and clamps the environment value", () => {
		const cases = [
			["3", 3],
			["", MAX_DISPATCH_PER_PASS],
			[" 7 ", 7],
			["0", 1],
			["99999", 5000],
			["abc", MAX_DISPATCH_PER_PASS],
			["2.5", MAX_DISPATCH_PER_PASS],
		] as const;

		for (const [raw, expected] of cases) {
			expect(parseMaxDispatchPerPass({ MAX_DISPATCH_PER_PASS: raw })).toBe(expected);
		}
	});
});

describe("dispatchPendingJobs", () => {
	test("a pending job is dispatched exactly once and marked running", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db);
			const t = fakeTransport();

			const summary = await dispatchPendingJobs(db, t, config());
			expect(summary).toMatchObject({ selected: 1, dispatched: 1, skipped: 0, errored: 0 });
			expect(t.ran.length).toBe(1);
			// The fixed pr-review template body, not repo content or commands.
			expect(t.ran[0]?.job).toContain("Pull request review");

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("running");

			// A second pass finds nothing pending: no re-dispatch.
			const again = await dispatchPendingJobs(db, t, config());
			expect(again).toMatchObject({ selected: 0, dispatched: 0 });
			expect(t.ran.length).toBe(1);
		});
	});

	test("a pending verb job is excluded from the generic selector and cannot render as prose", async () => {
		await withTestDb(async (db) => {
			await seedPendingJob(db, { jobType: "newapp" });
			const t = fakeTransport();
			const cfg = config({
				job_templates: [
					...config().job_templates,
					{ id: "newapp", runner_size: "small", return_mode: "patch" },
				],
			});

			const summary = await dispatchPendingJobs(db, t, cfg);
			expect(summary.selected).toBe(0);
			expect(summary.dispatched).toBe(0);
			expect(t.ran).toEqual([]);
		});
	});

	test("an already-running job is not selected and never re-dispatched", async () => {
		await withTestDb(async (db) => {
			await seedPendingJob(db, { status: "running" });
			const t = fakeTransport();

			const summary = await dispatchPendingJobs(db, t, config());
			expect(summary.selected).toBe(0);
			expect(summary.dispatched).toBe(0);
			expect(t.ran).toEqual([]);
		});
	});

	test("a dispatch failure marks the job errored, releases it, and does not abort the batch", async () => {
		await withTestDb(async (db) => {
			// Two pending jobs; the first errors at allocation, the second must still run.
			const failing = await seedPendingJob(db);
			const [item] = await db
				.insert(githubItems)
				.values({ repositoryId: 1, kind: "pull", number: 43, state: "open", headSha: "def456" })
				.returning();
			const [second] = await db
				.insert(jobs)
				.values({
					repositoryId: 1,
					itemId: item?.id,
					sha: "def456",
					jobType: "pr-review",
					status: "pending",
				})
				.returning();
			if (!second) throw new Error("seed failed");

			let calls = 0;
			const errors: unknown[] = [];
			const t = fakeTransport({
				needed: async () => {
					calls++;
					// The first allocation throws; the second succeeds.
					if (calls === 1) throw new Error("mcp connection error");
					return { ok: true, boxes: [{ vmid: 9002, size: "medium" }] };
				},
			});

			const summary = await dispatchPendingJobs(db, t, config(), {
				onError: (e) => errors.push(e),
			});

			// One errored, one dispatched — the failure did not abort the batch.
			expect(summary.selected).toBe(2);
			expect(summary.errored).toBe(1);
			expect(summary.dispatched).toBe(1);
			expect(errors.length).toBe(1);

			// The failing job was released to pending (not lost), with a recorded attempt.
			const [failed] = await db.select().from(jobs).where(eq(jobs.id, failing));
			expect(failed?.status).toBe("pending");
			const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, failing));
			expect(attempts[0]?.status).toBe("failed");

			// The second job was dispatched and is running.
			const [ran] = await db.select().from(jobs).where(eq(jobs.id, second.id));
			expect(ran?.status).toBe("running");
		});
	});

	test("a throwing onError sink does not abort the batch: the second job still dispatches", async () => {
		await withTestDb(async (db) => {
			// Two pending jobs; the first errors at allocation, and the operator's error
			// sink itself THROWS on that first error. A faulty monitoring sink must not
			// take down per-job isolation — the second job must still dispatch and the
			// summary must complete.
			const failing = await seedPendingJob(db);
			const [item] = await db
				.insert(githubItems)
				.values({ repositoryId: 1, kind: "pull", number: 44, state: "open", headSha: "feed01" })
				.returning();
			const [second] = await db
				.insert(jobs)
				.values({
					repositoryId: 1,
					itemId: item?.id,
					sha: "feed01",
					jobType: "pr-review",
					status: "pending",
				})
				.returning();
			if (!second) throw new Error("seed failed");

			let calls = 0;
			let onErrorCalls = 0;
			const t = fakeTransport({
				needed: async () => {
					calls++;
					if (calls === 1) throw new Error("mcp connection error");
					return { ok: true, boxes: [{ vmid: 9003, size: "medium" }] };
				},
			});

			// The summary must resolve (the throwing sink never escapes the loop).
			const summary = await dispatchPendingJobs(db, t, config(), {
				onError: () => {
					onErrorCalls++;
					throw new Error("faulty logging sink");
				},
			});

			// The sink threw on the first job's error but did not abort dispatch.
			expect(onErrorCalls).toBeGreaterThan(0);
			expect(summary.selected).toBe(2);
			expect(summary.errored).toBe(1);
			expect(summary.dispatched).toBe(1);

			// The failing job was still released to pending; the second job ran.
			const [failed] = await db.select().from(jobs).where(eq(jobs.id, failing));
			expect(failed?.status).toBe("pending");
			const [ran] = await db.select().from(jobs).where(eq(jobs.id, second.id));
			expect(ran?.status).toBe("running");
		});
	});

	test("a job type with no allowlisted template is skipped, never dispatched", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db);
			const t = fakeTransport();

			// The config lists NO templates, so pr-review is not allowlisted.
			const summary = await dispatchPendingJobs(db, t, config({ job_templates: [] }));
			expect(summary.selected).toBe(1);
			expect(summary.skipped).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(t.ran).toEqual([]);

			// The job stays pending — released for a corrected allowlist, not lost.
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
		});
	});

	test("the template-miss defer NAMES the job it is deferring", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db);
			const t = fakeTransport();

			// Before #144 this defer logged NOTHING, so a job whose template was not
			// allowlisted was re-deferred every cycle in total silence — findable only
			// by querying the `jobs` table by hand (live 2026-08-02, job 715). Trap #84
			// one layer up: a PRESENT, REFUSING gate is indistinguishable from a passing
			// one unless it says so.
			const { value: summary, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, config({ job_templates: [] })),
			);

			// The defer BEHAVIOUR is unchanged: skipped, not dispatched, still pending.
			expect(summary.skipped).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");

			// MUTATION TARGET: delete the log call and this reds.
			const warn = lines.find((l) => l.msg === "dispatch.template_not_allowlisted");
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			expect(warn?.job_id).toBe(String(jobId));
			expect(warn?.repository).toBe("rodaddy/x");
			expect(warn?.template_id).toBe("pr-review");
		});
	});

	test("the unmanaged-repository defer NAMES the job it is deferring", async () => {
		await withTestDb(async (db) => {
			// #144 named the template branch and left this SIBLING branch silent, so a
			// job whose repository the operator de-scoped deferred every cycle without a
			// word. Same trap #84 shape as the template refusal above.
			const jobId = await seedPendingJob(db);
			const t = fakeTransport();
			const now = new Date("2026-07-20T00:00:00.000Z");

			// rodaddy/x is in the DB but ABSENT from the managed config below.
			const cfg = config({
				repositories: [
					{ name: "rodaddy/other", provider: "github", checks: "standard", gate_selection: "full" },
				],
			});
			const { value: summary, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, cfg, { now }),
			);

			// The defer BEHAVIOUR is unchanged: skipped, not errored, still pending.
			expect(summary.skipped).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(0);
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");

			// MUTATION TARGET: delete the log call and this reds.
			const warn = lines.find((l) => l.msg === "dispatch.repo_not_managed");
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			expect(warn?.job_id).toBe(String(jobId));
			expect(warn?.repository).toBe("rodaddy/x");
			expect(warn?.provider).toBe("github");
		});
	});

	test("a capacity-refused allocation NAMES its reason instead of dropping it", async () => {
		await withTestDb(async (db) => {
			// THE #147 DEFECT. With the template allowlisted the job reaches
			// `transport.needed()`; a refusal released it +15 minutes carrying a `reason`
			// that the `"queued"` arm discarded, so a refusing allocator and a dead
			// dispatcher looked identical in the journal (live 2026-08-02, job 715).
			const jobId = await seedPendingJob(db);
			const t = fakeTransport({
				needed: async (): Promise<RunnerAllocation> => ({
					ok: false,
					refused: true,
					reason: "pool exhausted: no free 90xx box",
				}),
			});

			const { value: summary, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, config()),
			);

			// The queue BEHAVIOUR is unchanged: queued, not dispatched, still pending.
			expect(summary.queued).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(0);
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");

			// MUTATION TARGET: delete the log call and this reds. The transport's own
			// reason must survive to the line — that string IS the diagnosis.
			const warn = lines.find((l) => l.msg === "dispatch.allocation_refused");
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			expect(warn?.reason).toBe("pool exhausted: no free 90xx box");
			expect(warn?.job_id).toBe(String(jobId));
			expect(warn?.repository).toBe("rodaddy/x");
			expect(warn?.template_id).toBe("pr-review");
			expect(warn?.retry_after_minutes).toBe(String(DEFAULT_RETRY_MINUTES));
		});
	});

	test("an unregistered job type is never dispatched even if named in the allowlist", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db, { jobType: "exfiltrate-secrets" });
			const t = fakeTransport();
			// Even if config tries to allowlist it, the fixed registry gate rejects it.
			const cfg = config({
				job_templates: [{ id: "pr-review", runner_size: "small", return_mode: "patch" }],
			});
			const summary = await dispatchPendingJobs(db, t, cfg);
			expect(summary.skipped).toBe(1);
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
		});
	});

	test("a job for a repo removed from the config allowlist is skipped and DEFERRED, never dispatched", async () => {
		await withTestDb(async (db) => {
			// The job was queued for rodaddy/x, but the operator has since removed that
			// repo from config/repos.yml. Even with a valid template, it must not dispatch.
			const jobId = await seedPendingJob(db);
			const t = fakeTransport();
			const now = new Date("2026-07-20T00:00:00.000Z");

			const cfg = config({
				repositories: [
					{ name: "rodaddy/other", provider: "github", checks: "standard", gate_selection: "full" },
				],
			});
			const summary = await dispatchPendingJobs(db, t, cfg, { now });
			expect(summary.selected).toBe(1);
			expect(summary.skipped).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(0); // a de-scoped repo is not a runner failure
			expect(t.ran).toEqual([]);

			// The job stays pending (not lost, not errored, no cursor touched), but is now
			// DEFERRED to a bounded future time so it stops re-entering the immediate
			// shortlist every pass. It still dispatches once re-added AND the window passes.
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt).not.toBeNull();
			expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());
		});
	});

	test("re-adding the repo lets a previously-skipped+deferred job dispatch after the defer window", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db);
			const t = fakeTransport();
			const skipAt = new Date("2026-07-20T00:00:00.000Z");

			// First pass: repo not managed -> skipped, left pending, DEFERRED.
			await dispatchPendingJobs(db, t, config({ repositories: [] }), { now: skipAt });
			expect(t.ran.length).toBe(0);
			let [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(skipAt.getTime());

			// Re-added, but still WITHIN the defer window: not yet due, not dispatched.
			const withinWindow = new Date(skipAt.getTime() + 60_000);
			const early = await dispatchPendingJobs(db, t, config(), { now: withinWindow });
			expect(early.selected).toBe(0);
			expect(t.ran.length).toBe(0);

			// Re-added AND now past the defer window: it dispatches (revive-on-re-add).
			const past = new Date(skipAt.getTime() + 60 * 60_000);
			const summary = await dispatchPendingJobs(db, t, config(), { now: past });
			expect(summary.dispatched).toBe(1);
			expect(t.ran.length).toBe(1);
			[row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("running");
		});
	});

	test("re-allowlisting a template lets a previously-skipped+deferred job dispatch after the window", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db);
			const t = fakeTransport();
			const skipAt = new Date("2026-07-20T00:00:00.000Z");

			// First pass: template de-allowlisted -> skipped, left pending, DEFERRED.
			await dispatchPendingJobs(db, t, config({ job_templates: [] }), { now: skipAt });
			expect(t.ran.length).toBe(0);
			let [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(skipAt.getTime());

			// Template re-allowlisted AND past the defer window: it dispatches.
			const past = new Date(skipAt.getTime() + 60 * 60_000);
			const summary = await dispatchPendingJobs(db, t, config(), { now: past });
			expect(summary.dispatched).toBe(1);
			expect(t.ran.length).toBe(1);
			[row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("running");
		});
	});

	test("skipped de-scoped jobs are DEFERRED out of the shortlist so a newer managed job is no longer starved", async () => {
		await withTestDb(async (db) => {
			// STARVATION CLOSURE. Seed >maxPerPass low-id pending jobs for a de-scoped repo
			// (stale/skip), PLUS one newer higher-id due job for a MANAGED repo with an
			// allowlisted template. Before the fix the low-id skips re-entered the id-ordered
			// shortlist at the front every pass and, past maxPerPass, permanently starved the
			// newer job. After the fix the skips get deferred out of the immediate shortlist,
			// so a subsequent pass (same due window) selects and dispatches the newer job.
			const staleCount = 60;
			const maxPerPass = 50;
			const now = new Date("2026-07-20T00:00:00.000Z");

			// A de-scoped repo (present in the DB, ABSENT from the managed config below).
			const [stale] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/descoped", checks: "standard" })
				.returning();
			if (!stale) throw new Error("seed failed");
			for (let i = 0; i < staleCount; i++) {
				await db
					.insert(jobs)
					.values({
						repositoryId: stale.id,
						sha: `stale${i}`,
						jobType: "pr-review",
						status: "pending",
					})
					.returning();
			}

			// The newer managed job: higher id (seeded last), allowlisted template.
			const [managed] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!managed) throw new Error("seed failed");
			const [newer] = await db
				.insert(jobs)
				.values({
					repositoryId: managed.id,
					sha: "newerjob",
					jobType: "pr-review",
					status: "pending",
				})
				.returning();
			if (!newer) throw new Error("seed failed");

			const t = fakeTransport();
			// Only rodaddy/x is managed; rodaddy/descoped is de-scoped.
			const cfg = config();

			// Pass 1: the first page (limit=maxPerPass) is filled entirely by low-id stale
			// jobs and every one is skipped and deferred. Since PR #680 round 4 the pass
			// refills past them in the SAME pass, so the newer job is selected on the
			// second page and dispatched at once; the stale ones are still deferred out
			// of the immediate due window.
			const pass1 = await dispatchPendingJobs(db, t, cfg, { now, maxPerPass });
			expect(pass1.selected).toBe(staleCount + 1);
			expect(pass1.skipped).toBe(staleCount);
			expect(pass1.dispatched).toBe(1);
			expect(t.ran.length).toBe(1);

			// Every stale job the pass touched was deferred to a future nextAttemptAt.
			const deferred = await db.select().from(jobs).where(eq(jobs.repositoryId, stale.id));
			const deferredCount = deferred.filter(
				(r) => r.nextAttemptAt !== null && r.nextAttemptAt.getTime() > now.getTime(),
			).length;
			expect(deferredCount).toBeGreaterThanOrEqual(maxPerPass);

			// Pass 2 (same due window `now`): the remaining stale-and-still-due jobs are
			// fewer than maxPerPass, so the newer managed job now enters the shortlist and
			// dispatches. It is no longer permanently starved.
			let dispatchedNewer = false;
			for (let pass = 0; pass < 5 && !dispatchedNewer; pass++) {
				await dispatchPendingJobs(db, t, cfg, { now, maxPerPass });
				const [row] = await db.select().from(jobs).where(eq(jobs.id, newer.id));
				dispatchedNewer = row?.status === "running";
			}
			expect(dispatchedNewer).toBe(true);
			expect(t.ran.length).toBe(1);
			expect(t.ran[0]?.job).toContain("Pull request review");
		});
	});

	test("advancing real sweeps: deferred low-id skips no longer starve a newer managed job", async () => {
		await withTestDb(async (db) => {
			// STEADY-STATE STARVATION under PRODUCTION-LIKE advancing time. Unlike the
			// same-`now` drain test, here `now` advances by the poll interval each sweep,
			// so a deferred skip whose window merely EQUALS the poll cadence comes back due
			// on the very next sweep and re-saturates the id-ordered shortlist forever. With
			// the cadence-relative window (a MULTIPLE of poll_interval_minutes) the deferred
			// batch contends on only 1-in-MULTIPLE sweeps, so the newer job dispatches within
			// a bounded number of advancing sweeps. This test FAILS on the round-1 fixed 15m
			// window and PASSES with the cadence-relative window.
			const staleCount = 60;
			const maxPerPass = 50;
			const pollIntervalMinutes = 15;
			const base = new Date("2026-07-20T00:00:00.000Z");

			// A de-scoped repo (present in the DB, ABSENT from the managed config).
			const [stale] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/descoped", checks: "standard" })
				.returning();
			if (!stale) throw new Error("seed failed");
			for (let i = 0; i < staleCount; i++) {
				await db
					.insert(jobs)
					.values({
						repositoryId: stale.id,
						sha: `stale${i}`,
						jobType: "pr-review",
						status: "pending",
					})
					.returning();
			}

			// The newer managed job: higher id (seeded last), allowlisted template.
			const [managed] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!managed) throw new Error("seed failed");
			const [newer] = await db
				.insert(jobs)
				.values({
					repositoryId: managed.id,
					sha: "newerjob",
					jobType: "pr-review",
					status: "pending",
				})
				.returning();
			if (!newer) throw new Error("seed failed");

			const t = fakeTransport();
			const cfg = config({ poll_interval_minutes: pollIntervalMinutes });

			// Simulate real sweeps that ADVANCE now by the poll interval each sweep. The
			// bound is 2 * SKIP_DEFER_POLL_MULTIPLE sweeps: the deferred batch re-arms only
			// once every MULTIPLE sweeps, so the newer job is guaranteed a shortlist slot
			// within that bound.
			const maxSweeps = 2 * 4;
			let dispatchedNewer = false;
			for (let sweep = 0; sweep < maxSweeps && !dispatchedNewer; sweep++) {
				const now = new Date(base.getTime() + sweep * pollIntervalMinutes * 60_000);
				await dispatchPendingJobs(db, t, cfg, { now, maxPerPass });
				const [row] = await db.select().from(jobs).where(eq(jobs.id, newer.id));
				dispatchedNewer = row?.status === "running";
			}

			expect(dispatchedNewer).toBe(true);
			expect(t.ran.length).toBe(1);
			expect(t.ran[0]?.job).toContain("Pull request review");
		});
	});

	test("a skip-defer never clobbers a row that is no longer pending (releaseJob status guard)", async () => {
		await withTestDb(async (db) => {
			// The skip-defer path releases only a still-`pending` row. Seed a de-scoped
			// job, but flip it to `running` (as if a concurrent path just claimed+ran it)
			// before the pass touches it. The guarded release must NOT revert it to pending.
			const jobId = await seedPendingJob(db);
			const now = new Date("2026-07-20T00:00:00.000Z");

			// Repo de-scoped => the pass would take the skip-defer branch...
			const cfg = config({
				repositories: [
					{ name: "rodaddy/other", provider: "github", checks: "standard", gate_selection: "full" },
				],
			});
			// ...but the row is no longer pending. The shortlist selects only pending rows,
			// so drive the guard directly: this is exactly the write the skip-defer issues.
			await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));

			const { releaseJob } = await import("../../src/runner/dispatch");
			await releaseJob(db, jobId, new Date(now.getTime() + 60 * 60_000), {
				now,
				expectedStatus: "pending",
			});

			// The guard matched no pending row, so the running job is untouched — no revert,
			// no risk of a duplicate dispatch.
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("running");
			expect(row?.nextAttemptAt).toBeNull();

			// A pass over the same DB likewise selects nothing (the row is not pending).
			const t = fakeTransport();
			const summary = await dispatchPendingJobs(db, t, cfg, { now });
			expect(summary.selected).toBe(0);
			expect(t.ran).toEqual([]);
		});
	});

	test("a future nextAttemptAt defers a job (not due) — it is not dispatched", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db);
			const future = new Date("2999-01-01T00:00:00.000Z");
			await db.update(jobs).set({ nextAttemptAt: future }).where(eq(jobs.id, jobId));
			const t = fakeTransport();
			const summary = await dispatchPendingJobs(db, t, config(), {
				now: new Date("2026-07-20T00:00:00.000Z"),
			});
			expect(summary.selected).toBe(0);
			expect(t.ran).toEqual([]);
		});
	});

	// The dedicated infra-static exact-SHA lane. The DEFECT these pin: an
	// infra-static dispatch must LAND the CONCRETE exact-SHA contract (the fixed
	// bwrap launcher + the fixed per-gate static commands + the fixed depth-1 fetch
	// of the exact SHA) and submit only the tiny digest-bound bootstrap — NOT the
	// ~10-line generic stub the defect shipped. rtech/rtech-infra is the fixed
	// foreign static-only repo; the sha is a real hex PR-head SHA.
	const RTECH_INFRA = "rtech/rtech-infra";
	const INFRA_SHA = "c".repeat(40);

	/** Config that manages rtech-infra static-only and allowlists infra-static. */
	function infraConfig(gateSelection: "full" | "changed-files" = "full"): WatcherConfig {
		return config({
			repositories: [
				{
					name: RTECH_INFRA,
					provider: "github",
					checks: "static-only",
					gate_selection: gateSelection,
				},
			],
			job_templates: [{ id: "infra-static", runner_size: "small", return_mode: "patch" }],
		});
	}

	test("an infra-static dispatch LANDS the concrete exact-SHA contract, narrowed by the selector", async () => {
		await withTestDb(async (db) => {
			await seedPendingJob(db, {
				jobType: "infra-static",
				checks: "static-only",
				repository: RTECH_INFRA,
				sha: INFRA_SHA,
			});
			const t = fakeTransport({
				needed: async () => ({ ok: true, boxes: [{ vmid: 9001, size: "small" }] }),
			});
			const landing = recordingLandingStager();
			const summary = await dispatchPendingJobs(db, t, infraConfig("changed-files"), {
				bodyLandingStager: landing.stager,
				// A narrow selector: only the scripts gate applies.
				infraGateSelector: async () => ({
					ansible: false,
					workflows: false,
					scripts: true,
					config: false,
					fullEscalation: false,
				}),
			});
			expect(summary.dispatched).toBe(1);

			// The CONCRETE contract was LANDED as job.md — not the generic stub. It
			// carries the fixed bwrap launcher, the fixed per-gate static command for
			// the SELECTED gate only, and the fixed depth-1 fetch of the exact SHA.
			expect(landing.landed).toHaveLength(1);
			const landed = landing.landed[0]?.body ?? "";
			expect(landed).toContain("sudo bwrap");
			expect(landed).toContain("--unshare-net");
			expect(landed).toContain("setpriv --reuid 65534");
			expect(landed).toContain("shellcheck --norc -f gcc");
			expect(landed).not.toContain("actionlint");
			// The unselected gate's COMMAND, not the bare tool name: since sf#592 the
			// fixed setup writes the pinned `/work/lintrc/ansible-lint.yml` config for
			// every selection, so a bare substring would match that filename.
			expect(landed).not.toContain("ansible-lint -f pep8");
			// The exact commit is acquired by the fixed depth-1 fetch of THIS sha.
			expect(landed).toContain(`fetch --depth 1`);
			expect(landed).toContain(`https://github.com/${RTECH_INFRA}.git ${INFRA_SHA}`);
			expect(landed).toContain(`sha: ${INFRA_SHA}`);

			// The SUBMITTED body is the tiny digest-bound bootstrap that points the
			// runner at the landed job.md — NOT the generic stub, NOT the full contract.
			const submitted = t.ran[0]?.job ?? "";
			const landedJobId = landing.landed[0]?.jobId ?? "";
			expect(submitted).toContain(`/mnt/share/runners/jobs/${landedJobId}/input/job.md`);
			expect(submitted).toContain("compute the SHA-256");
			expect(submitted).not.toContain("sudo bwrap");
			expect(submitted).not.toContain("Infrastructure static validation");
		});
	});

	test("an infra-static dispatch with NO selector lands a FULL static escalation contract", async () => {
		await withTestDb(async (db) => {
			await seedPendingJob(db, {
				jobType: "infra-static",
				checks: "static-only",
				repository: RTECH_INFRA,
				sha: INFRA_SHA,
			});
			const t = fakeTransport({
				needed: async () => ({ ok: true, boxes: [{ vmid: 9001, size: "small" }] }),
			});
			const landing = recordingLandingStager();
			// No infraGateSelector => full escalation (every fixed gate) reaches the body.
			const summary = await dispatchPendingJobs(db, t, infraConfig("full"), {
				bodyLandingStager: landing.stager,
			});
			expect(summary.dispatched).toBe(1);
			const landed = landing.landed[0]?.body ?? "";
			// Every fixed gate's fixed static command is enumerated under full escalation.
			// Pinned lint configs outside the checkout (F1/F9).
			expect(landed).toContain(
				"YAMLLINT_CONFIG_FILE=/work/lintrc/yamllint.yml ansible-lint -f pep8 -c /work/lintrc/ansible-lint.yml --project-dir .",
			);
			expect(landed).toContain("actionlint");
			expect(landed).toContain("shellcheck");
			expect(landed).toContain("yamllint -f parsable -c /work/lintrc/yamllint.yml .");
			expect(landed).toContain("sudo bwrap");
		});
	});

	test("an infra-static dispatch carries the selector's base SHA into the landed body", async () => {
		await withTestDb(async (db) => {
			await seedPendingJob(db, {
				jobType: "infra-static",
				checks: "static-only",
				repository: RTECH_INFRA,
				sha: INFRA_SHA,
			});
			const t = fakeTransport({
				needed: async () => ({ ok: true, boxes: [{ vmid: 9001, size: "small" }] }),
			});
			const landing = recordingLandingStager();
			const base = "b".repeat(40);
			let seen: { itemNumber: number | null; itemKind: string | null } | undefined;
			const summary = await dispatchPendingJobs(db, t, infraConfig("full"), {
				bodyLandingStager: landing.stager,
				// A full escalation that read the PR base: the body must render the
				// base-relative verdict, not the absolute one (live: jobs 11864/11869).
				infraGateSelector: async (job) => {
					seen = { itemNumber: job.itemNumber, itemKind: job.itemKind };
					return {
						ansible: true,
						workflows: true,
						scripts: true,
						config: true,
						fullEscalation: true,
						baseSha: base,
					};
				},
			});
			expect(summary.dispatched).toBe(1);
			expect(seen?.itemKind).toBe("pull");
			const landed = landing.landed[0]?.body ?? "";
			expect(landed).toContain("/work/base");
			expect(landed).toContain(`https://github.com/${RTECH_INFRA}.git ${base}`);
			expect(landed).toContain(`pre-existing on base ${base}`);
		});
	});

	test("an infra-static dispatch with NO body-landing stager fails closed (skipped, left pending)", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db, {
				jobType: "infra-static",
				checks: "static-only",
				repository: RTECH_INFRA,
				sha: INFRA_SHA,
			});
			const t = fakeTransport({
				needed: async () => ({ ok: true, boxes: [{ vmid: 9001, size: "small" }] }),
			});
			// The dedicated lane REQUIRES a landing seam; without it, never dispatch a
			// runner with a missing contract — skip and leave the job pending.
			const summary = await dispatchPendingJobs(db, t, infraConfig("full"));
			expect(summary.dispatched).toBe(0);
			expect(summary.skipped).toBe(1);
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
		});
	});

	test("a NON-infra-static job still dispatches the UNCHANGED generic body", async () => {
		await withTestDb(async (db) => {
			// A pr-review job on a standard repo must keep the generic renderJobBody
			// path verbatim — no landing, no bootstrap, no concrete contract.
			await seedPendingJob(db, { jobType: "pr-review", checks: "standard" });
			const t = fakeTransport();
			const landing = recordingLandingStager();
			const summary = await dispatchPendingJobs(db, t, config(), {
				bodyLandingStager: landing.stager,
			});
			expect(summary.dispatched).toBe(1);
			// The generic body is submitted directly; nothing was landed for it.
			expect(landing.landed).toHaveLength(0);
			const body = t.ran[0]?.job ?? "";
			expect(body).toContain("Pull request review");
			expect(body).not.toContain("sudo bwrap");
			expect(body).not.toContain("compute the SHA-256");
		});
	});

	test("a job for a CLOSED item is skipped and never takes a box", async () => {
		await withTestDb(async (db) => {
			// THE sf#429 DEFECT. `isItemEligible` was enforced only at RESULT time, so a
			// job whose item had closed still allocated a runner box, ran, and then failed
			// ingest with "runner result identity is invalid" — burning a box per cycle.
			const jobId = await seedPendingJob(db, { itemState: "closed", sha: "a".repeat(40) });
			const t = fakeTransport();
			const now = new Date("2026-07-20T00:00:00.000Z");

			const summary = await dispatchPendingJobs(db, t, config(), { now });

			expect(summary.skipped).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(0);
			// NEVER TOOK A BOX: the allocator was not even asked.
			expect(t.ran).toEqual([]);

			// AMENDED BY sf#481: the row's DISPOSITION (terminal, not deferred) and the
			// refusal log now belong to the sf#481 test below, which supersedes those
			// assertions here. What this test still uniquely pins is the sf#429 claim —
			// the gate fires BEFORE the allocator, so no box and no attempt are ever
			// spent on a result that could never be published.
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).not.toBe("running");
			expect(row?.activeAttemptId).toBeNull();
			const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));
			expect(attempts).toHaveLength(0);
		});
	});

	test("a job whose PR head moved off the job SHA is skipped, never dispatched", async () => {
		await withTestDb(async (db) => {
			// A force-push or new commit moves the open PR's head off the SHA this job
			// pinned. The result would be rejected at ingest, so the box is wasted.
			const jobId = await seedPendingJob(db, { sha: "abc123", itemHeadSha: "def456" });
			const t = fakeTransport();
			const now = new Date("2026-07-20T00:00:00.000Z");

			const { value: summary, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, config(), { now }),
			);

			expect(summary.skipped).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(0);
			expect(t.ran).toEqual([]);

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(now.getTime());

			const warn = lines.find((l) => l.msg === "dispatch.item_not_eligible");
			expect(warn).toBeDefined();
			expect(warn?.job_id).toBe(String(jobId));
			// The item is OPEN; only the head moved.
			expect(warn?.item_state).toBe("open");
		});
	});

	test("a job with no item is not gated by item eligibility", async () => {
		await withTestDb(async (db) => {
			// Repo-scoped lanes bind to no item, so there is no item state to gate on.
			// The gate must leave them exactly as they were.
			//
			// DEVIATION from the dispatch brief, which named `repo-validate` here: that
			// job type has no reviewed model/effort route, so it is refused by the
			// UNRELATED sf#386 route gate (`dispatch.route_refused`) before item
			// eligibility is ever reached, and the test would assert the wrong gate. A
			// routed type with `withoutItem` isolates the item gate, which is the claim.
			await seedPendingJob(db, { withoutItem: true, jobType: "pr-review" });
			const t = fakeTransport();

			const summary = await dispatchPendingJobs(db, t, config());

			expect(summary.dispatched).toBe(1);
			expect(summary.skipped).toBe(0);
			expect(t.ran.length).toBe(1);
		});
	});

	test("an open issue job dispatches regardless of head sha", async () => {
		await withTestDb(async (db) => {
			// Issues have no head SHA to drift; only their state can make them ineligible.
			await seedPendingJob(db, { itemKind: "issue", itemHeadSha: null });
			const t = fakeTransport();

			const summary = await dispatchPendingJobs(db, t, config());

			expect(summary.dispatched).toBe(1);
			expect(summary.skipped).toBe(0);
			expect(t.ran.length).toBe(1);
		});
	});

	test("a CLOSED-item job is TERMINALIZED, not deferred, and is never selected again", async () => {
		await withTestDb(async (db) => {
			// THE sf#481 DEFECT. The sf#429 gate treated "item closed" as recoverable and
			// deferred it by `skipDeferMinutes()`, so the row re-armed hourly forever: 41
			// such rows sat pending on the watcher host, re-selected ahead of every fresh job. A
			// closed item is NOT recoverable by waiting — reopening fires a webhook that
			// queues a NEW job — so the only futures for the old row are zombie or
			// duplicate. The gate must terminalize it.
			const jobId = await seedPendingJob(db, { itemState: "closed" });
			const t = fakeTransport();
			const now = new Date("2026-07-20T00:00:00.000Z");

			const { value: summary, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, config(), { now }),
			);

			expect(summary.skipped).toBe(1);
			expect(summary.dispatched).toBe(0);
			expect(t.ran).toEqual([]);

			// TERMINAL, not deferred: failed, with the sf#429 terminal reason, and no
			// next attempt at all — nothing re-arms it.
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("failed");
			expect(row?.nextAttemptAt).toBeNull();
			expect(row?.terminalReason).toContain("terminal: item is no longer eligible");
			expect(row?.terminalReason).toContain("sf#429");

			const notices = await db.select().from(githubPostings).where(eq(githubPostings.jobId, jobId));
			expect(notices).toHaveLength(1);
			const notice = notices[0];
			expect(notice?.kind).toBe("check");
			expect(notice?.target).toBe(TERMINAL_CHECK_TARGET);
			const payload = JSON.parse(notice?.payload ?? "null") as Record<string, unknown>;
			expect(payload.name).toBe(TERMINAL_CHECK_NAME);
			expect(payload.title).toBe(TERMINAL_CHECK_TITLE);
			expect(payload.conclusion).toBe("neutral");
			expect(payload.summary).toContain(`Job ${jobId}`);
			expect(payload.summary).toContain("no verdict was produced");
			expect(payload.summary).toContain("sf#429");

			// MUTATION TARGET: delete the log call and this reds.
			const warn = lines.find((l) => l.msg === "dispatch.item_reaped");
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			expect(warn?.job_id).toBe(String(jobId));
			expect(warn?.repository).toBe("rodaddy/x");
			expect(warn?.item_number).toBe("42");
			expect(warn?.item_state).toBe("closed");

			// AND IT NEVER COMES BACK: a second pass, far in the future (past any
			// backoff window a defer would have set), does not select it at all.
			const second = await dispatchPendingJobs(db, t, config(), {
				now: new Date("2026-09-20T00:00:00.000Z"),
			});
			expect(second.selected).toBe(0);
			expect(second.skipped).toBe(0);
			expect(
				await db.select().from(githubPostings).where(eq(githubPostings.jobId, jobId)),
			).toHaveLength(1);
		});
	});

	test("a closed shaless job terminalizes with a warning but no bogus check", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db, { itemState: "closed", sha: "" });
			const t = fakeTransport();
			const { value: summary, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, config(), { now: new Date("2026-07-20T00:00:00.000Z") }),
			);

			expect(summary.skipped).toBe(1);
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("failed");
			expect(lines.find((line) => line.msg === "dispatch.item_reaped")).toBeDefined();
			expect(
				await db.select().from(githubPostings).where(eq(githubPostings.jobId, jobId)),
			).toHaveLength(0);
		});
	});

	test("a publication enqueue failure rolls the guarded terminalization back", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db, { itemState: "closed", sha: "b".repeat(40) });
			let failedOnce = false;
			const failingDb = new Proxy(db as object, {
				get(dbTarget, dbProp) {
					if (dbProp === "transaction") {
						return (fn: (tx: unknown) => Promise<unknown>) =>
							db.transaction((tx) => {
								const proxiedTx = new Proxy(tx as object, {
									get(txTarget, txProp) {
										if (txProp === "insert") {
											return (table: unknown) => {
												if (table === githubPostings && !failedOnce) {
													failedOnce = true;
													throw new Error("simulated terminal-notice insert fault");
												}
												return (
													Reflect.get(txTarget, txProp, txTarget) as (t: unknown) => unknown
												).call(txTarget, table);
											};
										}
										const txValue = Reflect.get(txTarget, txProp, txTarget);
										return typeof txValue === "function" ? txValue.bind(txTarget) : txValue;
									},
								});
								return fn(proxiedTx);
							});
					}
					const value = Reflect.get(dbTarget, dbProp, dbTarget);
					return typeof value === "function" ? value.bind(dbTarget) : value;
				},
			}) as TestDb;

			const errors: unknown[] = [];
			const t = fakeTransport();
			const first = await dispatchPendingJobs(failingDb, t, config(), {
				now: new Date("2026-07-20T00:00:00.000Z"),
				onError: (error) => errors.push(error),
			});
			expect(first.skipped).toBe(1);
			expect(errors).toHaveLength(1);
			const [rolledBack] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(rolledBack?.status).toBe("pending");
			expect(
				await db.select().from(githubPostings).where(eq(githubPostings.jobId, jobId)),
			).toHaveLength(0);

			await dispatchPendingJobs(db, t, config(), {
				now: new Date("2026-07-20T00:00:00.000Z"),
			});
			const [terminal] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(terminal?.status).toBe("failed");
			expect(
				await db.select().from(githubPostings).where(eq(githubPostings.jobId, jobId)),
			).toHaveLength(1);
		});
	});

	test("a pending-to-running race loses the reap and publishes no notice", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedPendingJob(db, { itemState: "closed", sha: "c".repeat(40) });
			let raced = false;
			const racingDb = new Proxy(db as object, {
				get(dbTarget, dbProp) {
					if (dbProp === "transaction") {
						return async (fn: (tx: unknown) => Promise<unknown>) => {
							if (!raced) {
								raced = true;
								await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
							}
							return await db.transaction(fn);
						};
					}
					const value = Reflect.get(dbTarget, dbProp, dbTarget);
					return typeof value === "function" ? value.bind(dbTarget) : value;
				},
			}) as TestDb;

			const t = fakeTransport();
			const summary = await dispatchPendingJobs(racingDb, t, config(), {
				now: new Date("2026-07-20T00:00:00.000Z"),
			});
			expect(summary.skipped).toBe(1);
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("running");
			expect(
				await db.select().from(githubPostings).where(eq(githubPostings.jobId, jobId)),
			).toHaveLength(0);
		});
	});

	test("an OPEN item whose head moved keeps the DEFER, and stays pending", async () => {
		await withTestDb(async (db) => {
			// The other half of the sf#481 split: a force-push race on an OPEN PR can
			// settle, so head-moved-on-open stays recoverable and must NOT be reaped.
			const jobId = await seedPendingJob(db, { sha: "abc123", itemHeadSha: "def456" });
			const t = fakeTransport();
			const now = new Date("2026-07-20T00:00:00.000Z");

			const { value: summary, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, config(), { now }),
			);

			expect(summary.skipped).toBe(1);
			expect(t.ran).toEqual([]);

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.terminalReason).toBeNull();
			expect(row?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(now.getTime());

			// The DEFER refusal, not the reap.
			expect(lines.find((l) => l.msg === "dispatch.item_not_eligible")).toBeDefined();
			expect(lines.find((l) => l.msg === "dispatch.item_reaped")).toBeUndefined();
		});
	});

	test("a closed-item zombie is reaped without starving a fresh job at a 1-slot cap", async () => {
		await withTestDb(async (db) => {
			// THE STARVATION REGRESSION PIN. The shortlist is id-ordered and capped, so a
			// re-arming low-id zombie re-takes the slot every pass and a newer job can
			// NEVER dispatch. Reaping the zombie means it consumes ONE slot, once.
			const zombieId = await seedPendingJob(db, { itemState: "closed" });
			const [freshRepo] = await db.select().from(repositories);
			if (!freshRepo) throw new Error("seed failed");
			const [freshItem] = await db
				.insert(githubItems)
				.values({
					repositoryId: freshRepo.id,
					kind: "pull",
					number: 99,
					state: "open",
					headSha: "beef01",
				})
				.returning();
			const [freshJob] = await db
				.insert(jobs)
				.values({
					repositoryId: freshRepo.id,
					itemId: freshItem?.id,
					sha: "beef01",
					jobType: "pr-review",
					status: "pending",
				})
				.returning();
			if (!freshJob) throw new Error("seed failed");
			expect(freshJob.id).toBeGreaterThan(zombieId);

			const t = fakeTransport();
			// STARVATION: run one 1-slot pass per hour across the defer window. Pre-fix
			// the zombie re-arms every `skipDeferMinutes()` and re-takes the id-ordered
			// slot on every tick, so it is skipped again and again and the fresh job is
			// still pending at the end. Post-fix it is terminal after the FIRST tick and
			// never appears in a shortlist again.
			let skips = 0;
			for (let hour = 0; hour < 6; hour++) {
				const pass = await dispatchPendingJobs(db, t, config(), {
					now: new Date(Date.UTC(2026, 6, 20, hour * 2, 0, 0)),
					maxPerPass: 1,
				});
				skips += pass.skipped;
			}

			// The zombie cost exactly ONE slot, ever.
			expect(skips).toBe(1);
			expect(t.ran.length).toBe(1);

			const [zombie] = await db.select().from(jobs).where(eq(jobs.id, zombieId));
			expect(zombie?.status).toBe("failed");
			const [fresh] = await db.select().from(jobs).where(eq(jobs.id, freshJob.id));
			expect(fresh?.status).not.toBe("pending");
		});
	});
});

describe("a revived job dispatches with its previous attempt's failure reason", () => {
	/** A config allowlisting the issue-triage lane, the only `accepts_extras: allowed` packet. */
	function triageConfig(): WatcherConfig {
		return config({
			job_templates: [{ id: "issue-triage", runner_size: "small", return_mode: "patch" }],
		});
	}

	/**
	 * Seed a pending issue-triage job and, optionally, a PRIOR terminal attempt
	 * carrying `failure_summary` — the shape an infra-class requeue leaves
	 * behind when it revives a terminal-`failed` job back to `pending`.
	 */
	async function seedRevivedTriageJob(db: TestDb, summaries: (string | null)[]): Promise<number> {
		const jobId = await seedPendingJob(db, { jobType: "issue-triage" });
		for (const summary of summaries) {
			await db.insert(jobAttempts).values({
				jobId,
				runnerJobId: `rw-issue-triage-prior-${summaries.indexOf(summary)}-${summary ?? "none"}`,
				status: summary === null ? "completed" : "failed",
				failureSummary: summary,
			});
		}
		return jobId;
	}

	test("the dispatched body carries the prior bounded reason as a tier-2 extra", async () => {
		await withTestDb(async (db) => {
			await seedRevivedTriageJob(db, ["change.verify.path_outside_repo"]);
			const transport = fakeTransport();

			await dispatchPendingJobs(db, transport, triageConfig(), {});

			expect(transport.ran).toHaveLength(1);
			const body = transport.ran[0]?.job ?? "";
			// End-to-end: the reason was read from `job_attempts.failure_summary` by the
			// dispatch pass, carried on `DispatchableJob.previousFailure`, and rendered
			// into the tier-2 block. MUTATION PROOF: drop `previousFailure` from either
			// the select or `prepareDispatchableJob` and this goes RED.
			expect(body).toContain("previous_failure: change.verify.path_outside_repo");
			expect(body).toContain("<<<CALLER_EXTRAS");
		});
	});

	test("a FIRST attempt (no prior attempt rows) dispatches an unchanged body", async () => {
		await withTestDb(async (db) => {
			await seedRevivedTriageJob(db, []);
			const transport = fakeTransport();

			await dispatchPendingJobs(db, transport, triageConfig(), {});

			const body = transport.ran[0]?.job ?? "";
			expect(body).not.toContain("CALLER_EXTRAS");
			expect(body).not.toContain("previous_failure");
		});
	});

	test("the LATEST reason wins when a job has several summarised attempts", async () => {
		await withTestDb(async (db) => {
			// Two prior failures. Ordered by attempt id DESC, so the SECOND is the one
			// the revived attempt must learn from — an older reason would send the
			// agent to correct something already corrected. MUTATION PROOF: change the
			// subquery's `order by ... desc` to `asc` and this goes RED.
			await seedRevivedTriageJob(db, ["first.reason.stale", "second.reason.current"]);
			const transport = fakeTransport();

			await dispatchPendingJobs(db, transport, triageConfig(), {});

			const body = transport.ran[0]?.job ?? "";
			expect(body).toContain("previous_failure: second.reason.current");
			expect(body).not.toContain("first.reason.stale");
		});
	});

	test("an attempt with NO summary does not mask an earlier summarised failure", async () => {
		await withTestDb(async (db) => {
			// A `completed` attempt writes `failure_summary: null`. Selecting the latest
			// attempt ROW rather than the latest attempt WITH a summary would surface
			// null here and silently drop the correction.
			await seedRevivedTriageJob(db, ["real.reason.persisted", null]);
			const transport = fakeTransport();

			await dispatchPendingJobs(db, transport, triageConfig(), {});

			expect(transport.ran[0]?.job ?? "").toContain("previous_failure: real.reason.persisted");
		});
	});
});

describe("the due shortlist is ordered by due time, not id", () => {
	test("three re-armed low-id rows do not keep a fresh higher-id row out of a cap-3 pass", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			// Three OLD rows (low ids) that failed and were re-armed one minute ago:
			// the infra-requeue shape, which keeps the id and only moves next_attempt_at.
			for (let i = 0; i < 3; i++) {
				await db.insert(jobs).values({
					repositoryId: repo.id,
					sha: `stale${i}`,
					jobType: "pr-review",
					status: "pending",
					createdAt: minutesAgo(60),
					nextAttemptAt: minutesAgo(1),
				});
			}
			// One FRESH row (highest id), never attempted, waiting ten minutes already.
			const [fresh] = await db
				.insert(jobs)
				.values({
					repositoryId: repo.id,
					sha: "fresh",
					jobType: "pr-review",
					status: "pending",
					createdAt: minutesAgo(10),
				})
				.returning({ id: jobs.id });
			if (!fresh) throw new Error("seed failed");

			// The fake transport hands out ONE vmid, so only the FIRST row in the
			// shortlist actually places a box this pass (the rest are refused by the
			// same-pass vmid ledger and released). Id order dispatches stale0 and leaves
			// the fresh row waiting; due-time order dispatches the fresh row.
			const t = fakeTransport();
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 3 });
			// The two vmid refusals place nothing and refund their slots, so the pass
			// refills with the one remaining due row: four rows
			// seen, still exactly one box.
			expect(pass.selected).toBe(4);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, fresh.id));
			expect(row?.status).toBe("running");
			expect(t.ran.length).toBe(1);
		});
	});
});

describe("the per-pass cap is one budget shared with the verb lane", () => {
	test("a budget with one slot left shortlists the whole cap but dispatches one row", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			for (let i = 0; i < 3; i++) {
				await db.insert(jobs).values({
					repositoryId: repo.id,
					sha: `job${i}`,
					jobType: "pr-review",
					status: "pending",
				});
			}
			const passBudget = createPassBudget(3);
			expect(passBudget.take()).toBe(true);
			expect(passBudget.take()).toBe(true);
			const t = fakeTransport();
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 3, passBudget });
			// The shortlist is the cap (a skipped row must be replaceable, PR #680
			// round 3); the budget, checked before each dispatch, stops after one box.
			expect(pass.selected).toBe(3);
			expect(pass.dispatched).toBe(1);
			expect(t.ran).toHaveLength(1);
			expect(passBudget.remaining()).toBe(0);
		});
	});

	test("a shortlisted row that places no box spends no slot", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			// Lowest id first: a job type with NO allowlisted template is skipped by the
			// preparer without a box; the second row is an ordinary dispatch.
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-no-template",
				jobType: "no-such-template",
				status: "pending",
			});
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-real",
				jobType: "pr-review",
				status: "pending",
			});
			const passBudget = createPassBudget(2);
			const t = fakeTransport();
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 2, passBudget });
			expect(pass.selected).toBe(2);
			expect(pass.skipped).toBe(1);
			expect(pass.dispatched).toBe(1);
			// One box placed, one slot spent. The skip cost nothing.
			expect(passBudget.remaining()).toBe(1);
		});
	});

	test("skipped rows past the cap do not starve a dispatchable row: the shortlist refills", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			// Cap 1. The two lowest-id rows have no template; each would fill the
			// whole shortlist on its own and be skipped, leaving the real row pending
			// on every pass. The pass must refill past them within the same pass.
			for (const sha of ["skip-a", "skip-b"]) {
				await db.insert(jobs).values({
					repositoryId: repo.id,
					sha,
					jobType: "no-such-template",
					status: "pending",
				});
			}
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-real",
				jobType: "pr-review",
				status: "pending",
			});
			const t = fakeTransport();
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 1 });
			expect(pass.selected).toBe(3);
			expect(pass.skipped).toBe(2);
			expect(pass.dispatched).toBe(1);
			expect(t.ran).toHaveLength(1);
		});
	});

	test("the refill is bounded: a pass stops after MAX_SHORTLIST_PAGES pages", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			for (let i = 0; i < MAX_SHORTLIST_PAGES + 1; i++) {
				await db.insert(jobs).values({
					repositoryId: repo.id,
					sha: `skip-${i}`,
					jobType: "no-such-template",
					status: "pending",
				});
			}
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-real",
				jobType: "pr-review",
				status: "pending",
			});
			const t = fakeTransport();
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 1 });
			// One page per row at cap 1; the real row sits behind more skips than
			// the bound allows and waits for the next pass (the skips are deferred
			// by then, so it goes first).
			expect(pass.selected).toBe(MAX_SHORTLIST_PAGES);
			expect(pass.dispatched).toBe(0);
			expect(t.ran).toHaveLength(0);
		});
	});

	test("a spent budget stops the refill: no second shortlist is read", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			for (const sha of ["a", "b", "c"]) {
				await db.insert(jobs).values({
					repositoryId: repo.id,
					sha,
					jobType: "pr-review",
					status: "pending",
				});
			}
			const t = fakeTransport();
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 1 });
			expect(pass.selected).toBe(1);
			expect(pass.dispatched).toBe(1);
			const pending = await db.select().from(jobs).where(eq(jobs.status, "pending"));
			expect(pending).toHaveLength(2);
		});
	});

	test("a skipped row does not starve the last slot", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			// One slot left. The lowest-id row has no template and is skipped; the
			// next due row must still be shortlisted and dispatched.
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-no-template",
				jobType: "no-such-template",
				status: "pending",
			});
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-real",
				jobType: "pr-review",
				status: "pending",
			});
			const passBudget = createPassBudget(1);
			const t = fakeTransport();
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 2, passBudget });
			expect(pass.skipped).toBe(1);
			expect(pass.dispatched).toBe(1);
			expect(t.ran).toHaveLength(1);
			expect(passBudget.remaining()).toBe(0);
		});
	});

	test("a submit failure after the box was placed keeps the slot", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-real",
				jobType: "pr-review",
				status: "pending",
			});
			const passBudget = createPassBudget(2);
			const t = fakeTransport({
				run: async () => {
					throw new Error("submit failed");
				},
			});
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 2, passBudget });
			expect(pass.errored).toBe(1);
			// The gateway allocated a box before the submit failed: the slot is spent.
			expect(passBudget.remaining()).toBe(1);
		});
	});

	test("an allocation refusal that placed nothing refunds the slot", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job-real",
				jobType: "pr-review",
				status: "pending",
			});
			const passBudget = createPassBudget(2);
			const t = fakeTransport({
				needed: async () => ({ ok: false, refused: true, reason: "runner capacity unavailable" }),
			});
			const pass = await dispatchPendingJobs(db, t, config(), { now, maxPerPass: 2, passBudget });
			expect(pass.queued).toBe(1);
			expect(passBudget.remaining()).toBe(2);
		});
	});

	test("an exhausted budget selects nothing and says so", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-28T12:00:00.000Z");
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			await db.insert(jobs).values({
				repositoryId: repo.id,
				sha: "job0",
				jobType: "pr-review",
				status: "pending",
			});
			const t = fakeTransport();
			const { value: pass, lines } = await withCapturedLogs(() =>
				dispatchPendingJobs(db, t, config(), {
					now,
					maxPerPass: 3,
					passBudget: createPassBudget(0),
				}),
			);
			expect(pass.selected).toBe(0);
			expect(t.ran.length).toBe(0);
			const said = lines.filter((l) => l.msg === "dispatch.pass_budget_exhausted");
			expect(said.length).toBe(1);
			expect(said[0]?.max_per_pass).toBe("3");
		});
	});
});
