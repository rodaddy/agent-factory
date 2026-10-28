/**
 * The #190 tripwire's PRODUCTION WIRING, asserted at the two seams that carry it.
 *
 * `host-conflicts.test.ts` proves the tripwire's behavior: an observer records a
 * two-host disagreement, and a status handler wired to that tally renders it.
 * But every test in that file constructs its OWN observer/tally pair, so neither
 * seam that makes the feature reachable in production is covered — and both were
 * verified deleteable while the whole suite stayed green:
 *
 *   Mutation A — `src/service-ingest.ts`: hand `new HostConflictTally()` to the
 *     observer instead of the tally `hostConflicts()` reads. The observer records
 *     into an object nobody can read; the page reports 0 forever.
 *   Mutation B — `src/service.ts`: delete `hostConflicts,` from the
 *     `serveStatus({...})` call. `StartStatusServerOptions.hostConflicts` is
 *     OPTIONAL, so this is not even a type error; the section silently vanishes
 *     from the page.
 *
 * These are WIRING tests, in the sense `shutdown-wiring.test.ts` established for
 * exactly this seam class: they assert that the object built in one place is the
 * object read in another, and nothing about the tally's own behavior.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, jobAttempts, jobs, repositories } from "../../src/db/schema";
import type { ForgeRegistry } from "../../src/forge/registry";
import type { GitRunner } from "../../src/results/branch-publisher";
import { startService } from "../../src/service";
import { createIngestAndPublish } from "../../src/service-ingest";
import { withTestDb } from "../db/helpers";
import { testArchiveDir, testTmpBase } from "../support/test-temp";
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

/**
 * The minimum inputs `createIngestAndPublish` needs.
 *
 * `config` and `registry` are STORED, never dereferenced at construction (read
 * from `src/service-ingest.ts`, not assumed), so a cast placeholder is honest
 * here — this test asserts the tripwire wiring, not the publication wiring.
 */
function inputs(db: Db) {
	return {
		db,
		config: {} as WatcherConfig,
		registry: {} as ForgeRegistry,
		shadow: true,
		collabRoot: "/nonexistent/collab",
		changeWorkRoot: "/nonexistent/work",
		shareRootOverride: undefined,
		git: (() => {}) as unknown as GitRunner,
		remoteFor: () => null,
		credentialFor: async () => null,
		triageAllowlistFor: () => [],
		clientFor: async () => null,
		onError: () => {},
	};
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

describe("the ingest wiring's observer records into the tally the page reads", () => {
	test("THE IMPORTANT ONE: a conflict through the WIRED observer moves the WIRED reader", async () => {
		await withTestDb(async (db) => {
			const attemptId = await seedAttempt(db, "rw-wiring-conflict");
			// Everything comes from the production wiring: no observer and no tally is
			// constructed by this test. That is the whole point — the observer that
			// records and the reader that reports must be two ends of ONE object.
			const wiring = createIngestAndPublish(inputs(db));

			// Nothing has happened yet, so the reader the status server would call
			// reports a clean tripwire.
			expect(wiring.hostConflicts().count).toBe(0);

			// Host 1 wins the first-writer race and stamps `gpt-5.6-sol`.
			wiring.observer.observe({
				jobRunnerId: "rw-wiring-conflict",
				hostname: "runner-1",
				rawEventStream: PILOT,
				ingested: true,
				schemaValid: true,
			});
			await stamped(db, "rw-wiring-conflict");
			// Host 2 attests a DIFFERENT model for the same attempt.
			wiring.observer.observe({
				jobRunnerId: "rw-wiring-conflict",
				hostname: "runner-2",
				rawEventStream: pilotAttesting("claude-opus-5"),
				ingested: true,
				schemaValid: true,
			});
			// Drain every in-flight observation: the second host's compare-and-record
			// has finished once this resolves.
			await wiring.shutdownObserver();

			// Under Mutation A (a fresh tally handed to the observer) this reads 0:
			// the record landed in an object no reader is bound to.
			const status = wiring.hostConflicts();
			expect(status.count).toBe(1);
			expect(status.lastAttemptId).toBe(String(attemptId));
			expect(status.lastPairs).toEqual([
				{ host: "unknown", model: "gpt-5.6-sol" },
				{ host: "runner-2", model: "claude-opus-5" },
			]);
		});
	});
});

/**
 * The end-to-end half: drive the REAL `startService` and prove it HANDS the
 * tripwire reader to the status server.
 *
 * The seam test above proves `createIngestAndPublish` returns a reader bound to
 * its observer; this proves `service.ts` PASSES that reader on. Both are needed —
 * deleting `hostConflicts,` from the `serveStatus({...})` call leaves the seam
 * test green and produces no type error (the option is optional), so without this
 * the tripwire could be silently unwired from the page.
 *
 * `startService` does not return the status server, but it takes the server
 * factory as an injectable seam (`opts.startStatusServer`, the idiom
 * `service-runonce.test.ts` uses), so the spy sees exactly what production passes.
 */
describe("startService hands the tripwire reader to the status server (end to end)", () => {
	const ENV_KEYS = [
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DATABASE_URL",
		"WATCHER_WORK_ROOT",
		"LANGFUSE_BASE_URL",
		"LANGFUSE_PUBLIC_KEY",
		"LANGFUSE_SECRET_KEY",
	] as const;
	const savedEnv: Record<string, string | undefined> = {};

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("THE IMPORTANT ONE: serveStatus receives a LIVE reader, not an omitted option", async () => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		// Same posture `shutdown-wiring.test.ts` uses: a token satisfies credential
		// resolution without the gh CLI, and a valid-protocol URL at a refused port
		// builds a LAZY sql client (no connect on construct).
		process.env.GITHUB_TOKEN = "ghp_test_token_not_a_real_secret";
		delete process.env.GH_TOKEN;
		process.env.DATABASE_URL = "postgres://watcher:pw@127.0.0.1:1/watcher_test";
		process.env.WATCHER_WORK_ROOT = join(testTmpBase(), "_scratch", "host-conflict-wiring-work");
		// Langfuse stays UNCONFIGURED here: this test is about the status-server
		// argument, and an emitter would only add a network flush to the stop path.
		for (const key of ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) {
			delete process.env[key];
		}

		const configPath = join(
			testTmpBase(),
			"_scratch",
			`host-conflict-wiring-${crypto.randomUUID()}.yml`,
		);
		await Bun.write(
			configPath,
			[
				"poll_interval_minutes: 15",
				"repositories:",
				"  - name: rodaddy/open-brain",
				"    provider: github",
				"    checks: standard",
				"job_templates: []",
				"",
			].join("\n"),
		);

		let seen: { hostConflicts?: () => unknown } | null = null;
		const handle = await startService({
			configPath,
			statusPort: 0,
			// A scheduler that neither arms a timer nor runs a pass: this test is about
			// the status-server ARGUMENT, not the cycle.
			createScheduler: () =>
				({ start: async () => {}, stop: async () => {}, trigger: () => {} }) as never,
			startStatusServer: ((opts: { hostConflicts?: () => unknown }) => {
				seen = opts;
				return { hostname: "127.0.0.1", port: 0, stop: async () => {} };
			}) as never,
		});
		await handle.stop();

		// THE ASSERTION. Deleting `hostConflicts,` from the `serveStatus({...})` call
		// in service.ts makes this undefined — with no type error, because the option
		// is optional — and the tripwire section silently leaves the status page.
		const opts = seen as { hostConflicts?: () => unknown } | null;
		expect(opts).not.toBeNull();
		expect(typeof opts?.hostConflicts).toBe("function");
		// And it is a LIVE READER of a real tally, not a stub: calling it yields the
		// empty-tripwire shape rather than throwing or returning undefined. A reader
		// is passed rather than a value so each request sees the current count.
		expect(opts?.hostConflicts?.()).toEqual({
			count: 0,
			lastAttemptId: null,
			lastAt: null,
			lastPairs: [],
		});

		await rename(
			configPath,
			join(testArchiveDir(), `${basename(configPath)}-${crypto.randomUUID()}`),
		);
	});
});
