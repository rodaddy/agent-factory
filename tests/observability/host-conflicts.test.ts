/**
 * The #190 tripwire, driven at the PUBLIC boundary.
 *
 * The point of the issue is that a real dual-host interleaving must be NOTICED,
 * not merely exist in journald. So the important test does not poke the tally
 * directly: it seeds an attempt, ingests two hosts' attestations through
 * `AttemptObserver.observe` exactly as the reconciler does, and then asks the
 * SERVED STATUS PAGE what it says. A test that called `tally.record()` itself
 * would pass with the observer's call site deleted — which is precisely the bug
 * this feature exists to prevent.
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { githubItems, jobAttempts, jobs, repositories } from "../../src/db/schema";
import { AttemptObserver } from "../../src/observability/attempt-observer";
import { HostConflictTally } from "../../src/observability/host-conflicts";
import { getStatus } from "../../src/status/query";
import { createStatusHandler } from "../../src/status/server";
import { withTestDb } from "../db/helpers";
import { until } from "../support/wait-until";

/** The REAL #110 pilot stream: attests `gpt-5.6-sol`. */
const PILOT = readFileSync(
	join(import.meta.dir, "..", "fixtures", "observability", "pilot-events.jsonl"),
	"utf8",
);

/** The same stream, re-attested to a different model — the conflicting host. */
function pilotAttesting(model: string): string {
	return PILOT.replaceAll('"model":"gpt-5.6-sol"', `"model":${JSON.stringify(model)}`);
}

type Db = Parameters<Parameters<typeof withTestDb>[0]>[0];

/**
 * Wait until the first host's attestation is STAMPED on the attempt row: the
 * observer's last write for that observation, and the state the second host's
 * observation compares against.
 */
async function stamped(db: Db, runnerJobId: string): Promise<void> {
	await until(
		async () => {
			const [row] = await db
				.select({ observedModel: jobAttempts.observedModel })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, runnerJobId));
			return row?.observedModel != null;
		},
		2_000,
		"first host's model stamped",
	);
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

describe("host-conflict tripwire on the status page", () => {
	test("THE IMPORTANT ONE: a real two-host conflict reaches the served status page", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-conflict-page");
			const tally = new HostConflictTally(() => new Date("2026-08-04T12:00:00.000Z"));
			const observer = new AttemptObserver(db, null, undefined, tally);

			// Host 1 wins the first-writer race and stamps `gpt-5.6-sol`.
			observer.observe({
				jobRunnerId: "rw-conflict-page",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await stamped(db, "rw-conflict-page");
			// Host 2 attests a DIFFERENT model for the same attempt.
			observer.observe({
				jobRunnerId: "rw-conflict-page",
				hostname: "runner-2",
				rawEventStream: pilotAttesting("claude-opus-5"),
				ingested: true,
				schemaValid: true,
			});
			// Drain every in-flight observation: the second host's compare-and-record
			// has finished once this resolves.
			await observer.shutdown();

			// Read it the way the operator does: through the real handler, wired the
			// way `startStatusServer` wires it.
			const handler = createStatusHandler({
				source: () => getStatus(db, "2026-08-04T12:00:05.000Z", { hostConflicts: tally.status() }),
				pollIntervalMinutes: 15,
			});

			const json = await handler(new Request("http://localhost/status.json"));
			const snapshot = (await json.json()) as {
				hostConflicts?: {
					count: number;
					lastAttemptId: string | null;
					lastAt: string | null;
					lastPairs: Array<{ host: string; model: string }>;
				};
			};
			expect(snapshot.hostConflicts?.count).toBe(1);
			expect(snapshot.hostConflicts?.lastAttemptId).toBe(String(attemptId));
			expect(snapshot.hostConflicts?.lastAt).toBe("2026-08-04T12:00:00.000Z");
			// The host that DISAGREED is named exactly, with the model it attested.
			expect(snapshot.hostConflicts?.lastPairs).toEqual([
				{ host: "unknown", model: "gpt-5.6-sol" },
				{ host: "runner-2", model: "claude-opus-5" },
			]);

			// And the HTML page an operator actually opens shows it.
			const html = await (await handler(new Request("http://localhost/"))).text();
			expect(html).toContain("Model host conflicts");
			expect(html).toContain("runner-2");
			expect(html).toContain("claude-opus-5");
			expect(html).toContain(String(attemptId));
		});
	});

	test("an IDENTICAL re-ingest does not move the counter — a re-read is not a conflict", async () => {
		await withTestDb(async (db) => {
			await seedAttempt(db, "rw-conflict-same");
			const tally = new HostConflictTally();
			const observer = new AttemptObserver(db, null, undefined, tally);
			const observeRunner1 = () =>
				observer.observe({
					jobRunnerId: "rw-conflict-same",
					hostname: "runner-1",
					rawEventStream: PILOT,
					ingested: true,
					schemaValid: true,
				});
			observeRunner1();
			await stamped(db, "rw-conflict-same");
			observeRunner1();
			// The re-read's compare has FINISHED once the drain resolves, so the zero
			// below is an absence observed after the work, not before it.
			await observer.shutdown();
			const status = tally.status();
			expect(status.count).toBe(0);
			expect(status.lastAttemptId).toBeNull();
			expect(status.lastPairs).toEqual([]);
		});
	});

	test("a zero count still RENDERS — an absent section is indistinguishable from unwired", async () => {
		await withTestDb(async (db) => {
			const handler = createStatusHandler({
				source: () =>
					getStatus(db, "2026-08-04T12:00:00.000Z", {
						hostConflicts: new HostConflictTally().status(),
					}),
				pollIntervalMinutes: 15,
			});
			const html = await (await handler(new Request("http://localhost/"))).text();
			expect(html).toContain("Model host conflicts");
			expect(html).toContain(">0<");
		});
	});

	test("no tally supplied leaves the field and the section absent, not a false zero", async () => {
		await withTestDb(async (db) => {
			const snapshot = await getStatus(db, "2026-08-04T12:00:00.000Z");
			expect(snapshot.hostConflicts).toBeUndefined();
			const handler = createStatusHandler({
				source: async () => snapshot,
				pollIntervalMinutes: 15,
			});
			const html = await (await handler(new Request("http://localhost/"))).text();
			expect(html).not.toContain("Model host conflicts");
		});
	});

	test("only the LAST conflict's detail is retained, and the count keeps climbing", async () => {
		const tally = new HostConflictTally(() => new Date("2026-08-04T09:00:00.000Z"));
		tally.record({
			attemptId: "11",
			stamped: { host: "unknown", model: "a" },
			observed: { host: "h1", model: "b" },
		});
		tally.record({
			attemptId: "22",
			stamped: { host: "unknown", model: "c" },
			observed: { host: "h2", model: "d" },
		});
		const status = tally.status();
		expect(status.count).toBe(2);
		expect(status.lastAttemptId).toBe("22");
		expect(status.lastPairs).toEqual([
			{ host: "unknown", model: "c" },
			{ host: "h2", model: "d" },
		]);
	});

	test("an overlong host is CLIPPED here, not left to a distant caller's bound", () => {
		// `host` reaches the tripwire unbounded on this path — its only ceiling was
		// ~255 enforced three modules away (`isSafeSegment`, results/share-reader),
		// which this module neither calls nor can see. The module claims nothing
		// unbounded reaches the status page, so it enforces that claim itself.
		const tally = new HostConflictTally();
		tally.record({
			attemptId: "1",
			stamped: { host: "unknown", model: "a" },
			observed: { host: "h".repeat(5000), model: "m".repeat(5000) },
		});
		const pair = tally.status().lastPairs[1];
		expect(pair?.host.length).toBe(200);
		expect(pair?.model.length).toBe(200);
	});

	test("the reported status is a COPY — a caller cannot mutate the tally through it", () => {
		const tally = new HostConflictTally();
		tally.record({
			attemptId: "7",
			stamped: { host: "unknown", model: "a" },
			observed: { host: "h", model: "b" },
		});
		const first = tally.status();
		first.lastPairs[0] = { host: "spoofed", model: "spoofed" };
		expect(tally.status().lastPairs[0]).toEqual({ host: "unknown", model: "a" });
	});
});
