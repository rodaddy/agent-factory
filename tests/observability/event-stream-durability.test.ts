/**
 * The raw event stream OUTLIVES the job directory.
 *
 * The ticket asked the watcher to copy `events.jsonl` to a "durable
 * watcher-owned artifact path". There is no such path: the collab share's
 * per-job directories carry NO retention guarantee (rtech-infra, 2026-08-17), so
 * a watcher-owned copy on the same share is the same no-guarantee class plus a
 * second unmanaged store. The durable home is therefore Postgres —
 * `attempt_event_streams`, keyed by attempt id.
 *
 * EVERY CLAUSE RUNS AGAINST LIVE SCRATCH POSTGRES via `withTestDb`, never a
 * fake. First-writer-wins is a PRIMARY KEY plus `ON CONFLICT DO NOTHING`, and a
 * fake db cannot prove a constraint holds — it can only prove the code called
 * what the author expected it to call, which is the shape of a green-but-wrong
 * test this repo has already shipped twice.
 *
 * Mutation receipts for each clause are in the lane report; each was observed
 * RED before the implementation was trusted.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import type { WatcherDb } from "../../src/db/client";
import {
	attemptEventStreams,
	githubItems,
	jobAttempts,
	jobs,
	repositories,
} from "../../src/db/schema";
import {
	AttemptObserver,
	MAX_PERSISTED_EVENT_STREAM_BYTES,
} from "../../src/observability/attempt-observer";
import { withTestDb } from "../db/helpers";

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

/**
 * A real fixture stream: one attested assistant turn, parseable by the REAL
 * `parseEventStream`. Built as literal JSON rather than hand-typed NDJSON so the
 * bytes under assertion are exactly what a producer would emit.
 */
function fixtureStream(text: string): string {
	return `${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			model: "gpt-5.6-sol",
			provider: "cliproxy",
			usage: { input: 1, output: 1, totalTokens: 2 },
			content: [{ type: "text", text }],
			timestamp: 1785615593072,
		},
	})}\n`;
}

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

/** Read the durable stream row back for one attempt. */
async function streamRowOf(db: Db, attemptId: number) {
	const [row] = await db
		.select()
		.from(attemptEventStreams)
		.where(eq(attemptEventStreams.attemptId, attemptId));
	return row;
}

/** Every durable stream row in the database, for "no row at all" assertions. */
async function allStreamRows(db: Db) {
	return await db.select().from(attemptEventStreams);
}

/**
 * Drive one observation to settlement.
 *
 * `observe` is void-returning by contract; `shutdown` drains the detached chain,
 * which is this module's own documented way to await it.
 */
async function observeAndSettle(
	db: WatcherDb,
	rawEventStream: string,
	runnerJobId = "rw-183-1",
): Promise<void> {
	const observer = new AttemptObserver(db, null);
	observer.observe({
		jobRunnerId: runnerJobId,
		hostname: "runner-1",
		rawEventStream,
		ingested: true,
		schemaValid: true,
	});
	await observer.shutdown();
}

/**
 * Capture the NDJSON lines written to fd 2 while `fn` runs.
 *
 * Same seam as `tests/observability/stream-skip-visibility.test.ts`: pino is
 * constructed once at module init against `pino.destination({dest: 2, sync:
 * true})`, so intercepting `fs.writeSync` is the only way to read what a level
 * actually emitted without re-importing the logger under a different env.
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

describe("the raw event stream is persisted durably at ingest", () => {
	test("(a) an observed attempt persists the EXACT bytes, keyed by attempt id", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-183-a");
			const raw = fixtureStream("the exact bytes");

			await observeAndSettle(db as unknown as WatcherDb, raw, "rw-183-a");

			const row = await streamRowOf(db, attemptId);
			expect(row).toBeDefined();
			// BYTE-EXACT, not "contains" and not a parsed round trip. The point of the
			// row is that it IS the file: a stored value that merely parses the same
			// is a lossy mirror, and the share copy it replaces is already gone.
			expect(row?.content).toBe(raw);
			expect(row?.byteLength).toBe(Buffer.byteLength(raw, "utf8"));
			expect(row?.createdAt).toBeInstanceOf(Date);
		});
	});

	test("(b) a SECOND ingest of the same attempt writes nothing and the original survives", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-183-b");
			const first = fixtureStream("the original record");
			const second = fixtureStream("a later re-read that must NOT win");

			await observeAndSettle(db as unknown as WatcherDb, first, "rw-183-b");
			await observeAndSettle(db as unknown as WatcherDb, second, "rw-183-b");

			// FIRST-WRITER-WINS, proved against the live PRIMARY KEY. Results are per
			// (job, host) and a restart re-reads the same DONE, so a second read is
			// ordinary — an upsert here would make the durable bytes last-writer-wins.
			const row = await streamRowOf(db, attemptId);
			expect(row?.content).toBe(first);
			expect(row?.content).not.toBe(second);
			// Exactly ONE row, not merely "the first content is somewhere": a plain
			// index instead of the PK would admit a duplicate and this clause is what
			// catches it.
			expect(await allStreamRows(db)).toHaveLength(1);
		});
	});

	test("(c) an ABSENT stream is a clean skip — no row, and no warn", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-183-c");
			// Absence is TODAY'S NORMAL CASE: the producer is still unwired,
			// so every real attempt takes this path. It must be silent at warn — a
			// warn per attempt would be pure noise on every job the factory runs.
			const { lines } = await withCapturedLogs(async () => {
				const observer = new AttemptObserver(db as unknown as WatcherDb, null);
				// Ingest never calls `observe` for an absent stream; it returns before
				// the observer is reached. Driving the observer with the empty string
				// asserts the same outcome from the observer's own side.
				observer.observe({
					jobRunnerId: "rw-183-c",
					hostname: "runner-1",
					rawEventStream: "",
					ingested: true,
					schemaValid: true,
				});
				await observer.shutdown();
			});

			expect(await allStreamRows(db)).toHaveLength(0);
			expect(lines.some((l) => l.level === "warn")).toBe(false);
		});
	});

	test("(d) an OVERSIZED stream is skipped with one warn, and writes no row", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-183-d");
			// Padded inside the fixture's own text field so the stream still PARSES —
			// otherwise the parse skip would short-circuit and this clause would prove
			// the wrong branch.
			// A LITERAL SIZE, NOT ONE DERIVED FROM THE CONSTANT. Padding to
			// `MAX_PERSISTED_EVENT_STREAM_BYTES` makes the fixture follow the cap, so
			// raising the cap raises the fixture with it and the clause stays green
			// against a cap that no longer bounds anything — proved by mutation
			// (raising it to 500_000_000 left all five clauses passing). Pinning the
			// size is what makes this measure the cap rather than itself.
			const OVERSIZE_BYTES = 6_000_000;
			const oversized = fixtureStream("x".repeat(OVERSIZE_BYTES));
			expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(
				MAX_PERSISTED_EVENT_STREAM_BYTES,
			);

			const { lines } = await withCapturedLogs(async () => {
				await observeAndSettle(db as unknown as WatcherDb, oversized, "rw-183-d");
			});

			// SKIPPED, NEVER TRUNCATED. A truncated stream parses and looks complete,
			// so "there is a row" would stop meaning "these are the exact bytes".
			expect(await allStreamRows(db)).toHaveLength(0);
			const warn = lines.find((l) => l.msg === "observability.event_stream.oversized");
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			// The log carries the SIZE and the LIMIT, so an operator can tell a
			// genuinely huge stream from a cap set too low without reading source.
			// Compared as strings: this repo's logger serializes numeric fields as
			// strings in the NDJSON line, and the assertion is about what an operator
			// reads in the journal, not about the in-process type.
			expect(String(warn?.byte_length)).toBe(String(Buffer.byteLength(oversized, "utf8")));
			expect(String(warn?.limit)).toBe(String(MAX_PERSISTED_EVENT_STREAM_BYTES));
			// And it is not a thrown ingest failure: the observation completed and
			// reached its ordinary unusable-stream skip, which is the #219 line. An
			// oversized stream is also unparseable (the parser refuses whole above its
			// own 4MB cap), so this is the SAME outcome an unusable stream has always
			// had — the cap changes only whether a durable row is written.
			expect(lines.some((l) => l.msg === "observability.stream.skipped")).toBe(true);
		});
	});

	test("(e) a THROWING insert logs one warn and the observation still completes", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-183-e");
			const raw = fixtureStream("the copy fails, the observation does not");

			// Fail ONLY the durable-copy insert, by making the insert into
			// `attempt_event_streams` throw while every other db call runs for real.
			// A blanket-throwing db would prove nothing: the question is whether a
			// failure HERE stops the stamp and emit that follow it.
			const realInsert = db.insert.bind(db);
			const faultyDb = new Proxy(db as object, {
				get(target, prop, receiver) {
					if (prop === "insert") {
						return (table: unknown) => {
							if (table === attemptEventStreams) {
								throw new Error("durable copy write exploded");
							}
							return realInsert(table as never);
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			}) as unknown as WatcherDb;

			const { lines } = await withCapturedLogs(async () => {
				await observeAndSettle(faultyDb, raw, "rw-183-e");
			});

			const warn = lines.find((l) => l.msg === "observability.event_stream.persist_failed");
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			// pino serializes the id as a string in the NDJSON line; compare as one
			// rather than "fixing" the log to emit a number a journal never sees.
			expect(String(warn?.attempt_id)).toBe(String(attemptId));
			// CLASS ONLY, never the message: a driver error can quote the connection
			// string and a constraint error can quote the row it refused.
			expect(JSON.stringify(warn)).not.toContain("exploded");

			// THE POINT OF THE CLAUSE. The copy is defence in depth, not a gate — so
			// the trace-id stamp, which runs strictly AFTER the copy, must still have
			// happened. If the throw escaped `persistEventStream`, the caller's own
			// catch would swallow it and this stamp would be missing.
			const [attempt] = await db
				.select({ traceId: jobAttempts.traceId, observedModel: jobAttempts.observedModel })
				.from(jobAttempts)
				.where(eq(jobAttempts.id, attemptId));
			expect(attempt?.traceId).not.toBeNull();
			expect(attempt?.observedModel).toBe("gpt-5.6-sol");
		});
	});
});
