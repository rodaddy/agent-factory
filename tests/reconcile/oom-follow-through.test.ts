/**
 * sf#1076 (found 2026-09-30, `_reports/2026-09/2026-09-30-oom-trigger-session.md`):
 * a large OOM re-run used to wait for the next 15-minute sweep before the band
 * scaler saw its demand, so slot 9111 came up 11 to 21 minutes after the retry.
 * The re-run is dispatched DURING a pass (inside the band listing), so the pass
 * that dispatched it cannot see its own waiting job; the follow-through hook is
 * what brings the next pass back in 20 s.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { WatcherDb } from "../../src/db/client";
import {
	buildBumpBumps,
	buildBumpCandidates,
	type ForgeRunState,
	forgeRuns,
} from "../../src/db/schema";
import { followThroughSink, passFollowThroughDelay } from "../../src/reconcile/follow-through";
import { OOM_RETRY_WINDOW_MS, oomRetryInFlight } from "../../src/reconcile/oom-retry";
import { withTestDb } from "../db/helpers";

const NOW = new Date("2026-09-30T19:30:00.000Z");
const MIN = 60_000;
const SHA = "c".repeat(40);
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

async function seedRun(
	db: WatcherDb,
	opts: { inputs: Record<string, string>; state: ForgeRunState; dispatchedAt: Date },
): Promise<void> {
	await db.insert(forgeRuns).values({
		repo: "rodaddy/software-factory",
		workflow: "prepush.yml",
		runId: null,
		targetSha: SHA,
		inputs: sql`(${JSON.stringify(opts.inputs)}::text)::jsonb`,
		state: opts.state,
		dispatchedAt: opts.dispatchedAt,
	});
}

/** A bump merged 2 minutes ago whose Argo refresh has not happened. */
async function seedMergedBump(db: WatcherDb): Promise<void> {
	const [candidate] = await db
		.insert(buildBumpCandidates)
		.values({ repository: "o/r", image: "r", tag: "v1.0.1", sha: "d".repeat(40), status: "built" })
		.returning({ id: buildBumpCandidates.id });
	if (!candidate) throw new Error("seed insert returned no row");
	await db.insert(buildBumpBumps).values({
		candidateId: candidate.id,
		appDir: "portal-uat",
		pr: 21,
		status: "opened",
		settledAt: new Date(Date.now() - 2 * MIN),
		mergedAt: new Date(Date.now() - 2 * MIN),
	});
}

describe("oomRetryInFlight (found defect 3)", () => {
	test("no forge_runs rows -> not in flight", async () => {
		await withTestDb(async (db) => {
			expect(await oomRetryInFlight(db, NOW)).toBe(false);
		});
	});

	test("an unsettled large re-run dispatched 1 min ago is in flight", async () => {
		await withTestDb(async (db) => {
			await seedRun(db, {
				inputs: { repo: "rodaddy/software-factory", number: "12", runner_size: "large" },
				state: "dispatched",
				dispatchedAt: ago(MIN),
			});
			expect(await oomRetryInFlight(db, NOW)).toBe(true);
		});
	});

	test("a re-run without runner_size=large is not an OOM re-run", async () => {
		await withTestDb(async (db) => {
			await seedRun(db, {
				inputs: { repo: "rodaddy/software-factory", number: "12" },
				state: "dispatched",
				dispatchedAt: ago(MIN),
			});
			expect(await oomRetryInFlight(db, NOW)).toBe(false);
		});
	});

	test("a settled large re-run is not in flight", async () => {
		await withTestDb(async (db) => {
			for (const state of ["success", "failure", "cancelled"] as const) {
				await seedRun(db, {
					inputs: { runner_size: "large", number: String(state.length) },
					state,
					dispatchedAt: ago(MIN),
				});
			}
			expect(await oomRetryInFlight(db, NOW)).toBe(false);
		});
	});

	// Reviewer note on PR #1117: the first version of this test named two states
	// and seeded only `waiting`, so it proved half of what it claimed. Each
	// nonterminal state now gets its own database.
	for (const state of ["dispatched", "waiting", "running", "unknown"] as const) {
		test(`a large re-run in state '${state}' is in flight`, async () => {
			await withTestDb(async (db) => {
				await seedRun(db, {
					inputs: { runner_size: "large", number: "1" },
					state,
					dispatchedAt: ago(MIN),
				});
				expect(await oomRetryInFlight(db, NOW)).toBe(true);
			});
		});
	}

	test("a large re-run older than the window no longer holds the short cadence", async () => {
		await withTestDb(async (db) => {
			await seedRun(db, {
				inputs: { runner_size: "large", number: "12" },
				state: "dispatched",
				dispatchedAt: ago(OOM_RETRY_WINDOW_MS + MIN),
			});
			expect(await oomRetryInFlight(db, NOW)).toBe(false);
		});
	});
});

describe("passFollowThroughDelay (found defect 3)", () => {
	test("nothing in flight -> null", async () => {
		await withTestDb(async (db) => {
			expect(await passFollowThroughDelay(db, NOW, true)).toBeNull();
		});
	});

	test("an in-flight large OOM re-run arms the 20 s follow-through", async () => {
		await withTestDb(async (db) => {
			await seedRun(db, {
				inputs: { runner_size: "large", number: "12" },
				state: "dispatched",
				dispatchedAt: ago(2 * MIN),
			});
			expect(await passFollowThroughDelay(db, NOW, false)).toBe(20_000);
		});
	});
});

describe("followThroughSink (found defect 3)", () => {
	test("the sink answers the composed delay for its own db", async () => {
		await withTestDb(async (db) => {
			const sink = followThroughSink(db, {});
			expect(await sink()).toBeNull();
			await seedRun(db, {
				inputs: { runner_size: "large", number: "12" },
				state: "dispatched",
				dispatchedAt: new Date(Date.now() - MIN),
			});
			expect(await sink()).toBe(20_000);
		});
	});

	test("an unconfigured environment leaves the Argo-pending window out", async () => {
		await withTestDb(async (db) => {
			// A merged bump awaiting its refresh is in flight only when Argo is
			// configured, so the two sinks disagree on the SAME row.
			await seedMergedBump(db);
			expect(await followThroughSink(db, {})()).toBeNull();
			expect(
				await followThroughSink(db, {
					ARGOCD_TOKEN: "t",
					ARGOCD_SERVER: "https://argocd.example",
				})(),
			).toBe(20_000);
		});
	});
});
