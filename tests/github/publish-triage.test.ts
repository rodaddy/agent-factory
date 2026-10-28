/**
 * @module tests/github/publish-triage
 * @description The persist→decode round trip for the issue-triage label lane.
 *  #119 added triage add-label PLAN creation but the publisher's stored-
 *   plan re-validation still required the fixed `watcher:*` vocabulary, so every
 *   triage label plan died terminal ("unreadable stored publication plan") while
 *   its comment claimed the label was applied. #119's tests stopped at the
 *   planner and never crossed persist→decode, which is why the defect shipped —
 *   so THESE tests deliberately persist a real plan via `persistPublicationPlans`
 *   and drive it through the REAL publisher against a fake GitHub client.
 *
 *   Each test is mutation-proofed: reverting the decoder change (restoring the
 *   unconditional `ALL_RESULT_LABELS.includes(label)` gate) turns the round-trip
 *   test red with the exact "unreadable stored publication plan" terminal error.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type { GitHubClient, GitHubResponse } from "../../src/github/client";
import type { JobIdentity } from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { persistPublicationPlans } from "../../src/github/publish-plan";
import { RESULT_VERSION, type RunnerResult, TRIAGE_JOB_TYPE } from "../../src/results/schema";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-08-01T12:00:00.000Z");
const TRIAGE_LABEL = "type: bug";

interface WriteCall {
	method: string;
	path: string;
	body?: unknown;
}

/**
 * A minimal fake GitHub client that models label add/remove and the comment/
 * check upserts the triage lane also queues, so a full triage result can be
 * published end-to-end. It records every write so a test can prove the triage
 * label POST reached the transport (or prove none did).
 */
class FakeGitHub {
	writes: WriteCall[] = [];
	labels = new Map<string, Set<string>>();
	comments = new Map<string, Array<{ id: number; body: string }>>();
	checks = new Map<string, Array<{ id: number; external_id: string }>>();
	private nextId = 100;

	asClient(): GitHubClient {
		const self = this;
		const resp = <T>(data: T): GitHubResponse<T> => ({
			status: 200,
			data,
			link: null,
			rateRemaining: null,
		});
		return {
			async get<T>(): Promise<GitHubResponse<T>> {
				return resp([] as unknown as T);
			},
			async getPage<T>(path: string): Promise<{ body: T; next: string | null }> {
				const c = path.match(/\/repos\/(.+)\/commits\/([^/?]+)\/check-runs/);
				if (c) {
					return { body: { check_runs: [] } as unknown as T, next: null };
				}
				// Comment dedupe listing: no prior comment, proven-absent (empty array).
				return { body: [] as unknown as T, next: null };
			},
			async write<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
				self.writes.push({ method, path, body });
				const labelAdd = path.match(/\/repos\/(.+)\/issues\/(\d+)\/labels$/);
				if (labelAdd && method === "POST") {
					const key = `${labelAdd[1]}#${labelAdd[2]}`;
					const set = self.labels.get(key) ?? new Set<string>();
					for (const l of (body as { labels: string[] }).labels) set.add(l);
					self.labels.set(key, set);
					return resp([...set].map((name) => ({ name })) as unknown as T);
				}
				const labelDel = path.match(/\/repos\/(.+)\/issues\/(\d+)\/labels\/(.+)$/);
				if (labelDel && method === "DELETE") {
					const key = `${labelDel[1]}#${labelDel[2]}`;
					self.labels.get(key)?.delete(decodeURIComponent(labelDel[3] as string));
					return resp(null as unknown as T);
				}
				const commentCreate = path.match(/\/repos\/(.+)\/issues\/(\d+)\/comments$/);
				if (commentCreate && method === "POST") {
					const id = self.nextId++;
					return resp({ id } as unknown as T);
				}
				const checkCreate = path.match(/\/repos\/(.+)\/check-runs$/);
				if (checkCreate && method === "POST") {
					const id = self.nextId++;
					return resp({ id } as unknown as T);
				}
				return resp(null as unknown as T);
			},
		} as unknown as GitHubClient;
	}
}

/** Seed a triage job with an open issue item and return its trusted identity. */
async function seedTriageJob(db: TestDb): Promise<JobIdentity> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x" })
		.onConflictDoUpdate({
			target: [repositories.provider, repositories.fullName],
			set: { checks: "standard" },
		})
		.returning();
	if (!repo) throw new Error("seed failed");
	const sha = "deadbeefcafe";
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "issue", number: 113, state: "open", headSha: sha })
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha,
			jobType: TRIAGE_JOB_TYPE,
			status: "running",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return { jobId: job.id, repository: "rodaddy/x", itemNumber: 113, sha, jobType: TRIAGE_JOB_TYPE };
}

function triageResult(labels: string[]): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: TRIAGE_JOB_TYPE,
		item_number: 113,
		sha: "deadbeefcafe",
		status: "passed",
		checks: [],
		findings: [],
		triage: { labels },
	};
}

/** The persisted triage add-label posting row for a given label. */
async function triageLabelRow(db: TestDb, jobId: number, label: string) {
	const rows = await db.select().from(githubPostings).where(eq(githubPostings.jobId, jobId));
	return rows.find((r) => r.kind === "label" && r.action === "add" && r.target === label);
}

/**
 * The recorded label-add POST that carries a SPECIFIC label. The status label
 * (`watcher:passed`) and a triage label both POST to the same `/labels` endpoint,
 * so a test asserting on the triage label must inspect the body, not the path.
 */
function labelAddFor(gh: FakeGitHub, label: string): WriteCall | undefined {
	return gh.writes.find(
		(w) =>
			w.method === "POST" &&
			w.path === "/repos/rodaddy/x/issues/113/labels" &&
			Array.isArray((w.body as { labels?: unknown }).labels) &&
			(w.body as { labels: string[] }).labels.includes(label),
	);
}

describe("GitHubPublisher — issue-triage label round trip", () => {
	test("persist→decode→publish: an allowlisted triage add-label POSTS", async () => {
		await withTestDb(async (db) => {
			const identity = await seedTriageJob(db);
			// Persist through the REAL planner with the label allowlisted.
			await persistPublicationPlans({
				tx: db,
				identity,
				result: triageResult([TRIAGE_LABEL]),
				now: at,
				triageAllowlist: [TRIAGE_LABEL],
			});
			// Sanity: the add-label plan row exists, pending, with the runner-chosen name.
			const before = await triageLabelRow(db, identity.jobId, TRIAGE_LABEL);
			expect(before).toBeDefined();
			expect(before?.status).toBe("pending");

			const gh = new FakeGitHub();
			// The publisher must be given the SAME live allowlist the store filtered with.
			const pub = new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				triageAllowlistFor: () => [TRIAGE_LABEL],
			});
			const summary = await pub.run();

			// The row is posted, not failed — mutation: revert the decoder change and this
			// row instead reaches `failed` with "unreadable stored publication plan".
			const after = await triageLabelRow(db, identity.jobId, TRIAGE_LABEL);
			expect(after?.status).toBe("posted");
			expect(after?.lastError ?? null).toBe(null);
			expect(summary.failed).toBe(0);

			// The label actually reached the transport as an add against the trusted item.
			expect(labelAddFor(gh, TRIAGE_LABEL)).toBeDefined();
			expect(gh.labels.get("rodaddy/x#113")?.has(TRIAGE_LABEL)).toBe(true);
		});
	});

	test("MUTATION GUARD: a publisher with NO allowlist resolver fails the triage plan closed", async () => {
		// This is the fail-closed direction of the same boundary: even with the decoder
		// change in place, a publisher that cannot vouch for the vocabulary (empty
		// allowlist) must refuse the label — proving the re-validation is load-bearing,
		// not merely the jobType/action gate.
		await withTestDb(async (db) => {
			const identity = await seedTriageJob(db);
			await persistPublicationPlans({
				tx: db,
				identity,
				result: triageResult([TRIAGE_LABEL]),
				now: at,
				triageAllowlist: [TRIAGE_LABEL],
			});
			const gh = new FakeGitHub();
			// Default resolver -> empty allowlist: the label is no longer vouched for.
			const pub = new GitHubPublisher(db, gh.asClient(), { now: () => at });
			await pub.run();

			const row = await triageLabelRow(db, identity.jobId, TRIAGE_LABEL);
			expect(row?.status).toBe("failed");
			expect(row?.lastError).toBe("unreadable stored publication plan");
			// The triage label was never posted (the status label add is a separate row).
			expect(labelAddFor(gh, TRIAGE_LABEL)).toBeUndefined();
		});
	});

	test("publish-time re-check: a label DROPPED from the allowlist after persist fails terminally, posts nothing", async () => {
		await withTestDb(async (db) => {
			const identity = await seedTriageJob(db);
			// Persisted WHILE allowlisted (the plan row is legitimately created).
			await persistPublicationPlans({
				tx: db,
				identity,
				result: triageResult([TRIAGE_LABEL]),
				now: at,
				triageAllowlist: [TRIAGE_LABEL],
			});
			const before = await triageLabelRow(db, identity.jobId, TRIAGE_LABEL);
			expect(before?.status).toBe("pending");

			const gh = new FakeGitHub();
			// The allowlist has since changed and NO LONGER contains the label.
			const pub = new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				triageAllowlistFor: () => ["priority: high"],
			});
			await pub.run();

			// Fail closed, terminally — never posted, never retried.
			const after = await triageLabelRow(db, identity.jobId, TRIAGE_LABEL);
			expect(after?.status).toBe("failed");
			expect(after?.lastError).toBe("unreadable stored publication plan");
			expect(after?.attempts).toBe(0);
			expect(labelAddFor(gh, TRIAGE_LABEL)).toBeUndefined();
		});
	});

	test("the fixed watcher:* status labels still decode and post unchanged in the triage lane", async () => {
		// Byte-identical behavior for the existing vocabulary: a triage job still adds
		// its status label and removes the others, regardless of the triage allowlist.
		await withTestDb(async (db) => {
			const identity = await seedTriageJob(db);
			await persistPublicationPlans({
				tx: db,
				identity,
				result: triageResult([TRIAGE_LABEL]),
				now: at,
				triageAllowlist: [TRIAGE_LABEL],
			});
			const gh = new FakeGitHub();
			const pub = new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				triageAllowlistFor: () => [TRIAGE_LABEL],
			});
			await pub.run();

			const statusRow = (
				await db.select().from(githubPostings).where(eq(githubPostings.jobId, identity.jobId))
			).find((r) => r.kind === "label" && r.target === "watcher:passed");
			expect(statusRow?.status).toBe("posted");
		});
	});
});
