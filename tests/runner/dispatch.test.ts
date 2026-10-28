import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { JobTemplateConfig } from "../../src/config/schema";
import { jobAttempts, jobs, repositories, runnerBoxes } from "../../src/db/schema";
import { PACKET_PI_DISPATCH_ENV_VAR } from "../../src/packets/dispatch-flag";
import { RUNNER_BOXES } from "../../src/runner/bands";
import { dispatchJob, newRunnerJobId } from "../../src/runner/dispatch";
import { ENGINE_ENDPOINTS, resolveRuntimeRoute } from "../../src/runner/route";
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

/** Configurable fake transport recording what it received. */
function fakeTransport(overrides: Partial<RunnerTransport> = {}): RunnerTransport & {
	ran: RunnerRunParams[];
	reaped: number[];
} {
	const ran: RunnerRunParams[] = [];
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
		ran,
		reaped,
		needed:
			overrides.needed ??
			(async (): Promise<RunnerAllocation> => ({
				ok: true,
				boxes: [{ vmid: 9001, size: "medium" }],
			})),
		run:
			overrides.run ??
			(async (p: RunnerRunParams) => {
				ran.push(p);
			}),
		list: async () => [],
		done:
			overrides.done ??
			(async (vmid: number) => {
				reaped.push(vmid);
			}),
	};
}

/**
 * Seed the runner box inventory, as `scripts/migrate.ts` does in production.
 * `withTestDb` pushes the schema but no rows, so a claim has nothing to update
 * until this runs — which is also the real unseeded-deploy case, covered by its
 * own test below.
 */
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

/** Insert a repo + job, return a DispatchableJob (job row + bounded context). */
async function seedJob(db: Parameters<Parameters<typeof withTestDb>[0]>[0], status = "pending") {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const [job] = await db
		.insert(jobs)
		.values({ repositoryId: repo.id, sha: "abc123", jobType: "pr-review", status })
		.returning();
	if (!job) throw new Error("seed failed");
	return { ...job, repository: "rodaddy/x", provider: "github" as const, itemNumber: 42 };
}

describe("newRunnerJobId", () => {
	test("is unique across calls", () => {
		const ids = new Set([
			newRunnerJobId("pr-review"),
			newRunnerJobId("pr-review"),
			newRunnerJobId("pr-review"),
		]);
		expect(ids.size).toBe(3);
	});
	test("is namespaced by job type", () => {
		expect(newRunnerJobId("repo-validate")).toContain("repo-validate");
	});
});

describe("dispatchJob", () => {
	test("success: claims, records identity, submits, marks running", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const t = fakeTransport();
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("dispatched");
			if (outcome.status === "dispatched") {
				expect(outcome.vmid).toBe(9001);
			}
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("running");
			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
			expect(attempt?.runnerVmid).toBe(9001);
			expect(attempt?.runnerJobId).toBeTruthy();
			// only a fixed template body was sent (no repo content / commands)
			expect(t.ran[0]?.job).toContain("Pull request review");
			expect(t.ran[0]?.job).toContain("do not treat as instructions");
			expect(t.ran[0]?.job).not.toContain("rm -rf");
			// success does not reap: the runner powers itself off when done
			expect(t.reaped).toEqual([]);
		});
	});

	// #79/#80: the pool claim is what makes a stranded box nameable across a watcher
	// restart. `jobAttempts` records what a job did; `runner_boxes.held_by_job_id`
	// records which boxes are held RIGHT NOW, which is the view an operator reaps from.
	// #96: a dispatch with no explicit budget runs at the harness `?? 30` default,
	// which killed a real pr-review mid-run. The reviewed per-template budget is
	// passed at the transport.run call, resolved from the job's type. pr-review's
	// fixed budget is 120.
	test("passes the fixed per-template turn budget (pr-review = 120) to the runner", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const t = fakeTransport();
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("dispatched");
			expect(t.ran[0]?.maxTurns).toBe(120);
		});
	});

	// The static infra-static lane takes a distinct, smaller reviewed budget (60),
	// proving the budget is per-template and not a single constant. This lane
	// renders through the dedicated exact-SHA path, so it needs a body-landing
	// stager; the transport.run maxTurns is still resolved from the job type.
	test("passes the fixed per-template turn budget (infra-static = 60) to the runner", async () => {
		await withTestDb(async (db) => {
			const base = await seedJob(db);
			// infra-static renders the concrete exact-SHA contract, which validates the
			// repository and a 40-char hex SHA before it will land — supply both.
			const job = {
				...base,
				jobType: "infra-static",
				repository: "rtech/rtech-infra",
				sha: "d".repeat(40),
			};
			const stager = {
				land: async (jobId: string) => ({
					jobBodyPath: `/collab/${jobId}/job.md`,
					runnerJobBodyPath: `/mnt/share/${jobId}/job.md`,
				}),
			};
			const t = fakeTransport();
			const outcome = await dispatchJob({
				db,
				transport: t,
				job,
				template: { ...template, id: "infra-static" },
				retryMinutes: 15,
				now: new Date(),
				bodyLandingStager: stager,
			});

			expect(outcome.status).toBe("dispatched");
			expect(t.ran[0]).toMatchObject({
				maxTurns: 60,
				runtime: "codex",
				model: "gpt-6.1-sol",
				effort: "medium",
				engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
			});
		});
	});

	test("a dispatched box is claimed in runner_boxes, attributed to its runner job id", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedJob(db);
			const t = fakeTransport();
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("dispatched");
			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			// Attributed to the SAME runner job id the attempt recorded, or the claim
			// cannot be correlated back to the job that owns the box.
			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
			expect(box?.heldByJobId).toBe(attempt?.runnerJobId ?? "");
			expect(box?.heldAt).toBeInstanceOf(Date);
		});
	});

	test("a reaped box has its claim cleared, so a failed dispatch leaves nothing held", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedJob(db);
			// Submission fails after allocation, so dispatch reaps the box it took.
			const t = fakeTransport({
				run: async () => {
					throw new Error("submission error");
				},
			});
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("error");
			expect(t.reaped).toEqual([9001]);
			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			// A claim outliving its box is a FALSE leak report, and a false leak is what
			// makes a real one easy to dismiss.
			expect(box?.heldByJobId).toBeNull();
			expect(box?.heldAt).toBeNull();
		});
	});

	test("a stale reap does NOT clear or power off a box a newer attempt already claimed", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedJob(db);
			// The interleaving: this dispatch's submission fails, and while it is
			// failing the fleet recycles 9001 and a LATER attempt claims it. The reap
			// that follows must not touch the box — clearing the claim would report a
			// live box as free, and calling done() on it would power off a running job.
			const t = fakeTransport({
				run: async () => {
					await db
						.update(runnerBoxes)
						.set({ heldByJobId: "rw-newer-attempt", heldAt: new Date() })
						.where(eq(runnerBoxes.vmid, 9001));
					throw new Error("submission error");
				},
			});
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("error");
			// The box belongs to someone else now, so it must NOT be reaped.
			expect(t.reaped).toEqual([]);
			const [box] = await db.select().from(runnerBoxes).where(eq(runnerBoxes.vmid, 9001));
			expect(box?.heldByJobId).toBe("rw-newer-attempt");
		});
	});

	// #85: a stale attempt's submission failure must not release a job a newer
	// attempt now owns. During A's submission the reclaimer re-pends the job and B
	// claims + owns it (`active_attempt_id = B`). When A's submission then throws, its
	// release is scoped to A's own attempt id, so it matches zero rows and B's live
	// `running` job is left untouched — never reverted to `pending`, which would let a
	// third dispatch start while B still runs.
	test("a stale attempt's submission failure does NOT release a job a newer attempt owns", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedJob(db);
			let newerAttemptId = 0;
			const t = fakeTransport({
				run: async () => {
					// Model the reclaimer + B taking over WHILE A's submission is in flight:
					// the job is re-pended and re-dispatched under a newer attempt B that now
					// owns it. B's attempt row and the ownership marker are written here.
					const [b] = await db
						.insert(jobAttempts)
						.values({
							jobId: job.id,
							runnerJobId: "rw-newer-B",
							runnerVmid: 9002,
							status: "submitted",
						})
						.returning({ id: jobAttempts.id });
					newerAttemptId = b?.id ?? 0;
					await db
						.update(jobs)
						.set({ status: "running", activeAttemptId: newerAttemptId })
						.where(eq(jobs.id, job.id));
					throw new Error("submission error");
				},
			});
			const outcome = await dispatchJob({
				db,
				transport: t,
				job,
				template,
				retryMinutes: 15,
				now: new Date(),
			});

			expect(outcome.status).toBe("error");
			// B's job is untouched: still running, still owned by B — NOT reverted to
			// pending by A's stale failure.
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("running");
			expect(row?.activeAttemptId).toBe(newerAttemptId);
		});
	});

	// #85: an attempt superseded between recording its row and its `running` write
	// (the reclaimer re-pended it out of `dispatching`) must not resurrect ownership.
	test("an attempt superseded before the running write does not mark the job running", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedJob(db);
			// After A takes ownership at `dispatching`, a concurrent reclaim re-pends it
			// and B claims + owns it. A's `running` write is guarded on A's ownership, so
			// it matches nothing and B's ownership stands.
			let newerAttemptId = 0;
			const t = fakeTransport({
				run: async () => {
					const [b] = await db
						.insert(jobAttempts)
						.values({
							jobId: job.id,
							runnerJobId: "rw-took-over",
							runnerVmid: 9002,
							status: "submitted",
						})
						.returning({ id: jobAttempts.id });
					newerAttemptId = b?.id ?? 0;
					await db
						.update(jobs)
						.set({ status: "running", activeAttemptId: newerAttemptId })
						.where(eq(jobs.id, job.id));
				},
			});
			const outcome = await dispatchJob({ db, transport: t, job, template });

			// A's dispatch reports dispatched (its own submit succeeded), but the job
			// remains owned by B — A's running write matched zero rows.
			expect(outcome.status).toBe("dispatched");
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.activeAttemptId).toBe(newerAttemptId);
		});
	});

	test("an unseeded runner_boxes table does not fail the dispatch", async () => {
		// The claim is bookkeeping, not a lock. `runner_needed` has already placed the
		// box by then, so refusing to run on a bookkeeping miss would STRAND it — the
		// exact harm the claim exists to make visible. Deliberately no seedBoxes() here.
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const t = fakeTransport();
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("dispatched");
			expect(t.ran).toHaveLength(1);
			expect(t.reaped).toEqual([]);
		});
	});

	test("skipped: a job that is not pending is never dispatched", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db, "running");
			const t = fakeTransport();
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("skipped");
			expect(t.ran).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("running"); // untouched
			expect(
				(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id))).length,
			).toBe(0);
		});
	});

	test("unknown template: an unallowlisted job type is never dispatched", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const rogue = { ...job, jobType: "exfiltrate-secrets" };
			const t = fakeTransport();
			const outcome = await dispatchJob({ db, transport: t, job: rogue, template });

			expect(outcome.status).toBe("skipped");
			expect(t.ran).toEqual([]); // no runner ever allocated or fired
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending"); // released, not lost
		});
	});

	test("deploy-smoke: a persisted deploy-smoke row is refused without a generic body", async () => {
		// deploy-smoke is a doctor-probe-only lane: even a stray persisted row must
		// never be dispatched through the generic renderJobBody path (which would embed
		// repository/SHA metadata). dispatchJob refuses it BEFORE any body render or
		// runner allocation, releasing the claim so the row is not lost.
		await withTestDb(async (db) => {
			const job = { ...(await seedJob(db)), jobType: "deploy-smoke" };
			const t = fakeTransport();
			const outcome = await dispatchJob({
				db,
				transport: t,
				job,
				template: { ...template, id: "deploy-smoke" },
			});

			expect(outcome.status).toBe("skipped");
			if (outcome.status === "skipped") {
				expect(outcome.reason).toContain("doctor-probe-only");
			}
			// No generic body was rendered or sent, and no runner was ever allocated.
			expect(t.ran).toEqual([]);
			expect(t.reaped).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending"); // released, not lost
			expect(
				(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id))).length,
			).toBe(0);
		});
	});

	test("refusal: capacity exhausted releases to pending with a bounded next-attempt", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const now = new Date("2026-07-19T00:00:00.000Z");
			const t = fakeTransport({
				needed: async () => ({ ok: false, refused: true, reason: "runner capacity unavailable" }),
			});
			const outcome = await dispatchJob({ db, transport: t, job, template, retryMinutes: 15, now });

			expect(outcome.status).toBe("queued");
			if (outcome.status === "queued") {
				expect(outcome.retryAfterMinutes).toBe(15);
			}
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending"); // not lost
			// backoff persisted 15 minutes ahead so the next pass defers it
			expect(row?.nextAttemptAt?.toISOString()).toBe("2026-07-19T00:15:00.000Z");
			expect(
				(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id))).length,
			).toBe(0);
		});
	});

	test("allocation error: records a failed attempt, releases job to pending", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const t = fakeTransport({
				needed: async () => {
					throw new Error("mcp connection error");
				},
			});
			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("error");
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending");
			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
			expect(attempt?.status).toBe("failed");
			expect(attempt?.failureSummary).toContain("mcp connection error");
			// A `failed` attempt is TERMINAL on write: attempt 158 sat `failed`
			// with a NULL finish time, so nothing could tell a dead row from a live one.
			expect(attempt?.finishedAt).not.toBeNull();
		});
	});

	describe("#149 the attempt row tells the truth about the placement", () => {
		test("an UNKNOWN allocation outcome says the box may be running unattributed", async () => {
			await withTestDb(async (db) => {
				// Attempt 158's exact shape: `runner_needed` timed out client-side and
				// generally COMPLETED server-side, placing a box whose vmid never came
				// back. The fix cannot invent that vmid — but the row must stop reading
				// like an ordinary failure, or an operator has no reason to go look.
				const job = await seedJob(db);
				const t = fakeTransport({
					needed: async () => {
						throw new RunnerAllocationUnknownError(
							"runner_needed outcome UNKNOWN: transport fault (exit 1)",
						);
					},
				});
				const outcome = await dispatchJob({ db, transport: t, job, template });

				expect(outcome.status).toBe("error");
				const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
				expect(attempt?.status).toBe("failed");
				// No vmid is INVENTED: naming one would send an operator to reap a box
				// that may belong to another job.
				expect(attempt?.runnerVmid).toBeNull();
				expect(attempt?.failureSummary).toContain("outcome unknown");
				expect(attempt?.failureSummary).toContain("box may be running unattributed");
				expect(attempt?.finishedAt).not.toBeNull();
			});
		});

		test("a verb that RAN and plainly failed gets no unattributed-box hint", async () => {
			await withTestDb(async (db) => {
				// A `runner_needed` that ran and failed placed NOTHING. Printing the
				// go-look hint here would train operators to skip it on the one shape
				// where it matters.
				const job = await seedJob(db);
				const t = fakeTransport({
					needed: async () => {
						throw new Error("runner_needed failed (exit 1)");
					},
				});
				await dispatchJob({ db, transport: t, job, template });

				const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
				expect(attempt?.failureSummary).toContain("runner_needed failed");
				expect(attempt?.failureSummary).not.toContain("box may be running unattributed");
			});
		});

		test("a refusal's PARTIAL PLACEMENT is persisted with its vmid, not just reaped", async () => {
			await withTestDb(async (db) => {
				// A capacity refusal can carry boxes the verb already powered on. They
				// are reaped best-effort — and `reap` swallows a failure — so without a
				// row naming the vmid a surviving box is reachable by nothing.
				const job = await seedJob(db);
				const t = fakeTransport({
					needed: async () => ({
						ok: false,
						refused: true,
						reason: "runner capacity unavailable",
						placed: [{ vmid: 9003, size: "medium" }],
					}),
				});
				const outcome = await dispatchJob({ db, transport: t, job, template });

				expect(outcome.status).toBe("queued");
				expect(t.reaped).toEqual([9003]);
				const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
				expect(attempt?.runnerVmid).toBe(9003); // nameable by an operator query
				expect(attempt?.status).toBe("failed");
				expect(attempt?.failureSummary).toContain("runner capacity unavailable");
				expect(attempt?.failureSummary).toContain("9003");
			});
		});

		test("a refusal that placed NOTHING writes no attempt row", async () => {
			await withTestDb(async (db) => {
				// There is no placement to record and no box to find. A row per empty
				// refusal would bury the ones that carry a real stranded box.
				const job = await seedJob(db);
				const t = fakeTransport({
					needed: async () => ({
						ok: false,
						refused: true,
						reason: "runner capacity unavailable",
					}),
				});
				await dispatchJob({ db, transport: t, job, template });

				expect(
					(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id))).length,
				).toBe(0);
			});
		});

		test("a placement whose REAP FAILED is still named by its attempt row", async () => {
			await withTestDb(async (db) => {
				// The case that makes this fix load-bearing rather than cosmetic: the
				// reap threw, so the box is very likely still live — and the row is the
				// only thing that can name it.
				const job = await seedJob(db);
				const t = fakeTransport({
					needed: async () => ({
						ok: false,
						refused: true,
						reason: "runner capacity unavailable",
						placed: [{ vmid: 9004, size: "medium" }],
					}),
					list: async () => [],
					done: async () => {
						throw new Error("runner_done outcome UNKNOWN for vmid 9004");
					},
				});
				await dispatchJob({ db, transport: t, job, template });

				const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
				expect(attempt?.runnerVmid).toBe(9004);
				expect(attempt?.failureSummary).toContain("reap-failed");
			});
		});
	});

	test("submission timeout: box proven gone by list, records failure and releases with backoff", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const now = new Date("2026-07-19T00:00:00.000Z");
			const t = fakeTransport({
				run: async () => {
					// The HTTP transport's AbortSignal.timeout rejection (PR #575 F2: classified by
					// the transport's own shape, never by "timed out" text).
					const timeout = new Error("The operation timed out.");
					timeout.name = "TimeoutError";
					throw timeout;
				},
			});
			const outcome = await dispatchJob({ db, transport: t, job, template, retryMinutes: 15, now });

			expect(outcome.status).toBe("error");
			if (outcome.status === "error") {
				expect(outcome.vmid).toBe(9001); // surfaced so the caller can reconcile
			}
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending");
			// a wedged runner is backed off, not churned every pass
			expect(row?.nextAttemptAt?.toISOString()).toBe("2026-07-19T00:15:00.000Z");
			// sf#564: a TIMEOUT never reaps. This fake's `list` returns [], which PROVES
			// the box gone, so there is nothing left to power off.
			expect(t.reaped).toEqual([]);
			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
			expect(attempt?.runnerVmid).toBe(9001); // traceable
			expect(attempt?.status).toBe("failed");
			expect(attempt?.failureSummary).toContain("timed out");
			expect(attempt?.failureSummary).toContain("runner_run failed after");
			expect(attempt?.failureSummary).toMatch(/after \d+ ms:/);
		});
	});

	test("submission error that is NOT a timeout keeps the reap-and-release path", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const now = new Date("2026-07-19T00:00:00.000Z");
			const t = fakeTransport({
				run: async () => {
					// A verb that genuinely RAN and failed — no ambiguity about the box.
					throw new Error("runner_run failed (exit 1) -- boom");
				},
			});
			const outcome = await dispatchJob({ db, transport: t, job, template, retryMinutes: 15, now });

			expect(outcome.status).toBe("error");
			expect(t.reaped).toEqual([9001]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending");
			expect(row?.nextAttemptAt?.toISOString()).toBe("2026-07-19T00:15:00.000Z");
			const [attempt] = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
			expect(attempt?.status).toBe("failed");
			expect(attempt?.failureSummary).toContain("runner_run failed (exit 1)");
		});
	});

	test("ambiguous completion: ok=true with no box releases to pending as queued", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const t = fakeTransport({
				needed: async () => ({ ok: true, boxes: [] }),
			});
			const outcome = await dispatchJob({ db, transport: t, job, template });
			expect(outcome.status).toBe("queued");
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending");
			expect(t.reaped).toEqual([]); // nothing to reap
			expect(
				(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id))).length,
			).toBe(0);
		});
	});

	test("surplus allocation: reaps EVERY returned box and never runs on it", async () => {
		// We request one box and the reap-guarded region below can release exactly
		// one, so running on a surplus allocation would strand the extras. The verb
		// caps placement at the requested count, so this is not reachable today —
		// the guard exists so that if it ever becomes reachable, nothing leaks.
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const now = new Date("2026-07-19T00:00:00.000Z");
			const t = fakeTransport({
				needed: async () => ({
					ok: true,
					boxes: [
						{ vmid: 9001, size: "medium" },
						{ vmid: 9002, size: "medium" },
					],
				}),
			});
			const outcome = await dispatchJob({ db, transport: t, job, template, retryMinutes: 15, now });

			expect(outcome.status).toBe("queued");
			// every box released, not just the one we would have used
			expect(t.reaped).toEqual([9001, 9002]);
			expect(t.ran).toEqual([]); // never submitted
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending"); // not lost
			expect(row?.nextAttemptAt?.toISOString()).toBe("2026-07-19T00:15:00.000Z");
			// The allocator NAMED these boxes, so the placement is persisted.
			// This assertion previously read `.toBe(0)` — that encoded the leak: the
			// reap is best-effort and can fail, and a surviving box that no attempt row
			// names is reachable by no automated cleanup path at all.
			const attempts = await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id));
			expect(attempts.length).toBe(1); // one row, one minted runner_job_id
			expect(attempts[0]?.status).toBe("failed");
			expect(attempts[0]?.runnerVmid).toBe(9001); // the first placed box, actionable by vmid
			expect(attempts[0]?.finishedAt).not.toBeNull(); // terminal on write
			// The surplus box is not lost either: the summary names the whole set.
			expect(attempts[0]?.failureSummary).toContain("9002");
		});
	});

	test("concurrent dispatch of the same job: exactly one wins, one box", async () => {
		await withTestDb(async (db) => {
			const job = await seedJob(db);
			const t = fakeTransport();
			const [a, b] = await Promise.all([
				dispatchJob({ db, transport: t, job, template }),
				dispatchJob({ db, transport: t, job, template }),
			]);
			const outcomes = [a.status, b.status].sort();
			// one dispatch claims the job; the other is skipped — never two boxes.
			expect(outcomes).toEqual(["dispatched", "skipped"]);
			expect(t.ran.length).toBe(1);
			const running = await db
				.select()
				.from(jobs)
				.where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
			expect(running.length).toBe(1);
		});
	});
});

/**
 * #171 — a packet's DECLARED route reaches the pi invocation, but only behind the
 * kill switch.
 *
 * A packet is the agent's entire pi system prompt (proven end to end by the
 * #110 pilot), and #171 wires the factory half. The wrapper half is rtech-infra's
 * and is not running — the live verb dies on any runtime other than
 * `claude|codex` — so the EMISSION of the trio is gated on
 * `PACKET_PI_DISPATCH_ENABLED`, DEFAULT OFF. These tests pin all four properties:
 * the flag defaults off and the payload is then byte-identical to pre-#171, the
 * declared route travels verbatim when the flag is on, a route-less render fails
 * closed on the #95 release-and-skip path, and non-packet lanes are untouched
 * either way.
 */
const PI_ON: NodeJS.ProcessEnv = { PACKET_PI_DISPATCH_ENABLED: "1" };

describe("packet lanes carry their declared route, gated", () => {
	test("issue-triage carries codex/gpt-6.1-sol/low from its packet", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = { ...(await seedJob(db)), jobType: "issue-triage" };
			const t = fakeTransport();

			const outcome = await dispatchJob({
				db,
				transport: t,
				job,
				template: { ...template, id: "issue-triage" },
				env: PI_ON,
			});

			expect(outcome.status).toBe("dispatched");
			expect(t.ran.length).toBe(1);
			const params = t.ran[0];
			// The route is read from the REAL packet on disk, not a fixture: these are
			// the values `packets/issue-triage.md` frontmatter DECLARES (runtime
			// included — it is no longer derived from lane membership).
			expect(params?.runtime).toBe("codex");
			expect(params?.model).toBe("gpt-6.1-sol");
			expect(params?.effort).toBe("low");
			expect(params?.engineEndpoint).toEqual(ENGINE_ENDPOINTS.cliproxyapi);
			// The body is still the packet body the lane has always sent.
			expect(params?.job).toContain("# Identity");
		});
	});

	test("issue-triage dispatch gives Codex the fixed read-only issue fetch", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = { ...(await seedJob(db)), jobType: "issue-triage" };
			const t = fakeTransport();

			const outcome = await dispatchJob({
				db,
				transport: t,
				job,
				template: { ...template, id: "issue-triage" },
				env: {},
			});

			expect(outcome.status).toBe("dispatched");
			expect(t.ran[0]?.job).toContain("gh issue view 42 --repo rodaddy/x --json title,body");
		});
	});

	test("issue-triage emits its supported Codex route without the legacy pi flag", async () => {
		await withTestDb(async (db) => {
			// The legacy flag gates only runtime=pi. A supported codex declaration is
			// explicit at every deployment state and never inherits Claude.
			await seedBoxes(db);
			const job = { ...(await seedJob(db)), jobType: "issue-triage" };
			const t = fakeTransport();

			const outcome = await dispatchJob({
				db,
				transport: t,
				job,
				template: { ...template, id: "issue-triage" },
				env: {},
			});

			expect(outcome.status).toBe("dispatched");
			const params = t.ran[0];
			expect(params).toMatchObject({
				runtime: "codex",
				model: "gpt-6.1-sol",
				effort: "low",
				engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
			});
			expect(params?.job).toContain("# Identity");
		});
	});

	test("a non-packet agent lane dispatches its reviewed Codex default", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = await seedJob(db); // pr-review: a TS-literal lane
			const t = fakeTransport();

			const outcome = await dispatchJob({ db, transport: t, job, template, env: PI_ON });

			expect(outcome.status).toBe("dispatched");
			expect(t.ran[0]).toMatchObject({
				runtime: "codex",
				model: "gpt-6.1-sol",
				effort: "low",
				engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
				maxTurns: 120,
			});
		});
	});
});

describe("resolveRuntimeRoute: route emission is gated and route-less fails closed", () => {
	test("a packet lane missing its route is a named failure, never a dispatch", () => {
		const resolved = resolveRuntimeRoute("issue-triage", { body: "rendered body" }, PI_ON);

		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.reason).toContain("issue-triage");
		expect(resolved.reason).toContain("no runtime/model/effort route");
	});

	test("a route-less packet lane is refused even with the flag OFF", () => {
		// The invariant is "a packet's body and its route are one artifact", not "we
		// are emitting the route today". A body that arrived without its route means
		// the render path LOST it, and that is a defect at either flag state.
		const resolved = resolveRuntimeRoute("issue-triage", { body: "rendered body" }, {});

		expect(resolved.ok).toBe(false);
	});

	test("flag ON: a packet lane carries the runtime it DECLARED, not a derived one", () => {
		// `codex` here, deliberately: under the old derivation every packet lane was
		// forced to `pi` regardless. This asserts the declaration is what travels.
		const resolved = resolveRuntimeRoute(
			"issue-triage",
			{ body: "rendered body", routing: { runtime: "codex", model: "gpt-6.1-sol", effort: "low" } },
			PI_ON,
		);

		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.submission).toEqual({
			body: "rendered body",
			runtime: "codex",
			model: "gpt-6.1-sol",
			effort: "low",
			engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
		});
	});

	test("flag OFF: the declared route is REFUSED, not defaulted", () => {
		const resolved = resolveRuntimeRoute(
			"issue-triage",
			{ body: "rendered body", routing: { runtime: "pi", model: "gpt-6.1-sol", effort: "low" } },
			{},
		);

		// Not `runtime: "claude"`, and no longer a bare `{ body }` either: sf#386
		// refuses rather than hand the wrapper a submission naming no route at all.
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.reason).toMatch(/pi/);
	});

	test("a typo'd flag value is OFF: a kill switch is never enabled by a misspelling", () => {
		const resolved = resolveRuntimeRoute(
			"issue-triage",
			{ body: "rendered body", routing: { runtime: "pi", model: "gpt-6.1-sol", effort: "low" } },
			{ PACKET_PI_DISPATCH_ENABLED: "enabled-please" },
		);

		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.reason).toMatch(/pi/);
	});

	test("a non-packet agent lane ignores stray routing and uses its reviewed default", () => {
		const resolved = resolveRuntimeRoute(
			"pr-review",
			{ body: "rendered body", routing: { runtime: "pi", model: "gpt-6.1-sol", effort: "low" } },
			PI_ON,
		);

		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		// The stray packet-like routing is ignored; the lane's own table row wins.
		expect(resolved.submission).toEqual({
			body: "rendered body",
			runtime: "codex",
			model: "gpt-6.1-sol",
			effort: "low",
			engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
		});
	});

	/**
	 * sf#386 — the three route-less exits from `resolveRuntimeRoute`. Each one
	 * today returns `ok: true` with a bare `{ body }`, so the submission reaches
	 * the wrapper naming no model, no effort, and no engine endpoint, and the
	 * transport's Claude fallback decides. Per the sf#384/L-042 ruling every
	 * submission names a real model, effort, and engine endpoint — so an
	 * unroutable lane must REFUSE, naming what is missing, rather than dispatch.
	 */
	test("an UNKNOWN jobType with no declared runtime is REFUSED, naming the missing route", () => {
		const resolved = resolveRuntimeRoute("no-such-lane", { body: "x" }, {});

		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.reason).toMatch(/no-such-lane/);
			expect(resolved.reason).toMatch(/model/);
		}
	});

	test("a template-declared NON-script runtime without a route is REFUSED", () => {
		const resolved = resolveRuntimeRoute("no-such-lane", { body: "x", runtime: "codex" }, {});

		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.reason).toMatch(/codex/);
			expect(resolved.reason).toMatch(/model/);
		}
	});

	test("a packet pi lane with the emission flag OFF is REFUSED rather than sent unrouted", () => {
		const resolved = resolveRuntimeRoute(
			"issue-triage",
			{ body: "rendered body", routing: { runtime: "pi", model: "gpt-6.1-sol", effort: "low" } },
			{},
		);

		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.reason).toMatch(/pi/);
		}
	});

	test("a packet lane declaring gpt-6-luna below effort max is REFUSED (L-042)", () => {
		// Luna runs only at max. The packet
		// frontmatter is reviewed, but the resolver is the last factory-side gate
		// before the wire, so it refuses rather than trust the declaration.
		const resolved = resolveRuntimeRoute(
			"issue-triage",
			{
				body: "rendered body",
				routing: { runtime: "codex", model: "gpt-6-luna", effort: "low" },
			},
			PI_ON,
		);

		expect(resolved.ok).toBe(false);
		if (!resolved.ok) {
			expect(resolved.reason).toMatch(/gpt-6-luna/);
			expect(resolved.reason).toMatch(/max/);
		}
	});
});

/**
 * The failure returned by `resolveRuntimeRoute` must reach the SAME
 * release-and-skip path a null body takes: the job goes back to `pending`,
 * no runner is allocated, and its dedup key is not burned.
 *
 * #175 review: this used to be asserted ONLY through a proxy (an unknown job
 * type), because no packet on disk can render without a route — the schema
 * requires the trio. The `renderDispatch` seam makes the real branch reachable, so
 * the property is now asserted on the input that actually drives it.
 */
describe("a body-resolution failure releases the job, retryable", () => {
	test("a ROUTE-LESS packet render releases the job and allocates no runner", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = { ...(await seedJob(db)), jobType: "issue-triage" };
			const t = fakeTransport();

			const outcome = await dispatchJob({
				db,
				transport: t,
				job,
				template: { ...template, id: "issue-triage" },
				env: PI_ON,
				// A render that lost the route: the exact shape the refusal guards.
				renderDispatch: () => ({ body: "a packet body with no route" }),
			});

			expect(outcome.status).toBe("skipped");
			expect(outcome.status === "skipped" && outcome.reason).toContain(
				"no runtime/model/effort route",
			);
			expect(t.ran).toEqual([]);
			expect(t.reaped).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending");
			// Zero attempt rows: the (repo, item, sha, job_type) dedup key is NOT
			// burned, so a corrected packet re-runs this job.
			expect(
				(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id))).length,
			).toBe(0);
		});
	});

	test("no runner is allocated and the job returns to pending", async () => {
		await withTestDb(async (db) => {
			await seedBoxes(db);
			const job = { ...(await seedJob(db)), jobType: "not-a-real-lane" };
			const t = fakeTransport();

			const outcome = await dispatchJob({ db, transport: t, job, template });

			expect(outcome.status).toBe("skipped");
			expect(t.ran).toEqual([]);
			expect(t.reaped).toEqual([]);
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("pending");
			// Nothing was recorded against the job, so a corrected packet re-runs it.
			expect(
				(await db.select().from(jobAttempts).where(eq(jobAttempts.jobId, job.id))).length,
			).toBe(0);
		});
	});
});

/**
 * A route refusal releases the claim and returns `skipped` — the SAME outcome as
 * every other skip, so in a counter it is invisible. The warn line is what makes a
 * packet that declares no route diagnosable as an operator-fixable defect instead
 * of a lane that quietly never dispatches.
 *
 * CAPTURED IN A CHILD, deliberately. The logger's pino destination is
 * `pino.destination({ dest: 2, sync: true })`, which writes to fd 2 DIRECTLY —
 * verified here, not assumed: a `process.stderr.write` spy captures nothing, and
 * `spyOn(logmod, "log")` records no calls because `dispatch.ts` closed over the
 * import. Node exposes no `dup2` to redirect fd 2 in-process. So this uses the
 * same child-process capture `tests/log.test.ts` uses, which reads the real fd.
 */
describe("a route refusal is logged, not just counted", () => {
	test("a ROUTE-LESS packet render emits warn dispatch.route_refused", async () => {
		const here = new URL(".", import.meta.url).pathname;
		const snippet = `
import { dispatchJob } from "${here}../../src/runner/dispatch.ts";
import { withTestDb } from "${here}../db/helpers.ts";
import { jobs, repositories, runnerBoxes } from "${here}../../src/db/schema.ts";
import { RUNNER_BOXES } from "${here}../../src/runner/bands.ts";

await withTestDb(async (db) => {
  await db.insert(runnerBoxes).values(RUNNER_BOXES.map((b) => ({
    vmid: b.vmid, band: b.band, mac: b.mac, ip: b.ip, allocatable: b.allocatable,
  })));
  const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
  const [row] = await db.insert(jobs).values({
    repositoryId: repo.id, sha: "abc123", jobType: "issue-triage", status: "pending",
  }).returning();
  const job = { ...row, repository: "rodaddy/x", provider: "github", itemNumber: 42 };
  const outcome = await dispatchJob({
    db,
    transport: {
      needed: async () => ({ ok: true, boxes: [{ vmid: 9001, size: "medium" }] }),
      run: async () => ({ ok: true }),
      reap: async () => {},
    },
    job,
    template: { id: "issue-triage", label: "t", runner_size: "medium", return_mode: "patch" },
    env: { PACKET_PI_DISPATCH_ENABLED: "1" },
    // A render that lost its route: the exact input the refusal guards.
    renderDispatch: () => ({ body: "a packet body with no route" }),
  });
  if (outcome.status !== "skipped") throw new Error("expected skipped, got " + outcome.status);
});
`;
		const proc = Bun.spawn(["bun", "-e", snippet], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, LOG_LEVEL: "", RODADDY_WATCHER_DEBUG: "" },
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).toBe(0);

		const refusals = stderr
			.split("\n")
			.filter((l) => l.trim().startsWith("{"))
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((o) => o.msg === "dispatch.route_refused");

		expect(refusals).toHaveLength(1);
		const [only] = refusals;
		expect(only?.level).toBe("warn");
		expect(only?.job_type).toBe("issue-triage");
		// The cause names the actual defect, so an operator can fix the packet.
		expect(String(only?.cause)).toContain("no runtime/model/effort route");
	}, 60000);
});

/**
 * The flag-off drop is SILENT on the wire by design — a packet declaring `pi` and
 * a lane running on the wrapper default submit byte-identical bodies. That makes
 * the two states indistinguishable in a lane's output, so the withheld emission
 * is logged.
 *
 * CAPTURED IN A CHILD for the same reason the refusal test above is: the logger's
 * pino destination writes to fd 2 directly, so neither a `process.stderr.write`
 * spy nor `spyOn(logmod, "log")` sees these lines. `resolveRuntimeRoute` is
 * exported and pure, so the child calls it directly rather than driving a whole
 * dispatch — the log call is on that function's branch, not the caller's.
 */
describe("the flag-off drop is logged, not silent", () => {
	/** Run `resolveRuntimeRoute` calls in a child and return the parsed stderr lines. */
	async function captureRouteLogs(calls: string): Promise<Record<string, unknown>[]> {
		const here = new URL(".", import.meta.url).pathname;
		const snippet = `
import { resolveRuntimeRoute } from "${here}../../src/runner/route.ts";
${calls}
`;
		const proc = Bun.spawn(["bun", "-e", snippet], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, LOG_LEVEL: "", RODADDY_WATCHER_DEBUG: "" },
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).toBe(0);
		return stderr
			.split("\n")
			.filter((l) => l.trim().startsWith("{"))
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	}

	test("flag OFF + a packet lane WITH a route emits info dispatch.pi_flag_off", async () => {
		const lines = await captureRouteLogs(`
const resolved = resolveRuntimeRoute(
  "issue-triage",
  { body: "rendered body", routing: { runtime: "pi", model: "gpt-6.1-sol", effort: "low" } },
  {},
);
if (resolved.ok) throw new Error("expected a refusal, got ok");
`);

		const dropped = lines.filter((o) => o.msg === "dispatch.pi_flag_off");
		expect(dropped).toHaveLength(1);
		const [only] = dropped;
		expect(only?.level).toBe("info");
		expect(only?.job_type).toBe("issue-triage");
		// The DECLARED runtime, not the one that will actually run: that is the whole
		// point of the line — it names what was withheld.
		expect(only?.declared_runtime).toBe("pi");
		// Sourced from the flag module, so renaming the env var cannot leave the log
		// naming a variable an operator can no longer set.
		expect(only?.flag_env_var).toBe(PACKET_PI_DISPATCH_ENV_VAR);
	}, 60000);

	test("flag ON emits nothing: the route travelled, there is nothing to report", async () => {
		const lines = await captureRouteLogs(`
const resolved = resolveRuntimeRoute(
  "issue-triage",
  { body: "rendered body", routing: { runtime: "pi", model: "gpt-6.1-sol", effort: "low" } },
  { PACKET_PI_DISPATCH_ENABLED: "1" },
);
if (!resolved.ok) throw new Error("expected ok, got refusal");
if (resolved.submission.runtime !== "pi") throw new Error("expected the route to travel");
`);

		expect(lines.filter((o) => o.msg === "dispatch.pi_flag_off")).toEqual([]);
	}, 60000);

	test("a NON-PACKET lane emits nothing even with the flag off", async () => {
		// A TS-literal lane never declared a route, so there is no withheld emission to
		// report — logging here would fire on every ordinary dispatch.
		const lines = await captureRouteLogs(`
const resolved = resolveRuntimeRoute(
  "pr-review",
  { body: "rendered body", routing: { runtime: "pi", model: "gpt-6.1-sol", effort: "low" } },
  {},
);
if (!resolved.ok) throw new Error("expected ok, got refusal");
`);

		expect(lines.filter((o) => o.msg === "dispatch.pi_flag_off")).toEqual([]);
	}, 60000);
});

describe("resolveRuntimeRoute: the agentless script runtime", () => {
	test("a template-declared script runtime travels WITH the reviewed luna/max route", () => {
		const resolved = resolveRuntimeRoute(
			"infra-static-agentless",
			{ body: "#!/usr/bin/env bash\nset -euo pipefail\nactionlint", runtime: "script" },
			{},
		);

		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		// Exact-equality, not per-key checks: a sixth key added later and quietly
		// forwarded onto a script route reds THIS assertion.
		expect(resolved.submission).toEqual({
			body: "#!/usr/bin/env bash\nset -euo pipefail\nactionlint",
			runtime: "script",
			model: "gpt-6-luna",
			effort: "max",
			engineEndpoint: {
				baseUrl: "https://codex-proxy.example.internal",
				authHeaderName: "Authorization",
			},
		});
	});

	test("the script route is NOT gated on the pi flag", () => {
		// The pi flag exists because an unknown runtime burned a held box through
		// the full readiness window. `isContractRejection` already makes that
		// terminal on attempt one, and the config `job_templates` allowlist is the
		// real opt-in, so gating this twice would only hide the lane.
		for (const env of [{}, PI_ON]) {
			const resolved = resolveRuntimeRoute(
				"infra-static-agentless",
				{ body: "actionlint", runtime: "script" },
				env,
			);
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			expect(resolved.submission.runtime).toBe("script");
		}
	});

	test("an agent lane keeps its Codex route through the script branch — the control", () => {
		const resolved = resolveRuntimeRoute("infra-static", { body: "rendered body" }, PI_ON);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.submission).toEqual({
			body: "rendered body",
			runtime: "codex",
			model: "gpt-6.1-sol",
			effort: "medium",
			engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
		});
	});
});
