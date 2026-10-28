/**
 * #90 — the proposal candidate loader must bind the pushed bundle to THE result
 * that completed the job, not to ANY schema-valid result recorded for the
 * attempt.
 *
 * The interleaving (from PR #86 review finding 1): reconcile ingests every host
 * dir under an attempt, and hostnames on the share are runner-writable. So a
 * runner can write host dirs `a` and `b`, BOTH DONE, BOTH independently passing
 * full verification, under ONE runner job id. Exactly one persist wins the
 * `running`-guarded job transition and completes the job; both host results end
 * up as `result_postings` rows for that job. Before the fix the loader joined
 * `result_postings` with no status filter, so it emitted two candidates and the
 * runner — by choosing which host dir sorts first — chose which of two verified
 * trees gets pushed to `rw/issue-<n>`. The fix marks the job-completing posting
 * `accepted` in the SAME transaction that transitions the job, and the loader
 * filters on that.
 *
 * This drives the REAL store (so `accepted` is set by the real transition, never
 * hand-seeded) and the REAL `createCandidateLoader`, and asserts ONLY the
 * job-completing host's snapshot is proposed.
 *
 * MUTATION-PROVEN. Reverting the loader's `status = accepted` join filter makes
 * "only the job-completing host's result is proposed" fail with two candidates;
 * marking BOTH postings accepted in the store makes it fail the same way.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import {
	githubItems,
	githubPostings,
	jobAttempts,
	jobs,
	repositories,
	resultPostings,
} from "../../src/db/schema";
import { quarantinePathFor } from "../../src/results/change-ingest";
import { snapshotPathFor } from "../../src/results/change-verifier";
import type { PersistedResult } from "../../src/results/ingest";
import { createCandidateLoader, MAX_PROPOSALS_PER_PASS } from "../../src/results/proposal-pass";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { DbResultStore } from "../../src/results/store";
import { withTestDb } from "../db/helpers";
import { testTmpBase } from "../support/test-temp";

/** The production `snapshotExists`: a file at the path, resolved by fstat (service.ts). */
async function productionSnapshotExists(path: string): Promise<boolean> {
	try {
		const { stat } = await import("node:fs/promises");
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-07-19T12:00:00.000Z");
const REPO = "rodaddy/x";
const ITEM = 42;
const SHA = "deadbeef";

/** Seed a running implement-issue job + submitted attempt that OWNS the job. */
async function seedImplementJob(db: TestDb, runnerJobId: string): Promise<{ jobId: number }> {
	const [repo] = await db.insert(repositories).values({ fullName: REPO }).returning();
	if (!repo) throw new Error("seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "issue", number: ITEM, state: "open", headSha: SHA })
		.returning();
	if (!item) throw new Error("seed failed");
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item.id,
			sha: SHA,
			jobType: "implement-issue",
			status: "running",
		})
		.returning({ id: jobs.id });
	if (!job) throw new Error("seed failed");
	const [attempt] = await db
		.insert(jobAttempts)
		.values({ jobId: job.id, runnerJobId, runnerVmid: 9001, status: "submitted" })
		.returning({ id: jobAttempts.id });
	if (!attempt) throw new Error("seed failed");
	// Real dispatch sets active_attempt_id when an attempt claims the job;
	// the store's ownership guard needs it to allow the job transition.
	await db.update(jobs).set({ activeAttemptId: attempt.id }).where(eq(jobs.id, job.id));
	return { jobId: job.id };
}

function passingResult(outputPath: string): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: REPO,
		job_type: "implement-issue",
		item_number: ITEM,
		sha: SHA,
		status: "passed",
		checks: [],
		findings: [],
		output_path: outputPath,
	};
}

/** A passing ingest for one host under a shared runner job id. */
function hostResult(runnerJobId: string, hostname: string): PersistedResult {
	const outputPath = `runners/jobs/${runnerJobId}/${hostname}/agent.log`;
	return {
		jobRunnerId: runnerJobId,
		hostname,
		status: "ingested",
		result: passingResult(outputPath),
		outputPath,
	};
}

describe("createCandidateLoader", () => {
	test("only the job-completing host's result is proposed when two hosts both verify", async () => {
		await withTestDb(async (db) => {
			const runnerJobId = "rw-two-host";
			await seedImplementJob(db, runnerJobId);
			const store = new DbResultStore(db, () => at);

			// Two host dirs under ONE attempt, both DONE, both schema-valid and passing.
			// Host `a` lands first: its persist wins the running-guarded transition and
			// completes the job (posting -> `accepted`). Host `b` lands second: the
			// attempt is already terminal and the job already completed, so its persist
			// does NOT transition the job and its posting stays `recorded`.
			await store.persist(hostResult(runnerJobId, "host-a"));
			await store.persist(hostResult(runnerJobId, "host-b"));

			// Prove the two-posting shape the loader must disambiguate.
			const postings = await db.select().from(resultPostings).orderBy(resultPostings.target);
			expect(postings.map((p) => [p.target, p.status])).toEqual([
				["runner:host-a:rw-two-host", "accepted"],
				["runner:host-b:rw-two-host", "recorded"],
			]);

			// The loader is asked which snapshot to propose. Both hosts' snapshots
			// "exist"; the loader must pick ONLY the accepted one.
			const seen: string[] = [];
			const loader = createCandidateLoader(
				db,
				(jobRunnerId, hostname) => `runners/jobs/${jobRunnerId}/${hostname}/change.bundle`,
				async (path) => {
					seen.push(path);
					return true;
				},
			);
			const candidates = await loader(10);

			expect(candidates).toHaveLength(1);
			expect(candidates[0]?.snapshotPath).toBe("runners/jobs/rw-two-host/host-a/change.bundle");
			// The runner-writable host-b tree is never even probed as a candidate source.
			expect(seen).toEqual(["runners/jobs/rw-two-host/host-a/change.bundle"]);
		});
	});

	test("a job with only a recorded (never-accepted) posting yields no candidate", async () => {
		// Defense in depth: a posting that never completed a job must not be pushed.
		// Seeded directly as `recorded` to isolate the loader's status filter.
		await withTestDb(async (db) => {
			const { jobId } = await seedImplementJob(db, "rw-stuck");
			// Force the job to `completed`/`completed` without an accepted posting, the
			// exact shape the pre-fix loader treated as pushable.
			await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, jobId));
			await db.update(jobAttempts).set({ status: "completed" }).where(eq(jobAttempts.jobId, jobId));
			await db.insert(resultPostings).values({
				jobId,
				target: "runner:host-x:rw-stuck",
				status: "recorded",
				postedAt: at,
			});

			const loader = createCandidateLoader(
				db,
				(jobRunnerId, hostname) => `runners/jobs/${jobRunnerId}/${hostname}/change.bundle`,
				async () => true,
			);
			expect(await loader(10)).toHaveLength(0);
		});
	});
});

/**
 * #91 — a completed implement job that produced NO change matches the SQL WHERE
 * forever (it has an `accepted` posting but no bundle, so `snapshotExists` is
 * false and it is dropped in JS) yet never gets a `proposal` posting. With a
 * single `.limit(limit)` cut ordered by `jobs.id asc`, the oldest `limit`
 * no-change jobs permanently fill the page and starve every younger real
 * candidate. The loader must seek PAST those JS-dropped rows.
 *
 * This drives the REAL store (so `accepted` is set by the real transition) and
 * the REAL loader. It seeds `limit + 1` OLDER no-change jobs, then one real
 * candidate, and asserts the real candidate is still loaded.
 *
 * MUTATION-PROVEN: replacing the keyset loop with a single fixed `.limit(limit)`
 * cut makes the real candidate disappear (0 candidates), because the older
 * no-change jobs consume the whole page.
 */
describe("createCandidateLoader", () => {
	const HOST = "host-a";
	const BUNDLE = "change.bundle";

	/**
	 * Seed one running implement-issue job under a SHARED repo, with its own item
	 * number and SHA so (repo,item,sha,type) stays unique. Returns the job id;
	 * `jobs.id` is insertion-monotonic, so earlier calls are the OLDER jobs the
	 * loader orders first.
	 */
	async function seedJob(
		db: TestDb,
		repoId: number,
		runnerJobId: string,
		itemNumber: number,
	): Promise<{ jobId: number }> {
		const sha = `sha${itemNumber}`;
		const [item] = await db
			.insert(githubItems)
			.values({
				repositoryId: repoId,
				kind: "issue",
				number: itemNumber,
				state: "open",
				headSha: sha,
			})
			.returning();
		if (!item) throw new Error("seed failed");
		const [job] = await db
			.insert(jobs)
			.values({
				repositoryId: repoId,
				itemId: item.id,
				sha,
				jobType: "implement-issue",
				status: "running",
			})
			.returning({ id: jobs.id });
		if (!job) throw new Error("seed failed");
		const [attempt] = await db
			.insert(jobAttempts)
			.values({ jobId: job.id, runnerJobId, runnerVmid: 9001, status: "submitted" })
			.returning({ id: jobAttempts.id });
		if (!attempt) throw new Error("seed failed");
		await db.update(jobs).set({ activeAttemptId: attempt.id }).where(eq(jobs.id, job.id));
		return { jobId: job.id };
	}

	/** A passing implement result under (runnerJobId, HOST) for the given item/sha. */
	function passingHostResult(runnerJobId: string, itemNumber: number): PersistedResult {
		const sha = `sha${itemNumber}`;
		const outputPath = `runners/jobs/${runnerJobId}/${HOST}/agent.log`;
		return {
			jobRunnerId: runnerJobId,
			hostname: HOST,
			status: "ingested",
			result: {
				result_version: RESULT_VERSION,
				repository: REPO,
				job_type: "implement-issue",
				item_number: itemNumber,
				sha,
				status: "passed",
				checks: [],
				findings: [],
				output_path: outputPath,
			},
			outputPath,
		};
	}

	test("a page full of OLDER no-change jobs does not starve a younger real candidate", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db.insert(repositories).values({ fullName: REPO }).returning();
			if (!repo) throw new Error("seed failed");
			const store = new DbResultStore(db, () => at);

			// `limit + 1` no-change jobs, seeded FIRST so they are the oldest by
			// `jobs.id`. Each completes via a real passing ingest (posting -> accepted),
			// so each matches the SQL WHERE forever, but none has a bundle on disk.
			const noChangeRunnerIds: string[] = [];
			for (let i = 0; i < MAX_PROPOSALS_PER_PASS + 1; i++) {
				const runnerJobId = `rw-nochange-${i}`;
				noChangeRunnerIds.push(runnerJobId);
				await seedJob(db, repo.id, runnerJobId, 100 + i);
				await store.persist(passingHostResult(runnerJobId, 100 + i));
			}

			// One real candidate, seeded LAST so it is the YOUNGEST job. It also
			// completes via a real passing ingest; unlike the others, its bundle exists.
			const realRunnerId = "rw-real";
			const realItem = 200;
			await seedJob(db, repo.id, realRunnerId, realItem);
			await store.persist(passingHostResult(realRunnerId, realItem));
			const realBundlePath = `runners/jobs/${realRunnerId}/${HOST}/${BUNDLE}`;

			// Only the real candidate's snapshot exists on disk; every no-change job's
			// snapshot is absent — the exact runtime state the loader must see through.
			const noChangeBundlePaths = new Set(
				noChangeRunnerIds.map((id) => `runners/jobs/${id}/${HOST}/${BUNDLE}`),
			);
			const loader = createCandidateLoader(
				db,
				(jobRunnerId, hostname) => `runners/jobs/${jobRunnerId}/${hostname}/${BUNDLE}`,
				async (path) => {
					if (noChangeBundlePaths.has(path)) return false;
					return path === realBundlePath;
				},
			);

			const candidates = await loader(MAX_PROPOSALS_PER_PASS);

			// The younger real candidate must survive the older page-filling no-change
			// jobs. Pre-fix (single `.limit` cut) this is 0.
			expect(candidates).toHaveLength(1);
			expect(candidates[0]?.snapshotPath).toBe(realBundlePath);
		});
	});
});

/**
 * sf#303 — a completed VERB job with an ACCEPTED posting must become a proposal
 * candidate, carrying the CHANGE identity rather than the dispatch identity.
 *
 * The gap: the loader hard-filtered `jobs.job_type = implement-issue` and read
 * `repository` off the managed repository with `dispatchedBaseSha` off
 * `jobs.sha`. A verb job is dispatched against a MANAGED repo's issue (that is
 * where the `deploy:<app>` label lives) with the rails-MANIFEST sha256 in
 * `jobs.sha`, but the change it returns is a render against `rtech/k3s-deploy`.
 * So a verb job that completed with an accepted, verified snapshot was invisible
 * to every proposal cycle: no branch, no proposal. Live proof it was reachable:
 * `rw-newapp-90531eaf` was ACCEPTED in production on 2026-08-16 and produced
 * neither.
 *
 * These drive the REAL store (so `accepted` is set by the real job transition,
 * never hand-seeded) and the REAL `createCandidateLoader`.
 *
 * MUTATION-PROVEN, both halves, run for real:
 *   - reverting the predicate to `eq(jobs.jobType, IMPLEMENT_TEMPLATE_ID)` makes
 *     the verb candidate DISAPPEAR (0 candidates) while the implement candidate
 *     in the mixed-page test survives;
 *   - reverting the identity mapping to `row.repository` / `row.dispatchedBaseSha`
 *     makes the verb candidate carry `rodaddy/x` and the manifest digest, failing
 *     the repository and base assertions.
 */
describe("createCandidateLoader", () => {
	const HOST = "host-a";
	const BUNDLE = "change.bundle";
	const VERB = "newapp";
	/** A full 40-hex k3s-deploy head — the only base shape a verb may declare. */
	const K3S_BASE = "a".repeat(40);
	/** The rails-manifest digest a verb dispatch puts in `jobs.sha`: NOT a git object. */
	const MANIFEST_SHA = "b".repeat(64);

	/**
	 * Seed a running job of `jobType` whose change base is whatever the caller
	 * passes, mirroring what `verb-live` records at dispatch. A null
	 * `changeBaseSha` is the "verb job with no usable base" shape.
	 */
	async function seedJob(
		db: TestDb,
		repoId: number,
		options: {
			runnerJobId: string;
			itemNumber: number;
			jobType: string;
			sha: string;
			changeBaseRepository?: string | null;
			changeBaseSha?: string | null;
		},
	): Promise<{ jobId: number }> {
		const [item] = await db
			.insert(githubItems)
			.values({
				repositoryId: repoId,
				kind: "issue",
				number: options.itemNumber,
				state: "open",
				headSha: options.sha,
			})
			.returning();
		if (!item) throw new Error("seed failed");
		const [job] = await db
			.insert(jobs)
			.values({
				repositoryId: repoId,
				itemId: item.id,
				sha: options.sha,
				jobType: options.jobType,
				status: "running",
				changeBaseRepository: options.changeBaseRepository ?? null,
				changeBaseSha: options.changeBaseSha ?? null,
			})
			.returning({ id: jobs.id });
		if (!job) throw new Error("seed failed");
		const [attempt] = await db
			.insert(jobAttempts)
			.values({
				jobId: job.id,
				runnerJobId: options.runnerJobId,
				runnerVmid: 9001,
				status: "submitted",
			})
			.returning({ id: jobAttempts.id });
		if (!attempt) throw new Error("seed failed");
		await db.update(jobs).set({ activeAttemptId: attempt.id }).where(eq(jobs.id, job.id));
		return { jobId: job.id };
	}

	/** A passing ingest for one job, under (runnerJobId, HOST). */
	function passingHostResult(options: {
		runnerJobId: string;
		itemNumber: number;
		jobType: string;
		sha: string;
	}): PersistedResult {
		const outputPath = `runners/jobs/${options.runnerJobId}/${HOST}/agent.log`;
		return {
			jobRunnerId: options.runnerJobId,
			hostname: HOST,
			status: "ingested",
			result: {
				result_version: RESULT_VERSION,
				repository: REPO,
				job_type: options.jobType,
				item_number: options.itemNumber,
				sha: options.sha,
				status: "passed",
				checks: [],
				findings: [],
				output_path: outputPath,
			},
			outputPath,
		};
	}

	test("a completed verb job with an accepted posting yields ONE candidate carrying the change base", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db.insert(repositories).values({ fullName: REPO }).returning();
			if (!repo) throw new Error("seed failed");
			const store = new DbResultStore(db, () => at);

			const runnerJobId = "rw-newapp-90531eaf";
			const itemNumber = 90531;
			await seedJob(db, repo.id, {
				runnerJobId,
				itemNumber,
				jobType: VERB,
				sha: MANIFEST_SHA,
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_BASE,
			});
			// The REAL transition: this persist completes the job and marks its posting
			// `accepted`, so the row reaches the loader exactly as production does.
			await store.persist(
				passingHostResult({ runnerJobId, itemNumber, jobType: VERB, sha: MANIFEST_SHA }),
			);

			const bundlePath = `runners/jobs/${runnerJobId}/${HOST}/${BUNDLE}`;
			const loader = createCandidateLoader(
				db,
				(jobRunnerId, hostname) => `runners/jobs/${jobRunnerId}/${hostname}/${BUNDLE}`,
				async (path) => path === bundlePath,
			);

			const candidates = await loader(10);

			// Pre-fix this is 0: the predicate never matched a verb job type.
			expect(candidates).toHaveLength(1);
			const candidate = candidates[0];
			// The CHANGE identity, not the dispatch identity. Both halves matter: the
			// managed repo would push a k3s render onto `rodaddy/x`, and the manifest
			// digest is not a git object at all, so the ancestry check could not resolve
			// it even if the repository were right.
			expect(candidate?.repository).toBe("rtech/k3s-deploy");
			expect(candidate?.dispatchedBaseSha).toBe(K3S_BASE);
			expect(candidate?.repository).not.toBe(REPO);
			expect(candidate?.dispatchedBaseSha).not.toBe(MANIFEST_SHA);
			// Carried through so the downstream check-trail allowance resolves against
			// the template that actually ran.
			expect(candidate?.jobType).toBe(VERB);
			expect(candidate?.itemNumber).toBe(itemNumber);
			expect(candidate?.snapshotPath).toBe(bundlePath);
		});
	});

	test("a verb job with NO valid change base is skipped, and does not starve a younger implement candidate", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db.insert(repositories).values({ fullName: REPO }).returning();
			if (!repo) throw new Error("seed failed");
			const store = new DbResultStore(db, () => at);

			// Three baseless verb rows, seeded FIRST so they are the OLDEST by `jobs.id`
			// and would fill the head of the page: a NULL base, a base naming the wrong
			// repository, and an abbreviated (not 40-hex) sha. Each is a PERMANENT JS
			// drop of the #91 shape — it matches the SQL WHERE forever — so the keyset
			// seek must page past all three.
			const baseless: Array<{
				runnerJobId: string;
				itemNumber: number;
				changeBaseRepository: string | null;
				changeBaseSha: string | null;
			}> = [
				{
					runnerJobId: "rw-verb-nullbase",
					itemNumber: 301,
					changeBaseRepository: null,
					changeBaseSha: null,
				},
				{
					runnerJobId: "rw-verb-wrongrepo",
					itemNumber: 302,
					changeBaseRepository: "rodaddy/x",
					changeBaseSha: K3S_BASE,
				},
				{
					runnerJobId: "rw-verb-shortsha",
					itemNumber: 303,
					changeBaseRepository: "rtech/k3s-deploy",
					changeBaseSha: "abc1234",
				},
			];
			for (const row of baseless) {
				const sha = `manifest-${row.itemNumber}`;
				await seedJob(db, repo.id, {
					runnerJobId: row.runnerJobId,
					itemNumber: row.itemNumber,
					jobType: VERB,
					sha,
					changeBaseRepository: row.changeBaseRepository,
					changeBaseSha: row.changeBaseSha,
				});
				await store.persist(
					passingHostResult({
						runnerJobId: row.runnerJobId,
						itemNumber: row.itemNumber,
						jobType: VERB,
						sha,
					}),
				);
			}

			// One implement-lane candidate, seeded LAST so it is the YOUNGEST job. This
			// is the unchanged-behavior control: widening the predicate must not alter
			// what the implement lane yields.
			const implementRunnerId = "rw-implement";
			const implementItem = 400;
			const implementSha = "sha400";
			await seedJob(db, repo.id, {
				runnerJobId: implementRunnerId,
				itemNumber: implementItem,
				jobType: "implement-issue",
				sha: implementSha,
			});
			await store.persist(
				passingHostResult({
					runnerJobId: implementRunnerId,
					itemNumber: implementItem,
					jobType: "implement-issue",
					sha: implementSha,
				}),
			);

			// EVERY seeded job has a bundle on disk, so the only thing that can drop the
			// three verb rows is the change-base rule itself — not a missing snapshot.
			const loader = createCandidateLoader(
				db,
				(jobRunnerId, hostname) => `runners/jobs/${jobRunnerId}/${hostname}/${BUNDLE}`,
				async () => true,
			);

			const candidates = await loader(10);

			expect(candidates).toHaveLength(1);
			expect(candidates[0]?.jobType).toBe("implement-issue");
			// The implement candidate keeps the dispatch identity, byte-for-byte as
			// before sf#303.
			expect(candidates[0]?.repository).toBe(REPO);
			expect(candidates[0]?.dispatchedBaseSha).toBe(implementSha);
			expect(candidates[0]?.itemNumber).toBe(implementItem);
		});
	});
});

/**
 * #92 — the quarantine path a rejected bundle would leave (`<verified>.unverified`)
 * must NEVER be loader-eligible. This is proven against the REAL wiring, not a
 * stub: the REAL `snapshotPathFor` (what the loader derives), the REAL
 * `quarantinePathFor` (what change-ingest would leave on the disk), and the REAL
 * production stat-based `snapshotExists`. The loader only ever probes the verified
 * path, so a bundle sitting only at the quarantine sibling yields no candidate —
 * which is exactly why quarantine-and-promote closes the gap even though a
 * rejection is also cleaned up.
 */
describe("createCandidateLoader (#92 quarantine is never loader-eligible)", () => {
	test("a job whose ONLY on-disk artifact is the quarantine sibling yields no candidate", async () => {
		await withTestDb(async (db) => {
			const runnerJobId = "rw-quarantine";
			const HOST = "host-a";
			await seedImplementJob(db, runnerJobId);
			const store = new DbResultStore(db, () => at);
			// A real passing ingest completes the job and marks its posting `accepted`,
			// so this row matches the loader's SQL WHERE and reaches the snapshot check.
			await store.persist(hostResult(runnerJobId, HOST));

			// A real watcher work root with the production `verified/<id>__<host>.bundle`
			// layout. Place ONLY the quarantine file — the state a rejected bundle would
			// leave under the OLD behavior, and the state a mid-verification rejection
			// transiently occupies under the new one. The verified path is ABSENT.
			const workRoot = mkdtempSync(join(testTmpBase(), "workroot-"));
			try {
				const verifiedPath = snapshotPathFor(workRoot, runnerJobId, HOST);
				const quarantinePath = quarantinePathFor(verifiedPath);
				mkdirSync(dirname(quarantinePath), { recursive: true });
				writeFileSync(quarantinePath, "PACK");

				const loader = createCandidateLoader(
					db,
					(jobRunnerId, hostname) => snapshotPathFor(workRoot, jobRunnerId, hostname),
					productionSnapshotExists,
				);

				// The verified path does not exist, so `snapshotExists` is false: the job
				// is NOT a candidate even though a quarantine file sits one name away.
				expect(await loader(10)).toHaveLength(0);

				// And the control: once the SAME bytes are promoted to the verified path
				// (what an `ok` verdict does), the job IS a candidate — proving the empty
				// result above is the quarantine name being ineligible, not the loader
				// simply never matching this seeded job.
				writeFileSync(verifiedPath, "PACK");
				const promoted = await loader(10);
				expect(promoted).toHaveLength(1);
				expect(promoted[0]?.snapshotPath).toBe(verifiedPath);
			} finally {
				rmSync(workRoot, { recursive: true, force: true });
			}
		});
	});
});

/**
 * sf#349 — a change candidate SUPERSEDED by a newer sibling must stop being
 * selected, and a candidate with NO newer sibling must keep being selected.
 *
 * The live defect (the watcher host, 2026-08-17): job 5107 (`newapp`, completed, bundle
 * rendered against the pre-#853 base) logged `proposal.rails_held` on EVERY
 * proposal pass since 04:32Z. Its bundle can never stop violating — the
 * violation is IN the proposed content — and the loader re-selected it each
 * pass because no `proposal` posting existed FOR IT. Meanwhile job 5123, same
 * item, newer base, passed rails and POSTED. Two costs: unbounded re-evaluation
 * noise forever, and a latent collision, because a held candidate that ever
 * passed later would push a STALE tree at the same `rw/issue-<n>` ref the newer
 * job already owns.
 *
 * The predicate is deliberately NARROW. A held candidate with no newer posted
 * sibling MUST keep being re-selected every pass — that re-evaluation is
 * precisely how a FIXED rails manifest eventually lets a held change through,
 * and it is load-bearing behavior, not an oversight. So supersession excludes
 * ONLY when a NEWER (higher `jobs.id`) completed job for the SAME
 * `(repository_id, item_id)`, whose type is in `CHANGE_PRODUCING_JOB_TYPES`,
 * already has a `proposal` posting row.
 *
 * MUTATION-PROVEN, both directions, run for real against the live scratch
 * cluster:
 *   - forcing the loader's `row.supersededByJobId !== null` skip to `false`
 *     makes the superseded older job reappear: test (a) fails with `[olderId]`,
 *     which is byte-for-byte the live 5107 behavior;
 *   - deleting the `github_postings` EXISTS clause — widening supersession to
 *     ANY newer sibling — makes test (b) fail with the held candidate gone,
 *     which is the re-evaluation path being killed;
 *   - rewriting the sibling item match as
 *     `coalesce(newer.item_id, jobs.item_id) = jobs.item_id` makes test (c')
 *     fail, the audit job superseding an unrelated held one.
 */
describe("createCandidateLoader", () => {
	const HOST = "host-a";
	const BUNDLE = "change.bundle";
	const VERB = "newapp";
	const K3S_BASE = "c".repeat(40);

	/** Seed a running job for `itemId` and return its job id. */
	async function seedJobForItem(
		db: TestDb,
		options: {
			repositoryId: number;
			itemId: number | null;
			runnerJobId: string;
			jobType: string;
			sha: string;
			changeBaseRepository?: string | null;
			changeBaseSha?: string | null;
		},
	): Promise<number> {
		const [job] = await db
			.insert(jobs)
			.values({
				repositoryId: options.repositoryId,
				itemId: options.itemId,
				sha: options.sha,
				jobType: options.jobType,
				status: "running",
				changeBaseRepository: options.changeBaseRepository ?? null,
				changeBaseSha: options.changeBaseSha ?? null,
			})
			.returning({ id: jobs.id });
		if (!job) throw new Error("seed failed");
		const [attempt] = await db
			.insert(jobAttempts)
			.values({
				jobId: job.id,
				runnerJobId: options.runnerJobId,
				runnerVmid: 9001,
				status: "submitted",
			})
			.returning({ id: jobAttempts.id });
		if (!attempt) throw new Error("seed failed");
		await db.update(jobs).set({ activeAttemptId: attempt.id }).where(eq(jobs.id, job.id));
		return job.id;
	}

	/** A passing ingest that drives the REAL transition to `completed` + `accepted`. */
	function passingHostResult(options: {
		runnerJobId: string;
		itemNumber: number;
		jobType: string;
		sha: string;
	}): PersistedResult {
		const outputPath = `runners/jobs/${options.runnerJobId}/${HOST}/agent.log`;
		return {
			jobRunnerId: options.runnerJobId,
			hostname: HOST,
			status: "ingested",
			result: {
				result_version: RESULT_VERSION,
				repository: REPO,
				job_type: options.jobType,
				item_number: options.itemNumber,
				sha: options.sha,
				status: "passed",
				checks: [],
				findings: [],
				output_path: outputPath,
			},
			outputPath,
		};
	}

	/** The `proposal` posting row the publisher's plan persist leaves behind. */
	async function seedProposalPosting(db: TestDb, jobId: number): Promise<void> {
		await db.insert(githubPostings).values({
			jobId,
			kind: "proposal",
			action: "open",
			target: "proposal",
			status: "posted",
			payload: "{}",
			dedupeKey: `proposal-${jobId}`,
		});
	}

	/** Every seeded job has a bundle on disk, so only the SQL can drop a row. */
	function loaderFor(db: TestDb) {
		return createCandidateLoader(
			db,
			(jobRunnerId, hostname) => `runners/jobs/${jobRunnerId}/${hostname}/${BUNDLE}`,
			async () => true,
		);
	}

	test("the older job stops being selected once the NEWER sibling's proposal posting exists", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db.insert(repositories).values({ fullName: REPO }).returning();
			if (!repo) throw new Error("seed failed");
			const store = new DbResultStore(db, () => at);

			// ONE item, two change-producing jobs against it — the live 5107 / 5123
			// shape: the older bundle renders against a base whose manifest holds it,
			// the newer one against the fixed base.
			const itemNumber = 795;
			const [item] = await db
				.insert(githubItems)
				.values({
					repositoryId: repo.id,
					kind: "issue",
					number: itemNumber,
					state: "open",
					headSha: "d".repeat(40),
				})
				.returning();
			if (!item) throw new Error("seed failed");

			const olderId = await seedJobForItem(db, {
				repositoryId: repo.id,
				itemId: item.id,
				runnerJobId: "rw-newapp-older",
				jobType: VERB,
				sha: "e".repeat(64),
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_BASE,
			});
			await store.persist(
				passingHostResult({
					runnerJobId: "rw-newapp-older",
					itemNumber,
					jobType: VERB,
					sha: "e".repeat(64),
				}),
			);

			const newerId = await seedJobForItem(db, {
				repositoryId: repo.id,
				itemId: item.id,
				runnerJobId: "rw-newapp-newer",
				jobType: VERB,
				sha: "f".repeat(64),
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_BASE,
			});
			await store.persist(
				passingHostResult({
					runnerJobId: "rw-newapp-newer",
					itemNumber,
					jobType: VERB,
					sha: "f".repeat(64),
				}),
			);
			expect(newerId).toBeGreaterThan(olderId);

			const loader = loaderFor(db);

			// BEFORE the newer job posts: BOTH are selectable. This is the control that
			// proves the assertion below is the posting doing the work, not the newer
			// job's mere existence — and it is test (c) of the acceptance set, the
			// newer job itself remains selectable before its posting exists.
			const before = await loader(10);
			expect(before.map((c) => c.jobId).sort((a, b) => a - b)).toEqual([olderId, newerId]);

			// The newer job posts its proposal. That is the supersession signal.
			await seedProposalPosting(db, newerId);

			const after = await loader(10);
			// Pre-fix this is [olderId] — the older job has no `proposal` posting of its
			// own, so the existing NOT-EXISTS clause still matched it forever.
			expect(after.map((c) => c.jobId)).toEqual([]);
			expect(after.map((c) => c.jobId)).not.toContain(olderId);
		});
	});

	test("a held candidate with NO posted sibling IS selected across two consecutive loads", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db.insert(repositories).values({ fullName: REPO }).returning();
			if (!repo) throw new Error("seed failed");
			const store = new DbResultStore(db, () => at);

			const itemNumber = 796;
			const [item] = await db
				.insert(githubItems)
				.values({
					repositoryId: repo.id,
					kind: "issue",
					number: itemNumber,
					state: "open",
					headSha: "d".repeat(40),
				})
				.returning();
			if (!item) throw new Error("seed failed");

			const heldId = await seedJobForItem(db, {
				repositoryId: repo.id,
				itemId: item.id,
				runnerJobId: "rw-newapp-held",
				jobType: VERB,
				sha: "e".repeat(64),
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_BASE,
			});
			await store.persist(
				passingHostResult({
					runnerJobId: "rw-newapp-held",
					itemNumber,
					jobType: VERB,
					sha: "e".repeat(64),
				}),
			);

			// A newer sibling EXISTS but has NOT posted. Widening the predicate to "any
			// newer sibling" would exclude the held job here and kill the very
			// re-evaluation that lets a fixed rails manifest release it later.
			await seedJobForItem(db, {
				repositoryId: repo.id,
				itemId: item.id,
				runnerJobId: "rw-newapp-unposted",
				jobType: VERB,
				sha: "f".repeat(64),
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_BASE,
			});
			await store.persist(
				passingHostResult({
					runnerJobId: "rw-newapp-unposted",
					itemNumber,
					jobType: VERB,
					sha: "f".repeat(64),
				}),
			);

			const loader = loaderFor(db);

			// Two CONSECUTIVE loads, because the property under test is that the pass
			// re-selects a held candidate rather than terminalizing it on first sight.
			const first = await loader(10);
			const second = await loader(10);
			expect(first.map((c) => c.jobId)).toContain(heldId);
			expect(second.map((c) => c.jobId)).toContain(heldId);
		});
	});

	test("a NULL item_id audit job is never a supersession sibling", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db.insert(repositories).values({ fullName: REPO }).returning();
			if (!repo) throw new Error("seed failed");
			const store = new DbResultStore(db, () => at);

			const itemNumber = 797;
			const [item] = await db
				.insert(githubItems)
				.values({
					repositoryId: repo.id,
					kind: "issue",
					number: itemNumber,
					state: "open",
					headSha: "d".repeat(40),
				})
				.returning();
			if (!item) throw new Error("seed failed");

			const heldId = await seedJobForItem(db, {
				repositoryId: repo.id,
				itemId: item.id,
				runnerJobId: "rw-newapp-nullsib",
				jobType: VERB,
				sha: "e".repeat(64),
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_BASE,
			});
			await store.persist(
				passingHostResult({
					runnerJobId: "rw-newapp-nullsib",
					itemNumber,
					jobType: VERB,
					sha: "e".repeat(64),
				}),
			);

			// A NEWER itemless job in the same repository, WITH a proposal posting.
			// `item_id` is nullable (a scheduled audit slot carries no item), and a
			// NULL must never make two unrelated jobs siblings.
			//
			// MUTATION-PROVEN against the realistic mistake: rewriting the sibling
			// clause as `coalesce(newer.item_id, jobs.item_id) = jobs.item_id` — the
			// shape someone reaches for when a NULL "should just match" — makes this
			// go red, because the audit job then supersedes the held one.
			//
			// NOT sensitive to `IS NOT DISTINCT FROM`, and that is stated rather than
			// papered over: the CANDIDATE side of the join is non-null by construction
			// (the outer query inner-joins `github_items` on `jobs.item_id`), so
			// `NULL IS NOT DISTINCT FROM <id>` is false and that mutation leaves this
			// green. The clause this test actually pins is that an itemless SIBLING is
			// never a match.
			const auditId = await seedJobForItem(db, {
				repositoryId: repo.id,
				itemId: null,
				runnerJobId: "rw-audit-nullitem",
				jobType: VERB,
				sha: "f".repeat(64),
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_BASE,
			});
			await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, auditId));
			await seedProposalPosting(db, auditId);

			const loader = loaderFor(db);
			expect((await loader(10)).map((c) => c.jobId)).toContain(heldId);
		});
	});
});
