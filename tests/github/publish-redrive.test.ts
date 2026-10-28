import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type { ForgeClient, ForgeResponse } from "../../src/forge/boundary";
import { CHECK_NAME, CHECK_TARGET, checkDedupeKey } from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { type RedriveOutcome, redriveFailedCheck } from "../../src/github/publish-redrive";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-09-05T12:00:00.000Z");
const oldPostedAt = new Date("2026-09-04T12:00:00.000Z");
let seedNumber = 0;

async function seed(
	db: TestDb,
	options: {
		status?: string;
		kind?: string;
		target?: string;
		sha?: string;
		attempts?: number;
		nextAttemptAt?: Date | null;
		lastError?: string | null;
		externalRef?: string | null;
		postedAt?: Date | null;
	} = {},
): Promise<{ jobId: number; postingId: number; dedupeKey: string; repository: string }> {
	const sha = options.sha ?? "deadbeefcafe";
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: `rodaddy/redrive-${seedNumber++}`, provider: "github" })
		.returning({ id: repositories.id, fullName: repositories.fullName });
	if (!repo) throw new Error("redrive fixture repository insert failed");
	const [item] = await db
		.insert(githubItems)
		.values({
			repositoryId: repo.id,
			kind: "pull",
			number: 7,
			state: "open",
			headSha: sha === "" ? null : sha,
		})
		.returning({ id: githubItems.id });
	if (!item) throw new Error("redrive fixture item insert failed");
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item.id,
			sha,
			jobType: "pr-review",
			status: "running",
		})
		.returning({ id: jobs.id });
	if (!job) throw new Error("redrive fixture job insert failed");

	const dedupeKey = checkDedupeKey({
		jobId: job.id,
		repository: repo.fullName,
		itemNumber: 7,
		sha,
		jobType: "pr-review",
	});
	const kind = options.kind ?? "check";
	const target = options.target ?? CHECK_TARGET;
	const payload = JSON.stringify({
		kind,
		action: "upsert",
		target,
		name: CHECK_NAME,
		sha,
		conclusion: "failure",
		title: "factory check failed",
		summary: "factory check failed",
		dedupeKey,
	});
	const [posting] = await db
		.insert(githubPostings)
		.values({
			jobId: job.id,
			kind,
			action: "upsert",
			target,
			status: options.status ?? "failed",
			payload,
			dedupeKey,
			externalRef: options.externalRef ?? null,
			attempts: options.attempts ?? 5,
			nextAttemptAt:
				options.nextAttemptAt === undefined
					? new Date("2026-09-06T12:00:00.000Z")
					: options.nextAttemptAt,
			lastError: options.lastError === undefined ? "posting exhausted" : options.lastError,
			postedAt: options.postedAt === undefined ? null : options.postedAt,
		})
		.returning({ id: githubPostings.id });
	if (!posting) throw new Error("redrive fixture posting insert failed");
	return { jobId: job.id, postingId: posting.id, dedupeKey, repository: repo.fullName };
}

async function readPosting(db: TestDb, postingId: number) {
	const [row] = await db.select().from(githubPostings).where(eq(githubPostings.id, postingId));
	if (!row) throw new Error("redrive fixture posting disappeared");
	return row;
}

test("re-arms one exhausted normal check and preserves its durable identity", async () => {
	await withTestDb(async (db) => {
		const fixture = await seed(db, {
			attempts: 5,
			externalRef: "77",
			postedAt: oldPostedAt,
		});
		const before = await readPosting(db, fixture.postingId);

		const outcome = await redriveFailedCheck(db, fixture.jobId, at);

		expect(outcome).toEqual({
			status: "queued",
			jobId: fixture.jobId,
			postingId: fixture.postingId,
			previousAttempts: 5,
		});
		const after = await readPosting(db, fixture.postingId);
		expect(after).toMatchObject({
			id: before.id,
			jobId: before.jobId,
			payload: before.payload,
			dedupeKey: before.dedupeKey,
			externalRef: before.externalRef,
			postedAt: before.postedAt,
			status: "pending",
			attempts: 0,
			nextAttemptAt: null,
			lastError: null,
			updatedAt: at,
		});
	});
});

test("concurrent and repeated re-drives change one row exactly once", async () => {
	await withTestDb(async (db) => {
		const fixture = await seed(db);
		const outcomes = await Promise.all([
			redriveFailedCheck(db, fixture.jobId, at),
			redriveFailedCheck(db, fixture.jobId, at),
		]);
		expect(outcomes.filter((value) => value.status === "queued")).toHaveLength(1);
		expect(outcomes.filter((value) => value.status === "not-failed")).toHaveLength(1);
		expect(await redriveFailedCheck(db, fixture.jobId, at)).toMatchObject({
			status: "not-failed",
			currentStatus: "pending",
		});
		expect((await readPosting(db, fixture.postingId)).attempts).toBe(0);
	});
});

test("posted and pending rows remain byte-for-byte unchanged", async () => {
	await withTestDb(async (db) => {
		const posted = await seed(db, {
			status: "posted",
			attempts: 1,
			nextAttemptAt: null,
			lastError: null,
			externalRef: "77",
			postedAt: oldPostedAt,
		});
		const pending = await seed(db, {
			status: "pending",
			attempts: 2,
			nextAttemptAt: new Date("2026-09-06T12:00:00.000Z"),
			lastError: "temporary failure",
		});
		const beforePosted = await readPosting(db, posted.postingId);
		const beforePending = await readPosting(db, pending.postingId);

		expect((await redriveFailedCheck(db, posted.jobId, at)).status).toBe("not-failed");
		expect((await redriveFailedCheck(db, pending.jobId, at)).status).toBe("not-failed");
		expect(await readPosting(db, posted.postingId)).toEqual(beforePosted);
		expect(await readPosting(db, pending.postingId)).toEqual(beforePending);
	});
});

test("non-check, non-target, other-job, and no-SHA rows are untouched", async () => {
	await withTestDb(async (db) => {
		const target = await seed(db);
		const noKind = await seed(db, { kind: "comment" });
		const wrongTarget = await seed(db, { target: "other-target" });
		const noSha = await seed(db, { sha: "" });
		const otherJob = await seed(db);
		const untouchedIds = [
			noKind.postingId,
			wrongTarget.postingId,
			noSha.postingId,
			otherJob.postingId,
		];
		const before = await Promise.all(untouchedIds.map((id) => readPosting(db, id)));

		expect((await redriveFailedCheck(db, target.jobId, at)).status).toBe("queued");
		expect((await redriveFailedCheck(db, noSha.jobId, at)).status).toBe("not-found");
		expect(await Promise.all(untouchedIds.map((id) => readPosting(db, id)))).toEqual(before);
	});
});

test("a re-driven row is consumed by the existing publisher and updates one stable check", async () => {
	await withTestDb(async (db) => {
		const fixture = await seed(db, {
			externalRef: "77",
			postedAt: oldPostedAt,
		});
		expect((await redriveFailedCheck(db, fixture.jobId, at)).status).toBe("queued");

		const writes: Array<{ method: string; path: string; body: unknown }> = [];
		const client: ForgeClient = {
			provider: "github",
			get: async <T>(): Promise<ForgeResponse<T>> => {
				throw new Error("unexpected GET");
			},
			getPage: async <T>(): Promise<{ body: T; next: string | null }> => ({
				body: {
					check_runs: [{ id: 77, external_id: fixture.dedupeKey }],
				} as T,
				next: null,
			}),
			paginate: async <T>(): Promise<T[]> => {
				throw new Error("unexpected pagination");
			},
			write: async <T>(
				method: "POST" | "PATCH" | "PUT" | "DELETE",
				path: string,
				body?: unknown,
			): Promise<ForgeResponse<T>> => {
				writes.push({ method, path, body });
				return { status: 200, data: { id: 77 } as T, link: null, rateRemaining: 100 };
			},
		} as unknown as ForgeClient;

		const summary = await new GitHubPublisher(db, client, { now: () => at, backoffMs: 0 }).run();
		expect(summary.deduped).toBe(1);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.method).toBe("PATCH");
		expect(writes[0]?.path).toBe(`/repos/${fixture.repository}/check-runs/77`);
		expect(await readPosting(db, fixture.postingId)).toMatchObject({
			status: "posted",
			attempts: 1,
			externalRef: "77",
			postedAt: at,
		});
	});
});

test("a missing job has no synthetic check posting", async () => {
	await withTestDb(async (db) => {
		const before = await db.select().from(githubPostings);
		const outcome: RedriveOutcome = await redriveFailedCheck(db, 999999, at);
		expect(outcome).toEqual({ status: "not-found", jobId: 999999 });
		expect(await db.select().from(githubPostings)).toEqual(before);
	});
});
