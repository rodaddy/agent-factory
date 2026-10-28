/**
 * Shadow-compare report regressions. The report reads the shadow ledger and
 * emits a bounded, human/CI-readable comparison record: per item, the intended
 * check conclusion, added label, and comment dedupe marker. These pin: a seeded
 * ledger produces the expected grouped record; the render is bounded; and the
 * scan/item bounds are observable (never silently truncated).
 */
import { describe, expect, test } from "bun:test";
import { githubPostings, jobs, repositories, shadowPublications } from "../../src/db/schema";
import {
	buildShadowReport,
	buildShadowReportForJobs,
	MAX_REPORT_ITEMS,
	renderShadowReport,
} from "../../src/github/shadow-report";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** Seed a repo + job + posting and one shadow ledger row, returning the job id. */
async function seedLedgerRow(
	db: TestDb,
	opts: {
		itemNumber?: number | null;
		sha?: string | null;
		kind: string;
		action?: string | null;
		target: string;
		wouldAction: string;
		dedupeKey: string;
		conclusion?: string | null;
	},
): Promise<number> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x" })
		.onConflictDoUpdate({
			target: [repositories.provider, repositories.fullName],
			set: { checks: "standard" },
		})
		.returning();
	if (!repo) throw new Error("seed failed");
	const [job] = await db
		.insert(jobs)
		.values({ repositoryId: repo.id, sha: opts.sha ?? "", jobType: "pr-review", status: "posted" })
		.returning();
	if (!job) throw new Error("seed failed");
	const [posting] = await db
		.insert(githubPostings)
		.values({
			jobId: job.id,
			kind: opts.kind,
			action: "upsert",
			target: opts.target,
			status: "posted",
			payload: "{}",
			dedupeKey: opts.dedupeKey,
		})
		.returning();
	if (!posting) throw new Error("seed failed");
	await db.insert(shadowPublications).values({
		postingId: posting.id,
		jobId: job.id,
		kind: opts.kind,
		// Default a check/comment to `upsert` and a label to its would-action-derived
		// add/remove; callers override `action` explicitly for label add/remove cases.
		action:
			opts.action === undefined
				? opts.kind === "label"
					? opts.wouldAction === "created"
						? "add"
						: "remove"
					: "upsert"
				: opts.action,
		repository: "rodaddy/x",
		itemNumber: opts.itemNumber === undefined ? 42 : opts.itemNumber,
		sha: opts.sha ?? null,
		wouldAction: opts.wouldAction,
		target: opts.target,
		dedupeKey: opts.dedupeKey,
		conclusion: opts.conclusion ?? null,
	});
	return job.id;
}

describe("buildShadowReport", () => {
	test("groups a seeded ledger into a per-item record with the salient fields", async () => {
		await withTestDb(async (db) => {
			await seedLedgerRow(db, {
				kind: "check",
				target: "check",
				wouldAction: "created",
				dedupeKey: "software-factory:check:job-1:abc",
				conclusion: "success",
				sha: "abc",
			});
			await seedLedgerRow(db, {
				kind: "label",
				target: "watcher:passed",
				wouldAction: "created",
				dedupeKey: "watcher:passed",
			});
			await seedLedgerRow(db, {
				kind: "comment",
				target: "comment",
				wouldAction: "deduped",
				dedupeKey: "software-factory:comment:job-3",
			});

			const report = await buildShadowReport(db);
			expect(report.scanned).toBe(3);
			expect(report.scanTruncated).toBe(false);
			expect(report.itemsTruncated).toBe(false);

			// One grouping carries the check conclusion, one the added label, one the
			// comment marker (each seeded row is its own job, but same repo/item # 42).
			const withCheck = report.items.find((i) => i.checkConclusion !== null);
			expect(withCheck?.checkConclusion).toBe("success");
			const withLabel = report.items.find((i) => i.addedLabel !== null);
			expect(withLabel?.addedLabel).toBe("watcher:passed");
			const withComment = report.items.find((i) => i.commentMarker !== null);
			expect(withComment?.commentMarker).toBe("software-factory:comment:job-3");

			const rendered = renderShadowReport(report);
			expect(rendered).toContain("shadow report:");
			expect(rendered).toContain("conclusion=success");
			expect(rendered).toContain("+watcher:passed");
			expect(rendered).toContain("(deduped)");
			// The render is bounded — never megabytes for a small ledger.
			expect(rendered.length).toBeLessThan(10_000);
		});
	});

	test("a PASSED job renders the ADDED label, never a removal (add/remove distinguished)", async () => {
		await withTestDb(async (db) => {
			// A PASSED job emits 1 add (watcher:passed) + 3 removes, all recorded as
			// `created` ledger rows. Without the action distinction the last-processed
			// removal would win and the report would show "+watcher:skipped".
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x" })
				.onConflictDoUpdate({
					target: [repositories.provider, repositories.fullName],
					set: { checks: "standard" },
				})
				.returning();
			if (!repo) throw new Error("seed failed");
			const [job] = await db
				.insert(jobs)
				.values({ repositoryId: repo.id, sha: "sha-pass", jobType: "pr-review", status: "posted" })
				.returning();
			if (!job) throw new Error("seed failed");

			// RESULT_LABELS order: passed (add), failed, error, skipped (removes).
			const labelOps: Array<{ target: string; action: string }> = [
				{ target: "watcher:passed", action: "add" },
				{ target: "watcher:failed", action: "remove" },
				{ target: "watcher:error", action: "remove" },
				{ target: "watcher:skipped", action: "remove" },
			];
			for (const op of labelOps) {
				const [posting] = await db
					.insert(githubPostings)
					.values({
						jobId: job.id,
						kind: "label",
						action: op.action,
						target: op.target,
						status: "posted",
						payload: "{}",
						dedupeKey: op.target,
					})
					.returning();
				if (!posting) throw new Error("seed failed");
				await db.insert(shadowPublications).values({
					postingId: posting.id,
					jobId: job.id,
					kind: "label",
					action: op.action,
					repository: "rodaddy/x",
					itemNumber: 55,
					sha: "sha-pass",
					wouldAction: "created", // both add and remove would create a ledger row
					target: op.target,
					dedupeKey: op.target,
					conclusion: null,
				});
			}

			const report = await buildShadowReport(db);
			const item = report.items.find((i) => i.itemNumber === 55);
			// The single ADD is surfaced; the removal processed last does NOT win.
			expect(item?.addedLabel).toBe("watcher:passed");
			expect(item?.removedLabels).toEqual(["watcher:failed", "watcher:error", "watcher:skipped"]);
			const rendered = renderShadowReport(report);
			expect(rendered).toContain("+watcher:passed");
			expect(rendered).not.toContain("+watcher:skipped");
			expect(rendered).toContain("removes: watcher:failed, watcher:error, watcher:skipped");
		});
	});

	test("a PR's check + label + comment correlate into ONE per-item block", async () => {
		await withTestDb(async (db) => {
			// All three kinds share the same trusted (item, sha) now, so they must land
			// in one group rather than splitting a check row from label/comment rows.
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x" })
				.onConflictDoUpdate({
					target: [repositories.provider, repositories.fullName],
					set: { checks: "standard" },
				})
				.returning();
			if (!repo) throw new Error("seed failed");
			const [job] = await db
				.insert(jobs)
				.values({ repositoryId: repo.id, sha: "sha-pr", jobType: "pr-review", status: "posted" })
				.returning();
			if (!job) throw new Error("seed failed");

			const rows = [
				{
					kind: "check",
					action: "upsert",
					target: "check",
					conclusion: "success" as string | null,
				},
				{ kind: "label", action: "add", target: "watcher:passed", conclusion: null },
				{ kind: "comment", action: "upsert", target: "comment", conclusion: null },
			];
			for (const r of rows) {
				const [posting] = await db
					.insert(githubPostings)
					.values({
						jobId: job.id,
						kind: r.kind,
						action: r.action,
						target: r.target,
						status: "posted",
						payload: "{}",
						dedupeKey: `k-${r.kind}`,
					})
					.returning();
				if (!posting) throw new Error("seed failed");
				await db.insert(shadowPublications).values({
					postingId: posting.id,
					jobId: job.id,
					kind: r.kind,
					action: r.action,
					repository: "rodaddy/x",
					itemNumber: 88, // BOTH item and sha recorded on every row for the PR
					sha: "sha-pr",
					wouldAction: "created",
					target: r.target,
					dedupeKey: `k-${r.kind}`,
					conclusion: r.conclusion,
				});
			}

			const report = await buildShadowReport(db);
			const item = report.items.find((i) => i.itemNumber === 88);
			expect(item).toBeDefined();
			// ONE block carries all three intents — not split across disjoint groups.
			expect(item?.checkConclusion).toBe("success");
			expect(item?.addedLabel).toBe("watcher:passed");
			expect(item?.commentMarker).toBe("k-comment");
			// Exactly one grouping for this (item, sha).
			expect(report.items.filter((i) => i.itemNumber === 88).length).toBe(1);
		});
	});

	test("an empty ledger yields an empty, bounded report", async () => {
		await withTestDb(async (db) => {
			const report = await buildShadowReport(db);
			expect(report.scanned).toBe(0);
			expect(report.items).toEqual([]);
			expect(renderShadowReport(report)).toContain("0 item(s)");
		});
	});

	test("buildShadowReportForJobs restricts to the named jobs", async () => {
		await withTestDb(async (db) => {
			const jobA = await seedLedgerRow(db, {
				kind: "check",
				target: "check",
				wouldAction: "created",
				dedupeKey: "k-a",
				conclusion: "failure",
				sha: "aaa",
			});
			await seedLedgerRow(db, {
				kind: "check",
				target: "check",
				wouldAction: "created",
				dedupeKey: "k-b",
				conclusion: "success",
				sha: "bbb",
			});

			const report = await buildShadowReportForJobs(db, [jobA]);
			expect(report.scanned).toBe(1);
			expect(report.items[0]?.checkConclusion).toBe("failure");
		});
	});

	test("buildShadowReportForJobs flags a truncated scan instead of claiming completeness", async () => {
		await withTestDb(async (db) => {
			// Seed three rows for one job but scan with a cap of one: the report must
			// surface scanTruncated rather than the old hardcoded `false`.
			const jobId = await seedLedgerRow(db, {
				kind: "check",
				target: "check",
				wouldAction: "created",
				dedupeKey: "t-0",
				conclusion: "success",
				sha: "s0",
			});
			// Add two more ledger rows against the SAME job.
			const [posting] = await db
				.insert(githubPostings)
				.values({
					jobId,
					kind: "label",
					action: "add",
					target: "watcher:passed",
					status: "posted",
					payload: "{}",
					dedupeKey: "watcher:passed",
				})
				.returning();
			if (!posting) throw new Error("seed failed");
			for (let n = 1; n <= 2; n++) {
				await db.insert(shadowPublications).values({
					postingId: posting.id,
					jobId,
					kind: "label",
					action: "add",
					repository: "rodaddy/x",
					itemNumber: 42,
					sha: null,
					wouldAction: n === 1 ? "created" : "deduped", // vary to satisfy the unique key
					target: "watcher:passed",
					dedupeKey: "watcher:passed",
					conclusion: null,
				});
			}

			const report = await buildShadowReportForJobs(db, [jobId], 1);
			expect(report.scanned).toBe(1);
			expect(report.scanTruncated).toBe(true);
			// The flag defaults false only when the scan truly saw everything.
			const full = await buildShadowReportForJobs(db, [jobId]);
			expect(full.scanTruncated).toBe(false);
			expect(full.itemsTruncated).toBe(false);
		});
	});

	test("the scan bound is observable: reading past the cap flags scanTruncated", async () => {
		await withTestDb(async (db) => {
			// Seed three rows but scan with a cap of one; the report must flag truncation
			// rather than silently claiming it saw everything.
			for (let n = 0; n < 3; n++) {
				await seedLedgerRow(db, {
					kind: "check",
					target: "check",
					wouldAction: "created",
					dedupeKey: `k-${n}`,
					conclusion: "success",
					sha: `sha${n}`,
				});
			}
			const report = await buildShadowReport(db, 1);
			expect(report.scanned).toBe(1);
			expect(report.scanTruncated).toBe(true);
		});
	});

	test("MAX_REPORT_ITEMS is a positive bound", () => {
		expect(MAX_REPORT_ITEMS).toBeGreaterThan(0);
	});
});
