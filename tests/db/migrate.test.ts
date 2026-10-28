import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { withEmptyTestDatabase, withTestDb } from "./helpers";

const REPO_ROOT = join(import.meta.dir, "../..");
const BASELINE_NAME = "0000_production_baseline.sql";
const PROVIDER_MIGRATION_NAME = "0001_repositories_provider.sql";
const RUNNER_BOXES_MIGRATION_NAME = "0002_runner_boxes.sql";
const ACTIVE_ATTEMPT_MIGRATION_NAME = "0003_jobs_active_attempt.sql";
const KBOARD_TASK_ID_MIGRATION_NAME = "0004_jobs_kboard_task_id.sql";
const CHECK_TRAIL_MIGRATION_NAME = "0005_result_postings_check_trail.sql";
const OBSERVED_MODEL_MIGRATION_NAME = "0006_job_attempts_observed_model.sql";
const CHANGE_BASE_MIGRATION_NAME = "0007_jobs_change_base.sql";
const TERMINAL_REASON_MIGRATION_NAME = "0008_jobs_terminal_reason.sql";
const TRACE_ID_MIGRATION_NAME = "0009_job_attempts_trace_id.sql";
const EVENT_STREAMS_MIGRATION_NAME = "0010_attempt_event_streams.sql";
const FORGE_DELIVERIES_MIGRATION_NAME = "0011_forge_deliveries.sql";
const BUS_RESULTS_MIGRATION_NAME = "0012_bus_results.sql";
const RETIRE_FORGE_BAND_MIGRATION_NAME = "0013_retire_forge_band.sql";
const BUILD_BUMP_CANDIDATES_MIGRATION_NAME = "0014_build_bump_candidates.sql";
const BUILD_BUMP_BUILD_MIGRATION_NAME = "0015_build_bump_candidate_build.sql";
const BUILD_BUMP_BUMPS_MIGRATION_NAME = "0016_build_bump_bumps.sql";
const RESTORE_FORGE_BAND_MIGRATION_NAME = "0017_restore_forge_band.sql";
const BUILD_BUMP_INVOKING_MIGRATION_NAME = "0018_build_bump_invoking.sql";
const BUILD_BUMP_READINESS_MIGRATION_NAME = "0019_build_bump_readiness.sql";
const BUILD_BUMP_IMAGES_MIGRATION_NAME = "0020_build_bump_images.sql";
const BUILD_BUMP_ENVIRONMENTS_MIGRATION_NAME = "0021_build_bump_environments.sql";
const BUILD_BUMP_SETTLED_AT_MIGRATION_NAME = "0022_build_bump_bumps_settled_at.sql";
const BUILD_BUMP_REQUEUES_MIGRATION_NAME = "0023_build_bump_candidates_requeues.sql";
const BUILD_BUMP_INDEX_NULLS_LAST_MIGRATION_NAME =
	"0024_build_bump_candidates_index_nulls_last.sql";
const ATTEMPT_LEVEL_MIGRATION_NAME = "0025_job_attempts_level.sql";
const FORGE_RUNS_MIGRATION_NAME = "0026_forge_runs.sql";
const MERGE_WATCH_MIGRATION_NAME = "0027_build_bump_bumps_merge_watch.sql";
const BASELINE_PATH = join(REPO_ROOT, "drizzle", BASELINE_NAME);
const SNAPSHOT_PATH = join(REPO_ROOT, "drizzle", "meta", "0000_snapshot.json");
const PRE_READINESS_MIGRATION_NAMES = [
	BASELINE_NAME,
	PROVIDER_MIGRATION_NAME,
	RUNNER_BOXES_MIGRATION_NAME,
	ACTIVE_ATTEMPT_MIGRATION_NAME,
	KBOARD_TASK_ID_MIGRATION_NAME,
	CHECK_TRAIL_MIGRATION_NAME,
	OBSERVED_MODEL_MIGRATION_NAME,
	CHANGE_BASE_MIGRATION_NAME,
	TERMINAL_REASON_MIGRATION_NAME,
	TRACE_ID_MIGRATION_NAME,
	EVENT_STREAMS_MIGRATION_NAME,
	FORGE_DELIVERIES_MIGRATION_NAME,
	BUS_RESULTS_MIGRATION_NAME,
	RETIRE_FORGE_BAND_MIGRATION_NAME,
	BUILD_BUMP_CANDIDATES_MIGRATION_NAME,
	BUILD_BUMP_BUILD_MIGRATION_NAME,
	BUILD_BUMP_BUMPS_MIGRATION_NAME,
	RESTORE_FORGE_BAND_MIGRATION_NAME,
	BUILD_BUMP_INVOKING_MIGRATION_NAME,
];

const EXPECTED_TABLES = [
	"attempt_event_streams",
	"audit_schedule_slots",
	// sf#544: one bump-script invocation per (candidate, app_dir).
	"build_bump_bumps",
	// sf#542: observed tags on build-bump-enrolled repositories.
	"build_bump_candidates",
	// sf#719: the movable tags environments promote by, rebuilt every intake pass.
	"build_bump_markers",
	"bus_results",
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
];

interface MigrationResult {
	code: number;
	output: string;
}

async function runMigrationCommand(
	databaseUrl: string,
	extraEnv: Record<string, string> = {},
): Promise<MigrationResult> {
	const proc = Bun.spawn(["bun", "run", "db:migrate"], {
		cwd: REPO_ROOT,
		env: { ...process.env, DATABASE_URL: databaseUrl, ...extraEnv },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, output: `${stdout}\n${stderr}` };
}

async function runMigrations(databaseUrl: string): Promise<string> {
	const result = await runMigrationCommand(databaseUrl);
	if (result.code !== 0) {
		throw new Error(`db:migrate failed (exit ${result.code}):\n${result.output}`);
	}
	return result.output;
}

describe("production migration baseline", () => {
	test("runner owns executable schema_migrations DDL while metadata retains its full shape", () => {
		const baseline = readFileSync(BASELINE_PATH, "utf8");
		expect(baseline).not.toMatch(/CREATE TABLE "schema_migrations"/);
		expect(baseline).toContain("schema_migrations is runner-owned");

		const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
		const tracking = snapshot.tables["public.schema_migrations"];
		expect(tracking.columns.version.primaryKey).toBe(true);
		expect(tracking.columns.checksum.notNull).toBe(true);
		expect(tracking.columns.applied_at.notNull).toBe(true);
	});

	test("migrates an empty local database and reruns idempotently", async () => {
		await withEmptyTestDatabase(async (databaseUrl) => {
			const firstRun = await runMigrations(databaseUrl);
			expect(firstRun).toContain(`applied: ${BASELINE_NAME}`);
			// The additive dual-forge provider migration applies on top of the
			// baseline in the same run.
			expect(firstRun).toContain(`applied: ${PROVIDER_MIGRATION_NAME}`);
			// #78: the runner box inventory table.
			expect(firstRun).toContain(`applied: ${RUNNER_BOXES_MIGRATION_NAME}`);
			// #85: the additive jobs.active_attempt_id column.
			expect(firstRun).toContain(`applied: ${ACTIVE_ATTEMPT_MIGRATION_NAME}`);
			// #71 phase 1b: the additive jobs.kboard_task_id column + its partial index.
			expect(firstRun).toContain(`applied: ${KBOARD_TASK_ID_MIGRATION_NAME}`);
			expect(firstRun).toContain(`applied: ${CHECK_TRAIL_MIGRATION_NAME}`);
			expect(firstRun).toContain(`applied: ${TERMINAL_REASON_MIGRATION_NAME}`);

			const sql = new SQL(databaseUrl);
			try {
				const tables = await sql<{ table_name: string }[]>`
					SELECT table_name
					FROM information_schema.tables
					WHERE table_schema = 'public'
					ORDER BY table_name
				`;
				// The provider migration adds a COLUMN and swaps a unique index, adding no
				// table; 0002 adds exactly one, `runner_boxes`.
				expect(tables.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);

				// The bare full_name unique index is replaced by the provider-qualified one.
				const repoIndexes = await sql<{ indexname: string }[]>`
					SELECT indexname FROM pg_indexes
					WHERE schemaname = 'public' AND tablename = 'repositories'
				`;
				const repoIndexNames = new Set(repoIndexes.map((row) => row.indexname));
				expect(repoIndexNames.has("repositories_provider_full_name_key")).toBe(true);
				expect(repoIndexNames.has("repositories_full_name_key")).toBe(false);

				// The provider column exists with a github default and NOT NULL.
				const providerColumn = await sql<{ column_default: string | null; is_nullable: string }[]>`
					SELECT column_default, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'repositories'
						AND column_name = 'provider'
				`;
				expect(providerColumn).toHaveLength(1);
				expect(providerColumn[0]?.is_nullable).toBe("NO");
				expect(providerColumn[0]?.column_default).toContain("github");

				const constraints = await sql<{ conname: string }[]>`
					SELECT conname
					FROM pg_constraint
					WHERE connamespace = 'public'::regnamespace
				`;
				const constraintNames = new Set(constraints.map((row) => row.conname));
				for (const expected of [
					"jobs_repo_item_sha_type_key",
					"audit_schedule_slots_repository_id_repositories_id_fk",
					"github_postings_job_id_jobs_id_fk",
					"shadow_publications_posting_id_github_postings_id_fk",
				]) {
					expect(constraintNames.has(expected)).toBe(true);
				}

				const indexes = await sql<{ indexname: string }[]>`
					SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
				`;
				const indexNames = new Set(indexes.map((row) => row.indexname));
				for (const expected of [
					"audit_schedule_slots_repo_audit_slot_key",
					"github_items_repo_state_idx",
					"github_postings_status_idx",
					"job_attempts_runner_job_id_key",
					"shadow_publications_job_id_id_idx",
					// The #71 ready-station read path: "does this task already have a live
					// job?" and "does this job carry a task id?". Partial on NOT NULL, so a
					// label-triggered row is not in it at all.
					"jobs_kboard_task_id_idx",
					// sf#465: the re-publish guard on bus_results. A redelivered NATS
					// message inserts ON CONFLICT DO NOTHING against this index, so a
					// migration that created the table without it would admit duplicates
					// silently.
					"bus_results_job_host_artifact_key",
				]) {
					expect(indexNames.has(expected)).toBe(true);
				}

				// #170: the attested-model column lands NULLABLE. Nullable is the whole
				// compatibility story — every pre-#170 attempt row predates it, and a lane
				// that writes no event stream has no attestation to record.
				const observedModel = await sql<{ data_type: string; is_nullable: string }[]>`
					SELECT data_type, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'job_attempts'
						AND column_name = 'observed_model'
				`;
				expect(observedModel).toHaveLength(1);
				expect(observedModel[0]?.data_type).toBe("text");
				expect(observedModel[0]?.is_nullable).toBe("YES");

				// #184: the Langfuse trace id lands NULLABLE for the same reason — every
				// row predating the column has no trace, and an attempt whose lane wrote
				// no parseable event stream is never observed at all. A NOT NULL would
				// need a backfill value and there is no honest one: inventing
				// `attempt-N-<host>` for an unobserved attempt would point the status
				// page at a trace that was never emitted.
				const traceId = await sql<{ data_type: string; is_nullable: string }[]>`
					SELECT data_type, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'job_attempts'
						AND column_name = 'trace_id'
				`;
				expect(traceId).toEqual([{ data_type: "text", is_nullable: "YES" }]);

				// sf#183: the durable event-stream copy. TWO properties are load-bearing
				// and neither is visible in the table list above.
				//
				// 1. `attempt_id` is the PRIMARY KEY, not a plain or unique index. The
				//    write is `ON CONFLICT DO NOTHING` on it, so the PK IS the
				//    first-writer-wins mechanism — a restart re-reads the same DONE and
				//    results are per (job, host), so repeat writes are ordinary. A
				//    nullable unique index would not substitute: PostgreSQL does not
				//    deduplicate NULLs in one, so it would admit unbounded duplicates.
				// 2. The foreign key is `NO ACTION`, NOT `CASCADE`. The whole point of
				//    the row is to outlive the share's job directory, and a cascade
				//    would hand the raw record a lifetime tied to the very table whose
				//    retention nobody guarantees. `retireAllocationIntent` is the only
				//    attempt-row delete in this codebase and is scoped to an
				//    `allocating` intent row that never ran, so it never has a stream.
				const streamPk = await sql<{ contype: string; column_name: string }[]>`
					SELECT c.contype::text AS contype, a.attname AS column_name
					FROM pg_constraint c
					JOIN unnest(c.conkey) AS k(attnum) ON true
					JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
					WHERE c.conrelid = 'public.attempt_event_streams'::regclass
						AND c.contype = 'p'
				`;
				expect(streamPk).toEqual([{ contype: "p", column_name: "attempt_id" }]);

				const streamFk = await sql<{ confdeltype: string }[]>`
					SELECT c.confdeltype::text AS confdeltype
					FROM pg_constraint c
					WHERE c.conrelid = 'public.attempt_event_streams'::regclass
						AND c.contype = 'f'
				`;
				// `a` is NO ACTION; `c` would be CASCADE — the value this asserts is NOT.
				expect(streamFk).toEqual([{ confdeltype: "a" }]);

				const streamColumns = await sql<
					{ column_name: string; data_type: string; is_nullable: string }[]
				>`
					SELECT column_name, data_type, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'attempt_event_streams'
					ORDER BY column_name
				`;
				expect(streamColumns).toEqual([
					{ column_name: "attempt_id", data_type: "integer", is_nullable: "NO" },
					{ column_name: "byte_length", data_type: "integer", is_nullable: "NO" },
					{ column_name: "content", data_type: "text", is_nullable: "NO" },
					{
						column_name: "created_at",
						data_type: "timestamp with time zone",
						is_nullable: "NO",
					},
				]);

				const applied = await sql<
					{ version: string; checksum: string; applied_at: Date }[]
				>`SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version`;
				// sf#301: both change-base columns land NULLABLE, and that is the whole
				// compatibility story — every job that predates the deterministic verbs
				// leaves them NULL and `dispatchedBaseForJob` then answers exactly as it
				// always did. A NOT NULL here would have required a backfill value, and
				// there is no honest one: a non-verb job has no separate change base.
				const changeBase = await sql<
					{ column_name: string; data_type: string; is_nullable: string }[]
				>`
					SELECT column_name, data_type, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'jobs'
						AND column_name IN ('change_base_repository', 'change_base_sha')
					ORDER BY column_name
				`;
				expect(changeBase).toHaveLength(2);
				for (const column of changeBase) {
					expect(column.data_type).toBe("text");
					expect(column.is_nullable).toBe("YES");
				}
				const terminalReason = await sql<{ data_type: string; is_nullable: string }[]>`
					SELECT data_type, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'jobs'
						AND column_name = 'terminal_reason'
				`;
				expect(terminalReason).toEqual([{ data_type: "text", is_nullable: "YES" }]);
				// sf#620: the readiness columns arrive through the migration path, and
				// each must be nullable with NO default — NULL is "never measured" and
				// a column default of 0 would assert every pre-existing bump deployed
				// instantly. `column_default` is the assertion that catches that.
				const readiness = await sql<
					{
						column_name: string;
						data_type: string;
						is_nullable: string;
						column_default: string | null;
					}[]
				>`
					SELECT column_name, data_type, is_nullable, column_default
					FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_bumps'
						AND column_name IN ('ready_seconds', 'ready_restart_count', 'ready_sample_count')
					ORDER BY column_name
				`;
				expect(readiness.map((row) => row.column_name)).toEqual([
					"ready_restart_count",
					"ready_sample_count",
					"ready_seconds",
				]);
				for (const column of readiness) {
					expect(column.data_type).toBe("integer");
					expect(column.is_nullable).toBe("YES");
					expect(column.column_default).toBeNull();
				}

				// sf#719: `settled_at` orders the terminal records of one app_dir, which
				// is what lets a marker environment re-drive a pair a later bump
				// superseded. NULLABLE with no default and no backfill: a row that
				// settled before the column existed has no observation, and NULL sorting
				// older than any set value is the correct reading.
				const settledAt = await sql<
					{ data_type: string; is_nullable: string; column_default: string | null }[]
				>`
					SELECT data_type, is_nullable, column_default FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_bumps'
						AND column_name = 'settled_at'
				`;
				expect(settledAt).toEqual([
					{
						data_type: "timestamp with time zone",
						is_nullable: "YES",
						column_default: null,
					},
				]);

				// sf#719 §8: `requeues` counts the marker-driven `failed` -> `pending`
				// transitions, which were previously invisible — no pair row is created
				// before a candidate builds, so a permanently failing build was requeued
				// every pass with nothing to alert on. NOT NULL DEFAULT 0, the opposite
				// of the readiness columns: zero is the honest value for a pre-existing
				// row, because nothing was ever counted under code that did not count.
				const requeues = await sql<
					{ data_type: string; is_nullable: string; column_default: string | null }[]
				>`
					SELECT data_type, is_nullable, column_default FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_candidates'
						AND column_name = 'requeues'
				`;
				expect(requeues).toEqual([
					{ data_type: "integer", is_nullable: "NO", column_default: "0" },
				]);

				// sf#708: the log level in force for an attempt. NOT NULL DEFAULT
				// 'info': every pre-existing attempt ran under the process-global
				// level, which was info, so info is the honest backfill.
				const attemptLevel = await sql<
					{ data_type: string; is_nullable: string; column_default: string | null }[]
				>`
					SELECT data_type, is_nullable, column_default FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'job_attempts'
						AND column_name = 'level'
				`;
				expect(attemptLevel).toEqual([
					{ data_type: "text", is_nullable: "NO", column_default: "'info'::text" },
				]);

				expect(applied).toHaveLength(28);
				expect(applied.map((row) => row.version)).toEqual([
					BASELINE_NAME,
					PROVIDER_MIGRATION_NAME,
					RUNNER_BOXES_MIGRATION_NAME,
					ACTIVE_ATTEMPT_MIGRATION_NAME,
					KBOARD_TASK_ID_MIGRATION_NAME,
					CHECK_TRAIL_MIGRATION_NAME,
					OBSERVED_MODEL_MIGRATION_NAME,
					CHANGE_BASE_MIGRATION_NAME,
					TERMINAL_REASON_MIGRATION_NAME,
					TRACE_ID_MIGRATION_NAME,
					EVENT_STREAMS_MIGRATION_NAME,
					FORGE_DELIVERIES_MIGRATION_NAME,
					BUS_RESULTS_MIGRATION_NAME,
					RETIRE_FORGE_BAND_MIGRATION_NAME,
					BUILD_BUMP_CANDIDATES_MIGRATION_NAME,
					BUILD_BUMP_BUILD_MIGRATION_NAME,
					BUILD_BUMP_BUMPS_MIGRATION_NAME,
					RESTORE_FORGE_BAND_MIGRATION_NAME,
					BUILD_BUMP_INVOKING_MIGRATION_NAME,
					BUILD_BUMP_READINESS_MIGRATION_NAME,
					BUILD_BUMP_IMAGES_MIGRATION_NAME,
					BUILD_BUMP_ENVIRONMENTS_MIGRATION_NAME,
					BUILD_BUMP_SETTLED_AT_MIGRATION_NAME,
					BUILD_BUMP_REQUEUES_MIGRATION_NAME,
					BUILD_BUMP_INDEX_NULLS_LAST_MIGRATION_NAME,
					ATTEMPT_LEVEL_MIGRATION_NAME,
					FORGE_RUNS_MIGRATION_NAME,
					MERGE_WATCH_MIGRATION_NAME,
				]);
				// sf#1076: the merge-watch columns land NULLABLE with no default —
				// NULL is "not observed", the honest value for every existing row.
				const mergeWatch = await sql<
					{
						column_name: string;
						data_type: string;
						is_nullable: string;
						column_default: string | null;
					}[]
				>`
					SELECT column_name, data_type, is_nullable, column_default
					FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_bumps'
						AND column_name IN ('merged_at', 'pr_closed_at', 'argo_refreshed_at')
					ORDER BY column_name
				`;
				expect(mergeWatch.map((row) => row.column_name)).toEqual([
					"argo_refreshed_at",
					"merged_at",
					"pr_closed_at",
				]);
				for (const column of mergeWatch) {
					expect(column.data_type).toBe("timestamp with time zone");
					expect(column.is_nullable).toBe("YES");
					expect(column.column_default).toBeNull();
				}
				// sf#719: the commit-date column lands NULLABLE with no default, because
				// NULL is "unknown", not "old" — a row that predates the column has no
				// observation and there is no honest value to invent for it.
				const tagCreated = await sql<
					{ data_type: string; is_nullable: string; column_default: string | null }[]
				>`
					SELECT data_type, is_nullable, column_default FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_candidates'
						AND column_name = 'tag_created_at'
				`;
				expect(tagCreated).toEqual([
					{
						data_type: "timestamp with time zone",
						is_nullable: "YES",
						column_default: null,
					},
				]);
				const markerColumns = await sql<
					{ column_name: string; data_type: string; is_nullable: string }[]
				>`
					SELECT column_name, data_type, is_nullable FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_markers'
					ORDER BY column_name
				`;
				expect(markerColumns).toEqual([
					{ column_name: "id", data_type: "integer", is_nullable: "NO" },
					{ column_name: "marker", data_type: "text", is_nullable: "NO" },
					{ column_name: "repository", data_type: "text", is_nullable: "NO" },
					{
						column_name: "seen_at",
						data_type: "timestamp with time zone",
						is_nullable: "NO",
					},
					{ column_name: "sha", data_type: "text", is_nullable: "NO" },
				]);
				const markerIndexes = await sql<{ indexname: string }[]>`
					SELECT indexname FROM pg_indexes
					WHERE schemaname = 'public' AND tablename = 'build_bump_markers'
				`;
				// The unique key IS the rebuild mechanism: intake upserts on it.
				expect(markerIndexes.map((row) => row.indexname)).toContain(
					"build_bump_markers_repository_marker_key",
				);
				// sf#645: every pre-existing candidate is the legacy single-image shape,
				// so the backfill names the repository's short name and the root
				// Dockerfile, and the dedupe key now carries the image.
				const imageColumns = await sql<
					{ column_name: string; is_nullable: string; column_default: string | null }[]
				>`
					SELECT column_name, is_nullable, column_default
					FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = 'build_bump_candidates'
						AND column_name IN ('image', 'dockerfile')
					ORDER BY column_name
				`;
				expect(imageColumns.map((c) => [c.column_name, c.is_nullable])).toEqual([
					["dockerfile", "NO"],
					["image", "NO"],
				]);
				expect(imageColumns[0]?.column_default).toContain("Dockerfile");
				expect(imageColumns[1]?.column_default).toBeNull();
				const candidateIndexes = await sql<{ indexname: string }[]>`
					SELECT indexname FROM pg_indexes
					WHERE schemaname = 'public' AND tablename = 'build_bump_candidates'
				`;
				const names = candidateIndexes.map((row) => row.indexname);
				expect(names).toContain("build_bump_candidates_repository_tag_sha_image_key");
				expect(names).not.toContain("build_bump_candidates_repository_tag_sha_key");
				// sf#719: the selection order the build and bump phases read by.
				expect(names).toContain("build_bump_candidates_status_tag_created_idx");
				for (const row of applied) {
					expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
					expect(row.applied_at).toBeInstanceOf(Date);
				}

				const secondRun = await runMigrations(databaseUrl);
				expect(secondRun).toContain(`SKIP (already applied): ${BASELINE_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${PROVIDER_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${RUNNER_BOXES_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${ACTIVE_ATTEMPT_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${KBOARD_TASK_ID_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${CHECK_TRAIL_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${OBSERVED_MODEL_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${CHANGE_BASE_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${TERMINAL_REASON_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${TRACE_ID_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${EVENT_STREAMS_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${FORGE_DELIVERIES_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${BUS_RESULTS_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${RETIRE_FORGE_BAND_MIGRATION_NAME}`);
				expect(secondRun).toContain(
					`SKIP (already applied): ${BUILD_BUMP_CANDIDATES_MIGRATION_NAME}`,
				);
				expect(secondRun).toContain(`SKIP (already applied): ${BUILD_BUMP_BUILD_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${BUILD_BUMP_BUMPS_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${RESTORE_FORGE_BAND_MIGRATION_NAME}`);
				expect(secondRun).toContain(
					`SKIP (already applied): ${BUILD_BUMP_INVOKING_MIGRATION_NAME}`,
				);
				expect(secondRun).toContain(
					`SKIP (already applied): ${BUILD_BUMP_READINESS_MIGRATION_NAME}`,
				);
				expect(secondRun).toContain(`SKIP (already applied): ${BUILD_BUMP_IMAGES_MIGRATION_NAME}`);
				expect(secondRun).toContain(
					`SKIP (already applied): ${BUILD_BUMP_ENVIRONMENTS_MIGRATION_NAME}`,
				);
				expect(secondRun).toContain(
					`SKIP (already applied): ${BUILD_BUMP_SETTLED_AT_MIGRATION_NAME}`,
				);
				expect(secondRun).toContain(
					`SKIP (already applied): ${BUILD_BUMP_REQUEUES_MIGRATION_NAME}`,
				);
				expect(secondRun).toContain(
					`SKIP (already applied): ${BUILD_BUMP_INDEX_NULLS_LAST_MIGRATION_NAME}`,
				);
				expect(secondRun).toContain(`SKIP (already applied): ${ATTEMPT_LEVEL_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${FORGE_RUNS_MIGRATION_NAME}`);
				expect(secondRun).toContain(`SKIP (already applied): ${MERGE_WATCH_MIGRATION_NAME}`);
				const afterRerun = await sql<
					{ count: string }[]
				>`SELECT count(*)::text AS count FROM schema_migrations`;
				expect(afterRerun[0]?.count).toBe("28");
			} finally {
				await sql.end();
			}
		});
	});

	test("seeds the runner box inventory even when there is nothing to apply", async () => {
		await withEmptyTestDatabase(async (databaseUrl) => {
			// Apply the schema normally first, so `runner_boxes` exists and every
			// migration is already recorded.
			await runMigrations(databaseUrl);

			const sql = new SQL(databaseUrl);
			try {
				await sql`TRUNCATE runner_boxes`;
				const emptied = await sql<
					{ count: string }[]
				>`SELECT count(*)::text AS count FROM runner_boxes`;
				expect(emptied[0]?.count).toBe("0");
			} finally {
				await sql.end();
			}

			// An empty MIGRATION_FILES is the operator-reachable form of "no files to
			// process". Before the fix this returned early, skipped the seed, printed a
			// benign message and exited 0 -- leaving allocation with an inventory it
			// could never see.
			const result = await runMigrationCommand(databaseUrl, { MIGRATION_FILES: "," });
			expect(result.code).toBe(0);
			expect(result.output).toContain("No migration files to process.");
			expect(result.output).toContain("seeded: runner_boxes");

			const verify = new SQL(databaseUrl);
			try {
				const rows = await verify<
					{ count: string }[]
				>`SELECT count(*)::text AS count FROM runner_boxes`;
				expect(Number(rows[0]?.count ?? "0")).toBeGreaterThan(0);
			} finally {
				await verify.end();
			}
		});
	});

	test("preserves historical bump values when readiness columns are added", async () => {
		await withEmptyTestDatabase(async (databaseUrl) => {
			const preReadiness = await runMigrationCommand(databaseUrl, {
				MIGRATION_FILES: PRE_READINESS_MIGRATION_NAMES.join(","),
			});
			expect(preReadiness.code).toBe(0);
			expect(preReadiness.output).toContain(`applied: ${BUILD_BUMP_INVOKING_MIGRATION_NAME}`);

			const sql = new SQL(databaseUrl);
			type HistoricalBump = {
				candidate_id: number;
				app_dir: string;
				status: string;
				pr: number | null;
				url: string | null;
				reason: string | null;
				attempts: number;
				started_at: Date | null;
				created_at: Date;
				finished_at: Date | null;
			};
			type ReadinessBump = HistoricalBump & {
				ready_seconds: number | null;
				ready_restart_count: number | null;
				ready_sample_count: number | null;
			};

			try {
				await sql`
					INSERT INTO build_bump_candidates
						(repository, tag, sha, status, build_job_name, build_started_at, build_finished_at)
					VALUES (
						${"acme/web-bb-landing"},
						${"v9.9.9"},
						${"e".repeat(40)},
						${"built"},
						${"build-web-bb-landing-620"},
						${"2026-01-02T03:04:05Z"}::timestamptz,
						${"2026-01-02T03:15:05Z"}::timestamptz
					)
				`;
				const candidates = await sql<{ id: number }[]>`
					SELECT id FROM build_bump_candidates
					WHERE repository = ${"acme/web-bb-landing"} AND tag = ${"v9.9.9"}
				`;
				const candidateId = candidates[0]?.id;
				if (candidateId === undefined) throw new Error("candidate seed insert returned no row");

				await sql`
					INSERT INTO build_bump_bumps
						(candidate_id, app_dir, status, pr, url, attempts, started_at, created_at, finished_at)
					VALUES (
						${candidateId},
						${"landing"},
						${"opened"},
						${624},
						${"https://forge.example.internal/rodaddy/k3s-deploy/pulls/624"},
						${1},
						${"2026-01-02T03:20:05Z"}::timestamptz,
						${"2026-01-02T03:19:05Z"}::timestamptz,
						${"2026-01-02T03:25:05Z"}::timestamptz
					)
				`;

				const beforeRows = await sql<HistoricalBump[]>`
					SELECT candidate_id, app_dir, status, pr, url, reason, attempts,
						started_at, created_at, finished_at
					FROM build_bump_bumps
					WHERE candidate_id = ${candidateId}
				`;
				expect(beforeRows).toHaveLength(1);
				const before = beforeRows[0];
				if (!before) throw new Error("bump seed insert returned no row");

				const apply = await runMigrationCommand(databaseUrl, {
					MIGRATION_FILES: BUILD_BUMP_READINESS_MIGRATION_NAME,
				});
				expect(apply.code).toBe(0);
				expect(apply.output).toContain(`applied: ${BUILD_BUMP_READINESS_MIGRATION_NAME}`);

				// sf#645: the images migration backfills the historical candidate as the
				// legacy single image, and leaves its build columns alone.
				const images = await runMigrationCommand(databaseUrl, {
					MIGRATION_FILES: BUILD_BUMP_IMAGES_MIGRATION_NAME,
				});
				expect(images.code).toBe(0);
				expect(images.output).toContain(`applied: ${BUILD_BUMP_IMAGES_MIGRATION_NAME}`);
				const backfilled = await sql<
					{ image: string; dockerfile: string; build_job_name: string | null }[]
				>`
					SELECT image, dockerfile, build_job_name FROM build_bump_candidates
					WHERE id = ${candidateId}
				`;
				expect(backfilled).toEqual([
					{
						image: "web-bb-landing",
						dockerfile: "Dockerfile",
						build_job_name: "build-web-bb-landing-620",
					},
				]);

				const afterApply = await sql<ReadinessBump[]>`
					SELECT candidate_id, app_dir, status, pr, url, reason, attempts,
						started_at, created_at, finished_at,
						ready_seconds, ready_restart_count, ready_sample_count
					FROM build_bump_bumps
					WHERE candidate_id = ${candidateId}
				`;
				expect(afterApply).toHaveLength(1);
				expect({
					candidate_id: afterApply[0]?.candidate_id,
					app_dir: afterApply[0]?.app_dir,
					status: afterApply[0]?.status,
					pr: afterApply[0]?.pr,
					url: afterApply[0]?.url,
					reason: afterApply[0]?.reason,
					attempts: afterApply[0]?.attempts,
					started_at: afterApply[0]?.started_at,
					created_at: afterApply[0]?.created_at,
					finished_at: afterApply[0]?.finished_at,
				}).toEqual(before);
				expect(afterApply[0]?.ready_seconds).toBeNull();
				expect(afterApply[0]?.ready_restart_count).toBeNull();
				expect(afterApply[0]?.ready_sample_count).toBeNull();

				const rerun = await runMigrationCommand(databaseUrl, {
					MIGRATION_FILES: BUILD_BUMP_READINESS_MIGRATION_NAME,
				});
				expect(rerun.code).toBe(0);
				expect(rerun.output).toContain(
					`SKIP (already applied): ${BUILD_BUMP_READINESS_MIGRATION_NAME}`,
				);

				const afterRerun = await sql<ReadinessBump[]>`
					SELECT candidate_id, app_dir, status, pr, url, reason, attempts,
						started_at, created_at, finished_at,
						ready_seconds, ready_restart_count, ready_sample_count
					FROM build_bump_bumps
					WHERE candidate_id = ${candidateId}
				`;
				expect(afterRerun).toEqual(afterApply);
			} finally {
				await sql.end();
			}
		});
	});

	test("fails closed when an applied migration checksum drifts", async () => {
		await withEmptyTestDatabase(async (databaseUrl) => {
			await runMigrations(databaseUrl);

			const sql = new SQL(databaseUrl);
			try {
				await sql`
					UPDATE schema_migrations
					SET checksum = ${"0".repeat(64)}
					WHERE version = ${BASELINE_NAME}
				`;
			} finally {
				await sql.end();
			}

			const result = await runMigrationCommand(databaseUrl);
			expect(result.code).not.toBe(0);
			expect(result.output).toContain(`Migration checksum drift: ${BASELINE_NAME}`);
			expect(result.output.length).toBeLessThan(2_000);
			expect(result.output).not.toContain("SKIP (already applied)");
		});
	});
});

/**
 * sf#821: the SQL production replays and the schema.ts drizzle-kit reads must
 * describe the same database, and drizzle/meta must know every migration file,
 * or the next `db:generate` re-emits already-shipped DDL.
 */
async function describeSchema(sql: SQL): Promise<unknown> {
	const columns = await sql`
		SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
		FROM information_schema.columns
		WHERE table_schema = 'public'
		ORDER BY table_name, column_name
	`;
	const constraints = await sql`
		SELECT rel.relname AS table_name, con.conname, con.contype,
			pg_get_constraintdef(con.oid) AS def
		FROM pg_constraint con
		JOIN pg_class rel ON rel.oid = con.conrelid
		JOIN pg_namespace ns ON ns.oid = rel.relnamespace
		WHERE ns.nspname = 'public'
		ORDER BY rel.relname, con.conname
	`;
	const indexes = await sql`
		SELECT tablename, indexname, indexdef FROM pg_indexes
		WHERE schemaname = 'public'
		ORDER BY tablename, indexname
	`;
	return { columns: [...columns], constraints: [...constraints], indexes: [...indexes] };
}

describe("drizzle meta parity", () => {
	test("the journal lists every migration file and the latest has a snapshot", () => {
		const journal = JSON.parse(
			readFileSync(join(REPO_ROOT, "drizzle", "meta", "_journal.json"), "utf8"),
		);
		const tags = readdirSync(join(REPO_ROOT, "drizzle"))
			.filter((name) => name.endsWith(".sql"))
			.sort()
			.map((name) => name.replace(/\.sql$/, ""));
		expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toEqual(tags);
		const latest = String(tags.length - 1).padStart(4, "0");
		expect(readdirSync(join(REPO_ROOT, "drizzle", "meta"))).toContain(`${latest}_snapshot.json`);
	});

	test("migrations 0000-latest produce the schema drizzle-kit pushes from schema.ts", async () => {
		const pushed = await withTestDb(async (db) => describeSchema(db.$client));
		const migrated = await withEmptyTestDatabase(async (databaseUrl) => {
			await runMigrations(databaseUrl);
			const sql = new SQL(databaseUrl);
			try {
				return await describeSchema(sql);
			} finally {
				await sql.end();
			}
		});
		// No pinned drift: schema.ts names the 0016 FK and declares the
		// index NULLS LAST as 0024 rebuilds it, so the two must match exactly.
		expect(migrated).toEqual(pushed);
	});
});
