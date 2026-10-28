import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import { buildPublicationPlans, type JobIdentity } from "../../src/github/publication";
import { persistPublicationPlans } from "../../src/github/publish-plan";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-07-20T12:00:00.000Z");

async function seedJob(
	db: TestDb,
	options: { itemNumber?: number | null; sha?: string } = {},
): Promise<JobIdentity> {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const itemNumber = options.itemNumber === undefined ? 7 : options.itemNumber;
	const sha = options.sha === undefined ? "deadbeefcafe" : options.sha;
	const [item] =
		itemNumber === null
			? []
			: await db
					.insert(githubItems)
					.values({
						repositoryId: repo.id,
						kind: "pull",
						number: itemNumber,
						state: "open",
						headSha: sha,
					})
					.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha,
			jobType: "pr-review",
			status: "running",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return { jobId: job.id, repository: "rodaddy/x", itemNumber, sha, jobType: "pr-review" };
}

const passing: RunnerResult = {
	result_version: RESULT_VERSION,
	repository: "rodaddy/x",
	job_type: "pr-review",
	item_number: 7,
	sha: "deadbeefcafe",
	status: "passed",
	checks: [],
	findings: [],
};

describe("persistPublicationPlans — durable plans + dedup across restarts", () => {
	test("persists one row per (kind, target) matching the built plans", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: passing, now: at });

			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			const built = buildPublicationPlans(identity, passing);
			expect(rows.length).toBe(built.length);
			// Every row is pending and carries a bounded, redacted payload (no raw output).
			for (const r of rows) {
				expect(r.status).toBe("pending");
				expect(r.payload.length).toBeGreaterThan(0);
				expect(r.dedupeKey.length).toBeGreaterThan(0);
			}
		});
	});

	test("re-persisting the same result does not duplicate rows (DB dedup)", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: passing, now: at });
			await persistPublicationPlans({ tx: db, identity, result: passing, now: at }); // restart re-ingest

			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			const built = buildPublicationPlans(identity, passing);
			expect(rows.length).toBe(built.length); // no duplication
		});
	});

	test("does not re-arm an already-posted plan on re-ingest", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: passing, now: at });
			// Simulate the reconciler having posted the comment plan.
			await db
				.update(githubPostings)
				.set({ status: "posted", externalRef: "111", postedAt: at })
				.where(eq(githubPostings.kind, "comment"));

			// A later re-ingest must not flip the posted comment back to pending.
			await persistPublicationPlans({ tx: db, identity, result: passing, now: at });
			const [comment] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(comment?.status).toBe("posted");
			expect(comment?.externalRef).toBe("111");
		});
	});

	test("itemless+shaless job persists no plans", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db, { itemNumber: null, sha: "" });
			const { item_number: _n, sha: _s, ...itemless } = passing;
			await persistPublicationPlans({
				tx: db,
				identity,
				result: itemless as RunnerResult,
				now: at,
			});
			const rows = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			expect(rows.length).toBe(0);
		});
	});
});
