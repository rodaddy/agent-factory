/**
 * @module tests/observability/postings-absence-alert
 * @description sf#605 (605d): a lane that dispatched past the window and posted
 *   nothing raises ONE `[monitoring-critical]` alert, deduped across passes.
 *   NO NETWORK: the target's client is a recording fake, and the forge WRITE is
 *   what is asserted, because `raiseCriticalAlert` never throws.
 */
import { describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../../src/config/schema";
import type { WatcherDb } from "../../src/db/client";
import { forgeRuns, githubPostings, jobAttempts, jobs, repositories } from "../../src/db/schema";
import type { ForgeClient, ForgePage, ForgeResponse } from "../../src/forge/boundary";
import { settleRunById } from "../../src/forge/actions-store";
import { type DueRun, settleForgeRuns } from "../../src/forge/settle-runs";
import type { CriticalAlertTarget } from "../../src/observability/critical-alert";
import {
	postingsAbsenceAlertClass,
	runPostingsAbsenceAlert,
} from "../../src/observability/postings-absence-alert";
import { withTestDb } from "../db/helpers";

const NOW = new Date("2026-09-24T11:00:00Z");
const OLD = new Date("2026-09-24T10:05:00Z"); // 55 min before NOW: past the 30 min window
const RECENT = new Date("2026-09-24T10:50:00Z"); // 10 min before NOW: inside the window
const CONFIG = {} as WatcherConfig;

/** The same recording fake the build-bump alert tests use: getPage + write only. */
function fakeTarget(): { target: CriticalAlertTarget; titles: string[]; bodies: string[] } {
	const bodies: string[] = [];
	const titles: string[] = [];
	const refuse = (verb: string) => () => {
		throw new Error(`${verb}() must not be called by the alert path`);
	};
	const client = {
		provider: "forgejo",
		get: refuse("get"),
		getPage: <T>(): Promise<ForgePage<T>> =>
			Promise.resolve({
				body: bodies.map((body, i) => ({ id: i + 1, number: i + 1, body })) as unknown as T,
				next: null,
			}),
		paginate: refuse("paginate"),
		write: <T>(_method: string, _path: string, body?: unknown): Promise<ForgeResponse<T>> => {
			const payload = body as { title?: string; body?: string };
			titles.push(payload.title ?? "");
			bodies.push(payload.body ?? "");
			return Promise.resolve({
				status: 201,
				data: { number: titles.length, id: titles.length } as unknown as T,
				link: null,
				rateRemaining: null,
			});
		},
		postCommitCheck: refuse("postCommitCheck"),
		findCommitCheck: refuse("findCommitCheck"),
	} as unknown as ForgeClient;
	return {
		target: { repository: "rodaddy/software-factory", client: () => Promise.resolve(client) },
		titles,
		bodies,
	};
}

async function seedJob(db: WatcherDb, startedAt: Date): Promise<number> {
	const [repo] = await db
		.insert(repositories)
		.values({ provider: "forgejo", fullName: "rodaddy/x" })
		.onConflictDoNothing()
		.returning();
	const repoId = repo?.id ?? (await db.select().from(repositories))[0]?.id;
	if (repoId === undefined) throw new Error("fixture repo not inserted");
	const [job] = await db
		.insert(jobs)
		.values({ repositoryId: repoId, jobType: "pr-review", sha: "a".repeat(40), status: "running" })
		.returning();
	if (!job) throw new Error("fixture job not inserted");
	await db.insert(jobAttempts).values({ jobId: job.id, status: "running", startedAt });
	return job.id;
}

async function postCheck(db: WatcherDb, jobId: number, postedAt: Date): Promise<void> {
	await db.insert(githubPostings).values({
		jobId,
		kind: "check",
		action: "upsert",
		target: "check",
		status: "posted",
		payload: JSON.stringify({ conclusion: "success" }),
		dedupeKey: `k-${jobId}`,
		postedAt,
	});
}

const clock = { now: NOW };

describe("runPostingsAbsenceAlert", () => {
	test("dispatched past the window with no posting raises one alert naming the lane", async () => {
		await withTestDb(async (db) => {
			await seedJob(db, OLD);
			await seedJob(db, RECENT);
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			expect(fake.titles).toHaveLength(1);
			expect(fake.titles[0]).toContain(postingsAbsenceAlertClass("pr-review"));
			expect(fake.bodies[0]).toContain("pr-review");
			expect(fake.bodies[0]).toContain(OLD.toISOString());
			expect(fake.bodies[0]).toContain("2 job(s)");
		});
	});

	test("dispatched past the window WITH a posting raises nothing", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJob(db, OLD);
			await db.insert(githubPostings).values({
				jobId,
				kind: "check",
				action: "upsert",
				target: "check",
				status: "posted",
				payload: JSON.stringify({ conclusion: "success" }),
				dedupeKey: `k-${jobId}`,
				postedAt: RECENT,
			});
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			expect(fake.titles).toEqual([]);
		});
	});

	test("an in-flight lane inside the window raises nothing", async () => {
		await withTestDb(async (db) => {
			await seedJob(db, RECENT);
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			expect(fake.titles).toEqual([]);
		});
	});

	test("the same state on a second pass does not raise a second issue", async () => {
		await withTestDb(async (db) => {
			await seedJob(db, OLD);
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			expect(fake.titles).toHaveLength(1);
		});
	});

	test("sf#901: a lane that posted once, then went silent past the window, alerts", async () => {
		await withTestDb(async (db) => {
			const first = await seedJob(db, new Date("2026-09-24T10:01:00Z"));
			await postCheck(db, first, new Date("2026-09-24T10:02:00Z"));
			await seedJob(db, OLD);
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			expect(fake.titles).toHaveLength(1);
			expect(fake.bodies[0]).toContain(`since ${OLD.toISOString()}`);
			expect(fake.bodies[0]).toContain("1 job(s)");
		});
	});

	test("sf#901: every older dispatch followed by a posting raises nothing", async () => {
		await withTestDb(async (db) => {
			const a = await seedJob(db, new Date("2026-09-24T10:01:00Z"));
			await postCheck(db, a, new Date("2026-09-24T10:02:00Z"));
			const b = await seedJob(db, OLD);
			await postCheck(db, b, RECENT);
			await seedJob(db, RECENT);
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			expect(fake.titles).toEqual([]);
		});
	});

	test("postings_absence_minutes widens the window", async () => {
		await withTestDb(async (db) => {
			await seedJob(db, OLD);
			const fake = fakeTarget();
			const wide = { postings_absence_minutes: 60 } as WatcherConfig;
			await runPostingsAbsenceAlert(db, fake.target, wide, clock);
			expect(fake.titles).toEqual([]);
		});
	});

	test("an old dispatched forge run alerts only for a workflow settleForgeRuns settles", async () => {
		for (const [workflow, alerts] of [
			["issue-triage.yml", 0],
			["prepush.yml", 1],
			["infra-static.yml", 1],
		] as const) {
			await withTestDb(async (db) => {
				await db.insert(forgeRuns).values({
					repo: "rodaddy/x",
					workflow,
					targetSha: "a".repeat(40),
					inputs: {},
					dispatchedAt: OLD,
				});
				const fake = fakeTarget();
				await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
				expect(fake.titles).toHaveLength(alerts);
			});
		}
	});

	test("sf#1274: a pr-review run that settles from an `error` status still alerts; `failure` does not", async () => {
		for (const [state, alerts] of [
			["error", 1],
			["failure", 0],
		] as const) {
			await withTestDb(async (db) => {
				const inputs = { repo: "rodaddy/x", head_sha: "a".repeat(40) };
				const [row] = await db
					.insert(forgeRuns)
					.values({
						repo: "rodaddy/software-factory",
						workflow: "pr-review.yml",
						targetSha: "b".repeat(40),
						inputs,
						dispatchedAt: OLD,
					})
					.returning();
				if (!row) throw new Error("fixture forge run not inserted");
				const due: DueRun = {
					id: row.id,
					repo: row.repo,
					workflow: row.workflow,
					targetSha: row.targetSha,
					inputs,
					dispatchedAt: OLD,
				};
				await settleForgeRuns({
					listDue: async () => [due],
					readStatuses: async () => [
						{
							id: 1,
							context: "factory/pr-review",
							status: state,
							description: "pr-review: the job ended without publishing",
							created_at: "2026-09-24T10:06:00Z",
						},
					],
					settle: (id, s) => settleRunById(db, id, s),
					touch: async () => 0,
				});
				const fake = fakeTarget();
				await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
				if (alerts === 0) expect(fake.titles).toEqual([]);
				else {
					expect(fake.titles).toHaveLength(1);
					expect(fake.titles[0]).toContain(postingsAbsenceAlertClass("pr-review.yml"));
				}
			});
		}
	});

	test("a silent dispatch from before this process started still alerts (default clock)", async () => {
		await withTestDb(async (db) => {
			await seedJob(db, new Date(Date.now() - 2 * 60 * 60_000));
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG);
			expect(fake.titles).toHaveLength(1);
		});
	});

	test("a silent dispatch older than the 24 h lookback raises nothing", async () => {
		await withTestDb(async (db) => {
			await seedJob(db, new Date(NOW.getTime() - 25 * 60 * 60_000));
			const fake = fakeTarget();
			await runPostingsAbsenceAlert(db, fake.target, CONFIG, clock);
			expect(fake.titles).toEqual([]);
		});
	});
});
