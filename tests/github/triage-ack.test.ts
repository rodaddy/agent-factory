/**
 * @module tests/github/triage-ack
 * @description The triage acknowledgment header: the issue-triage comment
 *   must OPEN with a claim receipt (k-board task id when bound, job id, lane),
 *   the factory's READ of the ask (phrased as a read, never asserted fact), and
 *   the named spec gaps the implement lane's spec contract would be missing.
 *
 *   Two properties are proven separately because they fail separately:
 *
 *   1. CONTENT — the header is the first visible block of the built comment plan,
 *      it names the trusted claim fields, it phrases the read as the factory's
 *      read, and it names gaps the runner reported (and stays silent when there
 *      are none, so a gapless issue does not get a heading reading as a problem).
 *   2. ONCE-ONLY — repeated watcher cycles over an unchanged issue add ZERO
 *      further comments. Asserted by COMMENT POST COUNT against a fake forge that
 *      records every write, never by absence of errors: the existing
 *      `(job, kind, target)` posting key plus the hidden marker are the guarantee,
 *      and the ack must not break either.
 *
 *   The claim fields come from the TRUSTED identity (the DB join), never from
 *   runner output — a test therefore proves a runner-supplied job/task claim
 *   cannot reach the rendered header.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type { GitHubClient, GitHubResponse } from "../../src/github/client";
import { buildPublicationPlans, type JobIdentity } from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { persistPublicationPlans } from "../../src/github/publish-plan";
import { renderPacketJobBody } from "../../src/packets/registry";
import { type RunnerResult, resultSchema, TRIAGE_JOB_TYPE } from "../../src/results/schema";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-08-10T12:00:00.000Z");
const TRIAGE_LABEL = "type: bug";

const identity: JobIdentity = {
	jobId: 42,
	repository: "rodaddy/x",
	itemNumber: 113,
	sha: "deadbeefcafe",
	jobType: TRIAGE_JOB_TYPE,
	kboardTaskId: "task-9f3",
};

function triageResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		result_version: 1,
		repository: "rodaddy/x",
		job_type: TRIAGE_JOB_TYPE,
		item_number: 113,
		sha: "deadbeefcafe",
		status: "passed",
		checks: [],
		findings: [],
		...overrides,
	};
}

/** The single comment plan the triage lane produced for this identity/result. */
function commentBody(id: JobIdentity, result: RunnerResult): string {
	const plans = buildPublicationPlans(id, result, true, [TRIAGE_LABEL]);
	const comment = plans.find((p) => p.kind === "comment");
	if (comment === undefined || comment.kind !== "comment") {
		throw new Error("no comment plan was produced");
	}
	return comment.body;
}

describe("triage ack header — content", () => {
	test("the ack OPENS the comment: it is the first visible block, before the status headline", () => {
		const body = commentBody(
			identity,
			triageResult({ triage: { read: "add a retry to the fetch helper" } }),
		);
		const lines = body.split("\n");
		// Line 0 is the hidden dedupe marker and line 1 is the sf#369 agent
		// signature; the ack heading is the first CONTENT block a reader sees, and
		// it still precedes the pre-existing status headline.
		expect(lines[0]?.startsWith("<!-- ")).toBe(true);
		expect(lines[1]?.startsWith("**agent:** rodaddy-watcher")).toBe(true);
		expect(lines[2]).toBe("### software-factory: triage claimed");
		expect(body.indexOf("### software-factory: triage claimed")).toBeLessThan(
			body.indexOf("### software-factory: passed"),
		);
	});

	test("claim receipt names the k-board task id, the job id, and the lane", () => {
		const body = commentBody(identity, triageResult());
		expect(body).toContain("task-9f3");
		expect(body).toContain("job 42");
		expect(body).toContain(TRIAGE_JOB_TYPE);
	});

	test("an unbound job says so rather than inventing a task id", () => {
		const body = commentBody({ ...identity, kboardTaskId: null }, triageResult());
		expect(body).toContain("not bound to a k-board task");
		// The BOUND wording must be absent, or "unbound" would render as a bound claim.
		expect(body).not.toContain("k-board task `");
	});

	test("the read is phrased as the factory's READ, not asserted fact", () => {
		const body = commentBody(
			identity,
			triageResult({ triage: { read: "add a retry to the fetch helper" } }),
		);
		expect(body).toContain("The factory's read of the ask");
		expect(body).toContain("add a retry to the fetch helper");
		// Worker output is PROPOSED: the header must flag it as unverified.
		expect(body).toContain("PROPOSED");
	});

	test("a read the runner did not supply renders no read section at all", () => {
		const body = commentBody(identity, triageResult());
		expect(body).not.toContain("The factory's read of the ask");
	});

	test("named spec gaps are listed; a gapless issue gets NO gaps section", () => {
		const withGaps = commentBody(
			identity,
			triageResult({ triage: { spec_gaps: ["acceptance criteria", "files to change"] } }),
		);
		expect(withGaps).toContain("Spec gaps");
		expect(withGaps).toContain("acceptance criteria");
		expect(withGaps).toContain("files to change");
		// Report, never block: the header must not claim the lane stopped.
		expect(withGaps).not.toContain("blocked");

		const withoutGaps = commentBody(identity, triageResult());
		expect(withoutGaps).not.toContain("Spec gaps");
	});

	test("runner text in the read and the gaps is escaped inert", () => {
		const body = commentBody(
			identity,
			triageResult({
				triage: {
					read: "# pwn [x](http://e.invalid) @rodaddy",
					spec_gaps: ["<img src=x> @everyone"],
				},
			}),
		);
		expect(body).not.toContain("[x](http://e.invalid)");
		expect(body).not.toContain("<img");
		expect(body).not.toContain("@rodaddy");
		expect(body).not.toContain("@everyone");
	});

	test("a runner cannot supply the claim fields: they come from the trusted identity", () => {
		// The runner claims a different item; nothing it sends can name the job/task.
		const body = commentBody(identity, triageResult({ item_number: 9999 }));
		expect(body).toContain("job 42");
		expect(body).not.toContain("9999");
	});

	test("the ack rides the triage lane only — a pr-review comment carries no ack", () => {
		const body = commentBody(
			{ ...identity, jobType: "pr-review" },
			triageResult({ job_type: "pr-review", triage: undefined }),
		);
		expect(body).not.toContain("triage claimed");
	});
});

describe("triage ack — the PRODUCER actually emits what the consumer renders", () => {
	test("the shipped packet names both ack fields, and a result built as it instructs parses AND renders", () => {
		const rendered = renderPacketJobBody("issue-triage", {
			repository: "rodaddy/x",
			itemNumber: 7,
			sha: "deadbeef",
			triageLabels: ["type: bug"],
		});
		expect(rendered.ok).toBe(true);
		if (!rendered.ok) return;
		// A complete consumer hides a missing producer: the packet must ASK for the
		// two fields, or nothing ever sends them and the header renders empty forever.
		expect(rendered.body).toContain("`read`");
		expect(rendered.body).toContain("`spec_gaps`");
		// The packet's key-count sentence must not still say "these two keys".
		expect(rendered.body).not.toContain("ONLY these two keys");
		// Still inside the render cap, so the new clause is not silently truncated.
		expect(rendered.body.endsWith("...")).toBe(false);
		expect(rendered.body.length).toBeLessThanOrEqual(9000);

		// Build the result exactly as the packet instructs, then drive it through the
		// REAL ingest schema and the REAL comment builder.
		const built = {
			result_version: 1,
			repository: "rodaddy/x",
			item_number: 7,
			sha: "deadbeef",
			job_type: TRIAGE_JOB_TYPE,
			status: "passed",
			findings: [{ severity: "info", title: "type: bug", detail: "why" }],
			triage: {
				labels: ["type: bug"],
				read: "add a retry to the fetch helper",
				spec_gaps: ["acceptance criteria", "files to change"],
			},
		};
		const parsed = resultSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		const body = commentBody({ ...identity, sha: "deadbeef", itemNumber: 7 }, parsed.data);
		expect(body).toContain("add a retry to the fetch helper");
		expect(body).toContain("acceptance criteria");
	});

	test("the schema BOUNDS both fields: an oversized read or an over-long gap list is rejected", () => {
		const base = {
			result_version: 1,
			repository: "rodaddy/x",
			item_number: 7,
			job_type: TRIAGE_JOB_TYPE,
			status: "passed",
		};
		expect(resultSchema.safeParse({ ...base, triage: { read: "x".repeat(501) } }).success).toBe(
			false,
		);
		expect(
			resultSchema.safeParse({ ...base, triage: { spec_gaps: Array(11).fill("g") } }).success,
		).toBe(false);
		expect(
			resultSchema.safeParse({ ...base, triage: { spec_gaps: ["x".repeat(201)] } }).success,
		).toBe(false);
		// The in-bounds shape still parses, so the bounds are not rejecting everything.
		expect(
			resultSchema.safeParse({
				...base,
				triage: { read: "x".repeat(500), spec_gaps: Array(10).fill("x".repeat(200)) },
			}).success,
		).toBe(true);
	});

	test("the ack fields stay issue-triage-only: another lane carrying them is REJECTED", () => {
		const rejected = resultSchema.safeParse({
			result_version: 1,
			repository: "rodaddy/x",
			item_number: 7,
			job_type: "pr-review",
			status: "passed",
			triage: { read: "a read the review lane was never asked for" },
		});
		expect(rejected.success).toBe(false);
	});
});

interface WriteCall {
	method: string;
	path: string;
	body?: unknown;
}

/**
 * A minimal fake forge that records every write and models the comment/label/
 * check upserts the triage lane queues. `getPage` returns the comments this fake
 * has already accepted, so the publisher's real marker dedupe scan sees the
 * comment it posted on an earlier run — the mechanism the once-only property
 * actually rests on.
 */
class FakeGitHub {
	writes: WriteCall[] = [];
	comments: Array<{ id: number; body: string }> = [];
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
				if (/\/check-runs/.test(path)) {
					return { body: { check_runs: [] } as unknown as T, next: null };
				}
				if (/\/issues\/\d+\/comments/.test(path)) {
					return { body: [...self.comments] as unknown as T, next: null };
				}
				return { body: [] as unknown as T, next: null };
			},
			async write<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>> {
				self.writes.push({ method, path, body });
				if (method === "POST" && /\/issues\/\d+\/comments$/.test(path)) {
					const id = self.nextId++;
					self.comments.push({ id, body: (body as { body: string }).body });
					return resp({ id } as unknown as T);
				}
				if (method === "PATCH" && /\/issues\/comments\/\d+$/.test(path)) {
					return resp({ id: 1 } as unknown as T);
				}
				if (method === "POST" && /\/check-runs$/.test(path)) {
					return resp({ id: self.nextId++ } as unknown as T);
				}
				return resp(null as unknown as T);
			},
		} as unknown as GitHubClient;
	}

	/** Every comment CREATE this fake accepted (the count the property asserts). */
	commentPosts(): WriteCall[] {
		return this.writes.filter(
			(w) => w.method === "POST" && /\/issues\/\d+\/comments$/.test(w.path),
		);
	}
}

/** Seed one triage job bound to a k-board task, with an open issue item. */
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
			kboardTaskId: "task-9f3",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return {
		jobId: job.id,
		repository: "rodaddy/x",
		itemNumber: 113,
		sha,
		jobType: TRIAGE_JOB_TYPE,
		kboardTaskId: "task-9f3",
	};
}

describe("triage ack — exactly one per pickup", () => {
	test("three watcher cycles over an unchanged issue post exactly ONE comment", async () => {
		await withTestDb(async (db) => {
			const id = await seedTriageJob(db);
			const result = triageResult({
				triage: { read: "add a retry", spec_gaps: ["acceptance criteria"] },
			});
			const gh = new FakeGitHub();
			const pub = new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				triageAllowlistFor: () => [TRIAGE_LABEL],
			});

			// Cycle 1: plan queued, comment posted.
			await persistPublicationPlans({
				tx: db,
				identity: id,
				result,
				now: at,
				triageAllowlist: [TRIAGE_LABEL],
			});
			await pub.run();
			expect(gh.commentPosts().length).toBe(1);
			expect(gh.comments[0]?.body).toContain("triage claimed");

			// Cycles 2 and 3: the pass re-derives the same plan for the same unchanged
			// job and the publisher runs again. Neither may add a comment.
			for (let cycle = 2; cycle <= 3; cycle++) {
				await persistPublicationPlans({
					tx: db,
					identity: id,
					result,
					now: at,
					triageAllowlist: [TRIAGE_LABEL],
				});
				await pub.run();
			}

			expect(gh.commentPosts().length).toBe(1);
			// And the durable posting row stayed a single posted row for the job.
			const rows = await db.select().from(githubPostings).where(eq(githubPostings.jobId, id.jobId));
			const commentRows = rows.filter((r) => r.kind === "comment");
			expect(commentRows.length).toBe(1);
			expect(commentRows[0]?.status).toBe("posted");
		});
	});

	test("a marked comment already on the forge is UPDATED, never duplicated", async () => {
		await withTestDb(async (db) => {
			const id = await seedTriageJob(db);
			const gh = new FakeGitHub();
			// A previous process already posted this job's marked comment.
			const plans = buildPublicationPlans(id, triageResult(), true, [TRIAGE_LABEL]);
			const planned = plans.find((p) => p.kind === "comment");
			if (planned === undefined || planned.kind !== "comment") throw new Error("no plan");
			gh.comments.push({ id: 55, body: planned.body });

			await persistPublicationPlans({
				tx: db,
				identity: id,
				result: triageResult(),
				now: at,
				triageAllowlist: [TRIAGE_LABEL],
			});
			const pub = new GitHubPublisher(db, gh.asClient(), {
				now: () => at,
				triageAllowlistFor: () => [TRIAGE_LABEL],
			});
			await pub.run();

			expect(gh.commentPosts().length).toBe(0);
			expect(
				gh.writes.some((w) => w.method === "PATCH" && /\/issues\/comments\/55$/.test(w.path)),
			).toBe(true);
		});
	});
});

/**
 * The agent signature line on the triage comment. It opens the body
 * ahead of the #248 acknowledgment header: the ack is still the first CONTENT
 * block, but the attribution line now precedes it, so the reader knows who wrote
 * the comment before reading what it claims. The hidden marker keeps line 1
 * (dedupe is a substring scan, `src/github/publish-dedupe.ts:157`).
 */
describe("agent signature line on the triage comment", () => {
	const SIG_PREFIX =
		"**agent:** rodaddy-watcher · model unattested · seat software-factory watcher (CT101) · ";

	test("marker, then signature, then the ack heading", () => {
		const body = commentBody(identity, triageResult());
		const lines = body.split("\n");
		expect(lines[0]?.startsWith("<!-- ")).toBe(true);
		expect(lines[1]?.startsWith(SIG_PREFIX)).toBe(true);
		expect(lines[1]?.slice(SIG_PREFIX.length)).toMatch(/^\d{4}-\d{2}-\d{2} UTC$/);
		expect(lines[2]).toBe("### software-factory: triage claimed");
	});
});
