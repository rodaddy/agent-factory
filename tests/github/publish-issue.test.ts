import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { githubPostings, jobs, repositories } from "../../src/db/schema";
import type { GitHubClient } from "../../src/github/client";
import { auditIssueDedupeKey } from "../../src/github/publication";
import { GitHubPublisher } from "../../src/github/publish";
import { withTestDb } from "../db/helpers";

const at = new Date("2026-07-21T12:00:00.000Z");

describe("publishIssue", () => {
	// The scheduled-audit lane was the only one that authorized an issue plan, and
	// it was retired with sf#830 (D10). A well-formed issue plan left in the table
	// must now fail closed: terminally failed, and no forge write at all.
	test("refuses every issue plan: terminally failed, no forge write", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/rtech-audit", checks: "standard" })
				.returning({ id: repositories.id });
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repo?.id as number,
					itemId: null,
					sha: "",
					jobType: "audit-rtech-audit",
				})
				.returning({ id: jobs.id });
			const jobId = job?.id as number;
			const fingerprint = "fp0123456789abcdef";
			const dedupeKey = auditIssueDedupeKey("rtech-audit", fingerprint);
			await db.insert(githubPostings).values({
				jobId,
				kind: "issue",
				action: "open",
				target: fingerprint,
				dedupeKey,
				payload: JSON.stringify({
					kind: "issue",
					action: "open",
					target: fingerprint,
					title: "leak",
					body: `<!-- ${dedupeKey} -->\nbody`,
					dedupeKey,
					cleared: false,
				}),
			});
			const writes: string[] = [];
			const client = {
				async write(method: string, path: string) {
					writes.push(`${method} ${path}`);
					throw new Error("no forge write is allowed");
				},
			} as unknown as GitHubClient;

			const summary = await new GitHubPublisher(db, client, { now: () => at }).run();

			expect(writes).toEqual([]);
			expect(summary.posted).toBe(0);
			expect(summary.failed).toBe(1);
			const [row] = await db
				.select({ status: githubPostings.status, lastError: githubPostings.lastError })
				.from(githubPostings)
				.where(eq(githubPostings.jobId, jobId))
				.limit(1);
			expect(row?.status).toBe("failed");
			expect(row?.lastError).toBe("plan target not authorized by job identity");
		});
	});
});
