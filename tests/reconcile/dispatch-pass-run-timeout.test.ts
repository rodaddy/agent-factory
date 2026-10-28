/**
 * sf#564: a `runner_run` TIMEOUT is not a failed verb, and must not recycle the
 * vmid inside the same pass.
 *
 * Live 2026-09-02: `runner_run` timed out client-side after 90 s while the verb
 * completed server-side; the catch path reaped the box, released the job, and
 * `releaseAbandonedTake` handed vmid 9001 back to the pass because the reap
 * "proved" the box gone — so the next job was dispatched onto the recycled 9001
 * while the first job's body may still have been running there. Only
 * `runner_list` can say what the box is doing.
 *
 * These cases run ONE `dispatchPendingJobs` pass over TWO pending jobs with a
 * fresh ledger, and pin what the second job may do for each `list()` verdict.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, jobAttempts, jobs, repositories } from "../../src/db/schema";
import { dispatchPendingJobs } from "../../src/reconcile/dispatch-pass";
import { createPassVmids } from "../../src/runner/pass-vmids";
import type {
	ListedBox,
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** A config whose allowlist maps pr-review to a fixed template. */
function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/x", provider: "github", checks: "standard", gate_selection: "full" },
		],
		job_templates: [{ id: "pr-review", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
	};
}

/**
 * Fake transport: `needed` always re-reports vmid 9001 (the gateway reports a
 * warm box without reserving it), `run` TIMES OUT on its first call only, and
 * `list` is the seam each case drives.
 */
function timingOutTransport(
	list: (ran: RunnerRunParams[]) => Promise<ListedBox[]>,
): RunnerTransport & {
	ran: RunnerRunParams[];
	reaped: number[];
} {
	const ran: RunnerRunParams[] = [];
	const reaped: number[] = [];
	let runCalls = 0;
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
		needed: async (): Promise<RunnerAllocation> => ({
			ok: true,
			boxes: [{ vmid: 9001, size: "medium" }],
		}),
		run: async (p: RunnerRunParams) => {
			runCalls++;
			ran.push(p);
			if (runCalls === 1) {
				// The HTTP transport's AbortSignal.timeout rejection: the platform TimeoutError.
				const timeout = new Error("The operation timed out.");
				timeout.name = "TimeoutError";
				throw timeout;
			}
		},
		list: async () => await list(ran),
		done: async (vmid: number) => {
			reaped.push(vmid);
		},
	};
}

/** Seed a repo plus TWO pending pr-review jobs, each with its own open PR item. */
async function seedTwoPendingJobs(db: TestDb): Promise<{ first: number; second: number }> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", checks: "standard" })
		.returning();
	if (!repo) throw new Error("seed failed");
	const ids: number[] = [];
	for (const [number, sha] of [
		[42, "abc123"],
		[43, "def456"],
	] as const) {
		const [item] = await db
			.insert(githubItems)
			.values({ repositoryId: repo.id, kind: "pull", number, state: "open", headSha: sha })
			.returning();
		const [job] = await db
			.insert(jobs)
			.values({
				repositoryId: repo.id,
				itemId: item?.id,
				sha,
				jobType: "pr-review",
				status: "pending",
			})
			.returning();
		if (!job) throw new Error("seed failed");
		ids.push(job.id);
	}
	const [first, second] = ids;
	if (first === undefined || second === undefined) throw new Error("seed failed");
	return { first, second };
}

async function runPassWith(
	db: TestDb,
	list: (ran: RunnerRunParams[]) => Promise<ListedBox[]>,
): Promise<{
	transport: ReturnType<typeof timingOutTransport>;
	first: number;
	second: number;
}> {
	const { first, second } = await seedTwoPendingJobs(db);
	const transport = timingOutTransport(list);
	await dispatchPendingJobs(db, transport, config(), {
		now: new Date("2026-09-02T00:00:00.000Z"),
		maxPerPass: 2,
		passVmids: createPassVmids(),
	});
	return { transport, first, second };
}

async function jobStatus(db: TestDb, id: number): Promise<string | undefined> {
	const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
	return row?.status;
}

async function attemptOf(db: TestDb, id: number) {
	const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, id));
	return attempt;
}

describe("runner_run timeout is not a release", () => {
	test("landed: the box still reports THIS job, so the dispatch is held and no sibling gets 9001", async () => {
		await withTestDb(async (db) => {
			// The runner job id is only known after `run` fired, so the row this case
			// returns is built from what the first (timed-out) call carried.
			const { transport, first, second } = await runPassWith(db, async (ran) => [
				{
					vmid: 9001,
					status: "running",
					name: "CT118",
					jobId: ran[0]?.jobId ?? "unknown",
					spawnIso: "x",
				},
			]);

			expect(await jobStatus(db, first)).toBe("running");
			expect((await attemptOf(db, first))?.status).not.toBe("failed");
			expect(await jobStatus(db, second)).toBe("pending");
			expect(transport.ran).toHaveLength(1);
			expect(transport.reaped).toEqual([]);
		});
	});

	test("unknown: a list() that throws holds the dispatch exactly as `landed` does", async () => {
		await withTestDb(async (db) => {
			const { transport, first, second } = await runPassWith(db, async () => {
				throw new Error("runner_list failed (exit 1) -- gateway unreachable");
			});

			expect(await jobStatus(db, first)).toBe("running");
			expect((await attemptOf(db, first))?.status).not.toBe("failed");
			expect(await jobStatus(db, second)).toBe("pending");
			expect(transport.ran).toHaveLength(1);
			expect(transport.reaped).toEqual([]);
		});
	});

	test("gone: an empty list proves the box absent, so the job fails and 9001 is reusable", async () => {
		await withTestDb(async (db) => {
			const { transport, first, second } = await runPassWith(db, async () => []);

			expect(await jobStatus(db, first)).toBe("pending");
			const attempt = await attemptOf(db, first);
			expect(attempt?.status).toBe("failed");
			expect(attempt?.failureSummary).toContain("runner_run failed after");
			expect(attempt?.failureSummary).toContain("timed out");
			expect(transport.reaped).toEqual([]);
			expect(await jobStatus(db, second)).toBe("running");
			expect(transport.ran).toHaveLength(2);
			expect(transport.ran[1]?.vmid).toBe(9001);
		});
	});

	test("foreign: another job owns the box, so this job fails and the vmid stays held", async () => {
		await withTestDb(async (db) => {
			const { transport, first, second } = await runPassWith(db, async () => [
				{ vmid: 9001, status: "running", name: "CT118", jobId: "someone-else", spawnIso: "x" },
			]);

			expect(await jobStatus(db, first)).toBe("pending");
			const attempt = await attemptOf(db, first);
			expect(attempt?.status).toBe("failed");
			expect(attempt?.failureSummary).toContain("someone-else");
			expect(await jobStatus(db, second)).toBe("pending");
			expect(transport.ran).toHaveLength(1);
			expect(transport.reaped).toEqual([]);
		});
	});
});
