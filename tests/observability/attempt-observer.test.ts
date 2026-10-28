import { describe, expect, test } from "bun:test";
import fs, { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { githubItems, jobAttempts, jobs, repositories } from "../../src/db/schema";
import { AttemptObserver, safeObservedModel } from "../../src/observability/attempt-observer";
import {
	type AttemptTraceIdentity,
	type TraceEmitter,
	traceIdFor,
} from "../../src/observability/langfuse";
import { withTestDb } from "../db/helpers";
import { until } from "../support/wait-until";

/** The REAL #110 pilot stream: attests `gpt-5.6-sol`, agent claimed "ChatGPT". */
const PILOT = readFileSync(
	join(import.meta.dir, "..", "fixtures", "observability", "pilot-events.jsonl"),
	"utf8",
);

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** Seed a repo + running job + submitted attempt, returning the attempt id. */
async function seedAttempt(db: Db, runnerJobId: string): Promise<number> {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "pull", number: 42, state: "open", headSha: "cafe" })
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha: "cafe",
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
	return attempt.id;
}

/** Recording emitter, standing in for the SDK. */
function recordingEmitter(): TraceEmitter & {
	calls: Array<{ identity: AttemptTraceIdentity; scores: Record<string, number | undefined> }>;
} {
	const calls: Array<{
		identity: AttemptTraceIdentity;
		scores: Record<string, number | undefined>;
	}> = [];
	return {
		calls,
		emit(args) {
			calls.push({ identity: args.identity, scores: { ...args.scores } });
		},
		shutdown: async () => {},
	};
}

/** An emitter whose `emit` throws — stands in for an unreachable Langfuse. */
const throwingEmitter: TraceEmitter = {
	emit() {
		throw new Error("langfuse is unreachable");
	},
	shutdown: async () => {},
};

/** Read the attested model back off the attempt row. */
async function observedModelOf(db: Db, attemptId: number): Promise<string | null> {
	const [row] = await db
		.select({ observedModel: jobAttempts.observedModel })
		.from(jobAttempts)
		.where(eq(jobAttempts.id, attemptId));
	return row?.observedModel ?? null;
}

/** Read the stamped Langfuse trace id back off the attempt row. */
async function traceIdOf(db: Db, attemptId: number): Promise<string | null> {
	const [row] = await db
		.select({ traceId: jobAttempts.traceId })
		.from(jobAttempts)
		.where(eq(jobAttempts.id, attemptId));
	return row?.traceId ?? null;
}

describe("AttemptObserver stamps the ATTESTED model", () => {
	test("stamps `observed_model` from the stream, not from the agent's claim", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-1");
			const observer = new AttemptObserver(db, null);
			// `observe` is void-returning by contract; await the settle explicitly.
			observer.observe({
				jobRunnerId: "rw-obs-1",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(async () => (await observedModelOf(db, attemptId)) !== null, 2000, "model stamp");
			// The provider attested this. The SAME stream contains the agent writing
			// `"observed_model":"ChatGPT"` into its own result file.
			expect(await observedModelOf(db, attemptId)).toBe("gpt-5.6-sol");
			expect(PILOT).toContain("ChatGPT");
		});
	});

	test("a garbage stream stamps nothing and leaves the row untouched", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-2");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-2",
				hostname: "runner-1",
				rawEventStream: "not json at all\n{{{\n",
				ingested: true,
				schemaValid: true,
			});
			// Absence needs a completion signal: `shutdown` drains every tracked observation.
			await observer.shutdown();
			expect(await observedModelOf(db, attemptId)).toBeNull();
		});
	});

	test("an unknown runner job id stamps nothing (foreign result)", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-3");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-not-ours",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			// Absence needs a completion signal: `shutdown` drains every tracked observation.
			await observer.shutdown();
			expect(await observedModelOf(db, attemptId)).toBeNull();
		});
	});

	test("THE IMPORTANT ONE: an unreachable Langfuse still stamps the attestation and the trace id", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-4");
			// The stamp is a write against the watcher's OWN database and has nothing
			// to do with whether a trace sink exists or is reachable.
			new AttemptObserver(db, throwingEmitter).observe({
				jobRunnerId: "rw-obs-4",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(async () => (await observedModelOf(db, attemptId)) !== null, 2000, "model stamp");
			expect(await observedModelOf(db, attemptId)).toBe("gpt-5.6-sol");
			// The trace id is the same kind of write: an id recorded for a trace
			// the sink never received is still the right id.
			await until(async () => (await traceIdOf(db, attemptId)) !== null, 2000, "trace id stamp");
			expect(await traceIdOf(db, attemptId)).toBe(`attempt-${attemptId}-runner-1`);
		});
	});
});

describe("AttemptObserver emits one trace bound to the TRUSTED identity", () => {
	test("identity comes from the DB join, never from runner output", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-5");
			const emitter = recordingEmitter();
			new AttemptObserver(db, emitter).observe({
				jobRunnerId: "rw-obs-5",
				hostname: "runner-3",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(() => emitter.calls.length > 0, 2000, "trace emitted");
			expect(emitter.calls).toHaveLength(1);
			const identity = emitter.calls[0]?.identity;
			// Trace id = the attempt; session = the job (requeues group under it).
			expect(identity?.attemptId).toBe(attemptId);
			expect(identity?.repository).toBe("rodaddy/x");
			expect(identity?.jobType).toBe("pr-review");
			expect(identity?.sha).toBe("cafe");
			expect(identity?.itemNumber).toBe(42);
			expect(identity?.vmid).toBe(9001);
			// Results are per (job, host): the host is carried, never dropped.
			expect(identity?.hostname).toBe("runner-3");
		});
	});

	test("scores record the gate outcomes that actually ran", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-obs-6");
			const emitter = recordingEmitter();
			new AttemptObserver(db, emitter).observe({
				jobRunnerId: "rw-obs-6",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: false,
				schemaValid: false,
				changeVerified: false,
			});
			await until(() => emitter.calls.length > 0, 2000, "trace emitted");
			expect(emitter.calls[0]?.scores).toEqual({
				ingestOk: 0,
				schemaValid: 0,
				changeVerified: 0,
			});
		});
	});

	test("a report-only lane records NO change score rather than a misleading zero", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-obs-7");
			const emitter = recordingEmitter();
			new AttemptObserver(db, emitter).observe({
				jobRunnerId: "rw-obs-7",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(() => emitter.calls.length > 0, 2000, "trace emitted");
			expect(emitter.calls[0]?.scores.changeVerified).toBeUndefined();
			expect(emitter.calls[0]?.scores.ingestOk).toBe(1);
		});
	});

	test("a garbage stream emits no trace at all", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-obs-8");
			const emitter = recordingEmitter();
			const observer = new AttemptObserver(db, emitter);
			observer.observe({
				jobRunnerId: "rw-obs-8",
				hostname: "runner-1",
				rawEventStream: "}{ not a stream",
				ingested: true,
				schemaValid: true,
			});
			// Absence needs a completion signal: `shutdown` drains every tracked observation.
			await observer.shutdown();
			expect(emitter.calls).toEqual([]);
		});
	});
});

/**
 * Run `fn` capturing the NDJSON log lines it emits.
 *
 * Captured at the DESCRIPTOR level (the idiom `tests/kboard/pass.test.ts` uses):
 * post-#88 pino writes synchronously to fd 2 via `fs.writeSync`, NOT through
 * `process.stderr.write`, so a `process.stderr` spy sees nothing and every
 * assertion on log content passes vacuously.
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

/** The pilot stream with its attested model rewritten — one differing host. */
function pilotAttesting(model: string): string {
	return PILOT.replaceAll('"model":"gpt-5.6-sol"', `"model":${JSON.stringify(model)}`);
}

describe("ONE attempt, TWO hosts (the #86 shape)", () => {
	test("THE IMPORTANT ONE: two hosts produce two DISTINCT traces, never one merged", async () => {
		// THE REGRESSION: results are per (job, host), but the trace id was
		// `attempt-N` alone, so two hosts upserted the SAME Langfuse trace —
		// metadata overwritten, generations merged, tokens double-counted. No test
		// seeded two hosts, which is exactly why the green suite could not see it.
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-2host");
			const emitter = recordingEmitter();
			const observer = new AttemptObserver(db, emitter);
			for (const hostname of ["runner-1", "runner-2"]) {
				observer.observe({
					jobRunnerId: "rw-obs-2host",
					hostname,
					rawEventStream: PILOT,
					ingested: true,
					schemaValid: true,
				});
			}
			await until(() => emitter.calls.length >= 2, 2000, "both host traces emitted");
			expect(emitter.calls).toHaveLength(2);
			// Same attempt, DIFFERENT host — which is what the trace id is built from.
			const hosts = emitter.calls.map((c) => c.identity.hostname).sort();
			expect(hosts).toEqual(["runner-1", "runner-2"]);
			// Grouping is unchanged: both still collapse under ONE job session.
			expect(new Set(emitter.calls.map((c) => c.identity.attemptId))).toEqual(new Set([attemptId]));
			expect(new Set(emitter.calls.map((c) => c.identity.jobId)).size).toBe(1);
		});
	});

	test("THE IMPORTANT ONE: the stamp is FIRST-writer-wins and deterministic", async () => {
		// THE REGRESSION: an unconditional UPDATE made the stamp last-writer-wins,
		// so which host's attestation persisted depended on ingest interleaving.
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-first");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-first",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(async () => (await observedModelOf(db, attemptId)) !== null, 2000, "model stamp");
			expect(await observedModelOf(db, attemptId)).toBe("gpt-5.6-sol");
			// A SECOND host arrives with a DIFFERENT attestation. The first one stands.
			observer.observe({
				jobRunnerId: "rw-obs-first",
				hostname: "runner-2",
				rawEventStream: pilotAttesting("claude-opus-5"),
				ingested: true,
				schemaValid: true,
			});
			// Absence of an overwrite needs a completion signal: drain the second host.
			await observer.shutdown();
			expect(await observedModelOf(db, attemptId)).toBe("gpt-5.6-sol");
		});
	});

	test("a DIFFERING second attestation is logged as a host conflict, not swallowed", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-conflict");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-conflict",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(async () => (await observedModelOf(db, attemptId)) !== null, 2000, "model stamp");
			const { lines } = await withCapturedLogs(async () => {
				observer.observe({
					jobRunnerId: "rw-obs-conflict",
					hostname: "runner-2",
					rawEventStream: pilotAttesting("claude-opus-5"),
					ingested: true,
					schemaValid: true,
				});
				// The capture must not close before the second host has finished.
				await observer.shutdown();
			});
			const conflicts = lines.filter((l) => l.msg === "observability.model.host_conflict");
			expect(conflicts).toHaveLength(1);
			// Per (job, host): the line names WHICH host disagreed and about what.
			expect(conflicts[0]?.host).toBe("runner-2");
			expect(conflicts[0]?.job_runner_id).toBe("rw-obs-conflict");
			expect(conflicts[0]?.attempt_id).toBe(String(attemptId));
			expect(conflicts[0]?.stamped_model).toBe("gpt-5.6-sol");
			expect(conflicts[0]?.observed_model).toBe("claude-opus-5");
		});
	});

	test("an IDENTICAL re-ingest is silent — a re-read is not a conflict", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-same");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-same",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(async () => (await observedModelOf(db, attemptId)) !== null, 2000, "model stamp");
			const { lines } = await withCapturedLogs(async () => {
				observer.observe({
					jobRunnerId: "rw-obs-same",
					hostname: "runner-1",
					rawEventStream: PILOT,
					ingested: true,
					schemaValid: true,
				});
				// Absence of a conflict line needs a completion signal: drain the re-ingest.
				await observer.shutdown();
			});
			expect(lines.filter((l) => l.msg === "observability.model.host_conflict")).toEqual([]);
		});
	});
});

describe("the attested model is REDACTED before the durable stamp", () => {
	test("THE IMPORTANT ONE: a secret-shaped attested model never lands in the column", async () => {
		// THE REGRESSION: the stamp length-SLICED the value and never redacted it, so
		// a secret-shaped `model` off a runner box persisted verbatim in a durable
		// column. `event-stream` clips+redacts it too; this is the second guard on
		// the one value that survives the process.
		// Driven DIRECTLY, not through `observe`: `parseEventStream` redacts these
		// fields itself, so an end-to-end test passes whether or not THIS guard
		// exists — proved by mutation, it stayed green with the redaction removed.
		expect(safeObservedModel("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe("[REDACTED]");
		expect(safeObservedModel("model ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).not.toContain(
			"ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
	});

	test("an over-long attested model is bounded before the write", () => {
		expect(safeObservedModel("m".repeat(50_000))).toHaveLength(200);
	});

	test("a blank or absent attestation writes nothing rather than clearing the row", () => {
		expect(safeObservedModel(null)).toBeNull();
		expect(safeObservedModel("   ")).toBeNull();
	});

	test("the guard is REACHED by the real stamp path, not merely exported", async () => {
		// Pairs with the direct tests above: they prove the guard's behavior, this
		// proves the observer actually routes through it.
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-long");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-long",
				hostname: "runner-1",
				rawEventStream: pilotAttesting("m".repeat(50_000)),
				ingested: true,
				schemaValid: true,
			});
			// A null stamp also passes `<= 200`, so wait for the observation to finish.
			await observer.shutdown();
			const stamped = await observedModelOf(db, attemptId);
			expect((stamped ?? "").length).toBeLessThanOrEqual(200);
		});
	});
});

describe("AttemptObserver.shutdown is the seam the service stop path uses", () => {
	test("it flushes the emitter it owns", async () => {
		await withTestDb(async (db) => {
			let flushed = 0;
			const emitter: TraceEmitter = {
				emit() {},
				shutdown: async () => {
					flushed++;
				},
			};
			await new AttemptObserver(db, emitter).shutdown();
			expect(flushed).toBe(1);
		});
	});

	test("a failing flush NEVER throws out of the stop path", async () => {
		await withTestDb(async (db) => {
			const emitter: TraceEmitter = {
				emit() {},
				shutdown: async () => {
					throw new Error("langfuse is unreachable");
				},
			};
			expect(new AttemptObserver(db, emitter).shutdown()).resolves.toBeUndefined();
		});
	});

	test("with Langfuse unconfigured the flush is a no-op, not a null dereference", async () => {
		await withTestDb(async (db) => {
			expect(new AttemptObserver(db, null).shutdown()).resolves.toBeUndefined();
		});
	});
});

/**
 * DRAIN BEFORE FLUSH — the ordering, not the existence.
 *
 * Every observation is DETACHED: ingest reads `events.jsonl` and calls
 * `observe`, and neither is awaited by the ingest path. So at the moment
 * `stop()` runs, the final pass's traces may not be in the emitter yet. If
 * `shutdown` flushes without draining, it ships an EMPTY queue, logs its
 * success line, and the process exits underneath the enqueue that was about to
 * happen (Sol gauntlet P1, head d0dd7de — the earlier shutdown tests proved
 * flush ordering against the SCHEDULER, never against the observation itself,
 * and stayed green with the observations untracked).
 *
 * These tests gate the slow part of the chain and record enqueue-vs-flush on
 * ONE ordered list, so the assertion is a real sequence rather than two
 * existence checks that would hold in either order.
 */
describe("AttemptObserver.shutdown DRAINS before it flushes", () => {
	test("THE IMPORTANT ONE: a gated ingest-layer read still enqueues BEFORE the flush", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-drain-1");
			const order: string[] = [];
			const emitter: TraceEmitter = {
				emit() {
					order.push("enqueued");
				},
				shutdown: async () => {
					order.push("flushed");
				},
			};
			const observer = new AttemptObserver(db, emitter);

			// The gate stands in for the share read ingest performs BEFORE `observe`
			// is ever called. Held open across the `shutdown()` call, it is the exact
			// interleaving Sol reproduced: work in flight, nothing in the emitter.
			let openGate = (): void => {};
			const gate = new Promise<void>((resolve) => {
				openGate = resolve;
			});
			// This is what `ingestResult` hands to `track`: read THEN observe, the
			// whole chain, detached. Ingest awaits none of it.
			observer.track(
				(async () => {
					await gate;
					observer.observe({
						jobRunnerId: "rw-drain-1",
						hostname: "runner-1",
						rawEventStream: PILOT,
						ingested: true,
						schemaValid: true,
					});
				})(),
			);

			// Nothing has been enqueued yet — the read is still gated. This is the
			// anti-vacuity guard: without it the test would pass on a chain that had
			// already finished, which proves nothing about draining.
			expect(order).toEqual([]);

			const stopping = observer.shutdown();
			// Let the stop path run as far as it can. If it does not drain, it
			// reaches the flush right here, with the queue empty.
			await new Promise((resolve) => setTimeout(resolve, 20)); // fixed-sleep-ok: asserts absence, no completion signal
			expect(order).toEqual([]);

			openGate();
			await stopping;

			// THE ASSERTION: the trace was enqueued, and it was enqueued BEFORE the
			// flush. Untracked, this reads `["flushed", "enqueued"]` or `["flushed"]`.
			expect(order).toEqual(["enqueued", "flushed"]);
		});
	});

	test("an observation that REJECTS still lets the flush run (allSettled, not all)", async () => {
		await withTestDb(async (db) => {
			const order: string[] = [];
			const emitter: TraceEmitter = {
				emit() {},
				shutdown: async () => {
					order.push("flushed");
				},
			};
			const observer = new AttemptObserver(db, emitter);
			let failGate = (): void => {};
			const gate = new Promise<void>((_resolve, reject) => {
				failGate = () => reject(new Error("share read exploded"));
			});
			observer.track(gate);

			const stopping = observer.shutdown();
			await new Promise((resolve) => setTimeout(resolve, 20)); // fixed-sleep-ok: asserts absence, no completion signal
			expect(order).toEqual([]);
			failGate();
			await stopping;
			// One broken observation must not cost every other queued trace its flush.
			expect(order).toEqual(["flushed"]);
		});
	});

	test("an observation registered AFTER shutdown is refused, not queued behind the flush", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-drain-late");
			let flushed = 0;
			const emitter: TraceEmitter = {
				emit() {},
				shutdown: async () => {
					flushed++;
				},
			};
			const observer = new AttemptObserver(db, emitter);
			await observer.shutdown();
			expect(flushed).toBe(1);

			// Late work is a no-op on the drain: tracking it would mean a second
			// shutdown blocks on work whose flush has already sailed. It must not
			// throw, and it must not leave an unhandled rejection behind.
			observer.track(Promise.reject(new Error("too late")));
			observer.observe({
				jobRunnerId: "rw-drain-late",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await new Promise((resolve) => setTimeout(resolve, 20)); // fixed-sleep-ok: asserts absence, no completion signal (late work is untracked by design)
			// The second shutdown returns promptly rather than hanging on late work.
			await observer.shutdown();
			expect(flushed).toBe(2);
		});
	});
});

describe("result_schema_valid scores the SCHEMA, not ingest success", () => {
	test("THE IMPORTANT ONE: a verifier rejection is schema-VALID with ingest 0", () => {
		return withTestDb(async (db) => {
			// The defect: `schemaValid` was derived from `ingested`, so an implement
			// result that parsed, validated against `resultSchema`, and then had its
			// PROPOSED CHANGE refused by the change verifier reported
			// `result_schema_valid = 0`. That blames the schema for a rejection a
			// strictly later boundary made. Schema validation SUCCEEDED here.
			await seedAttempt(db, "rw-obs-193a");
			const emitter = recordingEmitter();
			new AttemptObserver(db, emitter).observe({
				jobRunnerId: "rw-obs-193a",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: false,
				schemaValid: true,
				changeVerified: false,
			});
			await until(() => emitter.calls.length > 0, 2000, "trace emitted");
			expect(emitter.calls[0]?.scores).toEqual({
				// The schema is CLEAN and now says so.
				schemaValid: 1,
				// Ingest still failed, and still reports it — `ingest_ok` keeps its
				// meaning; the two scores answer different questions.
				ingestOk: 0,
				changeVerified: 0,
			});
		});
	});

	test("a parse/schema failure scores BOTH zero, so the fix is not vacuous", () => {
		return withTestDb(async (db) => {
			// Guards the assertion above from passing for the wrong reason: if
			// `schemaValid` were hardcoded to 1 the test above would be worthless.
			await seedAttempt(db, "rw-obs-193b");
			const emitter = recordingEmitter();
			new AttemptObserver(db, emitter).observe({
				jobRunnerId: "rw-obs-193b",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: false,
				schemaValid: false,
			});
			await until(() => emitter.calls.length > 0, 2000, "trace emitted");
			expect(emitter.calls[0]?.scores.schemaValid).toBe(0);
			expect(emitter.calls[0]?.scores.ingestOk).toBe(0);
		});
	});
});

describe("AttemptObserver stamps the LANGFUSE TRACE ID", () => {
	test("THE IMPORTANT ONE: the stamp is the emitter's OWN id, host-qualified", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-obs-184a");
			const emitter = recordingEmitter();
			new AttemptObserver(db, emitter).observe({
				jobRunnerId: "rw-obs-184a",
				hostname: "runner-7",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await until(
				async () => emitter.calls.length > 0 && (await traceIdOf(db, attemptId)) !== null,
				2000,
				"trace emitted and trace id stamped",
			);
			// The acceptance property of #184: one row, one query, the exact trace.
			expect(await traceIdOf(db, attemptId)).toBe(`attempt-${attemptId}-runner-7`);
			// And it is the SAME id the emitter would compute for this identity —
			// asserted through `traceIdFor` rather than against a second literal, so
			// a future change to the format cannot leave the column pointing at a
			// trace that is never emitted (the #211 lesson).
			const identity = emitter.calls[0]?.identity;
			expect(identity).toBeDefined();
			if (identity !== undefined) {
				expect(await traceIdOf(db, attemptId)).toBe(traceIdFor(identity));
			}
		});
	});

	test("stamped with NO attestation in the stream — the trace id does not ride on the model", async () => {
		await withTestDb(async (db) => {
			// A stream that parses but attests no model. The attempts worth reaching a
			// trace for are exactly these, so the trace id must not inherit the model
			// stamp's null-guard.
			const attemptId = await seedAttempt(db, "rw-obs-184b");
			// Blank the attested model rather than dropping the `message_end` line:
			// removing the line removes the assistant turn, and a stream with no
			// generation does not parse AT ALL, so the test would pass by observing
			// nothing. A blank model is the real shape — the turn happened, the
			// runtime recorded no model for it.
			const noModel = PILOT.replace(/"model":\s*"[^"]*"/g, '"model":""');
			expect(noModel).not.toBe(PILOT);
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-184b",
				hostname: "runner-1",
				rawEventStream: noModel,
				ingested: true,
				schemaValid: true,
			});
			// The null model is an absence: drain the observation before asserting it.
			await observer.shutdown();
			expect(await observedModelOf(db, attemptId)).toBeNull();
			expect(await traceIdOf(db, attemptId)).toBe(`attempt-${attemptId}-runner-1`);
		});
	});

	test("a garbage stream stamps NO trace id — nothing was observed to trace", async () => {
		await withTestDb(async (db) => {
			// Guards the assertions above from passing for the wrong reason: an
			// unconditional stamp would put a trace id on an attempt that emitted no
			// trace, and the status page would link to a trace that does not exist.
			const attemptId = await seedAttempt(db, "rw-obs-184d");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-184d",
				hostname: "runner-1",
				rawEventStream: "not json at all\n{{{\n",
				ingested: true,
				schemaValid: true,
			});
			// Absence needs a completion signal: `shutdown` drains every tracked observation.
			await observer.shutdown();
			expect(await traceIdOf(db, attemptId)).toBeNull();
		});
	});

	test("TWO hosts: the stamp is FIRST-writer-wins, matching the model stamp", async () => {
		await withTestDb(async (db) => {
			// Results are per (job, host), so two hosts emit two DISTINCT traces. The
			// column names the first observed — deterministic rather than a
			// last-writer race — and the `job-N` session still collects both.
			const attemptId = await seedAttempt(db, "rw-obs-184e");
			const observer = new AttemptObserver(db, null);
			observer.observe({
				jobRunnerId: "rw-obs-184e",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			// runner-1 must land first for "first" to mean runner-1: wait for its stamp.
			await until(async () => (await traceIdOf(db, attemptId)) !== null, 2000, "trace id stamp");
			observer.observe({
				jobRunnerId: "rw-obs-184e",
				hostname: "runner-2",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			// Absence of an overwrite needs a completion signal: drain the second host.
			await observer.shutdown();
			expect(await traceIdOf(db, attemptId)).toBe(`attempt-${attemptId}-runner-1`);
		});
	});
});
