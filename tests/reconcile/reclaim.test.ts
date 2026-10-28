/**
 * Restart-recovery reclaimer regressions (criterion 2). A crash between the
 * atomic claim and the `running`/release write strands a job in `dispatching`; a
 * runner box that dies before landing any result strands one in `running`. Neither
 * state was ever recovered (the #8 selector was never implemented), so the job was
 * lost forever. `reclaimStaleJobs` re-pends both past a bounded age, status-guarded
 * so a legitimately-progressing row is never clobbered, and the SAME cycle's dispatch
 * pass then re-claims it. These pin: stale `dispatching`/`running` are re-pended and
 * become re-claimable; recent in-flight rows are untouched (no race with live work);
 * the status guard keeps the two branches from crossing; and a reclaim failure is
 * isolated (a throwing sink never aborts the reclaim).
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, jobAttempts, jobs, repositories, runnerBoxes } from "../../src/db/schema";
import {
	CEILING_EXHAUSTED_ATTEMPT_SUMMARY,
	RECLAIMED_ATTEMPT_SUMMARY,
} from "../../src/reconcile/attempt-lifecycle";
import {
	CEILING_RECLAIM_BUDGET,
	DISPATCHING_STALE_MINUTES,
	dispatchPendingJobs,
	RUNNING_MAX_MINUTES,
	reclaimStaleJobs,
	requeueInfraFailedJobs,
} from "../../src/reconcile/dispatch-pass";
import { RUNNER_BOXES } from "../../src/runner/bands";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** A config whose allowlist maps pr-review to a fixed template. */
function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/x", provider: "github", checks: "standard", gate_selection: "full" },
		],
		job_templates: [{ id: "pr-review", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
		...overrides,
	};
}

/** Fake transport that always allocates and records every run. */
function fakeTransport(): RunnerTransport & { ran: RunnerRunParams[] } {
	const ran: RunnerRunParams[] = [];
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
		needed: async (): Promise<RunnerAllocation> => ({
			ok: true,
			boxes: [{ vmid: 9001, size: "medium" }],
		}),
		run: async (p: RunnerRunParams) => {
			ran.push(p);
		},
		list: async () => [],
		done: async () => {},
	};
}

/**
 * A transport that RECORDS every `done(vmid)` reap the reclaimer performs.
 * `throwOnDone` makes `done` reject so the fail-safe path can be exercised: a reap
 * that throws must still leave the job re-pended and the ownership cleared.
 */
function reapRecordingTransport(throwOnDone = false): RunnerTransport & { doneVmids: number[] } {
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
		run: async () => {},
		list: async () => [],
		done: async (vmid: number) => {
			doneVmids.push(vmid);
			if (throwOnDone) {
				throw new Error("runner_done outcome UNKNOWN for vmid " + vmid);
			}
		},
	};
}

/** Find-or-create the single managed repo (`rodaddy/x`) so multi-seed tests reuse it. */
async function ensureRepo(db: TestDb): Promise<number> {
	const [existing] = await db
		.select({ id: repositories.id })
		.from(repositories)
		.where(eq(repositories.fullName, "rodaddy/x"));
	if (existing) return existing.id;
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", checks: "standard" })
		.returning();
	if (!repo) throw new Error("seed failed");
	return repo.id;
}

let itemSeq = 0;

/** Seed one job (with a joined open-PR item) in a given status and updatedAt. */
async function seedJob(
	db: TestDb,
	opts: { status: string; updatedAt: Date; sha?: string },
): Promise<number> {
	const sha = opts.sha ?? "abc123";
	const repoId = await ensureRepo(db);
	itemSeq += 1;
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repoId, kind: "pull", number: itemSeq, state: "open", headSha: sha })
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repoId,
			itemId: item?.id,
			sha,
			jobType: "pr-review",
			status: opts.status,
			updatedAt: opts.updatedAt,
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return job.id;
}

/** Seed the stated box inventory; the migration creates the table empty. */
async function seedBoxes(db: TestDb) {
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

const NOW = new Date("2026-07-20T12:00:00.000Z");
/** A timestamp `minutes` before NOW. */
function ago(minutes: number): Date {
	return new Date(NOW.getTime() - minutes * 60_000);
}

describe("reclaimStaleJobs", () => {
	test("a stale `dispatching` job is re-pended, due now, and re-claimable by the dispatch pass", async () => {
		await withTestDb(async (db) => {
			// A claim that crashed before the running/release write: stuck `dispatching`
			// with an updatedAt past the stale threshold.
			const jobId = await seedJob(db, {
				status: "dispatching",
				updatedAt: ago(DISPATCHING_STALE_MINUTES + 5),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary).toMatchObject({ dispatchingRepended: 1, runningRepended: 0 });

			// Back to pending and due NOW (nextAttemptAt <= now), so the very next
			// dispatch pass will re-claim it.
			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt).not.toBeNull();
			expect(row?.nextAttemptAt?.getTime()).toBeLessThanOrEqual(NOW.getTime());

			// The same cycle's dispatch pass re-claims and dispatches it.
			const t = fakeTransport();
			const dispatch = await dispatchPendingJobs(db, t, config(), { now: NOW });
			expect(dispatch.dispatched).toBe(1);
			expect(t.ran.length).toBe(1);
			const [ran] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(ran?.status).toBe("running");
		});
	});

	test("reclaiming a crashed job also releases the runner box its attempt still holds", async () => {
		await withTestDb(async (db) => {
			// The crash window the claim cannot survive on its own: claimed at
			// dispatch.ts before transport.run(), then the watcher dies. Nothing reaps
			// and no result lands, so only the reclaimer can free the box.
			await seedBoxes(db);
			const jobId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES + 5),
			});
			await db
				.insert(jobAttempts)
				.values({
					jobId,
					runnerJobId: "rw-crashed-1",
					runnerVmid: 9001,
					status: "submitted",
				})
				.returning({ id: jobAttempts.id });
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-crashed-1", heldAt: ago(RUNNING_MAX_MINUTES + 5) })
				.where(eq(runnerBoxes.vmid, 9001));

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary).toMatchObject({ runningRepended: 1 });

			// Without the release the box reads as held forever while the job
			// redispatches onto a different vmid — a permanent pool leak.
			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			expect(box?.heldByJobId).toBeNull();
			expect(box?.heldAt).toBeNull();
		});
	});

	test("reclaim releases a box held by an OLDER attempt, not just the newest", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const jobId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES + 5),
			});
			// A job re-pended once before: attempt A stranded a box on 9001, attempt B
			// then ran on 9002. Inspecting only the newest attempt leaves A's claim
			// held forever, permanently consuming one of 25 pool VMIDs.
			await db.insert(jobAttempts).values({
				jobId,
				runnerJobId: "rw-older-a",
				runnerVmid: 9001,
				status: "failed",
			});
			await db.insert(jobAttempts).values({
				jobId,
				runnerJobId: "rw-newer-b",
				runnerVmid: 9002,
				status: "submitted",
			});
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-older-a", heldAt: ago(RUNNING_MAX_MINUTES + 9) })
				.where(eq(runnerBoxes.vmid, 9001));
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-newer-b", heldAt: ago(RUNNING_MAX_MINUTES + 5) })
				.where(eq(runnerBoxes.vmid, 9002));

			await reclaimStaleJobs(db, NOW);

			const [older] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			const [newer] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9002));
			expect(older?.heldByJobId).toBeNull();
			expect(newer?.heldByJobId).toBeNull();
		});
	});

	test("a LOST status guard releases no box: the live attempt keeps its claim", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			// Selected as stale `dispatching`, but the original dispatch advances it to
			// `running` before the guarded release lands. The guard matches zero rows,
			// so nothing was re-pended — and releasing the box anyway would report a
			// live attempt's box as free.
			const jobId = await seedJob(db, {
				status: "dispatching",
				updatedAt: ago(DISPATCHING_STALE_MINUTES + 5),
			});
			await db.insert(jobAttempts).values({
				jobId,
				runnerJobId: "rw-live-1",
				runnerVmid: 9001,
				status: "submitted",
			});
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-live-1", heldAt: NOW })
				.where(eq(runnerBoxes.vmid, 9001));
			// Win the race on the job row before the reclaimer's guarded update.
			await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));

			const summary = await reclaimStaleJobs(db, NOW);

			expect(summary.dispatchingRepended).toBe(0);
			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			expect(box?.heldByJobId).toBe("rw-live-1");
		});
	});

	test("reclaim does NOT clear a claim that a newer attempt already took", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const jobId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES + 5),
			});
			await db.insert(jobAttempts).values({
				jobId,
				runnerJobId: "rw-stale-1",
				runnerVmid: 9001,
				status: "submitted",
			});
			// The fleet recycled 9001 and a DIFFERENT job claimed it since. Clearing
			// this would orphan a live box: the DB would report it free while a job
			// runs on it.
			await db
				.update(runnerBoxes)
				.set({ heldByJobId: "rw-live-2", heldAt: NOW })
				.where(eq(runnerBoxes.vmid, 9001));

			await reclaimStaleJobs(db, NOW);

			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			expect(box?.heldByJobId).toBe("rw-live-2");
		});
	});

	test("a RECENT `dispatching` job is NOT touched (no race with an in-flight dispatch)", async () => {
		await withTestDb(async (db) => {
			// A claim that just happened (well within the threshold) is a normal in-flight
			// dispatch, not a crash — the reclaimer must leave it alone.
			const jobId = await seedJob(db, {
				status: "dispatching",
				updatedAt: ago(DISPATCHING_STALE_MINUTES - 5),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary.dispatchingRepended).toBe(0);

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("dispatching");
			expect(row?.nextAttemptAt).toBeNull();
		});
	});

	test("a `running` job past the max-age with no landed result is re-pended for a fresh attempt", async () => {
		await withTestDb(async (db) => {
			// A running job whose runner box died before landing any result: still
			// `running` past the max-age ceiling (a landed result would have moved it out
			// of `running`). Re-pend for a fresh attempt (no attempt budget to exhaust in
			// this service — every recovery here re-pends and the fresh attempt row is
			// written only by the next real dispatch).
			const jobId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES + 10),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary).toMatchObject({ dispatchingRepended: 0, runningRepended: 1 });

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt?.getTime()).toBeLessThanOrEqual(NOW.getTime());

			// Re-claimable: the dispatch pass picks it up (a fresh attempt on next dispatch).
			const t = fakeTransport();
			const dispatch = await dispatchPendingJobs(db, t, config(), { now: NOW });
			expect(dispatch.dispatched).toBe(1);
			const [ran] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(ran?.status).toBe("running");
		});
	});

	test("a `running` job within the max-age is untouched (never reclaims live in-flight work)", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES - 10),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary.runningRepended).toBe(0);

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("running");
			expect(row?.nextAttemptAt).toBeNull();
		});
	});

	test("the status guard keeps the branches from crossing: a stale `running` is not touched by the dispatching branch, and vice versa", async () => {
		await withTestDb(async (db) => {
			// One stale `running` and one stale `dispatching`, both old enough for their
			// own branch. Each is reclaimed by exactly its own branch — the dispatching
			// branch never re-pends the running row (and vice versa), because every
			// release is guarded on the exact expected status.
			const runningId = await seedJob(db, {
				status: "running",
				updatedAt: ago(RUNNING_MAX_MINUTES + 30),
				sha: "run111",
			});
			const dispatchingId = await seedJob(db, {
				status: "dispatching",
				updatedAt: ago(DISPATCHING_STALE_MINUTES + 30),
				sha: "disp22",
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary).toMatchObject({ dispatchingRepended: 1, runningRepended: 1 });

			// Both re-pended, each exactly once — no cross-branch double handling.
			const [running] = await db.select().from(jobs).where(eq(jobs.id, runningId));
			const [dispatching] = await db.select().from(jobs).where(eq(jobs.id, dispatchingId));
			expect(running?.status).toBe("pending");
			expect(dispatching?.status).toBe("pending");
		});
	});

	test("a stale `running` job that advanced out of `running` before the release is NOT reverted (guard, no clobber)", async () => {
		await withTestDb(async (db) => {
			// Model the race the status guard defends: a job selected as stale `running`
			// that the result store terminates (running -> completed) before the reclaimer's
			// guarded release runs. The guard matches no `running` row, so `completed` stands.
			const jobId = await seedJob(db, {
				status: "completed",
				updatedAt: ago(RUNNING_MAX_MINUTES + 30),
			});

			const summary = await reclaimStaleJobs(db, NOW);
			expect(summary.runningRepended).toBe(0);

			const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
			expect(row?.status).toBe("completed");
			expect(row?.nextAttemptAt).toBeNull();
		});
	});

	test("a per-row release failure is isolated even when the onError sink itself throws — the reclaim still resolves", async () => {
		await withTestDb(async (db) => {
			// A stale `dispatching` row is selected, but the guarded release WRITE fails
			// (db fault), AND the operator's error sink itself THROWS on that failure.
			// Neither may escape: the per-row failure is caught, the throwing sink is
			// swallowed, and `reclaimStaleJobs` resolves (never aborting the cycle).
			await seedJob(db, {
				status: "dispatching",
				updatedAt: ago(DISPATCHING_STALE_MINUTES + 5),
			});

			// Proxy the db so the SELECT still works but the release `update` throws.
			let onErrorCalls = 0;
			const poisoned = new Proxy(db, {
				get(target, prop, receiver) {
					if (prop === "update") {
						return () => {
							throw new Error("db write failed");
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			}) as typeof db;

			// The reclaim must resolve — no throw escapes — despite both the write fault
			// and the faulty sink.
			const summary = await reclaimStaleJobs(poisoned, NOW, {
				onError: () => {
					onErrorCalls++;
					throw new Error("faulty logging sink");
				},
			});

			// The row failed to release (counted as 0), the sink was invoked and its throw
			// swallowed, and the cycle was never aborted.
			expect(onErrorCalls).toBeGreaterThan(0);
			expect(summary.dispatchingRepended).toBe(0);
		});
	});

	describe("#129 reclaim reaps the LXC, not just the claim", () => {
		test("a released box claim carrying a vmid is REAPED through the transport with that vmid", async () => {
			await withTestDb(async (db) => {
				// The exact 2026-08-01 shape: a stale `running` job whose attempt claimed a
				// box. Before this fix the reclaimer released the DB claim (logging the
				// vmid) but never powered the LXC off — so the container ran orphaned. The
				// transport reap must now be invoked with that vmid.
				await seedBoxes(db);
				const jobId = await seedJob(db, {
					status: "running",
					updatedAt: ago(RUNNING_MAX_MINUTES + 5),
				});
				await db.insert(jobAttempts).values({
					jobId,
					runnerJobId: "rw-orphan-1",
					runnerVmid: 9004,
					status: "submitted",
				});
				await db
					.update(runnerBoxes)
					.set({ heldByJobId: "rw-orphan-1", heldAt: ago(RUNNING_MAX_MINUTES + 5) })
					.where(eq(runnerBoxes.vmid, 9004));

				const transport = reapRecordingTransport();
				const summary = await reclaimStaleJobs(db, NOW, { transport });
				expect(summary.runningRepended).toBe(1);

				// The box was actually powered off, with the attempt's exact vmid.
				expect(transport.doneVmids).toEqual([9004]);
				// And the DB claim is cleared (scoped release inside the reap).
				const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9004));
				expect(box?.heldByJobId).toBeNull();
			});
		});

		test("a reap that THROWS still re-pends the job and clears ownership (fail-safe)", async () => {
			await withTestDb(async (db) => {
				// The reap's `transport.done` rejects (an UNKNOWN-outcome fault). The reap is
				// best-effort: the throw is swallowed inside `reap`, so it must NOT block the
				// re-pend or the ownership clear. Model a job that already took ownership of
				// its attempt (as a real dispatched job would) to prove the re-pend clears it.
				await seedBoxes(db);
				const jobId = await seedJob(db, {
					status: "running",
					updatedAt: ago(RUNNING_MAX_MINUTES + 5),
				});
				const [attempt] = await db
					.insert(jobAttempts)
					.values({
						jobId,
						runnerJobId: "rw-throws-1",
						runnerVmid: 9006,
						status: "submitted",
					})
					.returning({ id: jobAttempts.id });
				await db.update(jobs).set({ activeAttemptId: attempt?.id }).where(eq(jobs.id, jobId));
				await db
					.update(runnerBoxes)
					.set({ heldByJobId: "rw-throws-1", heldAt: ago(RUNNING_MAX_MINUTES + 5) })
					.where(eq(runnerBoxes.vmid, 9006));

				const transport = reapRecordingTransport(true);
				const summary = await reclaimStaleJobs(db, NOW, { transport });

				// The reap was attempted with the right vmid, then threw.
				expect(transport.doneVmids).toEqual([9006]);
				// Despite the throw, the job was re-pended and its ownership cleared, so the
				// dispatch pass can re-claim it (the #85 stale-attempt-ownership semantics).
				expect(summary.runningRepended).toBe(1);
				const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
				expect(row?.status).toBe("pending");
				expect(row?.activeAttemptId).toBeNull();
			});
		});
	});

	describe("reap budget", () => {
		test("the reap loop stops between rows once the per-phase budget is spent; untouched rows are deferred to the next pass", async () => {
			await withTestDb(async (db) => {
				await seedBoxes(db);
				const jobIds: number[] = [];
				for (const [index, vmid] of [9001, 9002, 9003].entries()) {
					const jobId = await seedJob(db, {
						status: "dispatching",
						updatedAt: ago(DISPATCHING_STALE_MINUTES + 5),
					});
					jobIds.push(jobId);
					await db.insert(jobAttempts).values({
						jobId,
						runnerJobId: `rw-budget-row-${index}`,
						runnerVmid: vmid,
						status: "submitted",
					});
					await db
						.update(runnerBoxes)
						.set({
							heldByJobId: `rw-budget-row-${index}`,
							heldAt: ago(DISPATCHING_STALE_MINUTES + 5),
						})
						.where(eq(runnerBoxes.vmid, vmid));
				}

				let t = 0;
				const monotonicNow = () => t;
				const transport = reapRecordingTransport();
				const recordDone = transport.done;
				transport.done = async (vmid) => {
					await recordDone(vmid);
					t += 180_000;
				};
				const first = await reclaimStaleJobs(db, NOW, { transport, monotonicNow });

				expect(first.dispatchingRepended).toBe(2);
				expect(first.reapBudgetDeferred).toBe(1);
				expect(transport.doneVmids).toHaveLength(2);
				expect(transport.doneVmids).toEqual([9001, 9002]);
				const [deferred] = await db
					.select()
					.from(jobs)
					.where(eq(jobs.id, jobIds[2] ?? -1));
				expect(deferred?.status).toBe("dispatching");

				t = 0;
				const second = await reclaimStaleJobs(db, NOW, { transport, monotonicNow });
				expect(second.dispatchingRepended).toBe(1);
				expect(second.reapBudgetDeferred).toBe(0);
				expect(transport.doneVmids).toEqual([9001, 9002, 9003]);
			});
		});

		test("a row that started is finished: all of its attempts are reaped even when the budget expires mid-row", async () => {
			await withTestDb(async (db) => {
				await seedBoxes(db);
				const jobId = await seedJob(db, {
					status: "dispatching",
					updatedAt: ago(DISPATCHING_STALE_MINUTES + 5),
				});
				const vmids = [9004, 9005, 9006];
				for (const [index, vmid] of vmids.entries()) {
					const runnerJobId = `rw-budget-attempt-${index}`;
					await db.insert(jobAttempts).values({
						jobId,
						runnerJobId,
						runnerVmid: vmid,
						status: "submitted",
					});
					await db
						.update(runnerBoxes)
						.set({
							heldByJobId: runnerJobId,
							heldAt: ago(DISPATCHING_STALE_MINUTES + 5),
						})
						.where(eq(runnerBoxes.vmid, vmid));
				}

				let t = 0;
				const transport = reapRecordingTransport();
				const recordDone = transport.done;
				transport.done = async (vmid) => {
					await recordDone(vmid);
					t += 200_000;
				};
				const summary = await reclaimStaleJobs(db, NOW, {
					transport,
					monotonicNow: () => t,
				});

				expect(summary.dispatchingRepended).toBe(1);
				expect(transport.doneVmids).toHaveLength(3);
				expect([...transport.doneVmids].sort()).toEqual(vmids);
			});
		});
	});

	/**
	 * THE CEILING-RECLAIM LOOP IS BOUNDED.
	 *
	 * Job 1547 (`pr-review`, target #198) cycled the running ceiling for hours: each
	 * pass allocated a box, held it to `RUNNING_MAX_MINUTES`, produced no result, was
	 * reclaimed, and re-pended — ~40 attempts, one box per cycle, no terminal outcome
	 * and no path to one. The loop is also SILENT: it looks identical to a job making
	 * progress, which is the #84 silently-absent-gate trap wearing scheduling clothes.
	 *
	 * These pin the state-machine bound at the owning boundary: the reclaim itself.
	 * Under the ceiling budget a job still re-pends; at exhaustion it terminal-`fail`s
	 * with a visible cause instead of re-entering `running` again.
	 */
	describe("ceiling-reclaim budget", () => {
		/** Seed `count` terminal `failed` attempt rows — the ledger a reclaimed job accrues. */
		async function seedReclaimedAttempts(db: TestDb, jobId: number, count: number) {
			for (let i = 0; i < count; i++) {
				await db.insert(jobAttempts).values({
					jobId,
					runnerJobId: `rw-ceiling-${jobId}-${i}`,
					status: "failed",
					finishedAt: ago(RUNNING_MAX_MINUTES + 10),
				});
			}
		}

		test("under the budget, a ceiling-reclaimed job still re-pends for a fresh attempt", async () => {
			await withTestDb(async (db) => {
				const jobId = await seedJob(db, {
					status: "running",
					updatedAt: ago(RUNNING_MAX_MINUTES + 5),
				});
				// One prior reclaim plus the attempt in flight now = 2 attempt rows, which is
				// under CEILING_RECLAIM_BUDGET. Recovery must be unchanged.
				await seedReclaimedAttempts(db, jobId, 1);
				await db.insert(jobAttempts).values({
					jobId,
					runnerJobId: `rw-ceiling-${jobId}-live`,
					status: "submitted",
				});

				const summary = await reclaimStaleJobs(db, NOW);
				expect(summary.runningRepended).toBe(1);
				expect(summary.ceilingExhausted).toBe(0);

				const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
				expect(row?.status).toBe("pending");
			});
		});

		test("at budget exhaustion the job terminal-FAILS instead of re-entering running", async () => {
			await withTestDb(async (db) => {
				const jobId = await seedJob(db, {
					status: "running",
					updatedAt: ago(RUNNING_MAX_MINUTES + 5),
				});
				// Job 1547's shape: the ledger already carries a full budget of ceiling
				// reclaims, and the attempt in flight now is one past it.
				await seedReclaimedAttempts(db, jobId, CEILING_RECLAIM_BUDGET);
				await db.insert(jobAttempts).values({
					jobId,
					runnerJobId: `rw-ceiling-${jobId}-live`,
					status: "submitted",
				});

				const summary = await reclaimStaleJobs(db, NOW);

				// It is NOT counted as a re-pend, because it was not re-pended.
				expect(summary.runningRepended).toBe(0);
				expect(summary.ceilingExhausted).toBe(1);

				// TERMINAL. The state machine makes the loop impossible: `failed` is not a
				// dispatchable status, and the job carries no future attempt time.
				const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
				expect(row?.status).toBe("failed");
				expect(row?.activeAttemptId).toBeNull();

				// A dispatch pass cannot pick it up again — the loop is closed, not quieter.
				const t = fakeTransport();
				const dispatch = await dispatchPendingJobs(db, t, config(), { now: NOW });
				expect(dispatch.dispatched).toBe(0);
				expect(t.ran.length).toBe(0);
			});
		});

		test("the exhausted job carries a VISIBLE cause on its attempt rows", async () => {
			await withTestDb(async (db) => {
				// The loop's real cost was silence: nothing went red and nothing said why.
				// The abandoned attempt must state the ceiling as its cause.
				const jobId = await seedJob(db, {
					status: "running",
					updatedAt: ago(RUNNING_MAX_MINUTES + 5),
				});
				await seedReclaimedAttempts(db, jobId, CEILING_RECLAIM_BUDGET);
				const [live] = await db
					.insert(jobAttempts)
					.values({ jobId, runnerJobId: `rw-ceiling-${jobId}-live`, status: "submitted" })
					.returning({ id: jobAttempts.id });

				await reclaimStaleJobs(db, NOW);

				const [row] = await db
					.select()
					.from(jobAttempts)
					.where(eq(jobAttempts.id, live?.id ?? -1));
				expect(row?.status).toBe("failed");
				expect(row?.finishedAt).not.toBeNull();
				// The GIVE-UP summary, not the retry one. Asserting merely that the text
				// mentions the ceiling would pass on RECLAIMED_ATTEMPT_SUMMARY too — which
				// says the job "was re-pended for a fresh attempt" and is exactly the
				// reassuring line job 1547 wrote ~40 times while nothing was wrong-looking.
				expect(row?.failureSummary).toBe(CEILING_EXHAUSTED_ATTEMPT_SUMMARY);
				expect(row?.failureSummary).not.toBe(RECLAIMED_ATTEMPT_SUMMARY);
			});
		});

		test("an exhausted job is NOT revived by the infra-requeue sweep", async () => {
			await withTestDb(async (db) => {
				// The terminal state must STICK. #95 revives infra-class terminal-`failed`
				// jobs, and a ceiling-exhausted job is infra-class by that rule's own
				// predicate (no attempt ever reached `completed`) — so without an explicit
				// bar the requeue sweep simply restarts the very loop this fix closed,
				// through a second door.
				const jobId = await seedJob(db, {
					status: "running",
					updatedAt: ago(RUNNING_MAX_MINUTES + 5),
				});
				await seedReclaimedAttempts(db, jobId, CEILING_RECLAIM_BUDGET);
				await db.insert(jobAttempts).values({
					jobId,
					runnerJobId: `rw-ceiling-${jobId}-live`,
					status: "submitted",
				});

				await reclaimStaleJobs(db, NOW);
				const requeue = await requeueInfraFailedJobs(db, NOW);
				expect(requeue.requeued).toBe(0);

				const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
				expect(row?.status).toBe("failed");
			});
		});
	});
});
