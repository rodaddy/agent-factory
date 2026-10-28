/**
 * SAME-PASS VMID DE-DUP.
 *
 * The gateway's `needed()` REPORTS a warm box without reserving it, so two
 * dispatches in one pass can each be handed the same vmid. Live on the first
 * `deploy:hello` citizenship run that cost a whole dispatch
 * attempt: the `newapp` verb job and a concurrent `infra-static` job both got
 * VMID 9001, and the second submission died `runner_run failed (exit 1)` in ~5s.
 *
 * The claim classes, one receipt each:
 *
 *  1. TWO JOBS, ONE WARM BOX, ONE PASS -> the second never `run()`s against the
 *     shared vmid, and the box is NOT reaped (it is the winner's live box).
 *  2. A NEVER-REFUSING LEDGER reproduces the pre-fix collision -- the fix lives
 *     here and nowhere else in the dispatch path.
 *  3. DISTINCT BOXES still BOTH dispatch -- the de-dup must not become a
 *     one-dispatch-per-pass cap.
 *  4. THE NEXT PASS MAY REUSE THE BOX -- the ledger is same-pass only, which is
 *     what keeps a watcher-side mitigation from becoming a phantom lease the
 *     watcher does not own (the real lease is rtech-infra#797).
 *  5. CROSS-LANE -- a vmid the verb lane took earlier in the same sweep is
 *     refused here, which is the shape of the live defect.
 *  6. AN ABANDONED TAKE WHOSE REAP PROVED THE BOX GONE IS RELEASED --
 *     after a dispatch's own `run()` fails and its reap SUCCEEDS, a later job in
 *     the SAME pass may run on a re-placed box carrying the same vmid. Live
 *     2026-08-26: the first job of every pass took 9001, its box was already
 *     dead box-side, and the held vmid then refused all 28 remaining jobs --
 *     104 refusals in 3h, 0 dispatched.
 *  7. A REAP THAT FAILED HOLDS THE VMID -- `transport.done` throws, so the box
 *     may still be running job A's work and no second job may land on it.
 *  8. A REAP THAT SKIPPED ON UNPROVEN OWNERSHIP HOLDS THE VMID -- the claim was
 *     stolen mid-flight, the box was deliberately never powered off, and handing
 *     the number back would put a second job onto that live box.
 *  9. THE `recordOwnedAttempt` ABANDON ARM RELEASES ON A PROVEN REAP -- the
 *     "superseded before submit" arm, reached by re-pending the row from inside
 *     `needed()`, which is the ONE seam that arm has from `dispatchPendingJobs`.
 *     Its sibling arm (`recordSubmittedAttempt` returning undefined) has NO seam
 *     in reach and is therefore NOT pinned here.
 10. A TIMED-OUT `done` IS RE-PROBED BEFORE THE VMID IS HELD (sf#402) -- the
 *     HTTP transport aborts at 90s while the gateway has ALREADY destroyed the
 *     box, so a reap that TIMED OUT is not a reap that failed. One read-only
 *     `list()` decides it: vmid gone -> "reaped" and the number is released;
 *     vmid still present -> held, as before. Live on the watcher host: every job after the
 *     first in a pass was refused `vmid already dispatched this pass`.
 *
 * MUTATION-PROVEN against the source, not only against these fakes. Disabling the
 * guard in `acquireRunnerBox` turns class 1 red with `[9001, 9001]` received;
 * widening it to always refuse turns 1, 2, 3, and 4 red together. Making
 * `releaseAbandonedTake` release UNCONDITIONALLY turns 7 and 8 red with 6 and 9
 * green; making it never release turns 6 and 9 red with 7 and 8 green -- the two
 * halves of the reap gate, each pinned by the mutation the other survives.
 * Making `isTransportTimeout` always return false turns 10a red (the vmid is held
 * and job B never runs); making the re-probe return "reaped" unconditionally,
 * without reading the list, turns 10b red (a still-present box is handed back).
 *
 * Driven through `dispatchPendingJobs`, not `dispatchJob` directly: the defect is
 * a property of a PASS, and a test that drove one dispatch at a time would prove
 * the ledger's own `Set` rather than the behaviour under test.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, jobs, repositories, runnerBoxes } from "../../src/db/schema";
import { dispatchPendingJobs } from "../../src/reconcile/dispatch-pass";
import { RUNNER_BOXES } from "../../src/runner/bands";
import { createPassVmids } from "../../src/runner/pass-vmids";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/x", provider: "github", checks: "standard", gate_selection: "full" },
		],
		job_templates: [{ id: "pr-review", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
	};
}

/**
 * A transport whose `needed()` answers from a scripted queue of vmids, so a pass
 * can be handed the SAME warm box twice -- exactly what the live gateway did.
 * The queue's last entry repeats once exhausted, which is the warm-box behaviour:
 * `needed()` keeps re-reporting the box it already reported.
 */
function scriptedTransport(
	vmids: number[],
	failRuns: readonly number[] = [],
): RunnerTransport & {
	ran: RunnerRunParams[];
	allocated: number[];
	reaped: number[];
} {
	const ran: RunnerRunParams[] = [];
	const allocated: number[] = [];
	const reaped: number[] = [];
	let next = 0;
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
		allocated,
		reaped,
		needed: async (): Promise<RunnerAllocation> => {
			const vmid = vmids[Math.min(next, vmids.length - 1)] as number;
			next++;
			allocated.push(vmid);
			return { ok: true, boxes: [{ vmid, size: "medium" }] };
		},
		run: async (p: RunnerRunParams) => {
			ran.push(p);
			// `failRuns` names submission ORDINALS (1-based) that die terminally, which is
			// what the live box-side kill looks like from here (sf#395: "vmid 9001 not
			// found on any reachable node" after 10 attempts). The box is recorded as
			// submitted-against BEFORE the throw because the live transport does reach it.
			if (failRuns.includes(ran.length)) {
				throw new Error(`runner_run failed (vmid ${p.vmid} not found on any reachable node)`);
			}
		},
		list: async () => [],
		done: async (vmid: number) => {
			reaped.push(vmid);
		},
	};
}

/** Seed the inventory so `claimBox` has rows to update, as `scripts/migrate.ts` does. */
async function seedBoxes(db: TestDb): Promise<void> {
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

/** Seed one managed repository plus `count` pending pr-review jobs on it. */
async function seedRepoWithJobs(db: TestDb, count: number): Promise<number[]> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", checks: "standard" })
		.returning();
	if (!repo) throw new Error("seed failed");
	const ids: number[] = [];
	for (let i = 0; i < count; i++) {
		const [item] = await db
			.insert(githubItems)
			.values({
				repositoryId: repo.id,
				kind: "pull",
				number: 100 + i,
				state: "open",
				headSha: `sha${i}`,
			})
			.returning();
		const [job] = await db
			.insert(jobs)
			.values({
				repositoryId: repo.id,
				itemId: item?.id,
				sha: `sha${i}`,
				jobType: "pr-review",
				status: "pending",
			})
			.returning();
		if (!job) throw new Error("seed failed");
		ids.push(job.id);
	}
	return ids;
}

describe("same-pass vmid de-dup", () => {
	test("two jobs, one warm box: the second never runs against the shared vmid", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [first, second] = await seedRepoWithJobs(db, 2);
			// `needed()` re-reports 9001 for BOTH allocations -- the live gateway shape.
			const t = scriptedTransport([9001]);

			const summary = await dispatchPendingJobs(db, t, config());

			// Both jobs were selected and both reached the allocator.
			expect(summary.selected).toBe(2);
			expect(t.allocated).toEqual([9001, 9001]);

			// ONLY ONE submission, and it is against 9001. THIS is the claim: without the
			// de-dup `t.ran` carries two entries both naming vmid 9001 -- the collision.
			expect(t.ran.map((p) => p.vmid)).toEqual([9001]);

			// The de-dup REFUSES, it does not error: the loser is queued for a later pass
			// with a bounded backoff, exactly like a capacity refusal.
			expect(summary.dispatched).toBe(1);
			expect(summary.queued).toBe(1);
			expect(summary.errored).toBe(0);

			// The loser is back to `pending` with a future `nextAttemptAt`, not `failed`.
			const [winner] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, first as number));
			const [loser] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, second as number));
			expect(winner?.status).toBe("running");
			expect(loser?.status).toBe("pending");
			expect(loser?.nextAttemptAt).toBeTruthy();

			// AND THE BOX IS NOT REAPED. It belongs to the dispatch that took it first;
			// powering it off would kill live work. This is the property that makes the
			// mitigation safe, and it is asserted separately because a refusal that DID
			// reap would still satisfy every assertion above.
			expect(t.reaped).toEqual([]);
		});
	});

	test("a ledger that never refuses reproduces the pre-fix collision exactly", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			await seedRepoWithJobs(db, 2);
			const t = scriptedTransport([9001]);

			// A ledger whose `take` always succeeds is behaviourally identical to having
			// none, and it pins WHERE the fix lives: nothing else in the dispatch path
			// stops the second submission. `claimBox` in particular does not -- it runs
			// AFTER allocation, is explicitly "bookkeeping, not a lock", and must never
			// fail a dispatch. That is why the guard could not be built on it.
			//
			// This is the source mutation held as a permanent regression: a future change
			// that weakens `take` into a no-op turns THIS test green and the first test
			// red, which is exactly the signal wanted.
			const summary = await dispatchPendingJobs(db, t, config(), {
				// `release` is a no-op here for the same reason `take` always succeeds: this
				// stub reproduces the pre-fix ledger, and a ledger that never records a take
				// has nothing to give back.
				passVmids: {
					take: () => true,
					release: () => {},
					// Never held-unproven, so the sf#418 collision gate never re-probes here.
					markHeldUnproven: () => {},
					isHeldUnproven: () => false,
				},
			});

			// The collision returns: TWO submissions, both against 9001.
			expect(t.ran.map((p) => p.vmid)).toEqual([9001, 9001]);
			expect(summary.dispatched).toBe(2);
			expect(summary.queued).toBe(0);
		});
	});

	test("distinct boxes: both jobs dispatch", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			await seedRepoWithJobs(db, 2);
			const t = scriptedTransport([9001, 9002]);

			const summary = await dispatchPendingJobs(db, t, config());

			// The de-dup must not become a one-dispatch-per-pass cap.
			expect(t.ran.map((p) => p.vmid)).toEqual([9001, 9002]);
			expect(summary.dispatched).toBe(2);
			expect(summary.queued).toBe(0);
		});
	});

	test("the NEXT pass may reuse the box: the ledger is same-pass only", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			await seedRepoWithJobs(db, 1);
			const t = scriptedTransport([9001]);

			await dispatchPendingJobs(db, t, config());
			expect(t.ran.map((p) => p.vmid)).toEqual([9001]);

			// A SECOND pass, a fresh job, and the same warm vmid. The watcher does not
			// own a lease on 9001 -- the fleet does -- so a new pass must be free to use
			// it. A ledger that persisted across passes would refuse here and starve the
			// job on a claim the watcher was never entitled to make (rtech-infra#797 is
			// the real lease).
			await db
				.insert(jobs)
				.values({ repositoryId: 1, sha: "later", jobType: "pr-review", status: "pending" });
			await dispatchPendingJobs(db, t, config());

			expect(t.ran.map((p) => p.vmid)).toEqual([9001, 9001]);
		});
	});

	test("CROSS-LANE: a vmid another lane took this pass is refused here", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [only] = await seedRepoWithJobs(db, 1);
			const t = scriptedTransport([9001]);

			// The live collision was between the VERB lane and this
			// one, not between two jobs of this one. Both are handed the SAME ledger by
			// `runSweepPhase`, so standing in for the verb lane's earlier dispatch is a
			// take against that shared object. This is the property the sweep wiring
			// exists to provide, asserted at the boundary that consumes it: without a
			// SHARED ledger the sweep's two lanes de-dup independently and 9001 is
			// submitted twice, which is the defect.
			const shared = createPassVmids();
			expect(shared.take(9001)).toBe(true);

			const summary = await dispatchPendingJobs(db, t, config(), { passVmids: shared });

			expect(t.ran).toEqual([]);
			expect(summary.dispatched).toBe(0);
			expect(summary.queued).toBe(1);
			// Never reaped: 9001 is the other lane's live box.
			expect(t.reaped).toEqual([]);
			const [row] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, only as number));
			expect(row?.status).toBe("pending");
		});
	});

	test("an abandoned take is released: a re-placed box carrying the same vmid may run", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [jobA, jobB] = await seedRepoWithJobs(db, 2);
			// The live sf#395 shape: `needed()` re-reports 9001 for BOTH jobs because the
			// gateway placed a FRESH box that recycled the number after job A's box died
			// box-side. Job A's submission throws terminally; job B's succeeds.
			const t = scriptedTransport([9001], [1]);

			const summary = await dispatchPendingJobs(db, t, config());

			// TWO submissions against 9001. Without the release, job B is refused
			// "vmid already dispatched this pass" and `t.ran` carries only [9001] --
			// which is the 28-refusals-per-pass live defect.
			expect(t.ran.map((p) => p.vmid)).toEqual([9001, 9001]);

			// Job A errored (its own submission died); job B dispatched. Neither is
			// queued: the release means nothing was deferred on a collision that no
			// longer exists.
			expect(summary.dispatched).toBe(1);
			expect(summary.errored).toBe(1);
			expect(summary.queued).toBe(0);

			const [a] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobA as number));
			const [b] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobB as number));
			// Job A is back to `pending` with a bounded backoff -- the ordinary
			// submission-failure release, unchanged by sf#395.
			expect(a?.status).toBe("pending");
			expect(a?.nextAttemptAt).toBeTruthy();
			expect(b?.status).toBe("running");
		});
	});

	test("reap-failed: the vmid is HELD, so no second job lands on a possibly-live box", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [jobA, jobB] = await seedRepoWithJobs(db, 2);
			// Job A's run() throws AND its done() throws, so `reap` returns "reap-failed":
			// the box MAY STILL BE LIVE running job A's work. `needed()` re-reports 9001,
			// so without the gate job B is submitted onto that same box.
			const ran: RunnerRunParams[] = [];
			const doneCalls: number[] = [];
			const listCalls: number[] = [];
			const t: RunnerTransport = {
				startBandMember: async () => {
					throw new Error("not implemented");
				},
				stopBandMember: async () => {
					throw new Error("not implemented");
				},
				listBand: async () => {
					throw new Error("not implemented");
				},
				needed: async (): Promise<RunnerAllocation> => ({
					ok: true,
					boxes: [{ vmid: 9001, size: "medium" }],
				}),
				run: async (p: RunnerRunParams) => {
					ran.push(p);
					if (ran.length === 1) {
						// The dangerous live shape: a CLIENT-SIDE timeout. The submission
						// generally COMPLETED server-side, so the box is running job A's work.
						throw new Error("CONNECTION_ERROR: failed to communicate with local daemon");
					}
				},
				list: async () => {
					listCalls.push(9001);
					return [];
				},
				done: async (vmid: number) => {
					doneCalls.push(vmid);
					throw new Error(`runner_done outcome UNKNOWN for vmid ${vmid}: transport fault`);
				},
			};

			const summary = await dispatchPendingJobs(db, t, config());

			// THE CLAIM: exactly ONE submission. The reap was attempted and FAILED, so the
			// box is unproven-gone and the vmid stays held for the rest of the pass.
			expect(ran.map((p) => p.vmid)).toEqual([9001]);
			// The reap WAS attempted -- the hold is because it failed, not because the
			// abandon path skipped reaping.
			expect(doneCalls).toEqual([9001]);
			// AND NO RE-PROBE. This failure is a transport FAULT, not a timeout,
			// so it carries no "the verb probably completed" ambiguity to resolve and the
			// sf#402 probe must not fire. The one recorded read is the sf#179 identity
			// check, which runs BEFORE `done` on every scoped reap; a second entry here
			// would mean the timeout arm widened to catch ordinary failures.
			expect(listCalls).toEqual([9001]);

			// Job A errored on its own submission; job B is deferred (queued), not run.
			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(1);
			expect(summary.queued).toBe(1);

			const [a] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobA as number));
			const [b] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobB as number));
			expect(a?.status).toBe("pending");
			expect(b?.status).toBe("pending");
			expect(b?.nextAttemptAt).toBeTruthy();
		});
	});

	test("skipped-unproven-ownership: the vmid is HELD, and the box was never powered off", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [jobA, jobB] = await seedRepoWithJobs(db, 2);
			// A NEWER attempt steals the claim mid-flight, so `reap`'s scoped release
			// matches zero rows and it returns "skipped-unproven-ownership": the box is
			// deliberately LEFT RUNNING because someone else owns it. Handing 9001 back
			// would put job B onto that live box.
			const ran: RunnerRunParams[] = [];
			const doneCalls: number[] = [];
			const t: RunnerTransport = {
				startBandMember: async () => {
					throw new Error("not implemented");
				},
				stopBandMember: async () => {
					throw new Error("not implemented");
				},
				listBand: async () => {
					throw new Error("not implemented");
				},
				needed: async (): Promise<RunnerAllocation> => ({
					ok: true,
					boxes: [{ vmid: 9001, size: "medium" }],
				}),
				run: async (p: RunnerRunParams) => {
					ran.push(p);
					if (ran.length === 1) {
						await db
							.update(runnerBoxes)
							.set({ heldByJobId: "rw-SOMEONE-ELSES-LIVE-JOB" })
							.where(eq(runnerBoxes.vmid, 9001));
						throw new Error("CONNECTION_ERROR: failed to communicate with local daemon");
					}
				},
				list: async () => [],
				done: async (vmid: number) => {
					doneCalls.push(vmid);
				},
			};

			const summary = await dispatchPendingJobs(db, t, config());

			// THE CLAIM: one submission only.
			expect(ran.map((p) => p.vmid)).toEqual([9001]);
			// `done` was NEVER called -- the reap deliberately skipped, which is precisely
			// why the vmid may not be handed back. Asserted separately because a hold that
			// came from a FAILED reap would satisfy the submission count above.
			expect(doneCalls).toEqual([]);

			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(1);
			expect(summary.queued).toBe(1);

			const [a] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobA as number));
			const [b] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobB as number));
			expect(a?.status).toBe("pending");
			expect(b?.status).toBe("pending");
		});
	});

	test("the recordOwnedAttempt arm releases on a PROVEN reap (superseded before submit)", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [jobA, jobB] = await seedRepoWithJobs(db, 2);
			// The `recordOwnedAttempt` abandon arm, driven through the ONE seam that
			// reaches it from `dispatchPendingJobs`: `needed()` runs between the
			// `dispatching` claim and the ownership take, so re-pending job A's row from
			// inside it makes the ownership guard match zero rows -- "attempt superseded
			// before submit". That arm reaps UNCONDITIONALLY (no claim exists yet), the
			// reap SUCCEEDS here, and the proven-gone vmid is therefore released, letting
			// job B use the re-placed box carrying the same number.
			const ran: RunnerRunParams[] = [];
			const doneCalls: number[] = [];
			let allocations = 0;
			const t: RunnerTransport = {
				startBandMember: async () => {
					throw new Error("not implemented");
				},
				stopBandMember: async () => {
					throw new Error("not implemented");
				},
				listBand: async () => {
					throw new Error("not implemented");
				},
				needed: async (): Promise<RunnerAllocation> => {
					allocations++;
					if (allocations === 1) {
						await db
							.update(jobs)
							.set({ status: "pending" })
							.where(eq(jobs.id, jobA as number));
					}
					return { ok: true, boxes: [{ vmid: 9001, size: "medium" }] };
				},
				run: async (p: RunnerRunParams) => {
					ran.push(p);
				},
				list: async () => [],
				done: async (vmid: number) => {
					doneCalls.push(vmid);
				},
			};

			const summary = await dispatchPendingJobs(db, t, config());

			// Job A never submitted (superseded); job B did, on the released vmid.
			expect(ran.map((p) => p.vmid)).toEqual([9001]);
			// The reap ran and SUCCEEDED -- that is what earns the release.
			expect(doneCalls).toEqual([9001]);
			expect(summary.dispatched).toBe(1);

			const [b] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobB as number));
			expect(b?.status).toBe("running");
		});
	});

	test("a timed-out done whose re-probe shows the vmid gone is released: the next job runs on the re-placed box", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [jobA, jobB] = await seedRepoWithJobs(db, 2);
			// The live sf#402 shape on the watcher host: job A's submission fails, its reap calls
			// `runner_done`, and the HTTP transport ABORTS at 90s
			// (`AbortSignal.timeout` -> name "TimeoutError") while the gateway has
			// ALREADY destroyed the box. A timed-out verb is not a failed verb, so the
			// re-probe asks the read-only `list()` what is actually there: 9001 is GONE,
			// the reap is proven, and the vmid is released for job B's re-placed box.
			const ran: RunnerRunParams[] = [];
			const doneCalls: number[] = [];
			const listCalls: number[] = [];
			const t: RunnerTransport = {
				startBandMember: async () => {
					throw new Error("not implemented");
				},
				stopBandMember: async () => {
					throw new Error("not implemented");
				},
				listBand: async () => {
					throw new Error("not implemented");
				},
				needed: async (): Promise<RunnerAllocation> => ({
					ok: true,
					boxes: [{ vmid: 9001, size: "medium" }],
				}),
				run: async (p: RunnerRunParams) => {
					ran.push(p);
					if (ran.length === 1) {
						throw new Error("CONNECTION_ERROR: failed to communicate with local daemon");
					}
				},
				list: async () => {
					listCalls.push(9001);
					return [];
				},
				done: async (vmid: number) => {
					doneCalls.push(vmid);
					// The HTTP transport's live error: `AbortSignal.timeout` rejects with a
					// DOMException whose `name` is "TimeoutError". Node's message text is used
					// here so ONLY the name clause of `isTransportTimeout` can match it; the
					// message clause is pinned by 10b with the stdio transport's spelling.
					throw Object.assign(new Error("The operation was aborted due to timeout"), {
						name: "TimeoutError",
					});
				},
			};

			const summary = await dispatchPendingJobs(db, t, config());

			// THE CLAIM: TWO submissions against 9001. Without the re-probe the timeout
			// reads as "reap-failed", the vmid stays held, and job B is refused
			// `vmid already dispatched this pass` -- the live starvation.
			expect(ran.map((p) => p.vmid)).toEqual([9001, 9001]);
			// The reap WAS attempted and it was the DONE call that timed out.
			expect(doneCalls).toEqual([9001]);
			// EXACTLY TWO reads: the sf#179 identity check before `done`, then the ONE
			// sf#402 re-probe after it timed out. A third would mean the probe retried,
			// and retrying a probe is how a read-only check becomes a stall.
			expect(listCalls).toHaveLength(2);

			expect(summary.dispatched).toBe(1);
			expect(summary.errored).toBe(1);
			expect(summary.queued).toBe(0);

			const [a] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobA as number));
			const [b] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobB as number));
			expect(a?.status).toBe("pending");
			expect(b?.status).toBe("running");
		});
	});

	test("a timed-out done whose re-probe still shows the vmid is HELD", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [jobA, jobB] = await seedRepoWithJobs(db, 2);
			// The same timeout, the opposite answer. The probe is what decides, so it
			// must be able to say NO: 9001 is still listed and `running`, meaning the
			// box survived the timed-out `done` and may still be running job A's work.
			// Handing the number back would put job B onto a live box -- precisely the
			// harm the pre-sf#402 hold existed to prevent, which the fix must preserve.
			const ran: RunnerRunParams[] = [];
			const doneCalls: number[] = [];
			const listCalls: number[] = [];
			const t: RunnerTransport = {
				startBandMember: async () => {
					throw new Error("not implemented");
				},
				stopBandMember: async () => {
					throw new Error("not implemented");
				},
				listBand: async () => {
					throw new Error("not implemented");
				},
				needed: async (): Promise<RunnerAllocation> => ({
					ok: true,
					boxes: [{ vmid: 9001, size: "medium" }],
				}),
				run: async (p: RunnerRunParams) => {
					ran.push(p);
					if (ran.length === 1) {
						throw new Error("CONNECTION_ERROR: failed to communicate with local daemon");
					}
				},
				list: async () => {
					listCalls.push(9001);
					return [{ vmid: 9001, status: "running", name: "CT118", jobId: null, spawnIso: null }];
				},
				done: async (vmid: number) => {
					doneCalls.push(vmid);
					// The stdio transport's live error (`transport.ts` invoke timer race): a plain
					// Error with no `name`, so ONLY the message clause of `isTransportTimeout`
					// can match it.
					throw new Error("runner-boxes runner_done timed out after 90000ms");
				},
			};

			const summary = await dispatchPendingJobs(db, t, config());

			// THE CLAIM: ONE submission. The probe ran and REFUTED the reap.
			expect(ran.map((p) => p.vmid)).toEqual([9001]);
			expect(doneCalls).toEqual([9001]);
			// EXACTLY THREE reads: the sf#179 identity check before done, the ONE sf#402
			// re-probe after it timed out, and the ONE sf#418 collision-gate re-probe when
			// job B is offered the held vmid. A fourth would mean a probe retried.
			expect(listCalls).toHaveLength(3);

			expect(summary.dispatched).toBe(0);
			expect(summary.errored).toBe(1);
			expect(summary.queued).toBe(1);

			const [a] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobA as number));
			const [b] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobB as number));
			expect(a?.status).toBe("pending");
			expect(b?.status).toBe("pending");
			expect(b?.nextAttemptAt).toBeTruthy();
		});
	});

	test("a held-unproven vmid is re-probed at the collision gate: the vmid is gone by now, so the next job runs", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const [jobA, jobB] = await seedRepoWithJobs(db, 2);
			// The sf#418 shape, live on the watcher host: job A abandons, its reap TIMES OUT, and
			// the sf#402 re-probe still SEES 9001 (destroy in flight) -- so the vmid is
			// held, correctly. The gateway then re-reports that SAME vmid to job B, and
			// before this fix job B was refused at the take() gate without anyone asking
			// whether the box had finished dying in the meantime. One in-flight reap
			// poisoned the whole pass: 88 refusals, 0 dispatched.
			//
			// The hold is held-UNPROVEN (a reap that timed out and could not be proven),
			// not held by a live sibling. That distinction is what earns ONE read-only
			// list() at the collision gate: 9001 is gone by now, so the hold is cleared
			// and job B dispatches on the re-placed box. Nothing destructive is retried.
			const ran: RunnerRunParams[] = [];
			const doneCalls: number[] = [];
			let listCalls = 0;
			const t: RunnerTransport = {
				startBandMember: async () => {
					throw new Error("not implemented");
				},
				stopBandMember: async () => {
					throw new Error("not implemented");
				},
				listBand: async () => {
					throw new Error("not implemented");
				},
				needed: async (): Promise<RunnerAllocation> => ({
					ok: true,
					boxes: [{ vmid: 9001, size: "medium" }],
				}),
				run: async (p: RunnerRunParams) => {
					ran.push(p);
					if (ran.length === 1) {
						throw new Error("CONNECTION_ERROR: failed to communicate with local daemon");
					}
				},
				list: async () => {
					listCalls += 1;
					// Reads 1 and 2 are job A's sf#179 identity check and its sf#402 re-probe:
					// the destroy is still in flight, so 9001 is PRESENT and the vmid is held.
					// Read 3 is job B's collision-gate re-probe, by which time the box is gone.
					return listCalls <= 2
						? [{ vmid: 9001, status: "running", name: "CT118", jobId: null, spawnIso: null }]
						: [];
				},
				done: async (vmid: number) => {
					doneCalls.push(vmid);
					throw new Error("runner-boxes runner_done timed out after 90000ms");
				},
			};

			const summary = await dispatchPendingJobs(db, t, config());

			// THE CLAIM: job B RUNS on 9001 rather than being refused by a stale hold.
			expect(ran.map((p) => p.vmid)).toEqual([9001, 9001]);
			// The destructive verb was attempted exactly once and never retried here.
			expect(doneCalls).toEqual([9001]);
			expect(summary.dispatched).toBe(1);
			expect(summary.errored).toBe(1);
			expect(summary.queued).toBe(0);

			const [a] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobA as number));
			const [b] = await db
				.select()
				.from(jobs)
				.where(eq(jobs.id, jobB as number));
			expect(a?.status).toBe("pending");
			expect(b?.status).toBe("running");
		});
	});

	test("createPassVmids: a take is exclusive within one ledger and free across ledgers", () => {
		const pass = createPassVmids();
		expect(pass.take(9001)).toBe(true);
		expect(pass.take(9001)).toBe(false);
		expect(pass.take(9002)).toBe(true);
		// A fresh ledger is a fresh pass and knows nothing of the previous one.
		expect(createPassVmids().take(9001)).toBe(true);
	});
});
