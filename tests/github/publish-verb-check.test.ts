/**
 * sf#599 — the verb-CHECK write target, and the terminal 404.
 *
 * A commit status is addressed by (repository, sha). For a deterministic verb
 * job, `jobs.sha` is the dispatch digest for the CHANGE BASE, not a git object in
 * the MANAGED repository — so the check posted against the managed repo answered
 * 404 on every attempt and rescheduled until its budget was spent. Production
 * 2026-09-03: `github_postings` kind='check' 263 failed / 91 posted.
 *
 * Two properties are pinned here:
 *
 * 1. A verb job's check posts against `VERB_CHANGE_BASE_REPOSITORY` and the
 *    trusted `change_base_sha` — the repository and commit that own the change
 *    — under `VERB_CHECK_CONTEXT`, a context DELIBERATELY
 *    outside the sop-gate family so a factory receipt can never be read as a
 *    merge judgment there. No second status is posted on the managed repository.
 *
 * 2. A NON-verb check is completely unaffected: managed repository, the plan's
 *    own `CHECK_NAME` context, through the managed repo's own client.
 *
 * Plus the retry-termination rule: a proven 404 fails the row NOW instead of
 * burning the attempt budget on a write that can never succeed.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type { CommitCheck, ForgeClient, ForgeResponse } from "../../src/forge/boundary";
import type { Provider } from "../../src/forge/provider";
import type { ForgeClientResult, ForgeRegistry } from "../../src/forge/registry";
import {
	buildTerminalCheck,
	CHECK_NAME,
	CHECK_TARGET,
	type CheckPlan,
	checkDedupeKey,
	TERMINAL_CHECK_NAME,
	TERMINAL_CHECK_TARGET,
	TERMINAL_CHECK_TITLE,
} from "../../src/github/publication";
import { persistTerminalCheck } from "../../src/github/publication-terminal";
import { GitHubPublisher } from "../../src/github/publish";
import { type DecodableRow, decodePlan } from "../../src/github/publish-decode";
import { persistPublicationPlan, persistPublicationPlans } from "../../src/github/publish-plan";
import { VERB_CHANGE_BASE_REPOSITORY, VERB_CHECK_CONTEXT } from "../../src/jobs/verb-base";
import { RESULT_VERSION } from "../../src/results/schema";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-09-03T12:00:00.000Z");
const ITEM_NUMBER = 812;
const VERB_JOB_TYPE = "newapp";
const NON_VERB_JOB_TYPE = "pr-review";
const MANAGED_REPO = "rtech/rtech-infra";
/** Dispatch identity: deliberately not a Git commit in either repository. */
const JOB_SHA = "b".repeat(64);
/** Trusted Git base identity: a full commit SHA in rtech/k3s-deploy. */
const CHANGE_BASE_SHA = "c".repeat(40);

interface SeedChangeBase {
	changeBaseRepository?: string | null;
	changeBaseSha?: string | null;
}

/** One recorded commit-check upsert, with the repository it was aimed at. */
interface CheckCall {
	repository: string;
	check: CommitCheck;
}

/**
 * A fake forge client recording which repository each commit check targeted and
 * under what context. `notFound` makes `postCommitCheck` answer the way the live
 * client does for a (repository, sha) pair the forge does not hold: a PROVEN 404,
 * reported terminal.
 */
class FakeForge {
	checks: CheckCall[] = [];
	lookups: CheckCall[] = [];
	notFound = false;

	constructor(readonly provider: Provider) {}

	asClient(): ForgeClient {
		const self = this;
		const resp = <T>(data: T): ForgeResponse<T> => ({
			status: 200,
			data,
			link: null,
			rateRemaining: null,
		});
		return {
			provider: self.provider,
			async get<T>(): Promise<ForgeResponse<T>> {
				return resp([] as unknown as T);
			},
			async getPage<T>(): Promise<{ body: T; next: string | null }> {
				return { body: [] as unknown as T, next: null };
			},
			async paginate<T>(): Promise<T[]> {
				return [] as T[];
			},
			async write<T>(): Promise<ForgeResponse<T>> {
				return resp({ id: 1 } as unknown as T);
			},
			async postCommitCheck(repository: string, check: CommitCheck) {
				self.checks.push({ repository, check });
				if (self.notFound) {
					// Exactly the shape the real Forgejo client produces when the POST to
					// /repos/{repo}/statuses/{sha} 404s: proven impossible, so terminal.
					return {
						status: "failed" as const,
						reason: "Forgejo request failed: HTTP 404",
						terminal: true,
					};
				}
				return { status: "posted" as const, externalRef: check.context };
			},
			async findCommitCheck(repository: string, check: CommitCheck) {
				self.lookups.push({ repository, check });
				return { status: "absent" as const };
			},
		} as unknown as ForgeClient;
	}
}

/** A registry over the two fake clients, recording which providers were asked for. */
class FakeRegistry {
	github = new FakeForge("github");
	forgejo = new FakeForge("forgejo");
	requested: Provider[] = [];

	asRegistry(): ForgeRegistry {
		const self = this;
		return {
			async clientFor(provider: Provider): Promise<ForgeClientResult> {
				self.requested.push(provider);
				return {
					ok: true,
					client: provider === "forgejo" ? self.forgejo.asClient() : self.github.asClient(),
				};
			},
		} as unknown as ForgeRegistry;
	}
}

/**
 * The stored check plan for a job. The dedupe key is re-derived by
 * `publish-decode` from (jobId, sha), so it must be built from the real job id —
 * hence the two-step seed below.
 */
function checkPlan(jobId: number): CheckPlan {
	return {
		kind: "check",
		action: "upsert",
		target: CHECK_TARGET,
		name: CHECK_NAME,
		sha: JOB_SHA,
		conclusion: "success",
		title: "software-factory passed",
		summary: "Job `newapp` passed.",
		dedupeKey: checkDedupeKey({
			jobId,
			repository: MANAGED_REPO,
			itemNumber: ITEM_NUMBER,
			sha: JOB_SHA,
			jobType: VERB_JOB_TYPE,
		}),
	};
}

/** Seed the repo/item/job first, then persist a plan keyed on the real job id. */
async function seedJobThenCheckPlan(
	db: TestDb,
	jobType: string,
	changeBase: SeedChangeBase | null = jobType === VERB_JOB_TYPE
		? { changeBaseRepository: VERB_CHANGE_BASE_REPOSITORY, changeBaseSha: CHANGE_BASE_SHA }
		: null,
): Promise<number> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: MANAGED_REPO, provider: "github", checks: "standard" })
		.returning({ id: repositories.id });
	const [item] = await db
		.insert(githubItems)
		.values({
			repositoryId: repo?.id as number,
			number: ITEM_NUMBER,
			kind: "issue",
			state: "open",
			headSha: null,
			title: "newapp",
		})
		.returning({ id: githubItems.id });
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo?.id as number,
			itemId: item?.id as number,
			sha: JOB_SHA,
			jobType,
			...(changeBase === null
				? {}
				: {
						changeBaseRepository: changeBase.changeBaseRepository ?? null,
						changeBaseSha: changeBase.changeBaseSha ?? null,
					}),
		})
		.returning({ id: jobs.id });
	const jobId = job?.id as number;
	await persistPublicationPlan(db, jobId, checkPlan(jobId), at);
	return jobId;
}

describe("verb check write target", () => {
	test("the terminal notice decoder accepts only its fixed neutral shape", () => {
		const built = buildTerminalCheck({ jobId: 606, sha: JOB_SHA }, "sf#606 item was closed");
		expect(built).not.toBeNull();
		if (built === null) return;
		const plan = built as unknown as Record<string, unknown>;
		const row: DecodableRow = {
			jobId: 606,
			kind: "check",
			action: "upsert",
			target: TERMINAL_CHECK_TARGET,
			payload: JSON.stringify(plan),
			dedupeKey: String(plan.dedupeKey),
			jobType: NON_VERB_JOB_TYPE,
			repository: MANAGED_REPO,
		};

		const decoded = decodePlan(row, () => []);
		expect(decoded).toMatchObject({
			kind: "check",
			target: TERMINAL_CHECK_TARGET,
			name: TERMINAL_CHECK_NAME,
			conclusion: "neutral",
			title: TERMINAL_CHECK_TITLE,
		});

		for (const mutation of [
			{ conclusion: "success" },
			{ name: CHECK_NAME },
			{ target: CHECK_TARGET },
			{ dedupeKey: "software-factory:check:job-606:" + JOB_SHA },
		]) {
			const mutated = { ...plan, ...mutation };
			expect(decodePlan({ ...row, payload: JSON.stringify(mutated) }, () => [])).toBeNull();
		}
	});

	test("a terminal notice posts through Forge-style commit checks with neutral context and survives a late valid result", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJobThenCheckPlan(db, NON_VERB_JOB_TYPE);
			const identity = {
				jobId,
				repository: MANAGED_REPO,
				itemNumber: ITEM_NUMBER,
				sha: JOB_SHA,
				jobType: NON_VERB_JOB_TYPE,
			};
			const reason = "terminal: item is no longer eligible (sf#429)";
			await persistTerminalCheck(db, identity, reason, at);
			const terminalBefore = await db
				.select({ target: githubPostings.target, payload: githubPostings.payload })
				.from(githubPostings)
				.where(eq(githubPostings.jobId, jobId));
			const terminalRowBefore = terminalBefore.find((row) => row.target === TERMINAL_CHECK_TARGET);
			expect(terminalRowBefore).toBeDefined();

			// A valid runner result arriving later gets its normal check row; it must not
			// refresh or overwrite the separate terminal notice target.
			await persistPublicationPlans({
				tx: db,
				identity,
				result: {
					result_version: RESULT_VERSION,
					repository: MANAGED_REPO,
					job_type: NON_VERB_JOB_TYPE,
					item_number: ITEM_NUMBER,
					sha: JOB_SHA,
					status: "passed",
					checks: [],
					findings: [],
				},
				now: at,
			});

			const registry = new FakeRegistry();
			const summary = await new GitHubPublisher(db, registry.asRegistry(), { now: () => at }).run();
			expect(summary.posted).toBeGreaterThanOrEqual(2);
			const terminalCall = registry.github.checks.find(
				({ check }) => check.context === TERMINAL_CHECK_NAME,
			);
			expect(terminalCall).toBeDefined();
			expect(terminalCall?.repository).toBe(MANAGED_REPO);
			expect(terminalCall?.check.sha).toBe(JOB_SHA);
			expect(terminalCall?.check.conclusion).toBe("neutral");
			expect(terminalCall?.check.title).toBe(TERMINAL_CHECK_TITLE);
			expect(terminalCall?.check.summary).toContain(reason);
			const normalCall = registry.github.checks.find(({ check }) => check.context === CHECK_NAME);
			expect(normalCall?.check.conclusion).toBe("success");
			expect(normalCall?.check.context).not.toBe(TERMINAL_CHECK_NAME);

			const terminalRowAfter = await db
				.select({ target: githubPostings.target, payload: githubPostings.payload })
				.from(githubPostings)
				.where(eq(githubPostings.jobId, jobId));
			const terminalRow = terminalRowAfter.find((row) => row.target === TERMINAL_CHECK_TARGET);
			expect(terminalRow?.payload).toBe(terminalRowBefore?.payload);
		});
	});

	test("a verb job's check posts on the change base repo under watcher-verb", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJobThenCheckPlan(db, VERB_JOB_TYPE);
			const registry = new FakeRegistry();

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			expect(summary.posted).toBe(1);
			// The status went to the repository that OWNS the sha, through the forgejo
			// client. Reverting the redirect aims it at the managed repo — that IS the
			// live 404 defect (263 failed rows).
			expect(registry.forgejo.checks).toHaveLength(1);
			expect(registry.forgejo.checks[0]?.repository).toBe(VERB_CHANGE_BASE_REPOSITORY);
			// The context is DISTINCT from the sop-gate family, so this receipt can
			// never be read as a merge judgment on a protected repo.
			expect(registry.forgejo.checks[0]?.check.context).toBe(VERB_CHECK_CONTEXT);
			expect(registry.forgejo.checks[0]?.check.context).not.toContain("sop-gate");
			// The dispatch digest remains the job/plan identity, while the check uses
			// the separately trusted full Git base SHA owned by the destination repo.
			expect(registry.forgejo.checks[0]?.check.sha).toBe(CHANGE_BASE_SHA);
			const [stored] = await db
				.select({ payload: githubPostings.payload, dedupeKey: githubPostings.dedupeKey })
				.from(githubPostings)
				.where(eq(githubPostings.jobId, jobId))
				.limit(1);
			const storedPlan = JSON.parse(stored?.payload ?? "{}") as {
				sha?: string;
				dedupeKey?: string;
			};
			expect(storedPlan.sha).toBe(JOB_SHA);
			expect(storedPlan.dedupeKey).toBe(stored?.dedupeKey);
			// No second status on the managed repository — the published comment is
			// already the human-visible receipt there.
			expect(registry.github.checks).toHaveLength(0);
		});
	});

	test("a shadow verb check reads the same trusted repository and SHA it would write", async () => {
		await withTestDb(async (db) => {
			await seedJobThenCheckPlan(db, VERB_JOB_TYPE);
			const registry = new FakeRegistry();

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
				shadow: true,
			}).run();

			expect(summary.posted).toBe(1);
			expect(registry.forgejo.lookups).toHaveLength(1);
			expect(registry.forgejo.lookups[0]?.repository).toBe(VERB_CHANGE_BASE_REPOSITORY);
			expect(registry.forgejo.lookups[0]?.check.sha).toBe(CHANGE_BASE_SHA);
			expect(registry.forgejo.lookups[0]?.check.context).toBe(VERB_CHECK_CONTEXT);
			expect(registry.forgejo.checks).toHaveLength(0);
		});
	});

	test.each([
		{ label: "missing", base: {} },
		{
			label: "wrong repository",
			base: { changeBaseRepository: MANAGED_REPO, changeBaseSha: CHANGE_BASE_SHA },
		},
		{
			label: "non-full Git SHA",
			base: { changeBaseRepository: VERB_CHANGE_BASE_REPOSITORY, changeBaseSha: "c".repeat(39) },
		},
	])(
		"a verb check with $label trusted base fails closed without a Forge write",
		async ({ base }) => {
			await withTestDb(async (db) => {
				const jobId = await seedJobThenCheckPlan(db, VERB_JOB_TYPE, base);
				const registry = new FakeRegistry();

				const summary = await new GitHubPublisher(db, registry.asRegistry(), {
					now: () => at,
				}).run();

				expect(summary).toMatchObject({ posted: 0, failed: 1, retryable: 0 });
				expect(registry.forgejo.checks).toHaveLength(0);
				expect(registry.github.checks).toHaveLength(0);
				const [row] = await db
					.select({
						status: githubPostings.status,
						attempts: githubPostings.attempts,
						lastError: githubPostings.lastError,
					})
					.from(githubPostings)
					.where(eq(githubPostings.jobId, jobId))
					.limit(1);
				expect(row?.status).toBe("failed");
				expect(row?.attempts).toBe(0);
				expect(row?.lastError).toContain("change base");
			});
		},
	);

	test("a NON-verb job's check is unchanged: managed repo, CHECK_NAME context", async () => {
		await withTestDb(async (db) => {
			await seedJobThenCheckPlan(db, NON_VERB_JOB_TYPE);
			const registry = new FakeRegistry();

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			expect(summary.posted).toBe(1);
			// Managed repository, through the managed repository's own client, under
			// the plan's own fixed name. Widening the redirect past a verb jobType
			// moves this — which would post a factory status onto a GitOps repo for
			// every lane in the factory.
			expect(registry.github.checks).toHaveLength(1);
			expect(registry.github.checks[0]?.repository).toBe(MANAGED_REPO);
			expect(registry.github.checks[0]?.check.context).toBe(CHECK_NAME);
			expect(registry.github.checks[0]?.check.sha).toBe(JOB_SHA);
			expect(registry.forgejo.checks).toHaveLength(0);
			// The forgejo provider was never even asked for.
			expect(registry.requested).not.toContain("forgejo");
		});
	});

	test("a proven 404 fails the row NOW instead of burning the attempt budget", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJobThenCheckPlan(db, VERB_JOB_TYPE);
			const registry = new FakeRegistry();
			registry.forgejo.notFound = true;

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			// Terminal, not retryable: the write can never succeed, so no reschedule.
			expect(summary).toMatchObject({ posted: 0, failed: 1, retryable: 0 });

			const [row] = await db
				.select({
					status: githubPostings.status,
					attempts: githubPostings.attempts,
					nextAttemptAt: githubPostings.nextAttemptAt,
					lastError: githubPostings.lastError,
				})
				.from(githubPostings)
				.where(eq(githubPostings.jobId, jobId))
				.limit(1);
			expect(row?.status).toBe("failed");
			// The attempt budget was NOT consumed — the row failed on the merits of the
			// response, not by exhausting retries.
			expect(row?.attempts).toBe(0);
			expect(row?.lastError).toContain("404");
		});
	});

	test("a NON-terminal failure still reschedules, budget unspent", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJobThenCheckPlan(db, VERB_JOB_TYPE);
			const registry = new FakeRegistry();
			// Same failure path, but WITHOUT the terminal flag: the default posture is
			// still bounded-backoff retry. This is the control for the test above.
			const forgejo = registry.forgejo;
			const base = forgejo.asClient();
			registry.asRegistry = () =>
				({
					async clientFor(provider: Provider): Promise<ForgeClientResult> {
						if (provider === "forgejo") {
							return {
								ok: true,
								client: {
									...base,
									async postCommitCheck() {
										return { status: "failed" as const, reason: "HTTP 503" };
									},
								} as unknown as ForgeClient,
							};
						}
						return { ok: true, client: registry.github.asClient() };
					},
				}) as unknown as ForgeRegistry;

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			expect(summary).toMatchObject({ posted: 0, failed: 0, retryable: 1 });

			const [row] = await db
				.select({ status: githubPostings.status, attempts: githubPostings.attempts })
				.from(githubPostings)
				.where(eq(githubPostings.jobId, jobId))
				.limit(1);
			expect(row?.status).toBe("pending");
			expect(row?.attempts).toBe(1);
		});
	});
});
