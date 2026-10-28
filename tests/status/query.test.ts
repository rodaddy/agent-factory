import { describe, expect, test } from "bun:test";
import {
	buildBumpBumps,
	buildBumpCandidates,
	buildBumpMarkers,
	githubItems,
	jobAttempts,
	jobs,
	reconciliationCursors,
	repositories,
} from "../../src/db/schema";
import { ITEM_REAPED_TERMINAL_REASON } from "../../src/reconcile/dispatch-pass";
import { getStatus } from "../../src/status/query";
import { withTestDb } from "../db/helpers";

const NOW = "2026-07-19T18:00:00Z";

/** Insert a repository and return its id. */
async function seedRepo(
	db: Parameters<Parameters<typeof withTestDb>[0]>[0],
	name: string,
	checks = "standard",
): Promise<number> {
	const [row] = await db.insert(repositories).values({ fullName: name, checks }).returning();
	if (!row) throw new Error("seed failed");
	return row.id;
}

describe("getStatus", () => {
	test("empty database yields no repositories", async () => {
		await withTestDb(async (db) => {
			const status = await getStatus(db, NOW);
			expect(status.repositories).toEqual([]);
			expect(status.generatedAt).toBe(NOW);
		});
	});

	test("healthy repo reports counts and last sweep", async () => {
		await withTestDb(async (db) => {
			const id = await seedRepo(db, "rodaddy/x");
			await db.insert(githubItems).values([
				{ repositoryId: id, kind: "issue", number: 1, state: "open", title: "i" },
				{ repositoryId: id, kind: "pull", number: 2, state: "open", title: "p" },
			]);
			await db.insert(jobs).values({
				repositoryId: id,
				sha: "abc",
				jobType: "pr-review",
				status: "pending",
			});
			await db.insert(jobs).values({
				repositoryId: id,
				sha: "def",
				jobType: "pr-review",
				status: "completed",
			});
			await db.insert(reconciliationCursors).values({
				repositoryId: id,
				resource: "issues",
				cursor: "2026-07-19T17:55:00Z",
			});

			const status = await getStatus(db, NOW);
			const repo = status.repositories[0];
			expect(repo?.issueCount).toBe(1);
			expect(repo?.pullCount).toBe(1);
			expect(repo?.jobsPending).toBe(1);
			expect(repo?.jobsCompleted).toBe(1);
			expect(repo?.lastSweep).toBe("2026-07-19T17:55:00Z");
			expect(repo?.lastError).toBeNull();
		});
	});

	test("degraded repo reports failed jobs and a bounded last error", async () => {
		await withTestDb(async (db) => {
			const id = await seedRepo(db, "rodaddy/x");
			const [job] = await db
				.insert(jobs)
				.values({ repositoryId: id, sha: "abc", jobType: "pr-review", status: "failed" })
				.returning();
			if (!job) throw new Error("seed failed");
			await db.insert(jobAttempts).values({
				jobId: job.id,
				status: "failed",
				failureSummary: "runner timed out",
			});

			const status = await getStatus(db, NOW);
			expect(status.repositories[0]?.jobsFailed).toBe(1);
			expect(status.repositories[0]?.lastError).toBe("runner timed out");
		});
	});

	test("bounds an overlong error summary", async () => {
		await withTestDb(async (db) => {
			const id = await seedRepo(db, "rodaddy/x");
			const [job] = await db
				.insert(jobs)
				.values({ repositoryId: id, sha: "abc", jobType: "pr-review", status: "failed" })
				.returning();
			if (!job) throw new Error("seed failed");
			await db.insert(jobAttempts).values({
				jobId: job.id,
				status: "failed",
				failureSummary: "x".repeat(500),
			});

			const status = await getStatus(db, NOW);
			const err = status.repositories[0]?.lastError ?? "";
			expect(err.length).toBeLessThanOrEqual(200);
			expect(err.endsWith("...")).toBe(true);
		});
	});

	test("idle repo (never swept) has a null last sweep", async () => {
		await withTestDb(async (db) => {
			await seedRepo(db, "rodaddy/x");
			const status = await getStatus(db, NOW);
			expect(status.repositories[0]?.lastSweep).toBeNull();
		});
	});
});

describe("getStatus — traced attempts", () => {
	/** Seed a job with two attempts: one traced, one not. Returns both ids. */
	async function seedTracedJob(
		db: Parameters<Parameters<typeof withTestDb>[0]>[0],
		repoId: number,
	): Promise<{ traced: number; untraced: number }> {
		const [job] = await db
			.insert(jobs)
			.values({ repositoryId: repoId, sha: "cafe", jobType: "issue-triage", status: "completed" })
			.returning();
		if (!job) throw new Error("seed failed");
		const [untraced] = await db
			.insert(jobAttempts)
			.values({ jobId: job.id, runnerJobId: "rw-untraced", status: "failed" })
			.returning({ id: jobAttempts.id });
		const [traced] = await db
			.insert(jobAttempts)
			.values({
				jobId: job.id,
				runnerJobId: "rw-traced",
				status: "completed",
				traceId: "attempt-2-runner-1",
			})
			.returning({ id: jobAttempts.id });
		if (!traced || !untraced) throw new Error("seed failed");
		return { traced: traced.id, untraced: untraced.id };
	}

	test("THE IMPORTANT ONE: a traced attempt yields its trace id, lane, and repository", async () => {
		// The #184 acceptance property: pick an attempt in the db, one query yields
		// what is needed to reach the trace. Everything but the base URL comes from
		// here — the host itself never touches this snapshot.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			const { traced } = await seedTracedJob(db, repoId);
			const status = await getStatus(db, NOW);
			expect(status.tracedAttempts).toHaveLength(1);
			const row = status.tracedAttempts[0];
			expect(row?.attemptId).toBe(traced);
			expect(row?.traceId).toBe("attempt-2-runner-1");
			expect(row?.jobType).toBe("issue-triage");
			expect(row?.repository).toBe("rodaddy/x");
			expect(row?.startedAt).not.toBeNull();
		});
	});

	test("an attempt with NO trace id is excluded, not reported with a null", async () => {
		// Guards the assertion above from passing for the wrong reason: selecting
		// every attempt would put untraceable rows on the page with a dead link
		// column, and `toHaveLength(1)` above is what proves the filter runs.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			const { untraced } = await seedTracedJob(db, repoId);
			const status = await getStatus(db, NOW);
			expect(status.tracedAttempts.map((a) => a.attemptId)).not.toContain(untraced);
		});
	});

	test("a watcher that has traced nothing reports an empty list, never undefined", async () => {
		await withTestDb(async (db) => {
			await seedRepo(db, "rodaddy/x");
			const status = await getStatus(db, NOW);
			expect(status.tracedAttempts).toEqual([]);
		});
	});

	test("NO Langfuse host reaches the snapshot — /status.json stays ids-only", async () => {
		// The snapshot is what `/status.json` serves, and JSON is the shape that gets
		// scraped and pasted. The base URL is applied in the RENDERER and nowhere
		// else, so nothing here may look like a URL.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			await seedTracedJob(db, repoId);
			const status = await getStatus(db, NOW);
			const json = JSON.stringify(status.tracedAttempts);
			expect(json).not.toContain("http://");
			expect(json).not.toContain("https://");
		});
	});
});

describe("getStatus — the trace filter runs in SQL, before the limit", () => {
	test("THE IMPORTANT ONE: 25 newer untraced attempts do not hide the traced one", async () => {
		// The filter is not decoration and not redundant with the null-narrowing in
		// the mapper. `LIMIT` applies in SQL, BEFORE any mapping: without the
		// `IS NOT NULL` predicate the newest 20 rows are all untraced, every one is
		// dropped by the narrowing, and the page shows an EMPTY traced-attempts
		// section while the traced row sits in the table. Filtering after the limit
		// is the classic shape of this bug, and it is invisible on a small fixture —
		// which is why this test seeds past the limit.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repoId,
					sha: "cafe",
					jobType: "issue-triage",
					status: "completed",
				})
				.returning();
			if (!job) throw new Error("seed failed");
			// Inserted FIRST, so every untraced attempt below has a higher id and
			// sorts ahead of it under the newest-first order.
			const [traced] = await db
				.insert(jobAttempts)
				.values({
					jobId: job.id,
					runnerJobId: "rw-traced-old",
					status: "completed",
					traceId: "attempt-old-runner-1",
				})
				.returning({ id: jobAttempts.id });
			if (!traced) throw new Error("seed failed");
			await db.insert(jobAttempts).values(
				Array.from({ length: 25 }, (_, i) => ({
					jobId: job.id,
					runnerJobId: `rw-untraced-${i}`,
					status: "failed",
				})),
			);

			const status = await getStatus(db, NOW);
			expect(status.tracedAttempts).toHaveLength(1);
			expect(status.tracedAttempts[0]?.attemptId).toBe(traced.id);
		});
	});
});

describe("getStatus — reaper-health gauges", () => {
	/** Seed one job, optionally bound to an item, with explicit column values. */
	async function seedJob(
		db: Parameters<Parameters<typeof withTestDb>[0]>[0],
		values: Record<string, unknown>,
	): Promise<number> {
		const [row] = await db
			.insert(jobs)
			.values(values as never)
			.returning({ id: jobs.id });
		if (!row) throw new Error("seed failed");
		return row.id;
	}

	test("THE IMPORTANT ONE: a pending job whose item is CLOSED counts as a zombie", async () => {
		// The sf#444 starvation shape: the row is `pending` forever because the item
		// it binds to can never become eligible again. Should be 0 while sf#481's
		// dispatch-time reap holds; a non-zero reading is the queue starving.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			const [closed] = await db
				.insert(githubItems)
				.values({ repositoryId: repoId, kind: "issue", number: 7, state: "closed" })
				.returning({ id: githubItems.id });
			if (!closed) throw new Error("seed failed");
			await seedJob(db, {
				repositoryId: repoId,
				itemId: closed.id,
				sha: "abc",
				jobType: "issue-triage",
				status: "pending",
			});

			const status = await getStatus(db, NOW);
			expect(status.zombiePending).toBe(1);
		});
	});

	test("an OPEN item's pending job is not a zombie, and neither is an item-less one", async () => {
		// Guards the count above from passing for the wrong reason: a query that
		// forgot the state predicate, or one that used an inner join and swept every
		// pending row, would both report 2 here.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			const [open] = await db
				.insert(githubItems)
				.values({ repositoryId: repoId, kind: "issue", number: 8, state: "open" })
				.returning({ id: githubItems.id });
			if (!open) throw new Error("seed failed");
			await seedJob(db, {
				repositoryId: repoId,
				itemId: open.id,
				sha: "abc",
				jobType: "issue-triage",
				status: "pending",
			});
			await seedJob(db, {
				repositoryId: repoId,
				sha: "def",
				jobType: "repo-validate",
				status: "pending",
			});

			const status = await getStatus(db, NOW);
			expect(status.zombiePending).toBe(0);
		});
	});

	test("a CLOSED item's job that is no longer pending is not a zombie", async () => {
		// What sf#481 leaves behind: the reap terminalizes the row to `failed`, so
		// the gauge must fall back to 0 rather than counting the reaped history.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			const [closed] = await db
				.insert(githubItems)
				.values({ repositoryId: repoId, kind: "issue", number: 9, state: "closed" })
				.returning({ id: githubItems.id });
			if (!closed) throw new Error("seed failed");
			await seedJob(db, {
				repositoryId: repoId,
				itemId: closed.id,
				sha: "abc",
				jobType: "issue-triage",
				status: "failed",
			});

			const status = await getStatus(db, NOW);
			expect(status.zombiePending).toBe(0);
		});
	});

	test("THE IMPORTANT ONE: the oldest DUE pending job's age is reported in minutes", async () => {
		// A queue that is not moving shows up here before it shows up anywhere else:
		// the oldest due row keeps ageing while dispatch never reaches it.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			const nowMs = Date.parse(NOW);
			await seedJob(db, {
				repositoryId: repoId,
				sha: "old",
				jobType: "issue-triage",
				status: "pending",
				nextAttemptAt: new Date(nowMs - 30 * 60_000),
			});
			await seedJob(db, {
				repositoryId: repoId,
				sha: "new",
				jobType: "issue-triage",
				status: "pending",
				nextAttemptAt: new Date(nowMs - 5 * 60_000),
			});

			const status = await getStatus(db, NOW);
			// Tolerant range, never an exact clock value.
			expect(status.oldestDuePendingMinutes).toBeGreaterThanOrEqual(29);
			expect(status.oldestDuePendingMinutes).toBeLessThanOrEqual(31);
		});
	});

	test("a NULL next_attempt_at pending job is DUE — dispatch treats it that way", async () => {
		// dispatch-pass.ts selects due rows with (next_attempt_at IS NULL OR <= now),
		// so a newly created pending job with a NULL retry time is immediately due;
		// the gauge must age it from created_at or the starvation signal has a hole.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			await seedJob(db, {
				repositoryId: repoId,
				sha: "nullslot",
				jobType: "issue-triage",
				status: "pending",
				nextAttemptAt: null,
				createdAt: new Date(Date.parse(NOW) - 45 * 60_000),
			});

			const status = await getStatus(db, NOW);
			expect(status.oldestDuePendingMinutes).toBeGreaterThanOrEqual(44);
			expect(status.oldestDuePendingMinutes).toBeLessThanOrEqual(46);
		});
	});

	test("a pending job whose next attempt is in the FUTURE is not due", async () => {
		// Backoff is not starvation. A row deferred forward is working as designed,
		// and reporting its (negative) age as the queue's oldest would be a lie.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			await seedJob(db, {
				repositoryId: repoId,
				sha: "later",
				jobType: "issue-triage",
				status: "pending",
				nextAttemptAt: new Date(Date.parse(NOW) + 30 * 60_000),
			});

			const status = await getStatus(db, NOW);
			expect(status.oldestDuePendingMinutes).toBeNull();
		});
	});

	test("no due pending job at all yields null, never 0", async () => {
		// 0 would read as "the queue is perfectly fresh", which is the opposite claim
		// from "there is nothing in the queue".
		await withTestDb(async (db) => {
			await seedRepo(db, "rodaddy/x");
			const status = await getStatus(db, NOW);
			expect(status.oldestDuePendingMinutes).toBeNull();
		});
	});

	test("THE IMPORTANT ONE: a job reaped inside the window counts in reapedLastSweep", async () => {
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			await seedJob(db, {
				repositoryId: repoId,
				sha: "abc",
				jobType: "issue-triage",
				status: "failed",
				terminalReason: ITEM_REAPED_TERMINAL_REASON,
				updatedAt: new Date(Date.parse(NOW) - 5 * 60_000),
			});

			const status = await getStatus(db, NOW);
			expect(status.reapedLastSweep).toBe(1);
		});
	});

	test("a job reaped OUTSIDE the window does not count", async () => {
		// The gauge answers "is the reaper firing right now", so an hour-old reap
		// must fall out of it — otherwise the number only ever grows and stops
		// meaning anything.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			await seedJob(db, {
				repositoryId: repoId,
				sha: "abc",
				jobType: "issue-triage",
				status: "failed",
				terminalReason: ITEM_REAPED_TERMINAL_REASON,
				updatedAt: new Date(Date.parse(NOW) - 60 * 60_000),
			});

			const status = await getStatus(db, NOW);
			expect(status.reapedLastSweep).toBe(0);
		});
	});

	test("a job terminalized for a DIFFERENT reason does not count", async () => {
		// Guards the count from matching on recency alone: only the sf#481 reap's own
		// terminal reason is a reap.
		await withTestDb(async (db) => {
			const repoId = await seedRepo(db, "rodaddy/x");
			await seedJob(db, {
				repositoryId: repoId,
				sha: "abc",
				jobType: "issue-triage",
				status: "failed",
				terminalReason: "terminal: something else entirely",
				updatedAt: new Date(Date.parse(NOW) - 5 * 60_000),
			});

			const status = await getStatus(db, NOW);
			expect(status.reapedLastSweep).toBe(0);
		});
	});
});

/**
 * The §8 `/status.json` field: per enrolled (repository, image, environment),
 * what the promotion rule currently wants and what the last attempt to reach it
 * did.
 *
 * The enrolment blocks are an INPUT, so these tests declare two literal config
 * entries rather than constructing a whole valid watcher config — the query reads
 * only `name` and `build_bump`, and the schema's own invariants are pinned by the
 * config suite.
 */
describe("getStatus buildBump", () => {
	/** Seed one candidate row and return its id. */
	async function seedCandidate(
		db: Parameters<Parameters<typeof withTestDb>[0]>[0],
		values: {
			repository: string;
			tag: string;
			sha: string;
			image: string;
			status: string;
			tagCreatedAt?: Date;
		},
	): Promise<number> {
		const [row] = await db.insert(buildBumpCandidates).values(values).returning();
		if (!row) throw new Error("seed failed");
		return row.id;
	}

	test("a tag environment and a marker environment each report their own desired tag", async () => {
		await withTestDb(async (db) => {
			// Two versions; the marker is placed on the OLDER one, which per the
			// 2026-09-11 ruling is a legitimate deploy of that older version — so the
			// two environments must NOT report the same tag.
			const older = await seedCandidate(db, {
				repository: "acme/acme-ai",
				tag: "v0.2.57",
				sha: "a".repeat(40),
				image: "acme-portal",
				status: "built",
				tagCreatedAt: new Date("2026-09-01T00:00:00Z"),
			});
			await seedCandidate(db, {
				repository: "acme/acme-ai",
				tag: "v0.3.0",
				sha: "b".repeat(40),
				image: "acme-portal",
				status: "built",
				tagCreatedAt: new Date("2026-09-10T00:00:00Z"),
			});
			await db.insert(buildBumpMarkers).values({
				repository: "acme/acme-ai",
				marker: "prod",
				sha: "a".repeat(40),
			});
			await db.insert(buildBumpBumps).values({
				candidateId: older,
				appDir: "acme-portal-prod",
				status: "opened",
				pr: 412,
				reason: null,
				attempts: 1,
			});

			const status = await getStatus(db, NOW, {
				buildBumpRepositories: [
					{
						name: "acme/acme-ai",
						build_bump: {
							images: [
								{
									name: "acme-portal",
									environments: [
										{ name: "uat", app_dirs: ["acme-portal-uat"] },
										{ name: "prod", app_dirs: ["acme-portal-prod"] },
									],
								},
							],
						},
					},
				],
			});

			expect(status.buildBump).toEqual([
				{
					repository: "acme/acme-ai",
					image: "acme-portal",
					environment: "uat",
					// The version-tag stream: newest by COMMIT DATE, not by row id.
					desiredTag: "v0.3.0",
					markerSha: null,
					lastPr: null,
					lastOutcome: null,
					attempts: 0,
				},
				{
					repository: "acme/acme-ai",
					image: "acme-portal",
					environment: "prod",
					// The marker's commit, which is the OLDER version.
					desiredTag: "v0.2.57",
					markerSha: "a".repeat(40),
					lastPr: 412,
					lastOutcome: null,
					attempts: 1,
				},
			]);
		});
	});

	test("a build-only enrolment contributes no entry", async () => {
		await withTestDb(async (db) => {
			const status = await getStatus(db, NOW, {
				buildBumpRepositories: [{ name: "rodaddy/rtech-mcps", build_bump: {} }],
			});
			expect(status.buildBump).toEqual([]);
		});
	});

	test("no enrolment blocks yields an empty list rather than a missing field", async () => {
		await withTestDb(async (db) => {
			const status = await getStatus(db, NOW);
			expect(status.buildBump).toEqual([]);
		});
	});

	/**
	 * The gauge §8 alerts on. A pair failing repeatedly opens no PR, so `lastPr`
	 * stays null while `attempts` climbs — that pairing IS the stuck signature.
	 */
	test("a failing pair reports its fixed reason and climbing attempts, with no PR", async () => {
		await withTestDb(async (db) => {
			const id = await seedCandidate(db, {
				repository: "rodaddy/mcp2cli",
				tag: "v2.0.0",
				sha: "c".repeat(40),
				image: "mcp2cli",
				status: "built",
				tagCreatedAt: new Date("2026-09-11T00:00:00Z"),
			});
			await db.insert(buildBumpBumps).values({
				candidateId: id,
				appDir: "mcp2cli",
				status: "pending",
				reason: "UNKNOWN_ARGUMENT",
				attempts: 4,
			});

			const status = await getStatus(db, NOW, {
				buildBumpRepositories: [
					{
						name: "rodaddy/mcp2cli",
						build_bump: { environments: [{ name: "live", app_dirs: ["mcp2cli"] }] },
					},
				],
			});

			expect(status.buildBump).toEqual([
				{
					repository: "rodaddy/mcp2cli",
					image: "mcp2cli",
					environment: "live",
					desiredTag: "v2.0.0",
					markerSha: null,
					lastPr: null,
					lastOutcome: "UNKNOWN_ARGUMENT",
					attempts: 4,
				},
			]);
		});
	});

	/**
	 * An UNBUILT candidate is not desired: the environment cannot receive an image
	 * that does not exist. Reporting the tag anyway would show an operator a
	 * desired state the lane is deliberately not driving toward.
	 */
	test("a candidate that has not built yet is not the desired tag", async () => {
		await withTestDb(async (db) => {
			await seedCandidate(db, {
				repository: "rodaddy/mcp2cli",
				tag: "v2.1.0",
				sha: "d".repeat(40),
				image: "mcp2cli",
				status: "pending",
				tagCreatedAt: new Date("2026-09-11T00:00:00Z"),
			});

			const status = await getStatus(db, NOW, {
				buildBumpRepositories: [
					{
						name: "rodaddy/mcp2cli",
						build_bump: { environments: [{ name: "live", app_dirs: ["mcp2cli"] }] },
					},
				],
			});

			expect(status.buildBump?.[0]?.desiredTag).toBeNull();
			expect(status.buildBump?.[0]?.attempts).toBe(0);
		});
	});

	/**
	 * THE INVISIBLE STATE. A marker on a candidate whose build fails permanently
	 * is re-queued every pass forever and creates no pair row, so this view used
	 * to report it as all-nulls — identical to an environment nobody had marked —
	 * while the lane spent one Kaniko Job per cycle. The tag, the `unbuilt:`
	 * outcome, and the requeue count are what distinguish the two readings.
	 */
	test("a marker on a candidate that will not build reports the tag and its unbuilt outcome", async () => {
		await withTestDb(async (db) => {
			await db.insert(buildBumpCandidates).values({
				repository: "rodaddy/web-bb-landing",
				tag: "v1.4.0",
				sha: "f".repeat(40),
				image: "web-bb-landing",
				status: "failed",
				requeues: 3,
				buildReason: "BackoffLimitExceeded",
				tagCreatedAt: new Date("2026-09-11T00:00:00Z"),
			});
			await db.insert(buildBumpMarkers).values({
				repository: "rodaddy/web-bb-landing",
				marker: "prod",
				sha: "f".repeat(40),
			});

			const status = await getStatus(db, NOW, {
				buildBumpRepositories: [
					{
						name: "rodaddy/web-bb-landing",
						build_bump: {
							environments: [
								{ name: "uat", app_dirs: ["bb-landing-uat"] },
								{ name: "prod", app_dirs: ["bb-landing"] },
							],
						},
					},
				],
			});

			const prod = status.buildBump?.find((entry) => entry.environment === "prod");
			expect(prod?.desiredTag).toBe("v1.4.0");
			expect(prod?.lastOutcome).toBe("unbuilt: failed: BackoffLimitExceeded");
			expect(prod?.attempts).toBe(3);
			expect(prod?.markerSha).toBe("f".repeat(40));
			// The version-tag environment is unaffected: nothing built, nothing desired.
			const uat = status.buildBump?.find((entry) => entry.environment === "uat");
			expect(uat?.desiredTag).toBeNull();
			expect(uat?.lastOutcome).toBeNull();
		});
	});

	/**
	 * A marker on a commit no version tag carries is a MISPLACED marker, and it
	 * must not read as the unplaced one below. No candidate matches, so there is
	 * no desired tag — but the sha is known, and reporting it with an `unmatched:`
	 * outcome is the whole difference between "somebody marked the wrong commit"
	 * and "nobody has marked anything".
	 */
	test("a marker matching no candidate reports its sha and an unmatched outcome", async () => {
		await withTestDb(async (db) => {
			await seedCandidate(db, {
				repository: "rodaddy/web-bb-landing",
				tag: "v1.0.0",
				sha: "e".repeat(40),
				image: "web-bb-landing",
				status: "built",
				tagCreatedAt: new Date("2026-09-11T00:00:00Z"),
			});
			// The marker points at a commit no candidate for this image carries.
			await db.insert(buildBumpMarkers).values({
				repository: "rodaddy/web-bb-landing",
				marker: "prod",
				sha: "c".repeat(40),
			});

			const status = await getStatus(db, NOW, {
				buildBumpRepositories: [
					{
						name: "rodaddy/web-bb-landing",
						build_bump: {
							environments: [
								{ name: "uat", app_dirs: ["bb-landing-uat"] },
								{ name: "prod", app_dirs: ["bb-landing"] },
							],
						},
					},
				],
			});

			const prod = status.buildBump?.find((entry) => entry.environment === "prod");
			expect(prod?.markerSha).toBe("c".repeat(40));
			expect(prod?.lastOutcome).toStartWith("unmatched:");
			expect(prod?.desiredTag).toBeNull();
			expect(prod?.lastPr).toBeNull();
			expect(prod?.attempts).toBe(0);
		});
	});

	/**
	 * A marker that has never been placed is the NORMAL quiet state for a later
	 * environment, not a fault: nothing desired, and nothing to report but nulls.
	 */
	test("an unplaced marker desires nothing", async () => {
		await withTestDb(async (db) => {
			await seedCandidate(db, {
				repository: "rodaddy/web-bb-landing",
				tag: "v1.0.0",
				sha: "e".repeat(40),
				image: "web-bb-landing",
				status: "built",
				tagCreatedAt: new Date("2026-09-11T00:00:00Z"),
			});

			const status = await getStatus(db, NOW, {
				buildBumpRepositories: [
					{
						name: "rodaddy/web-bb-landing",
						build_bump: {
							environments: [
								{ name: "uat", app_dirs: ["bb-landing-uat"] },
								{ name: "prod", app_dirs: ["bb-landing"] },
							],
						},
					},
				],
			});

			const prod = status.buildBump?.find((entry) => entry.environment === "prod");
			expect(prod?.desiredTag).toBeNull();
			expect(prod?.markerSha).toBeNull();
		});
	});
});

describe("getStatus — repository ordering is TOTAL", () => {
	test("orders duplicate-name rows by id, so the sequence is deterministic", async () => {
		await withTestDb(async (db) => {
			// `fullName` is not unique: live 2026-09-17 four names each had two rows
			// (`rtech/rtech-infra`, `rodaddy/software-factory`, `rodaddy/mcp2cli`,
			// `rodaddy/rtech-mcps`). Postgres leaves the order of EQUAL sort keys
			// undefined, so ordering by name alone lets two rows swap between reads.
			// `/metrics` breaks a `lastSweep` tie positionally, so an unstable
			// position would flap the metric and an alert would read that as a real
			// state change.
			// Uniqueness is PROVIDER-qualified, so a duplicate name is legal only
			// across forges -- which is exactly the live shape: the same repo under
			// `github` (frozen at the Forge flag day) and `forgejo` (live).
			const [gh] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/dup", provider: "github", checks: "standard" })
				.returning();
			await seedRepo(db, "rodaddy/aaa");
			const [fj] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/dup", provider: "forgejo", checks: "standard" })
				.returning();
			if (!gh || !fj) throw new Error("seed failed");

			const status = await getStatus(db, NOW);
			const names = status.repositories.map((r) => r.repository);

			expect(names).toEqual(["rodaddy/aaa", "rodaddy/dup", "rodaddy/dup"]);
			// HONEST LIMIT OF THIS TEST: it does NOT fail when `repositories.id` is
			// dropped from the `orderBy`. Mutation-checked 2026-09-17 -- removing it
			// leaves all 29 tests green, because Postgres happens to return these rows
			// in insertion order for a table this small. Undefined order is not random
			// order, and a single-node test cannot force the reordering that a seq
			// scan, an index choice, or a vacuum produces in production.
			//
			// So this asserts the CONTRACT (duplicate names come back ordered, and the
			// provider is exposed so a consumer can tell them apart) and documents the
			// reason the `orderBy` is total. The `orderBy` is correct because
			// `fullName` is not unique, not because this test proves it -- claiming
			// otherwise would be the "green test that proves nothing" trap.
			const dups = status.repositories.filter((r) => r.repository === "rodaddy/dup");
			expect(dups.map((r) => r.provider)).toEqual(["github", "forgejo"]);
			expect(gh.id).toBeLessThan(fj.id);
		});
	});
});
