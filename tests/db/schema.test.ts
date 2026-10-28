import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { githubItems, jobs, repositories } from "../../src/db/schema";
import { withTestDb } from "./helpers";

/** Narrow a `returning()`/select result to its first row or fail the test. */
function first<T>(rows: T[]): T {
	const row = rows[0];
	if (row === undefined) {
		throw new Error("expected at least one row");
	}
	return row;
}

describe("watcher schema", () => {
	test("push creates all required tables", async () => {
		await withTestDb(async (db) => {
			const rows = await db.execute<{ table_name: string }>(
				sql`SELECT table_name FROM information_schema.tables
					WHERE table_schema = 'public' ORDER BY table_name`,
			);
			const names = rows.map((r) => r.table_name);
			expect(names).toEqual([
				// sf#183: the durable copy of each attempt's raw event stream. Alphabetical,
				// which is what the query orders by — not a statement about ownership.
				"attempt_event_streams",
				"audit_schedule_slots",
				// sf#544: one bump-script invocation per (candidate, app_dir). Alphabetical
				// position only.
				"build_bump_bumps",
				// sf#542: observed tags on build-bump-enrolled repositories. Alphabetical
				// position only.
				"build_bump_candidates",
				// sf#719: the movable tags environments promote by, rebuilt every intake
				// pass. Alphabetical position only.
				"build_bump_markers",
				// sf#465 R4: runner artifacts published on NATS and drained by the
				// watcher. Alphabetical position only.
				"bus_results",
				// sf#424: Forgejo webhook delivery replay key. Alphabetical position only.
				"forge_deliveries",
				"forge_runs",
				"github_items",
				"github_postings",
				"job_attempts",
				"jobs",
				"reconciliation_cursors",
				"repositories",
				"result_postings",
				"runner_boxes",
				"schema_migrations",
				"shadow_publications",
			]);
		});
	});

	test("timestamp columns are timestamptz", async () => {
		await withTestDb(async (db) => {
			const rows = await db.execute<{ data_type: string }>(
				sql`SELECT data_type FROM information_schema.columns
					WHERE table_schema = 'public' AND column_name LIKE '%_at'`,
			);
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) {
				expect(r.data_type).toBe("timestamp with time zone");
			}
		});
	});

	test("jobs uniqueness key prevents duplicate work", async () => {
		await withTestDb(async (db) => {
			const repo = first(
				await db.insert(repositories).values({ fullName: "rodaddy/open-brain" }).returning(),
			);
			const item = first(
				await db
					.insert(githubItems)
					.values({ repositoryId: repo.id, kind: "pull", number: 7, state: "open" })
					.returning(),
			);

			const values = {
				repositoryId: repo.id,
				itemId: item.id,
				sha: "abc123",
				jobType: "pr-review",
			};
			await db.insert(jobs).values(values);

			let rejected = false;
			try {
				await db.insert(jobs).values(values);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
		});
	});

	test("jobs without a SHA collapse to one per (repo, item, type)", async () => {
		await withTestDb(async (db) => {
			const repo = first(
				await db.insert(repositories).values({ fullName: "rodaddy/mcp2cli" }).returning(),
			);
			const item = first(
				await db
					.insert(githubItems)
					.values({ repositoryId: repo.id, kind: "issue", number: 3, state: "open" })
					.returning(),
			);

			const values = { repositoryId: repo.id, itemId: item.id, jobType: "triage" };
			await db.insert(jobs).values(values);

			// Empty-string SHA default means the second insert collides.
			let rejected = false;
			try {
				await db.insert(jobs).values(values);
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
		});
	});

	test("different job types for the same commit coexist", async () => {
		await withTestDb(async (db) => {
			const repo = first(
				await db.insert(repositories).values({ fullName: "rodaddy/rtech-mcps" }).returning(),
			);

			await db.insert(jobs).values({ repositoryId: repo.id, sha: "deadbeef", jobType: "validate" });
			await db
				.insert(jobs)
				.values({ repositoryId: repo.id, sha: "deadbeef", jobType: "pr-review" });

			const all = await db.select().from(jobs);
			expect(all.length).toBe(2);
		});
	});

	test("the same owner/repo coexists across providers but not within one", async () => {
		await withTestDb(async (db) => {
			// A GitHub `owner/repo` and a Forgejo `owner/repo` are distinct managed
			// repositories under the provider-qualified uniqueness key.
			const gh = first(
				await db
					.insert(repositories)
					.values({ provider: "github", fullName: "rodaddy/shared" })
					.returning(),
			);
			const fj = first(
				await db
					.insert(repositories)
					.values({ provider: "forgejo", fullName: "rodaddy/shared" })
					.returning(),
			);
			expect(gh.id).not.toBe(fj.id);

			// A second row for the SAME (provider, full_name) collides.
			let rejected = false;
			try {
				await db.insert(repositories).values({ provider: "github", fullName: "rodaddy/shared" });
			} catch {
				rejected = true;
			}
			expect(rejected).toBe(true);
		});
	});

	test("provider defaults to github", async () => {
		await withTestDb(async (db) => {
			const row = first(
				await db.insert(repositories).values({ fullName: "rodaddy/defaulted" }).returning(),
			);
			expect(row.provider).toBe("github");
		});
	});

	test("expected indexes exist", async () => {
		await withTestDb(async (db) => {
			const rows = await db.execute<{ indexname: string }>(
				sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
			);
			const names = new Set(rows.map((r) => r.indexname));
			for (const expected of [
				"repositories_provider_full_name_key",
				"jobs_repo_item_sha_type_key",
				"jobs_status_idx",
				"github_items_repo_kind_number_key",
				"job_attempts_runner_job_id_key",
				"github_postings_job_kind_target_key",
				"github_postings_status_idx",
				"result_postings_job_target_key",
				// Composite (job_id, id) that serves the scoped ordered shadow-report
				// read (`WHERE job_id IN (...) ORDER BY id`) without a sort.
				"shadow_publications_job_id_id_idx",
				// sf#465: the (job, host, artifact) unique index on bus_results IS the
				// re-publish guard — a redelivered NATS message inserts ON CONFLICT DO
				// NOTHING against it. Without the index the second copy duplicates the
				// row and the reader lists a host twice.
				"bus_results_job_host_artifact_key",
			]) {
				expect(names.has(expected)).toBe(true);
			}
		});
	});

	test("shadow_publications carries the label add/remove action column", async () => {
		await withTestDb(async (db) => {
			// The `action` column is load-bearing: it distinguishes a label ADD from a
			// REMOVE in the ledger (both are `created` rows), so the compare report can
			// name the single added label rather than the last-processed removal.
			const rows = await db.execute<{ column_name: string; is_nullable: string }>(
				sql`SELECT column_name, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'shadow_publications'
						AND column_name = 'action'`,
			);
			expect(rows.length).toBe(1);
			expect(first(rows).is_nullable).toBe("YES");
		});
	});

	test("build_bump_bumps carries settled_at, nullable and undefaulted", async () => {
		await withTestDb(async (db) => {
			// sf#719: the pair key is (candidate_id, app_dir) for all time, so a marker
			// environment moving back to a tag it already deployed finds that row still
			// terminal. `settled_at` orders the terminal records of one app_dir, which
			// is what lets the pass see a record superseded by a later bump and re-drive
			// it. NULL is "settled before this column existed" — older than any set
			// value — so it must carry no default that would invent a settlement time.
			const rows = await db.execute<{
				data_type: string;
				is_nullable: string;
				column_default: string | null;
			}>(
				sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_bumps'
						AND column_name = 'settled_at'`,
			);
			expect(rows.length).toBe(1);
			expect(first(rows).data_type).toBe("timestamp with time zone");
			expect(first(rows).is_nullable).toBe("YES");
			expect(first(rows).column_default).toBeNull();
		});
	});

	test("build_bump_candidates carries requeues, not-null and defaulted to zero", async () => {
		await withTestDb(async (db) => {
			// sf#719 §8: the count of marker-driven `failed` -> `pending` transitions.
			// No pair row exists before a candidate builds, so a build failing for a
			// permanent reason was requeued every pass with nothing for the stuck-pair
			// alert to match and nothing on `/status.json` to distinguish it from an
			// environment with no marker. The DEFAULT 0 is deliberate and is the
			// opposite of `settled_at` above: there is no "unknown" to preserve, since
			// nothing was ever counted under the code that did not count.
			const rows = await db.execute<{
				data_type: string;
				is_nullable: string;
				column_default: string | null;
			}>(
				sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_candidates'
						AND column_name = 'requeues'`,
			);
			expect(rows.length).toBe(1);
			expect(first(rows).data_type).toBe("integer");
			expect(first(rows).is_nullable).toBe("NO");
			expect(first(rows).column_default).toBe("0");
		});
	});

	test("push is idempotent (second push is a no-op)", async () => {
		await withTestDb(async (db) => {
			// helpers already pushed once; a repeat push against the same schema
			// must not error and must not change the table set.
			const before = await db.execute<{ n: string }>(
				sql`SELECT count(*)::text AS n FROM information_schema.tables
					WHERE table_schema = 'public'`,
			);
			// 18 since sf#476 added forge_runs.
			expect(Number(first(before).n)).toBe(18);
		});
	});
});
