import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import {
	githubItems,
	githubPostings,
	jobAttempts,
	jobs,
	repositories,
	resultPostings,
	runnerBoxes,
} from "../../src/db/schema";
import type { PersistedResult } from "../../src/results/ingest";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import {
	DbResultStore,
	IDENTITY_REJECTED_TERMINAL_REASON,
	INVALID_RESULT_IDENTITY,
} from "../../src/results/store";
import { RUNNER_BOXES } from "../../src/runner/bands";
import { withTestDb } from "../db/helpers";

const at = new Date("2026-07-19T12:00:00.000Z");

/** Seed a repo + running job + submitted attempt with the given runner job id. */
async function seedRunning(
	db: Parameters<Parameters<typeof withTestDb>[0]>[0],
	runnerJobId: string,
	options: { sha?: string; itemNumber?: number | null } = {},
) {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const itemNumber = options.itemNumber === undefined ? 7 : options.itemNumber;
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
						headSha: options.sha ?? "deadbeef",
					})
					.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha: options.sha ?? "deadbeef",
			jobType: "pr-review",
			status: "running",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	const [attempt] = await db
		.insert(jobAttempts)
		.values({ jobId: job.id, runnerJobId, runnerVmid: 9001, status: "submitted" })
		.returning({ id: jobAttempts.id });
	if (!attempt) throw new Error("seed failed");
	// The dispatch path sets `active_attempt_id` when an attempt claims the job;
	// a running job in production always has an owner. Seed it so the store's ownership
	// guard sees the attempt that OWNS this running job, mirroring real dispatch.
	await db.update(jobs).set({ activeAttemptId: attempt.id }).where(eq(jobs.id, job.id));
	return job;
}

/** Seed the box inventory, as `scripts/migrate.ts` does in production. */
async function seedBoxes(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
	await db.insert(runnerBoxes).values(
		RUNNER_BOXES.map((box) => ({
			vmid: box.vmid,
			band: box.band,
			mac: box.mac,
			ip: box.ip,
			allocatable: box.allocatable,
		})),
	);
}

const passingResult: RunnerResult = {
	result_version: RESULT_VERSION,
	repository: "rodaddy/x",
	job_type: "pr-review",
	item_number: 7,
	sha: "deadbeef",
	status: "passed",
	checks: [],
	findings: [],
	output_path: "runners/jobs/rw-1/host/agent.log",
};

describe("DbResultStore", () => {
	test("ingested pass: job -> completed, posting accepted, attempt completed", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-1");
			const store = new DbResultStore(db, () => at);
			const record: PersistedResult = {
				jobRunnerId: "rw-1",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			};
			await store.persist(record);

			const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(j?.status).toBe("completed");
			const [p] = await db.select().from(resultPostings).where(eq(resultPostings.jobId, job.id));
			// #90: the posting that transitioned the job is promoted to `accepted` in
			// the same transaction — this is what the candidate loader binds to.
			expect(p?.status).toBe("accepted");
			expect(p?.target).toBe("runner:host1:rw-1");
			expect(p?.outputPath).toContain("agent.log");
			const [a] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
			expect(a?.status).toBe("completed");
		});
	});

	// #79/#80: the claim must be cleared in the SAME transaction that finishes the
	// attempt, or `runner_boxes` reports a box as held by a job that already
	// finished — a false leak, which is what makes a real leak easy to dismiss.
	test("a terminal attempt releases its pool claim", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-held");
			await seedBoxes(db);
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-held", heldAt: at })
				.where(eq(runnerBoxes.vmid, 9001));

			const store = new DbResultStore(db, () => at);
			await store.persist({
				jobRunnerId: "rw-held",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			});

			const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(j?.status).toBe("completed");
			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			expect(box?.heldByJobId).toBeNull();
			expect(box?.heldAt).toBeNull();
		});
	});

	test("a stale attempt does NOT steal a claim a newer attempt holds", async () => {
		// A re-dispatched job can put a NEWER attempt on the same vmid. If the stale
		// attempt's result cleared that claim, a live box would go unattributed — the
		// exact harm the claim exists to prevent. The release is scoped to the runner
		// job id that actually holds it.
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-stale");
			await seedBoxes(db);
			// A newer attempt on the same box, holding the claim under its own id.
			await db
				.insert(jobAttempts)
				.values({ jobId: job.id, runnerJobId: "rw-fresh", runnerVmid: 9001, status: "submitted" });
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-fresh", heldAt: at })
				.where(eq(runnerBoxes.vmid, 9001));

			const store = new DbResultStore(db, () => at);
			await store.persist({
				jobRunnerId: "rw-stale",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			});

			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			// The live claim survives the stale attempt's result.
			expect(box?.heldByJobId).toBe("rw-fresh");
		});
	});

	test("invalid result: job -> failed, posting invalid", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-2");
			const store = new DbResultStore(db, () => at);
			await store.persist({
				jobRunnerId: "rw-2",
				hostname: "host1",
				status: "invalid",
				reason: "result.json is not valid JSON",
			});
			const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(j?.status).toBe("failed");
			const [p] = await db.select().from(resultPostings).where(eq(resultPostings.jobId, job.id));
			expect(p?.status).toBe("invalid");
			expect(p?.externalRef).toContain("JSON");
		});
	});

	test("idempotent: re-persisting the same DONE keeps one posting, stays terminal", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-3");
			const store = new DbResultStore(db, () => at);
			const record: PersistedResult = {
				jobRunnerId: "rw-3",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			};
			await store.persist(record);
			await store.persist(record); // restart reconciliation

			const postings = await db
				.select()
				.from(resultPostings)
				.where(eq(resultPostings.jobId, job.id));
			expect(postings.length).toBe(1); // upsert, not duplicate
			const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(j?.status).toBe("completed"); // still terminal, not re-transitioned

			// A later contradicting persist must NOT resurrect/re-transition the job
			// away from its terminal state (the running-only guard bites).
			await store.persist({
				jobRunnerId: "rw-3",
				hostname: "host1",
				status: "invalid",
				reason: "late contradicting report",
			});
			const [j2] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(j2?.status).toBe("completed"); // unchanged, not flipped to failed
		});
	});

	test("attempt-specific posting: a reused hostname does not overwrite another attempt's artifact", async () => {
		await withTestDb(async (db) => {
			// Attempt A ran, timed out; the job was re-dispatched under attempt B, which
			// happens to land on the SAME runner hostname (hostnames are reusable).
			const job = await seedRunning(db, "rw-reuse-A");
			const [b] = await db
				.insert(jobAttempts)
				.values({
					jobId: job.id,
					runnerJobId: "rw-reuse-B",
					runnerVmid: 9002,
					status: "submitted",
				})
				.returning({ id: jobAttempts.id });
			// B is the live re-dispatch, so it owns the job.
			await db.update(jobs).set({ activeAttemptId: b?.id }).where(eq(jobs.id, job.id));
			const store = new DbResultStore(db, () => at);

			// Attempt B (the live one) finishes first and records its posting.
			await store.persist({
				jobRunnerId: "rw-reuse-B",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: "runners/jobs/rw-reuse-B/host1/agent.log",
			});
			// Attempt A (stale, superseded) finally reports on the SAME hostname.
			await store.persist({
				jobRunnerId: "rw-reuse-A",
				hostname: "host1",
				status: "invalid",
				reason: "stale attempt A report",
			});

			// Two distinct postings: the reusable hostname is paired with runner job id,
			// so A's stale result cannot overwrite B's accepted artifact.
			const postings = await db
				.select()
				.from(resultPostings)
				.where(eq(resultPostings.jobId, job.id));
			expect(postings.length).toBe(2);
			const bPosting = postings.find((p) => p.target === "runner:host1:rw-reuse-B");
			// #90: B is the live owner and its passing result completed the job, so B's
			// posting is `accepted`; A's stale invalid report stays a distinct row.
			expect(bPosting?.status).toBe("accepted");
			expect(bPosting?.outputPath).toContain("rw-reuse-B");
		});
	});

	test("stale attempt: a superseded attempt's result never terminates the re-run", async () => {
		await withTestDb(async (db) => {
			// attempt A ran, timed out, job re-dispatched under attempt B (job running).
			// Ownership followed the re-dispatch: the reclaimer cleared A and B claimed,
			// so `active_attempt_id` is B's — the direct fact that A is superseded.
			const job = await seedRunning(db, "rw-A");
			const [b] = await db
				.insert(jobAttempts)
				.values({ jobId: job.id, runnerJobId: "rw-B", runnerVmid: 9002, status: "submitted" })
				.returning({ id: jobAttempts.id });
			await db.update(jobs).set({ activeAttemptId: b?.id }).where(eq(jobs.id, job.id));

			const store = new DbResultStore(db, () => at);
			// attempt A's original box finally reports DONE
			await store.persist({
				jobRunnerId: "rw-A",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			});

			// the live job (owned by attempt B) must NOT be terminated by A's result
			const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(j?.status).toBe("running");
			// A's own attempt is still recorded as finished + a posting exists
			const [a] = await db.select().from(jobAttempts).where(eq(jobAttempts.runnerJobId, "rw-A"));
			expect(a?.status).toBe("completed");
		});
	});

	// #85 / PR #86 review finding 5: results are per (job, host), so one attempt's
	// runner job id can receive more than one result. The attempt is finished ONCE —
	// the first terminal result wins and a later per-host result cannot flip it (e.g.
	// a `completed` attempt turned `failed` by a second host's invalid report).
	test("a later per-host result does NOT flip an already-finished attempt's status", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-two-host");
			const store = new DbResultStore(db, () => at);

			// First host lands a passing result: the attempt finishes `completed`.
			await store.persist({
				jobRunnerId: "rw-two-host",
				hostname: "host-a",
				status: "ingested",
				result: passingResult,
				outputPath: "runners/jobs/rw-two-host/host-a/agent.log",
			});
			const [a1] = await db
				.select()
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-two-host"));
			expect(a1?.status).toBe("completed");

			// A SECOND host under the same runner job id reports invalid afterward. It
			// must not overwrite the attempt's terminal `completed` with `failed`.
			await store.persist({
				jobRunnerId: "rw-two-host",
				hostname: "host-b",
				status: "invalid",
				reason: "second host invalid report",
			});
			const [a2] = await db
				.select()
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-two-host"));
			expect(a2?.status).toBe("completed");
			expect(a2?.failureSummary).toBeNull();
			// The job likewise stays completed (the running-only + ownership guard).
			const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(j?.status).toBe("completed");
		});
	});

	test("unknown runner job id: nothing to reconcile, no throw", async () => {
		await withTestDb(async (db) => {
			const store = new DbResultStore(db, () => at);
			await store.persist({
				jobRunnerId: "does-not-exist",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
			});
			const postings = await db.select().from(resultPostings);
			expect(postings.length).toBe(0);
		});
	});

	for (const testCase of [
		{ name: "repository mismatch", result: { repository: "attacker/other" } },
		{ name: "job_type mismatch", result: { job_type: "repo-validate" } },
		{ name: "SHA mismatch", result: { sha: "cafebabe" } },
		{ name: "missing result SHA", result: { sha: undefined } },
		{ name: "item-number mismatch", result: { item_number: 99 } },
		{ name: "missing result item number", result: { item_number: undefined } },
	] as const) {
		test(`${testCase.name}: generic invalid result, attempt/job failed`, async () => {
			await withTestDb(async (db) => {
				const runnerJobId = `rw-identity-${testCase.name.replaceAll(" ", "-")}`;
				const job = await seedRunning(db, runnerJobId);
				const store = new DbResultStore(db, () => at);
				const decision = await store.persist({
					jobRunnerId: runnerJobId,
					hostname: "host1",
					status: "ingested",
					result: { ...passingResult, ...testCase.result },
					outputPath: "attacker-controlled/path",
				});

				expect(decision).toEqual({ status: "invalid", reason: INVALID_RESULT_IDENTITY });
				const [persistedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
				expect(persistedJob?.status).toBe("failed");
				// sf#376: the rejection is deterministic in the payload, so the job is
				// terminalized with a reason and the infra requeue sweep will not revive it.
				expect(persistedJob?.terminalReason).toBe(IDENTITY_REJECTED_TERMINAL_REASON);
				const [attempt] = await db
					.select()
					.from(jobAttempts)
					.where(eq(jobAttempts.runnerJobId, runnerJobId));
				expect(attempt?.status).toBe("failed");
				expect(attempt?.failureSummary).toBe(INVALID_RESULT_IDENTITY);
				const [posting] = await db
					.select()
					.from(resultPostings)
					.where(eq(resultPostings.jobId, job.id));
				expect(posting?.status).toBe("invalid");
				expect(posting?.externalRef).toBe(INVALID_RESULT_IDENTITY);
				expect(posting?.outputPath).toBeNull();
				expect(JSON.stringify(posting)).not.toContain("attacker-controlled");
			});
		});
	}

	test("itemless, shaless job accepts an itemless, shaless result", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-itemless", { itemNumber: null, sha: "" });
			const { item_number: _itemNumber, sha: _sha, ...itemlessResult } = passingResult;
			const decision = await new DbResultStore(db, () => at).persist({
				jobRunnerId: "rw-itemless",
				hostname: "host1",
				status: "ingested",
				result: itemlessResult,
			});
			expect(decision).toBeUndefined();
			const [persistedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(persistedJob?.status).toBe("completed");
		});
	});

	test("shaless job rejects an unexpected result SHA", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-unexpected-sha", { itemNumber: null, sha: "" });
			const { item_number: _itemNumber, ...unexpectedShaResult } = passingResult;
			const decision = await new DbResultStore(db, () => at).persist({
				jobRunnerId: "rw-unexpected-sha",
				hostname: "host1",
				status: "ingested",
				result: unexpectedShaResult,
			});
			expect(decision?.status).toBe("invalid");
			const [persistedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(persistedJob?.status).toBe("failed");
		});
	});
});

describe("DbResultStore — atomic publication-plan creation", () => {
	test("accepting an ingested result queues bounded publication plans in one commit", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-plan");
			await new DbResultStore(db, () => at).persist({
				jobRunnerId: "rw-plan",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			});
			const plans = await db.select().from(githubPostings).where(eq(githubPostings.jobId, job.id));
			// labels + one comment + one check, all pending and bounded.
			expect(plans.length).toBeGreaterThan(0);
			expect(plans.some((p) => p.kind === "comment")).toBe(true);
			expect(plans.some((p) => p.kind === "check")).toBe(true);
			for (const p of plans) expect(p.status).toBe("pending");
		});
	});

	test("re-ingest does not duplicate publication plans", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-plan-dup");
			const store = new DbResultStore(db, () => at);
			const record: PersistedResult = {
				jobRunnerId: "rw-plan-dup",
				hostname: "host1",
				status: "ingested",
				result: passingResult,
				outputPath: passingResult.output_path,
			};
			await store.persist(record);
			const first = await db.select().from(githubPostings).where(eq(githubPostings.jobId, job.id));
			await store.persist(record); // restart re-ingest: job already terminal
			const second = await db.select().from(githubPostings).where(eq(githubPostings.jobId, job.id));
			expect(second.length).toBe(first.length);
		});
	});

	test("an invalid result queues no publication plans", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-plan-invalid");
			await new DbResultStore(db, () => at).persist({
				jobRunnerId: "rw-plan-invalid",
				hostname: "host1",
				status: "invalid",
				reason: "result.json is not valid JSON",
			});
			const plans = await db.select().from(githubPostings).where(eq(githubPostings.jobId, job.id));
			expect(plans.length).toBe(0);
		});
	});

	test("an itemless, shaless job queues no issue/PR or check plans", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-plan-itemless", { itemNumber: null, sha: "" });
			const { item_number: _n, sha: _s, ...itemless } = passingResult;
			await new DbResultStore(db, () => at).persist({
				jobRunnerId: "rw-plan-itemless",
				hostname: "host1",
				status: "ingested",
				result: itemless as RunnerResult,
			});
			const plans = await db.select().from(githubPostings).where(eq(githubPostings.jobId, job.id));
			expect(plans.length).toBe(0);
		});
	});
});

/**
 * Capture the NDJSON lines written to fd 2 while `fn` runs — the same seam
 * `tests/observability/stream-skip-visibility.test.ts` uses, because pino is
 * bound to fd 2 at module init.
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

const SUPPRESSED_EVENT = "publication.item_suppressed";

/** Persist a passing result for `runnerJobId` and return the captured log lines. */
async function persistAndCapture(
	db: Parameters<Parameters<typeof withTestDb>[0]>[0],
	runnerJobId: string,
) {
	const { lines } = await withCapturedLogs(() =>
		new DbResultStore(db, () => at).persist({
			jobRunnerId: runnerJobId,
			hostname: "host1",
			status: "ingested",
			result: passingResult,
			outputPath: passingResult.output_path,
		}),
	);
	return lines;
}

describe("DbResultStore — a suppressed item publication says why", () => {
	test("a closed item emits one INFO line naming the job, the item and `closed`", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-suppressed-closed");
			await db.update(githubItems).set({ state: "closed" }).where(eq(githubItems.number, 7));

			const lines = await persistAndCapture(db, "rw-suppressed-closed");

			const suppressed = lines.filter((l) => l.msg === SUPPRESSED_EVENT);
			expect(suppressed).toHaveLength(1);
			// THE LEVEL IS THE ASSERTION: at debug the line is invisible at the
			// default level, which is the defect; at warn a normal outcome pages.
			expect(suppressed[0]?.level).toBe("info");
			expect(suppressed[0]?.job_id).toBe(String(job.id));
			expect(suppressed[0]?.item_number).toBe("7");
			expect(suppressed[0]?.reason).toBe("closed");
			// The gate's decision is unchanged: no label or comment plan was queued.
			const plans = await db.select().from(githubPostings).where(eq(githubPostings.jobId, job.id));
			expect(plans.some((p) => p.kind === "label" || p.kind === "comment")).toBe(false);
		});
	});

	test("an open PR whose head moved off the job SHA emits `stale-head`", async () => {
		await withTestDb(async (db) => {
			await seedRunning(db, "rw-suppressed-stale");
			await db
				.update(githubItems)
				.set({ headSha: "feed0000feed" })
				.where(eq(githubItems.number, 7));

			const lines = await persistAndCapture(db, "rw-suppressed-stale");

			const suppressed = lines.filter((l) => l.msg === SUPPRESSED_EVENT);
			expect(suppressed).toHaveLength(1);
			expect(suppressed[0]?.reason).toBe("stale-head");
		});
	});

	test("an eligible item emits NO suppression line (mutation control)", async () => {
		await withTestDb(async (db) => {
			const job = await seedRunning(db, "rw-suppressed-none");

			const lines = await persistAndCapture(db, "rw-suppressed-none");

			expect(lines.some((l) => l.msg === SUPPRESSED_EVENT)).toBe(false);
			const plans = await db.select().from(githubPostings).where(eq(githubPostings.jobId, job.id));
			expect(plans.some((p) => p.kind === "comment")).toBe(true);
		});
	});
});
