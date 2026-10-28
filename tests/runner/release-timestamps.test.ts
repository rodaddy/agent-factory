/**
 * `releaseJob` writes an HONEST `updated_at`.
 *
 * `updated_at` answers "when was this row last written"; `next_attempt_at` answers
 * "when may it run again". `releaseJob` used to write the retry time into BOTH, so a
 * deferred release stamped `updated_at` with an instant that had not happened yet. On
 * 2026-08-02 a live investigation of job 715 read `next_attempt_at == updated_at ==
 * 03:56:16.934` on a row actually written at 03:41 and chased a phantom writer.
 *
 * These pin the two columns APART on a deferred release, and pin that a released row
 * carries a past-or-present `updated_at` — the property the stale-job reclaimer's
 * `lt(jobs.updatedAt, cutoff)` age math reads.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, jobs, repositories } from "../../src/db/schema";
import { releaseJob } from "../../src/runner/dispatch";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** Seed one job in `dispatching` — a row a release legitimately acts on. */
async function seedJob(db: TestDb, writtenAt: Date): Promise<number> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", checks: "standard" })
		.returning();
	if (!repo) throw new Error("seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "pull", number: 1, state: "open", headSha: "abc123" })
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha: "abc123",
			jobType: "pr-review",
			status: "dispatching",
			updatedAt: writtenAt,
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return job.id;
}

describe("releaseJob updated_at semantics", () => {
	test("a DEFERRED release writes the release time, not the future retry time", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-02T03:41:00.000Z");
			const nextAttemptAt = new Date("2026-08-02T03:56:16.934Z"); // now + ~15m backoff
			const jobId = await seedJob(db, new Date("2026-08-02T03:00:00.000Z"));

			expect(await releaseJob(db, jobId, nextAttemptAt, { now })).toBe(true);

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			// The two columns are DIFFERENT: the write time and the retry time.
			expect(row?.updatedAt?.toISOString()).toBe(now.toISOString());
			expect(row?.nextAttemptAt?.toISOString()).toBe(nextAttemptAt.toISOString());
			expect(row?.updatedAt?.getTime()).toBeLessThan(row?.nextAttemptAt?.getTime() ?? 0);
			// ...and the release still does everything else it did.
			expect(row?.status).toBe("pending");
			expect(row?.activeAttemptId).toBeNull();
		});
	});

	test("a released row's updated_at is never in the future of the release", async () => {
		await withTestDb(async (db) => {
			const now = new Date("2026-08-02T03:41:00.000Z");
			const jobId = await seedJob(db, new Date("2026-08-02T03:00:00.000Z"));

			// A 6-hour backoff — the case where a future-writing release would put
			// `updated_at` six hours ahead of the instant it actually ran.
			await releaseJob(db, jobId, new Date(now.getTime() + 6 * 60 * 60_000), { now });

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.updatedAt?.getTime()).toBeLessThanOrEqual(now.getTime());
		});
	});

	test("a DUE-NOW release leaves both columns at the same instant", async () => {
		await withTestDb(async (db) => {
			// The reclaimer releases due-now (`nextAttemptAt === now`), so the two
			// genuinely coincide there — but `now` is stated anyway, because the type
			// REQUIRES it (a deferred site must not be able to omit it by accident).
			// Pinned so a later change cannot quietly make the due-now release write
			// something else.
			const now = new Date("2026-08-02T03:41:00.000Z");
			const jobId = await seedJob(db, new Date("2026-08-02T03:00:00.000Z"));

			expect(await releaseJob(db, jobId, now, { now, expectedStatus: "dispatching" })).toBe(true);

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.updatedAt?.toISOString()).toBe(now.toISOString());
			expect(row?.nextAttemptAt?.toISOString()).toBe(now.toISOString());
		});
	});
});
