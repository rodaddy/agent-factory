/**
 * sf#179 — DISPATCH-TIME box attribution.
 *
 * The gap #149 left open: every attribution write in `dispatchJob` happened
 * AFTER `transport.needed()` returned or threw. The `runner_job_id` — the tag the
 * fleet stamps on the box it places — was minted in memory and existed nowhere in
 * the watcher's database while the verb was in flight.
 *
 * `runner_needed` is the one verb that routinely takes ~60s and, per
 * `_DOCS/runner-contract.md`, COMPLETES server-side when it times out
 * client-side. A watcher restart, crash, or deploy inside that window therefore
 * left a placed box tagged with an id no row anywhere had ever recorded: the
 * reclaimer's `releaseReclaimedBox` reads `job_attempts` and found none, and
 * `runner_list` could show the box without the operator being able to say which
 * job it belonged to.
 *
 * These tests pin the INTENT row: written before the verb fires, carrying the
 * runner job id and NO invented vmid, and reconciled by every downstream path.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { JobTemplateConfig } from "../../src/config/schema";
import { jobAttempts, jobs, repositories } from "../../src/db/schema";
import { ALLOCATING_ATTEMPT_STATUS } from "../../src/runner/attempt-record";
import { dispatchJob } from "../../src/runner/dispatch";
import { traceparentFor } from "../../src/runner/trace-context";
import {
	type RunnerAllocation,
	RunnerAllocationUnknownError,
	type RunnerRunParams,
	type RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

const template: JobTemplateConfig = {
	id: "pr-review",
	label: "PR review",
	runner_size: "medium",
	return_mode: "patch",
};

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

function fakeTransport(overrides: Partial<RunnerTransport> = {}): RunnerTransport & {
	reaped: number[];
} {
	const reaped: number[] = [];
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
		reaped,
		needed:
			overrides.needed ??
			(async (): Promise<RunnerAllocation> => ({
				ok: true,
				boxes: [{ vmid: 9001, size: "medium" }],
			})),
		run: overrides.run ?? (async (_p: RunnerRunParams) => {}),
		list: async () => [],
		done:
			overrides.done ??
			(async (vmid: number) => {
				reaped.push(vmid);
			}),
	};
}

async function seedJob(db: Db) {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const [job] = await db
		.insert(jobs)
		.values({ repositoryId: repo.id, sha: "abc123", jobType: "pr-review", status: "pending" })
		.returning();
	if (!job) throw new Error("seed failed");
	return { ...job, repository: "rodaddy/x", provider: "github" as const, itemNumber: 42 };
}

const attemptsOf = (db: Db, jobId: number) =>
	db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId));

describe("sf#179 dispatch-time attribution", () => {
	test("the intent row exists BEFORE the allocation verb is called", async () => {
		await withTestDb(async (db) => {
			// THE CORE CLAIM. Observed from inside `needed()` — the exact instant a
			// crash would strand a placed box — the row must already name this
			// dispatch. Mutation proof: move `recordAllocationIntent` after the
			// `transport.needed` call in `acquireRunnerBox` and this goes RED.
			const job = await seedJob(db);
			let inFlight: Awaited<ReturnType<typeof attemptsOf>> = [];
			const t = fakeTransport({
				needed: async (): Promise<RunnerAllocation> => {
					inFlight = await attemptsOf(db, job.id);
					return { ok: true, boxes: [{ vmid: 9001, size: "medium" }] };
				},
			});

			await dispatchJob({ db, transport: t, job, template });

			expect(inFlight.length).toBe(1);
			expect(inFlight[0]?.status).toBe(ALLOCATING_ATTEMPT_STATUS);
			// The tag the fleet stamps on the box: without it in the DB, a placed box
			// is nameable by nothing.
			expect(inFlight[0]?.runnerJobId).toBeTruthy();
			// NO INVENTED VMID. The verb has not answered yet, so there is nothing
			// honest to write here.
			expect(inFlight[0]?.runnerVmid).toBeNull();
			expect(inFlight[0]?.finishedAt).toBeNull();
		});
	});

	test("a LOST response leaves the intent row naming the job, with a null vmid", async () => {
		await withTestDb(async (db) => {
			// The attempt-158 shape: the verb timed out client-side and generally
			// completed server-side. The row must say "go look" and must NOT guess a
			// vmid — naming one sends an operator to reap a box that may belong to
			// another job.
			const job = await seedJob(db);
			const t = fakeTransport({
				needed: async () => {
					throw new RunnerAllocationUnknownError(
						"runner_needed outcome UNKNOWN: transport fault (exit 1)",
					);
				},
			});

			await dispatchJob({ db, transport: t, job, template });

			const rows = await attemptsOf(db, job.id);
			// ONE row, not two: the throw path RECONCILES the intent row it already
			// wrote rather than inserting a second one, which the partial unique index
			// on `runner_job_id` would reject anyway.
			expect(rows.length).toBe(1);
			expect(rows[0]?.runnerVmid).toBeNull();
			expect(rows[0]?.status).toBe("failed");
			expect(rows[0]?.runnerJobId).toBeTruthy();
			expect(rows[0]?.failureSummary).toContain("box may be running unattributed");
			expect(rows[0]?.finishedAt).not.toBeNull();
		});
	});

	test("a CLEAN refusal that placed nothing retires its intent row", async () => {
		await withTestDb(async (db) => {
			// A refusal the verb ANSWERED proves nothing was placed, so the intent row
			// has no box to name and is retired. Leaving it would bury the rows that
			// carry a real stranded box under one per capacity refusal — the invariant
			// #149 established and this must not regress.
			const job = await seedJob(db);
			const t = fakeTransport({
				needed: async () => ({
					ok: false,
					refused: true,
					reason: "runner capacity unavailable",
				}),
			});

			await dispatchJob({ db, transport: t, job, template });

			expect((await attemptsOf(db, job.id)).length).toBe(0);
		});
	});

	test("a refusal that DID place a box keeps one row carrying its vmid", async () => {
		await withTestDb(async (db) => {
			// #149's partial-placement property, preserved through the intent row: the
			// reap is best-effort, so the row is the only thing that can name a box
			// whose reap failed.
			const job = await seedJob(db);
			const t = fakeTransport({
				needed: async () => ({
					ok: false,
					refused: true,
					reason: "runner capacity unavailable",
					placed: [{ vmid: 9003, size: "medium" }],
				}),
			});

			await dispatchJob({ db, transport: t, job, template });

			const rows = await attemptsOf(db, job.id);
			expect(rows.length).toBe(1);
			expect(rows[0]?.runnerVmid).toBe(9003);
			expect(rows[0]?.status).toBe("failed");
			expect(rows[0]?.failureSummary).toContain("9003");
		});
	});

	test("a successful dispatch ends on ONE submitted row carrying the vmid", async () => {
		await withTestDb(async (db) => {
			// The already-populated path is UNCHANGED as observed from outside: one
			// row, `submitted`, with the placed vmid. Only its arrival time moved
			// earlier.
			const job = await seedJob(db);
			const t = fakeTransport();

			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("dispatched");
			const rows = await attemptsOf(db, job.id);
			expect(rows.length).toBe(1);
			expect(rows[0]?.status).toBe("submitted");
			expect(rows[0]?.runnerVmid).toBe(9001);
			expect(rows[0]?.finishedAt).toBeNull();
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("running");
			expect(row?.activeAttemptId).toBe(rows[0]?.id ?? -1);
		});
	});

	test("the intent status is NON-TERMINAL, so the orphan sweep can reach it", async () => {
		// A stranded intent row must be swept by the SAME `notInArray(TERMINAL)`
		// machinery #149 built, not need a new reconciliation of its own.
		const { TERMINAL_ATTEMPT_STATUSES } = await import("../../src/reconcile/attempt-lifecycle");
		expect([...TERMINAL_ATTEMPT_STATUSES]).not.toContain(ALLOCATING_ATTEMPT_STATUS);
	});
});

describe("sf#707 the dispatch produces a traceparent", () => {
	test("the correlator is set BEFORE the verb, and names the intent attempt", async () => {
		await withTestDb(async (db) => {
			// THE CORE CLAIM. A traceparent set after `needed()` correlates nothing:
			// the allocation is the call we want to trace. Observed from inside the
			// verb, exactly like the sf#179 test above, because "before" is the
			// whole property. Mutation proof: move the `setTraceparent` block below
			// the `transport.needed` call in `acquireRunnerBox` and this goes RED.
			const job = await seedJob(db);
			let seenAtVerb: string | undefined;
			let inFlight: Awaited<ReturnType<typeof attemptsOf>> = [];
			// A transport that CAN carry a correlator, which the mcp2cli fake cannot.
			let carried: string | undefined;

			const base = fakeTransport({
				needed: async (): Promise<RunnerAllocation> => {
					seenAtVerb = carried;
					inFlight = await attemptsOf(db, job.id);
					return { ok: true, boxes: [{ vmid: 9001, size: "medium" }] };
				},
			});
			const t = Object.assign(base, {
				setTraceparent(value: string | undefined) {
					carried = value;
				},
			});

			await dispatchJob({ db, transport: t, job, template });

			expect(inFlight.length).toBe(1);
			const attemptId = inFlight[0]?.id;
			expect(attemptId).toBeTruthy();
			// Derived from the attempt the intent row wrote, not from anything else.
			expect(seenAtVerb).toBe(traceparentFor(attemptId as number));
			// W3C shape, version 00 and sampled.
			expect(seenAtVerb).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		});
	});

	test("a transport that cannot carry one still dispatches", async () => {
		await withTestDb(async (db) => {
			// mcp2cli has no `_meta`. Absence of a correlator is ordinary, and must
			// never turn a working dispatch into a failure. Mutation proof: drop the
			// `carriesTraceparent` guard and this throws instead of dispatching.
			const job = await seedJob(db);
			const outcome = await dispatchJob({ db, transport: fakeTransport(), job, template });
			expect(outcome.status).toBe("dispatched");
		});
	});

	test("traceparentFor is deterministic and refuses an id it cannot encode", () => {
		// Deterministic is the point: an operator holding job_attempts.id can
		// recompute the trace the runner was sent, with nothing stored.
		expect(traceparentFor(158)).toBe(traceparentFor(158));
		expect(traceparentFor(158)).not.toBe(traceparentFor(159));
		// Neither W3C field may be all-zero, which a non-positive id would produce.
		expect(() => traceparentFor(0)).toThrow();
		expect(() => traceparentFor(-1)).toThrow();
	});
});
