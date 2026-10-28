/**
 * sf#179 seam 2 — SURFACE unconfirmed allocations. Never reap one.
 *
 * The gap: an attempt sitting in `allocating` with a NULL vmid is a dispatch
 * that entered `runner_needed` and never came back with a box name. Per
 * `_DOCS/deployment.md` that verb generally COMPLETES server-side when it times
 * out client-side, so a box very likely EXISTS, stamped with this attempt's
 * `runner_job_id` — and nothing in the watcher could name it.
 *
 * This pass names it. It does NOT reap it, and that is a hard non-goal rather
 * than a phase-two nicety: the standing trap says a timed-out verb probably
 * SUCCEEDED server-side, so acting automatically on an inference about a box we
 * could not name is exactly how boxes got leaked in the first place. The pass
 * emits a candidate and the fixed reap command; the operator decides.
 *
 * MATCHING IS JOB-ID-FIRST. Job ids are single-use per attempt (the verb's own
 * docstring says so), so an exact `jobId` hit is unambiguous and wins outright.
 * The spawn-time window is a FALLBACK for unstamped boxes only, it is
 * inherently fuzzy, and two candidates in one window are BOTH surfaced flagged
 * ambiguous rather than one being picked.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WatcherDb } from "../../src/db/client";
import { jobAttempts, jobs, repositories } from "../../src/db/schema";
import { DISPATCHING_STALE_MINUTES } from "../../src/reconcile/dispatch-pass";
import {
	surfaceUnconfirmedAllocations,
	UNCONFIRMED_ALLOCATION_MINUTES,
} from "../../src/reconcile/reclaim";
import { ALLOCATING_ATTEMPT_STATUS } from "../../src/runner/attempt-record";
import type {
	ListedBox,
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

const NOW = new Date("2026-08-17T06:00:00Z");
/** Comfortably past the surfacing window, so the row is a candidate. */
const OLD_START = new Date("2026-08-17T04:00:00Z");

/** A transport whose `list` is scripted and whose `done` calls are RECORDED. */
function listTransport(list: () => Promise<ListedBox[]>): RunnerTransport & {
	doneVmids: number[];
} {
	const doneVmids: number[] = [];
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
		doneVmids,
		needed: async (): Promise<RunnerAllocation> => ({ ok: false, refused: true, reason: "n/a" }),
		run: async (_p: RunnerRunParams) => {},
		done: async (vmid: number) => {
			doneVmids.push(vmid);
		},
		list,
	};
}

function box(overrides: Partial<ListedBox> = {}): ListedBox {
	return {
		vmid: 9001,
		status: "running",
		name: "CT118",
		jobId: null,
		spawnIso: null,
		...overrides,
	};
}

/** Seed one repo + job + an `allocating` attempt with a NULL vmid. */
async function seedAllocatingAttempt(
	db: WatcherDb,
	runnerJobId: string,
	startedAt: Date = OLD_START,
): Promise<number> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/software-factory", provider: "github", checks: "static-only" })
		.returning({ id: repositories.id });
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo?.id ?? 0,
			jobType: "pr-review",
			sha: "a".repeat(40),
			status: "dispatching",
		})
		.returning({ id: jobs.id });
	const [attempt] = await db
		.insert(jobAttempts)
		.values({
			jobId: job?.id ?? 0,
			runnerJobId,
			runnerVmid: null,
			status: ALLOCATING_ATTEMPT_STATUS,
			startedAt,
		})
		.returning({ id: jobAttempts.id });
	return attempt?.id ?? 0;
}

describe("the surfacing window is pinned to the dispatch-staleness ceiling", () => {
	test("UNCONFIRMED_ALLOCATION_MINUTES equals DISPATCHING_STALE_MINUTES", () => {
		// The two are stated separately because `reclaim` and `dispatch-pass` form
		// an import CYCLE: deriving one from the other threw `ReferenceError:
		// Cannot access 'DISPATCHING_STALE_MINUTES' before initialization` at import
		// time while `bun run check` stayed green, because a cycle is legal
		// TypeScript. `attempt-lifecycle.ts` states `SUBMITTED_MAX_MINUTES` as a
		// literal for exactly this reason. This assertion is the mechanism that
		// keeps the duplication honest — a comment saying "these are the same" is
		// not one.
		expect(UNCONFIRMED_ALLOCATION_MINUTES).toBe(DISPATCHING_STALE_MINUTES);
	});
});

describe("surfaceUnconfirmedAllocations — JOB_ID match is the primary matcher", () => {
	test("an EXACT job id hit wins over a box that only matches the time window", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-pr-review-ours");
			// 9002 carries OUR job id. 9001 is unstamped and its spawn time sits
			// inside the window, so a window-first matcher would report 9001.
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: null, spawnIso: "2026-08-17T04:05:00Z" }),
				box({ vmid: 9002, jobId: "rw-pr-review-ours", spawnIso: "2026-08-17T04:01:00Z" }),
			]);

			const found = await surfaceUnconfirmedAllocations(db, transport, NOW);

			expect(found).toHaveLength(1);
			expect(found[0]?.vmid).toBe(9002);
			expect(found[0]?.jobId).toBe("rw-pr-review-ours");
			// An exact single-use job id is unambiguous by construction.
			expect(found[0]?.ambiguous).toBe(false);
		});
	});

	test("a job-id hit is never treated as ambiguous even with window candidates present", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-x-1");
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: null, spawnIso: "2026-08-17T04:05:00Z" }),
				box({ vmid: 9003, jobId: null, spawnIso: "2026-08-17T04:06:00Z" }),
				box({ vmid: 9002, jobId: "rw-x-1", spawnIso: "2026-08-17T04:01:00Z" }),
			]);

			const found = await surfaceUnconfirmedAllocations(db, transport, NOW);

			expect(found.map((c) => c.vmid)).toEqual([9002]);
			expect(found[0]?.ambiguous).toBe(false);
		});
	});
});

describe("surfaceUnconfirmedAllocations — the window fallback surfaces ALL candidates", () => {
	test("TWO unstamped boxes in one window are BOTH surfaced, both flagged ambiguous", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-y-1");
			// No box carries our job id, so the fallback runs. Both spawn times sit
			// inside [startedAt, startedAt + window]. Picking one would be a guess
			// that could send an operator to reap another job's box.
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: null, spawnIso: "2026-08-17T04:05:00Z" }),
				box({ vmid: 9004, jobId: null, spawnIso: "2026-08-17T04:10:00Z" }),
			]);

			const found = await surfaceUnconfirmedAllocations(db, transport, NOW);

			expect(found.map((c) => c.vmid).sort()).toEqual([9001, 9004]);
			expect(found.every((c) => c.ambiguous)).toBe(true);
		});
	});

	test("a SINGLE window candidate is surfaced without the ambiguous flag", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-z-1");
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: null, spawnIso: "2026-08-17T04:05:00Z" }),
			]);

			const found = await surfaceUnconfirmedAllocations(db, transport, NOW);

			expect(found).toHaveLength(1);
			expect(found[0]?.ambiguous).toBe(false);
		});
	});

	test("a box spawned OUTSIDE the window is not a candidate", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-w-1");
			const transport = listTransport(async () => [
				// An hour BEFORE the attempt started: cannot be this attempt's box.
				box({ vmid: 9001, jobId: null, spawnIso: "2026-08-17T03:00:00Z" }),
				// An hour AFTER the window closed. Both bounds are asserted, because a
				// one-sided window silently sweeps in every later box on the fleet.
				box({ vmid: 9004, jobId: null, spawnIso: "2026-08-17T05:30:00Z" }),
			]);

			expect(await surfaceUnconfirmedAllocations(db, transport, NOW)).toEqual([]);
		});
	});

	test("a STAMPED box belonging to another job is never window-matched", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-v-1");
			// The window fallback applies to UNSTAMPED boxes only. A box that names a
			// different job has already answered the ownership question.
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: "rw-somebody-else", spawnIso: "2026-08-17T04:05:00Z" }),
			]);

			expect(await surfaceUnconfirmedAllocations(db, transport, NOW)).toEqual([]);
		});
	});
});

describe("surfaceUnconfirmedAllocations — degradation and non-goals", () => {
	test("list() THROWING yields an EMPTY surfacing and the pass still completes", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-t-1");
			const transport = listTransport(async () => {
				throw new Error("CONNECTION_ERROR: failed to communicate with local daemon");
			});

			// The assertion is that this RESOLVES. A throw escaping here would take
			// the whole reconcile pass down over a read that is advisory by design.
			const found = await surfaceUnconfirmedAllocations(db, transport, NOW);

			expect(found).toEqual([]);
		});
	});

	test("NOTHING is ever reaped — done() is never called on any path", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-s-1");
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: "rw-s-1", spawnIso: "2026-08-17T04:05:00Z" }),
			]);

			await surfaceUnconfirmedAllocations(db, transport, NOW);

			// The hard non-goal: a timed-out verb probably SUCCEEDED server-side, so
			// an automatic power-off acts on an inference about a box we could not
			// name. The operator decides.
			expect(transport.doneVmids).toEqual([]);
		});
	});

	test("each candidate carries the LITERAL reap command for the operator", async () => {
		await withTestDb(async (db) => {
			await seedAllocatingAttempt(db, "rw-r-1");
			const transport = listTransport(async () => [
				box({ vmid: 9002, jobId: "rw-r-1", spawnIso: "2026-08-17T04:05:00Z" }),
			]);

			const [candidate] = await surfaceUnconfirmedAllocations(db, transport, NOW);

			// A fixed string built from the validated integer vmid — the operator
			// should not have to re-derive the verb spelling from memory.
			expect(candidate?.reapCommand).toContain("9002");
			expect(candidate?.reapCommand).toContain("runner_done");
		});
	});

	test("a YOUNG allocating row is not yet a candidate", async () => {
		await withTestDb(async (db) => {
			// Started one minute ago: the verb may still legitimately be in flight.
			await seedAllocatingAttempt(db, "rw-q-1", new Date(NOW.getTime() - 60_000));
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: "rw-q-1", spawnIso: "2026-08-17T05:59:10Z" }),
			]);

			expect(await surfaceUnconfirmedAllocations(db, transport, NOW)).toEqual([]);
		});
	});

	test("an attempt that already has a vmid is not surfaced", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAllocatingAttempt(db, "rw-p-1");
			// A known vmid means the allocation CONFIRMED; the existing reclaim owns it.
			await db
				.update(jobAttempts)
				.set({ runnerVmid: 9001 })
				.where(eq(jobAttempts.id, attemptId))
				.returning({ id: jobAttempts.id });
			const transport = listTransport(async () => [
				box({ vmid: 9001, jobId: "rw-p-1", spawnIso: "2026-08-17T04:05:00Z" }),
			]);

			expect(await surfaceUnconfirmedAllocations(db, transport, NOW)).toEqual([]);
		});
	});
});
