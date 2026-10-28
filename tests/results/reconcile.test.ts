import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import {
	busResults,
	githubItems,
	jobAttempts,
	jobs,
	repositories,
	resultPostings,
} from "../../src/db/schema";
import { INFRA_RESULT_NAME } from "../../src/infra/body";
import { BusResultReader, DONE_ARTIFACT } from "../../src/results/bus-reader";
import { CompositeResultReader } from "../../src/results/composite-reader";
import { ResultReconciler } from "../../src/results/reconcile";
import { RESULT_VERSION } from "../../src/results/schema";
import { ShareResultReader } from "../../src/results/share-reader";
import { WATCHER_RESULT_NAME } from "../../src/templates/agent-lane";
import { withTestDb } from "../db/helpers";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

// Portable temp workspace: Mac default, or the runner's job-local override.
const tmpBase = testTmpBase();
const archive = testArchiveDir();
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) {
		renameSync(root, join(archive, `${basename(root)}-${Date.now()}`));
	}
});

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function seedActiveAttempt(
	db: TestDb,
	repositoryId: number,
	runnerJobId: string,
	itemNumber: number,
	jobType = "pr-review",
) {
	const sha = `deadbee${itemNumber}`;
	const [item] = await db
		.insert(githubItems)
		.values({
			repositoryId,
			kind: "pull",
			number: itemNumber,
			headSha: sha,
			state: "open",
		})
		.returning();
	if (!item) throw new Error("seed failed");
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId,
			itemId: item.id,
			sha,
			jobType,
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
	return { job, sha };
}

// The seeded attempts default to the `pr-review` job type, an agent lane that now
// reads the fixed named WATCHER_RESULT_NAME artifact — not the wrapper-owned
// result.json. So the default fixture filename is that named artifact; callers that
// need a different artifact (infra-static's own name, or the wrapper envelope) pass
// it explicitly.
function writeRunnerResult(
	shareRoot: string,
	runnerJobId: string,
	host: string,
	result: string,
	fileName: string = WATCHER_RESULT_NAME,
): void {
	const dir = join(shareRoot, "runners", "jobs", runnerJobId, host);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "DONE"), "");
	writeFileSync(join(dir, fileName), result);
}

function validResult(itemNumber: number, sha: string, jobType = "pr-review"): string {
	return JSON.stringify({
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: jobType,
		item_number: itemNumber,
		sha,
		status: "passed",
		checks: [],
		findings: [],
	});
}

describe("ResultReconciler", () => {
	test("fresh construction discovers DONE host and persists its active attempt", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-restart-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");
			const { job, sha } = await seedActiveAttempt(db, repo.id, "rw-restart", 8);
			writeRunnerResult(shareRoot, "rw-restart", "runner-a", validResult(8, sha));

			// Construction happens after durable DB/share state exists: restart shape.
			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 1, failures: 0 });
			const [persistedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(persistedJob?.status).toBe("completed");
			const [posting] = await db
				.select()
				.from(resultPostings)
				.where(eq(resultPostings.jobId, job.id));
			// #90: the single DONE host completed the job, so its posting is `accepted`.
			expect(posting?.status).toBe("accepted");
		});
	});

	// sf#465 R4: the same fixture, delivered over the bus instead of the share. The
	// composite reads the bus FIRST and the share second; the share here is an empty
	// directory, so the ONLY source of the artifact is `bus_results`. The stored
	// verdict must be byte-identical to the share-fed run above — the reader changes
	// where the bytes come from, never what ingest does with them.
	test("a bus-delivered result ingests exactly as the same result from the share", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-bus-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");
			const { job, sha } = await seedActiveAttempt(db, repo.id, "rw-bus", 11);
			// Nothing on the share for this job: no host directory, no DONE, no artifact.
			await db.insert(busResults).values({
				jobRunnerId: "rw-bus",
				hostname: "runner-a",
				artifact: WATCHER_RESULT_NAME,
				body: validResult(11, sha),
				msgId: "msg-rw-bus-1",
				subject: "factory.jobs.rw-bus.result",
			});
			// The completion marker the runner publishes LAST, after every artifact —
			// the bus equivalent of the share's DONE file, which the share fixtures in
			// this file write for exactly the same reason. Without it the host is not
			// done and the reconciler correctly leaves the attempt pending.
			await db.insert(busResults).values({
				jobRunnerId: "rw-bus",
				hostname: "runner-a",
				artifact: DONE_ARTIFACT,
				body: "",
				msgId: "msg-rw-bus-done",
				subject: "factory.jobs.rw-bus.result",
			});

			const shareReader = new ShareResultReader(shareRoot);
			const summary = await new ResultReconciler(db, {
				shareRoot,
				reader: new CompositeResultReader({
					first: new BusResultReader(db),
					second: shareReader,
				}),
			}).run();

			expect(summary).toMatchObject({
				attempts: 1,
				hosts: 1,
				ingested: 1,
				invalid: 0,
				failures: 0,
			});
			const [persistedJob] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(persistedJob?.status).toBe("completed");
			const [posting] = await db
				.select()
				.from(resultPostings)
				.where(eq(resultPostings.jobId, job.id));
			expect(posting?.status).toBe("accepted");
		});
	});
	test("one malformed result does not prevent another active result from reconciling", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-isolation-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");
			const bad = await seedActiveAttempt(db, repo.id, "rw-bad", 9);
			const good = await seedActiveAttempt(db, repo.id, "rw-good", 10);
			writeRunnerResult(shareRoot, "rw-bad", "runner-a", "{not-json");
			writeRunnerResult(shareRoot, "rw-good", "runner-b", validResult(10, good.sha));

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 2, hosts: 2, ingested: 1, invalid: 1 });
			const [badJob] = await db.select().from(jobs).where(eq(jobs.id, bad.job.id));
			const [goodJob] = await db.select().from(jobs).where(eq(jobs.id, good.job.id));
			expect(badJob?.status).toBe("failed");
			expect(goodJob?.status).toBe("completed");
		});
	});
	test("a throwing onError sink does not abort the pass: both failures still counted", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-onerror-throw-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			// Two active attempts. Each job directory is made UNREADABLE (mode 000) so
			// listHosts throws (EACCES, not ENOENT) and drives recordFailure for both —
			// and the operator's error sink itself THROWS on each. A faulty monitoring
			// sink must not escape recordFailure and abort the reconcile pass: both
			// failures must still be counted and no attempt state is lost.
			const a = await seedActiveAttempt(db, repo.id, "rw-throw-a", 30);
			const b = await seedActiveAttempt(db, repo.id, "rw-throw-b", 31);
			const jobDirs = ["rw-throw-a", "rw-throw-b"].map((id) =>
				join(shareRoot, "runners", "jobs", id),
			);
			for (const dir of jobDirs) {
				mkdirSync(dir, { recursive: true });
				chmodSync(dir, 0o000);
			}

			let onErrorCalls = 0;
			try {
				// The pass must resolve (the throwing sink never escapes recordFailure).
				const summary = await new ResultReconciler(db, {
					shareRoot,
					onError: () => {
						onErrorCalls++;
						throw new Error("faulty logging sink");
					},
				}).run();

				// Both attempts' listHosts failed and recordFailure fired for each — the
				// summary still reflects both failures despite the throwing sink.
				expect(summary).toMatchObject({ attempts: 2, failures: 2 });
				expect(onErrorCalls).toBe(2);
			} finally {
				// Restore permissions so the afterAll archive rename can traverse the tree.
				for (const dir of jobDirs) chmodSync(dir, 0o700);
			}

			// No attempt was wrongly advanced: both jobs stay running (nothing ingested).
			const [aJob] = await db.select().from(jobs).where(eq(jobs.id, a.job.id));
			const [bJob] = await db.select().from(jobs).where(eq(jobs.id, b.job.id));
			expect(aJob?.status).toBe("running");
			expect(bJob?.status).toBe("running");
		});
	});
});

describe("ResultReconciler — per-job-type result artifact", () => {
	test("an infra-static attempt ingests its named artifact; a pr-review attempt ingests its own named artifact", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-infra-artifact-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			// An infra-static attempt: its watcher-schema result lives in the fixed,
			// author-owned infra-static-result.json — NOT the wrapper-owned result.json.
			const infra = await seedActiveAttempt(db, repo.id, "rw-infra", 20, "infra-static");
			writeRunnerResult(
				shareRoot,
				"rw-infra",
				"runner-a",
				validResult(20, infra.sha, "infra-static"),
				"infra-static-result.json",
			);

			// A pr-review agent-lane attempt reads its own fixed WATCHER_RESULT_NAME
			// artifact (the fixture default), distinct from infra-static's name.
			const pr = await seedActiveAttempt(db, repo.id, "rw-pr", 21);
			writeRunnerResult(shareRoot, "rw-pr", "runner-b", validResult(21, pr.sha));

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 2, hosts: 2, ingested: 2, invalid: 0 });

			const [infraJob] = await db.select().from(jobs).where(eq(jobs.id, infra.job.id));
			expect(infraJob?.status).toBe("completed");
			const [prJob] = await db.select().from(jobs).where(eq(jobs.id, pr.job.id));
			expect(prJob?.status).toBe("completed");
		});
	});

	test("an infra-static attempt with ONLY result.json (no named artifact) fails closed to invalid", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-infra-missing-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			// The named artifact is absent; only the wrapper result.json exists. The
			// infra-static lane reads ONLY its named artifact, so the missing artifact
			// must ingest as invalid (a false pass is never adopted from result.json).
			const infra = await seedActiveAttempt(db, repo.id, "rw-infra2", 22, "infra-static");
			writeRunnerResult(shareRoot, "rw-infra2", "runner-a", validResult(22, infra.sha));

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 0, invalid: 1 });
			const [infraJob] = await db.select().from(jobs).where(eq(jobs.id, infra.job.id));
			expect(infraJob?.status).toBe("failed");
		});
	});
});

/**
 * The three agent lanes (pr-review, issue-triage, implement-issue) read the fixed
 * WATCHER_RESULT_NAME artifact, not the wrapper-owned result.json — and when that
 * artifact is ABSENT they classify the failure from the wrapper's own
 * verdict/envelope side channel. These fixtures write EXACTLY the artifacts
 * the fleet wrapper writes (`rtech-infra scripts/runner-job`): `verdict.json`
 * carries `state` + `language`; the `result.json` envelope carries `status` +
 * `state`. Both are UNTRUSTED (the share is writable by other principals).
 */
describe("ResultReconciler — agent-lane named artifact + wrapper-failure classification", () => {
	/** The wrapper's per-job verdict artifact for a terminal state (state + language). */
	function wrapperVerdict(state: string, language: string): string {
		return JSON.stringify({
			job_id: "rw-x",
			lane: "pr-review",
			host: "runner-a",
			state,
			rc: 78,
			agent_status: null,
			language,
		});
	}

	/** The wrapper's caller-facing result.json envelope (status + state, no language). */
	function wrapperEnvelope(state: string): string {
		return JSON.stringify({
			job_id: "rw-x",
			lane: "pr-review",
			status: null,
			host: "runner-a",
			state,
		});
	}

	test("(a) pr-review with ONLY the wrapper envelope + DONE classifies an agent failure, never a zod union error", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-agent-fail-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			// The exact live-observed defect (job 388): the agent produced no
			// watcher-result.json; the only artifacts are the wrapper's verdict + envelope
			// + DONE. The lane must record the wrapper's terminal state, NOT schema-parse
			// the envelope (which would surface an "invalid_union at result_version").
			const pr = await seedActiveAttempt(db, repo.id, "rw-agentfail", 40);
			const dir = join(shareRoot, "runners", "jobs", "rw-agentfail", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");
			writeFileSync(
				join(dir, "verdict.json"),
				wrapperVerdict("no-credentials", "no usable agent credentials on the share"),
			);
			writeFileSync(join(dir, "result.json"), wrapperEnvelope("no-credentials"));

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 0, invalid: 1 });

			const [prJob] = await db.select().from(jobs).where(eq(jobs.id, pr.job.id));
			expect(prJob?.status).toBe("failed");

			const [attempt] = await db
				.select({ failureSummary: jobAttempts.failureSummary })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-agentfail"))
				.limit(1);
			// The classified reason names the wrapper's terminal cause, not a schema error.
			expect(attempt?.failureSummary).toContain("runner agent failed before producing a result");
			expect(attempt?.failureSummary).toContain("no-credentials");
			expect(attempt?.failureSummary).toContain("no usable agent credentials");
			expect(attempt?.failureSummary).not.toContain("union");
			expect(attempt?.failureSummary).not.toContain("result_version");
		});
	});

	test("(b) pr-review with a valid watcher-result.json + wrapper envelope ingests the named artifact and ignores the envelope", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-agent-named-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			// Both artifacts are present: the author-owned named result AND the wrapper's
			// envelope. The lane must ingest the NAMED artifact and never schema-parse the
			// envelope — the success case that the current wrapper makes indistinguishable
			// at result.json alone.
			const pr = await seedActiveAttempt(db, repo.id, "rw-agentok", 41);
			const dir = join(shareRoot, "runners", "jobs", "rw-agentok", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");
			writeFileSync(join(dir, WATCHER_RESULT_NAME), validResult(41, pr.sha));
			// A wrapper envelope in result.json — a schema-invalid document if read — that
			// must be IGNORED because the lane never reads result.json.
			writeFileSync(join(dir, "result.json"), wrapperEnvelope("completed"));

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 1, invalid: 0 });

			const [prJob] = await db.select().from(jobs).where(eq(jobs.id, pr.job.id));
			expect(prJob?.status).toBe("completed");
		});
	});

	/**
	 * sf#254: the live 71/71 shape, end to end through the real reconciler.
	 *
	 * A present-but-DEAD credential passes the wrapper's `[ -s ... ]` preflight, so
	 * the wrapper runs the agent and finishes ST_COMPLETED with a nonzero
	 * agent_status. `verdict.json` therefore says nothing about auth — its language
	 * is the fixed "agent runtime ran to completion" enum text — and the only
	 * witness is `agent.log`. Before this carve-out the attempt read as
	 * "artifact missing" and three sessions went hunting a layout ghost.
	 */
	test("(c) sf#254 — a completed verdict whose agent.log carries an OAuth expiry persists the auth CLASS", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-agent-authdeath-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			const pr = await seedActiveAttempt(db, repo.id, "rw-authdeath", 43);
			const dir = join(shareRoot, "runners", "jobs", "rw-authdeath", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");
			// The wrapper's OWN verdict for this path: completed, and auth-silent.
			writeFileSync(
				join(dir, "verdict.json"),
				JSON.stringify({
					job_id: "rw-authdeath",
					lane: "pr-review",
					host: "runner-a",
					state: "completed",
					rc: 0,
					agent_status: 1,
					language: "agent runtime ran to completion; agent exit status is authoritative",
				}),
			);
			// The only witness to the real cause.
			writeFileSync(
				join(dir, "agent.log"),
				[
					"Reading repository configuration...",
					"Failed to authenticate: OAuth session expired and could not be refreshed",
				].join("\n"),
			);

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 0, invalid: 1 });

			const [attempt] = await db
				.select({ failureSummary: jobAttempts.failureSummary })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-authdeath"))
				.limit(1);
			// The claim: the persisted reason names its own class.
			expect(attempt?.failureSummary).toContain("runtime-auth-failure");
			// The regression #254 names: it must NOT read as a missing artifact.
			expect(attempt?.failureSummary).not.toContain("is missing");
			// The wrapper detail is not lost to the class prefix.
			expect(attempt?.failureSummary).toContain("runner agent failed before producing a result");

			const [prJob] = await db.select().from(jobs).where(eq(jobs.id, pr.job.id));
			expect(prJob?.status).toBe("failed");
		});
	});

	/**
	 * ANTI-OVERMATCH at the reconciler, not just the pure function: an agent that
	 * died for a NON-auth reason must not be swept into the class. Same shape as
	 * (c) — completed verdict, agent.log present — differing only in the log's
	 * content, so the log really is the discriminator.
	 */
	test("(d) sf#254 anti-overmatch — a completed verdict whose agent.log is a non-auth death carries NO class", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-agent-turnsdeath-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			await seedActiveAttempt(db, repo.id, "rw-turnsdeath", 44);
			const dir = join(shareRoot, "runners", "jobs", "rw-turnsdeath", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");
			writeFileSync(
				join(dir, "verdict.json"),
				JSON.stringify({
					job_id: "rw-turnsdeath",
					lane: "pr-review",
					host: "runner-a",
					state: "completed",
					rc: 0,
					agent_status: 1,
					language: "agent runtime ran to completion; agent exit status is authoritative",
				}),
			);
			// The real non-auth death this repo has already seen (registry.ts:89).
			writeFileSync(join(dir, "agent.log"), "Error: Reached max turns (30)");

			await new ResultReconciler(db, { shareRoot }).run();

			const [attempt] = await db
				.select({ failureSummary: jobAttempts.failureSummary })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-turnsdeath"))
				.limit(1);
			expect(attempt?.failureSummary).not.toContain("runtime-auth-failure");
			expect(attempt?.failureSummary).toContain("runner agent failed before producing a result");
		});
	});

	test("agent lane with NEITHER the named artifact NOR a usable verdict falls back to the named missing-artifact reason", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-agent-bare-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			// DONE but no watcher-result.json and no verdict/envelope. The classifier
			// yields null, so ingest falls back to a reason that names the artifact
			// actually sought — never a hardcoded result.json.
			await seedActiveAttempt(db, repo.id, "rw-agentbare", 42);
			const dir = join(shareRoot, "runners", "jobs", "rw-agentbare", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 0, invalid: 1 });

			const [attempt] = await db
				.select({ failureSummary: jobAttempts.failureSummary })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-agentbare"))
				.limit(1);
			expect(attempt?.failureSummary).toContain(WATCHER_RESULT_NAME);
			expect(attempt?.failureSummary).toContain("missing");
		});
	});
});

/**
 * sf#263 — the SAME wrapper-failure classification, on the `infra-static` lane.
 *
 * `infra-static` runs under the fleet wrapper exactly as the agent lanes do, but
 * `readerFor` attached `classifyMissing` only when `isAgentLaneJobType` was true,
 * so an infra-static attempt that died before writing `infra-static-result.json`
 * persisted the bare "DONE present but infra-static-result.json is missing".
 * That is precisely how a fleet-wide credential outage read as a repo-layout
 * problem for four days (116/116 failures, three sessions hunting a ghost) —
 * the witness was on the share the whole time and nothing read it.
 *
 * These fixtures write EXACTLY what the wrapper writes and are keyed on
 * (jobRunnerId, hostname), the per-(job, host) shape #86 fixed.
 */
describe("ResultReconciler — infra-static missing-artifact classification", () => {
	/**
	 * The wrapper's OWN verdict for a runtime auth death: it finishes `completed`
	 * with a nonzero `agent_status`, because a structurally-valid but DEAD
	 * credential passes its preflight. `language` is the fixed enum text and is
	 * auth-SILENT — the wrapper cannot express this cause, so `agent.log` is the
	 * only witness (the W1-d/sf#254 lesson, restated here rather than referenced).
	 */
	function completedVerdict(jobId: string): string {
		return JSON.stringify({
			job_id: jobId,
			lane: "infra-static",
			host: "runner-a",
			state: "completed",
			rc: 0,
			agent_status: 1,
			language: "agent runtime ran to completion; agent exit status is authoritative",
		});
	}

	test("an infra-static attempt whose agent.log carries an OAuth expiry persists the auth CLASS, not a bare missing artifact", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-infra-authdeath-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			const infra = await seedActiveAttempt(db, repo.id, "rw-infra-auth", 60, "infra-static");
			const dir = join(shareRoot, "runners", "jobs", "rw-infra-auth", "runner-a");
			mkdirSync(dir, { recursive: true });
			// DONE present, infra-static-result.json ABSENT: the live outage shape.
			writeFileSync(join(dir, "DONE"), "");
			writeFileSync(join(dir, "verdict.json"), completedVerdict("rw-infra-auth"));
			writeFileSync(
				join(dir, "agent.log"),
				[
					"Reading repository configuration...",
					"Failed to authenticate: OAuth session expired and could not be refreshed",
				].join("\n"),
			);

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 0, invalid: 1 });

			const [attempt] = await db
				.select({ failureSummary: jobAttempts.failureSummary })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-infra-auth"))
				.limit(1);
			// The claim of #263: the classified cause is attached on an infra lane.
			expect(attempt?.failureSummary).toContain("runtime-auth-failure");
			expect(attempt?.failureSummary).toContain("runner agent failed before producing a result");
			// The regression: it must no longer read as a bare missing artifact.
			expect(attempt?.failureSummary).not.toContain("is missing");
			expect(attempt?.failureSummary).not.toContain(INFRA_RESULT_NAME);

			// The lane still FAILS — #263 makes the failure readable, never green.
			const [infraJob] = await db.select().from(jobs).where(eq(jobs.id, infra.job.id));
			expect(infraJob?.status).toBe("failed");
		});
	});

	test("an infra-static attempt with a non-auth wrapper death carries the wrapper cause and NO auth class", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-infra-nonauth-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			await seedActiveAttempt(db, repo.id, "rw-infra-nonauth", 61, "infra-static");
			const dir = join(shareRoot, "runners", "jobs", "rw-infra-nonauth", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");
			writeFileSync(
				join(dir, "verdict.json"),
				JSON.stringify({
					job_id: "rw-infra-nonauth",
					lane: "infra-static",
					host: "runner-a",
					state: "timeout",
					rc: 124,
					agent_status: null,
					language: "job exceeded its wall-clock budget",
				}),
			);

			await new ResultReconciler(db, { shareRoot }).run();

			const [attempt] = await db
				.select({ failureSummary: jobAttempts.failureSummary })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-infra-nonauth"))
				.limit(1);
			expect(attempt?.failureSummary).toContain("runner agent failed before producing a result");
			expect(attempt?.failureSummary).toContain("timeout");
			// Anti-overmatch: a non-auth death is not swept into the class.
			expect(attempt?.failureSummary).not.toContain("runtime-auth-failure");
		});
	});

	test("an infra-static attempt with NO wrapper artifacts still falls back to the named missing-artifact reason", async () => {
		await withTestDb(async (db) => {
			const shareRoot = mkdtempSync(join(tmpBase, "reconcile-infra-bare-"));
			roots.push(shareRoot);
			const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
			if (!repo) throw new Error("seed failed");

			// DONE and nothing else. The classifier finds no usable state, returns null,
			// and the generic reason must still name the artifact actually sought.
			await seedActiveAttempt(db, repo.id, "rw-infra-bare", 62, "infra-static");
			const dir = join(shareRoot, "runners", "jobs", "rw-infra-bare", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");

			const summary = await new ResultReconciler(db, { shareRoot }).run();
			expect(summary).toMatchObject({ attempts: 1, hosts: 1, ingested: 0, invalid: 1 });

			const [attempt] = await db
				.select({ failureSummary: jobAttempts.failureSummary })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, "rw-infra-bare"))
				.limit(1);
			expect(attempt?.failureSummary).toContain(INFRA_RESULT_NAME);
			expect(attempt?.failureSummary).toContain("missing");
		});
	});
});
