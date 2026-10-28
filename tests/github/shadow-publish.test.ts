/**
 * Shadow-mode regressions for the GitHub publisher. In shadow mode the
 * publisher runs the FULL pipeline but, at the write boundary ONLY, records the
 * intended write into the `shadow_publications` ledger instead of calling the
 * GitHub write APIs. These pin: no write API is EVER called; the ledger records
 * the intended label/comment/check; and dedupe still holds — an existing marked
 * comment/check WOULD be a dedupe (recorded `deduped`), never a duplicate create.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
	githubItems,
	githubPostings,
	jobs,
	repositories,
	shadowPublications,
} from "../../src/db/schema";
import type { GitHubClient, GitHubResponse } from "../../src/github/client";
import type { JobIdentity } from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { persistPublicationPlans } from "../../src/github/publish-plan";
import { RESULT_VERSION, type RunnerResult } from "../../src/results/schema";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const at = new Date("2026-07-20T12:00:00.000Z");

/**
 * A fake GitHub client whose dedupe READS are served from in-memory state, but
 * whose WRITE seam throws unconditionally — so any write in shadow mode fails the
 * test. Pre-seed `comments`/`checks` to model an already-published item.
 */
class ReadOnlyFakeGitHub {
	comments = new Map<string, Array<{ id: number; body: string }>>();
	checks = new Map<string, Array<{ id: number; external_id: string }>>();
	writeCalls = 0;

	private commentKey(repo: string, item: number): string {
		return `${repo}#${item}`;
	}
	private checkKey(repo: string, sha: string): string {
		return `${repo}@${sha}`;
	}

	seedComment(repo: string, item: number, body: string): void {
		const key = this.commentKey(repo, item);
		const list = this.comments.get(key) ?? [];
		list.push({ id: 900 + list.length, body });
		this.comments.set(key, list);
	}
	seedCheck(repo: string, sha: string, externalId: string): void {
		const key = this.checkKey(repo, sha);
		const list = this.checks.get(key) ?? [];
		list.push({ id: 800 + list.length, external_id: externalId });
		this.checks.set(key, list);
	}

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
					const runs = self.checks.get(self.checkKey(c[1] as string, c[2] as string)) ?? [];
					return { body: { check_runs: runs } as unknown as T, next: null };
				}
				const m = path.match(/\/repos\/(.+)\/issues\/(\d+)\/comments/);
				if (m) {
					const list = [
						...(self.comments.get(self.commentKey(m[1] as string, Number(m[2]))) ?? []),
					].reverse();
					return { body: list as unknown as T, next: null };
				}
				return { body: [] as unknown as T, next: null };
			},
			async paginate<T>(): Promise<T[]> {
				return [];
			},
			async write<T>(): Promise<GitHubResponse<T>> {
				self.writeCalls++;
				throw new Error("shadow mode must never call the GitHub write API");
			},
		} as unknown as GitHubClient;
	}
}

async function seedJob(db: TestDb): Promise<JobIdentity> {
	const [repo] = await db.insert(repositories).values({ fullName: "rodaddy/x" }).returning();
	if (!repo) throw new Error("seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({
			repositoryId: repo.id,
			kind: "pull",
			number: 7,
			state: "open",
			headSha: "deadbeefcafe",
		})
		.returning();
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repo.id,
			itemId: item?.id,
			sha: "deadbeefcafe",
			jobType: "pr-review",
			status: "running",
		})
		.returning();
	if (!job) throw new Error("seed failed");
	return {
		jobId: job.id,
		repository: "rodaddy/x",
		itemNumber: 7,
		sha: "deadbeefcafe",
		jobType: "pr-review",
	};
}

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
	return {
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: "pr-review",
		item_number: 7,
		sha: "deadbeefcafe",
		status: "passed",
		checks: [],
		findings: [],
		...overrides,
	};
}

describe("GitHubPublisher — shadow mode", () => {
	test("records intended writes to the ledger and NEVER calls the write API", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new ReadOnlyFakeGitHub();
			const pub = new GitHubPublisher(db, gh.asClient(), { now: () => at, shadow: true });

			const summary = await pub.run();
			expect(summary.failed).toBe(0);
			expect(summary.scanned).toBeGreaterThan(0);
			// The load-bearing guarantee: no GitHub write happened.
			expect(gh.writeCalls).toBe(0);

			// The ledger recorded the intended check, the added label, and the comment.
			const ledger = await db
				.select()
				.from(shadowPublications)
				.where(eq(shadowPublications.jobId, identity.jobId));
			const kinds = ledger.map((r) => r.kind).sort();
			expect(kinds).toContain("check");
			expect(kinds).toContain("comment");
			expect(kinds).toContain("label");

			const check = ledger.find((r) => r.kind === "check");
			expect(check?.conclusion).toBe("success"); // passed -> success
			expect(check?.sha).toBe("deadbeefcafe");
			expect(check?.wouldAction).toBe("created"); // no prior check -> would POST

			const comment = ledger.find((r) => r.kind === "comment");
			expect(comment?.wouldAction).toBe("created");
			expect(comment?.dedupeKey).toContain(`job-${identity.jobId}`);

			// The postings themselves are marked terminal so shadow does not re-record.
			const postings = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.jobId, identity.jobId));
			for (const p of postings) expect(p.status).toBe("posted");
		});
	});

	test("dedupe holds: an existing marked comment/check WOULD dedupe, not duplicate", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			const gh = new ReadOnlyFakeGitHub();
			// Pre-seed the job's own prior comment marker and prior check external id, so
			// the dedupe scan finds them: the shadow record must say `deduped`, not create.
			const commentMarker = `<!-- software-factory:comment:job-${identity.jobId} -->`;
			gh.seedComment("rodaddy/x", 7, `${commentMarker}\nprevious body`);
			gh.seedCheck(
				"rodaddy/x",
				"deadbeefcafe",
				`software-factory:check:job-${identity.jobId}:deadbeefcafe`,
			);

			const pub = new GitHubPublisher(db, gh.asClient(), { now: () => at, shadow: true });
			const summary = await pub.run();
			expect(gh.writeCalls).toBe(0);
			expect(summary.failed).toBe(0);

			const ledger = await db
				.select()
				.from(shadowPublications)
				.where(eq(shadowPublications.jobId, identity.jobId));
			const comment = ledger.find((r) => r.kind === "comment");
			const check = ledger.find((r) => r.kind === "check");
			// Found the job's own prior write -> shadow records a dedupe, never a create.
			expect(comment?.wouldAction).toBe("deduped");
			expect(check?.wouldAction).toBe("deduped");
		});
	});

	test("an indeterminate dedupe scan stays retryable (no unprovable would-post recorded)", async () => {
		await withTestDb(async (db) => {
			const identity = await seedJob(db);
			await persistPublicationPlans({ tx: db, identity, result: result(), now: at });
			// A client whose comment dedupe read is malformed (non-array body) — absence
			// cannot be proven, so shadow mode must refuse to record a would-create.
			const gh = new ReadOnlyFakeGitHub();
			const base = gh.asClient();
			const client = {
				...base,
				async getPage<T>(path: string): Promise<{ body: T; next: string | null }> {
					if (/\/issues\/\d+\/comments/.test(path)) {
						return { body: "not-an-array" as unknown as T, next: null };
					}
					return base.getPage<T>(path);
				},
			} as unknown as GitHubClient;

			const pub = new GitHubPublisher(db, client, { now: () => at, shadow: true, backoffMs: 0 });
			await pub.run();
			expect(gh.writeCalls).toBe(0);

			// The comment plan stayed pending/retryable and recorded NO ledger row.
			const [commentRow] = await db
				.select()
				.from(githubPostings)
				.where(eq(githubPostings.kind, "comment"));
			expect(commentRow?.status).toBe("pending");
			const commentLedger = await db
				.select()
				.from(shadowPublications)
				.where(eq(shadowPublications.kind, "comment"));
			expect(commentLedger.length).toBe(0);
		});
	});
});
