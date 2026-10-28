/**
 * @module tests/reconcile/build-bump-merge-watch
 * @description DB-backed tests for the bump merge watch, the Argo refresh step,
 *   and the in-flight predicate. `readPull` and `refreshArgo` are
 *   recording fakes; no network.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { buildBumpBumps, buildBumpCandidates } from "../../src/db/schema";
import type { PullRequestMergeState } from "../../src/forgejo/pull-state";
import {
	FOLLOW_THROUGH_DELAY_MS,
	followThroughDelay,
	type MergeWatchDeps,
	railInFlight,
	runBumpMergeWatch,
} from "../../src/reconcile/build-bump-merge-watch";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const NOW = new Date("2026-09-29T12:00:00.000Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
let seq = 0;

const OPEN: PullRequestMergeState = {
	merged: false,
	mergeCommitSha: null,
	state: "open",
	mergedAt: null,
};
const CLOSED: PullRequestMergeState = { ...OPEN, state: "closed" };
const merged = (at: string | null): PullRequestMergeState => ({
	merged: true,
	mergeCommitSha: "a".repeat(40),
	state: "closed",
	mergedAt: at,
});

async function seedCandidate(
	db: TestDb,
	status = "built",
	buildStartedAt: Date | null = null,
): Promise<number> {
	const [row] = await db
		.insert(buildBumpCandidates)
		.values({
			repository: "o/r",
			image: "r",
			tag: `v1.0.${++seq}`,
			sha: "d".repeat(40),
			status,
			buildStartedAt,
		})
		.returning({ id: buildBumpCandidates.id });
	if (!row) throw new Error("seed insert returned no row");
	return row.id;
}

async function seedBump(
	db: TestDb,
	values: Partial<typeof buildBumpBumps.$inferInsert> & { appDir: string },
): Promise<number> {
	const candidateId = await seedCandidate(db);
	const [row] = await db
		.insert(buildBumpBumps)
		.values({ candidateId, status: "opened", settledAt: ago(5 * MIN), ...values })
		.returning({ id: buildBumpBumps.id });
	if (!row) throw new Error("seed insert returned no row");
	return row.id;
}

async function bump(db: TestDb, id: number) {
	const [row] = await db.select().from(buildBumpBumps).where(eq(buildBumpBumps.id, id));
	if (!row) throw new Error("bump row missing");
	return row;
}

function deps(
	pulls: Record<number, PullRequestMergeState | Error>,
	refreshArgo: MergeWatchDeps["refreshArgo"] = null,
) {
	const reads: number[] = [];
	const d: MergeWatchDeps = {
		readPull: async (pr) => {
			reads.push(pr);
			const s = pulls[pr];
			if (s === undefined) throw new Error(`unscripted readPull ${pr}`);
			if (s instanceof Error) throw s;
			return s;
		},
		refreshArgo,
		now: () => NOW,
	};
	return { d, reads };
}

describe("runBumpMergeWatch", () => {
	test("a merged PR records the forge merge time and is not polled again", async () => {
		await withTestDb(async (db) => {
			const id = await seedBump(db, { appDir: "a", pr: 11 });
			const { d, reads } = deps({ 11: merged("2026-09-29T11:58:00.000Z") });
			expect(await runBumpMergeWatch(db, d)).toEqual({
				checked: 1,
				merged: 1,
				closed: 0,
				refreshed: 0,
			});
			expect((await bump(db, id)).mergedAt?.toISOString()).toBe("2026-09-29T11:58:00.000Z");
			await runBumpMergeWatch(db, d);
			expect(reads).toEqual([11]);
		});
	});

	test("a PR closed unmerged sets pr_closed_at and is not polled again", async () => {
		await withTestDb(async (db) => {
			const id = await seedBump(db, { appDir: "a", pr: 12 });
			const { d, reads } = deps({ 12: CLOSED });
			expect((await runBumpMergeWatch(db, d)).closed).toBe(1);
			const row = await bump(db, id);
			expect(row.prClosedAt?.toISOString()).toBe(NOW.toISOString());
			expect(row.mergedAt).toBeNull();
			await runBumpMergeWatch(db, d);
			expect(reads).toEqual([12]);
		});
	});

	test("an open PR sets nothing and is polled again next run", async () => {
		await withTestDb(async (db) => {
			const id = await seedBump(db, { appDir: "a", pr: 13 });
			const { d, reads } = deps({ 13: OPEN });
			await runBumpMergeWatch(db, d);
			await runBumpMergeWatch(db, d);
			const row = await bump(db, id);
			expect(row.mergedAt).toBeNull();
			expect(row.prClosedAt).toBeNull();
			expect(reads).toEqual([13, 13]);
		});
	});

	test("a row settled 25 h ago is never polled", async () => {
		await withTestDb(async (db) => {
			await seedBump(db, { appDir: "a", pr: 14, settledAt: ago(25 * 60 * MIN) });
			const { d, reads } = deps({});
			expect((await runBumpMergeWatch(db, d)).checked).toBe(0);
			expect(reads).toEqual([]);
		});
	});

	test("a readPull failure for one row does not stop the next", async () => {
		await withTestDb(async (db) => {
			await seedBump(db, { appDir: "a", pr: 15 });
			const b = await seedBump(db, { appDir: "b", pr: 16 });
			const { d, reads } = deps({ 15: new Error("boom"), 16: merged(null) });
			const counts = await runBumpMergeWatch(db, d);
			expect(reads).toEqual([15, 16]);
			expect(counts.merged).toBe(1);
			expect((await bump(db, b)).mergedAt?.toISOString()).toBe(NOW.toISOString());
		});
	});

	test("the Argo refresh runs only when configured, once, and retries after a failure", async () => {
		await withTestDb(async (db) => {
			const id = await seedBump(db, { appDir: "portal-uat", pr: 17, mergedAt: ago(MIN) });
			const off = deps({});
			await runBumpMergeWatch(db, off.d);
			expect((await bump(db, id)).argoRefreshedAt).toBeNull();

			let fail = true;
			const calls: string[] = [];
			const refresher = async (app: string) => {
				calls.push(app);
				if (fail) throw new Error("argo refresh failed: HTTP 503");
			};
			const on = deps({}, refresher);
			expect((await runBumpMergeWatch(db, on.d)).refreshed).toBe(0);
			expect((await bump(db, id)).argoRefreshedAt).toBeNull();
			fail = false;
			expect((await runBumpMergeWatch(db, on.d)).refreshed).toBe(1);
			expect((await bump(db, id)).argoRefreshedAt?.toISOString()).toBe(NOW.toISOString());
			await runBumpMergeWatch(db, on.d);
			expect(calls).toEqual(["portal-uat", "portal-uat"]);
		});
	});
});

describe("railInFlight / followThroughDelay", () => {
	test("nothing in flight -> false / null", async () => {
		await withTestDb(async (db) => {
			expect(await railInFlight(db, NOW, true)).toBe(false);
			expect(await followThroughDelay(db, NOW, true)).toBeNull();
		});
	});

	test("a build started 5 min ago is in flight; 2 h ago is not", async () => {
		await withTestDb(async (db) => {
			await seedCandidate(db, "building", ago(2 * 60 * MIN));
			expect(await railInFlight(db, NOW, false)).toBe(false);
			await seedCandidate(db, "building", ago(5 * MIN));
			expect(await railInFlight(db, NOW, false)).toBe(true);
			expect(await followThroughDelay(db, NOW, false)).toBe(FOLLOW_THROUGH_DELAY_MS);
		});
	});

	test("an opened unmerged bump settled 5 min ago is in flight", async () => {
		await withTestDb(async (db) => {
			await seedBump(db, { appDir: "a", pr: 20, settledAt: ago(5 * MIN) });
			expect(await railInFlight(db, NOW, false)).toBe(true);
			expect(await followThroughDelay(db, NOW, false)).toBe(20_000);
		});
	});

	test("a merged, unrefreshed bump 2 min ago is in flight only when Argo is configured", async () => {
		await withTestDb(async (db) => {
			await seedBump(db, { appDir: "a", pr: 21, mergedAt: ago(2 * MIN) });
			expect(await railInFlight(db, NOW, false)).toBe(false);
			expect(await followThroughDelay(db, NOW, false)).toBeNull();
			expect(await railInFlight(db, NOW, true)).toBe(true);
			expect(await followThroughDelay(db, NOW, true)).toBe(20_000);
		});
	});
});
