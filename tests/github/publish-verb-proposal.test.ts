/**
 * sf#344 — the verb-proposal write target.
 *
 * A deterministic verb job's change is a render against
 * `VERB_CHANGE_BASE_REPOSITORY` on Forgejo, and the proposal pass pushes the
 * head branch THERE. The publisher used to resolve every plan's target from the
 * jobs join (the MANAGED repository), so the PR-open for a verb proposal was
 * aimed at GitHub, where the branch does not exist — a deterministic HTTP 422
 * on every retry (`github_postings` row 1117, RUNNING 2026-08-17).
 *
 * These tests pin the override to exactly one case (kind=proposal AND a verb
 * jobType) and pin every neighbour to the unchanged jobs-join target.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type {
	ChangeProposal,
	ChangeProposalOutcome,
	ForgeClient,
	ForgeResponse,
} from "../../src/forge/boundary";
import type { Provider } from "../../src/forge/provider";
import type { ForgeClientResult, ForgeRegistry } from "../../src/forge/registry";
import {
	buildProposalPlan,
	COMMENT_TARGET,
	type ProposalPlan,
	type PublicationPlan,
	RESULT_LABELS,
} from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { persistPublicationPlan } from "../../src/github/publish-plan";
import { VERB_CHANGE_BASE_REPOSITORY } from "../../src/jobs/verb-base";
import { IMPLEMENT_TEMPLATE_ID } from "../../src/templates/registry";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-08-17T12:00:00.000Z");
const ITEM_NUMBER = 795;
const VERB_JOB_TYPE = "newapp";
const MANAGED_REPO = "rtech/rtech-infra";

/** One recorded PR-open, with the repository the publisher aimed it at. */
interface OpenCall {
	repository: string;
	proposal: ChangeProposal;
}

/** One recorded bounded write (labels/comments go through this verb). */
interface WriteCall {
	method: string;
	path: string;
}

/** A fake forge client that records which repository each operation targeted. */
class FakeForge {
	opens: OpenCall[] = [];
	writes: WriteCall[] = [];

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
				// A fully consumed, well-formed EMPTY page: proven absence, so the
				// dedupe scan permits a create.
				return { body: [] as unknown as T, next: null };
			},
			async paginate<T>(): Promise<T[]> {
				return [] as T[];
			},
			async write<T>(method: string, path: string, body?: unknown): Promise<ForgeResponse<T>> {
				self.writes.push({ method, path });
				if (path.endsWith("/labels")) {
					// GitHub's add-label response is the item's full label set; the
					// publisher refuses to record an unconfirmed add.
					const labels = (body as { labels?: unknown[] })?.labels ?? [];
					return resp(labels.map((name) => ({ name })) as unknown as T);
				}
				return resp({ id: 1 } as unknown as T);
			},
			async openChangeProposal(
				repository: string,
				proposal: ChangeProposal,
			): Promise<ChangeProposalOutcome> {
				self.opens.push({ repository, proposal });
				return {
					status: "opened",
					number: 78,
					url: `https://forge.invalid/${repository}/pulls/78`,
					draftMode: "wip-marker",
				};
			},
		} as unknown as ForgeClient;
	}
}

/**
 * A registry over the two fake clients. `forgejoError` makes the forgejo
 * provider fail closed the way a missing token does in production.
 */
class FakeRegistry {
	github = new FakeForge("github");
	forgejo = new FakeForge("forgejo");
	forgejoError: string | null = null;
	requested: Provider[] = [];

	asRegistry(): ForgeRegistry {
		const self = this;
		return {
			async clientFor(provider: Provider): Promise<ForgeClientResult> {
				self.requested.push(provider);
				if (provider === "forgejo") {
					if (self.forgejoError !== null) {
						return { ok: false, error: self.forgejoError };
					}
					return { ok: true, client: self.forgejo.asClient() };
				}
				return { ok: true, client: self.github.asClient() };
			},
		} as unknown as ForgeRegistry;
	}
}

/** Seed a managed-GitHub repo + item + job, and queue one plan against it. */
async function seedJobWithPlan(
	db: TestDb,
	jobType: string,
	plan: PublicationPlan,
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
			sha: "",
			jobType,
		})
		.returning({ id: jobs.id });
	const jobId = job?.id as number;
	await persistPublicationPlan(db, jobId, plan, at);
	return jobId;
}

function proposalPlan(itemNumber = ITEM_NUMBER, jobType = VERB_JOB_TYPE): ProposalPlan {
	const plan = buildProposalPlan(itemNumber, "main", "a".repeat(40), {
		jobType,
		checks: [],
		degraded: [],
	});
	if (plan === null) throw new Error("fixture: proposal plan did not build");
	return plan;
}

describe("verb proposal write target", () => {
	test("a verb-job proposal opens on the change repo via the forgejo client", async () => {
		await withTestDb(async (db) => {
			await seedJobWithPlan(db, VERB_JOB_TYPE, proposalPlan());
			const registry = new FakeRegistry();

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			expect(summary.posted).toBe(1);
			// The PR-open went to the change repo through the forgejo client — the
			// same repository and branch the proposal pass pushed.
			expect(registry.forgejo.opens).toHaveLength(1);
			expect(registry.forgejo.opens[0]?.repository).toBe(VERB_CHANGE_BASE_REPOSITORY);
			expect(registry.forgejo.opens[0]?.proposal.headBranch).toBe(
				`verb/${VERB_JOB_TYPE}-${ITEM_NUMBER}`,
			);
			// The managed-repo GitHub client never saw the PR-open. Reverting the
			// override sends it here instead — that IS the live 422 defect.
			expect(registry.github.opens).toHaveLength(0);
		});
	});

	test("authorization refuses a verb branch derived for a different item", async () => {
		await withTestDb(async (db) => {
			const plan = proposalPlan(ITEM_NUMBER + 1);
			expect(plan.headBranch).toBe(`verb/${VERB_JOB_TYPE}-${ITEM_NUMBER + 1}`);
			await seedJobWithPlan(db, VERB_JOB_TYPE, plan);
			const registry = new FakeRegistry();

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			expect(summary).toMatchObject({ posted: 0, failed: 1 });
			expect(registry.forgejo.opens).toHaveLength(0);
			expect(registry.github.opens).toHaveLength(0);
		});
	});

	test("an implement-lane proposal still opens on the managed repo's client", async () => {
		await withTestDb(async (db) => {
			await seedJobWithPlan(
				db,
				IMPLEMENT_TEMPLATE_ID,
				proposalPlan(ITEM_NUMBER, IMPLEMENT_TEMPLATE_ID),
			);
			const registry = new FakeRegistry();

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			expect(summary.posted).toBe(1);
			expect(registry.github.opens).toHaveLength(1);
			expect(registry.github.opens[0]?.repository).toBe(MANAGED_REPO);
			expect(registry.github.opens[0]?.proposal.headBranch).toBe(`rw/issue-${ITEM_NUMBER}`);
			expect(registry.forgejo.opens).toHaveLength(0);
			// The forgejo provider was never even asked for.
			expect(registry.requested).not.toContain("forgejo");
		});
	});

	test("a verb job's label plan still targets the managed repo", async () => {
		await withTestDb(async (db) => {
			const plan: PublicationPlan = {
				kind: "label",
				action: "add",
				// A status label's idempotency target IS the label name (publish-decode
				// re-checks `target === label === dedupeKey`).
				target: RESULT_LABELS.passed,
				label: RESULT_LABELS.passed,
				itemNumber: ITEM_NUMBER,
			};
			const jobId = await seedJobWithPlan(db, VERB_JOB_TYPE, plan);
			// A state label is conditional on this job's receipt comment having
			// reached the forge; seed it already `posted` so the gate opens.
			await db.insert(githubPostings).values({
				jobId,
				kind: "comment",
				action: "create",
				target: COMMENT_TARGET,
				payload: "{}",
				dedupeKey: "receipt",
				status: "posted",
			});
			const registry = new FakeRegistry();

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			expect(summary.posted).toBe(1);
			// The label write went through the managed repo's GitHub client, on the
			// managed repo's path. Widening the override past kind=proposal moves it.
			expect(registry.github.writes).toHaveLength(1);
			expect(registry.github.writes[0]?.path).toContain(MANAGED_REPO);
			expect(registry.forgejo.writes).toHaveLength(0);
		});
	});

	test("an unresolvable forgejo client fails the row RETRYABLY, pass completes", async () => {
		await withTestDb(async (db) => {
			const jobId = await seedJobWithPlan(db, VERB_JOB_TYPE, proposalPlan());
			const registry = new FakeRegistry();
			registry.forgejoError = "no credential for provider forgejo";

			const summary = await new GitHubPublisher(db, registry.asRegistry(), {
				now: () => at,
			}).run();

			// The pass completed rather than throwing out.
			expect(summary.posted).toBe(0);
			expect(summary.retryable).toBe(1);
			expect(summary.failed).toBe(0);
			expect(registry.forgejo.opens).toHaveLength(0);
			expect(registry.github.opens).toHaveLength(0);

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
