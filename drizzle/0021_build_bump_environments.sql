-- sf#719: environments. A repository declares an ORDERED list of environments;
-- the first follows the version-tag stream and every later one follows a MOVABLE
-- tag (the marker). Two additions serve that model.
--
-- 1. `build_bump_candidates.tag_created_at` — the forge's `commit.created` for
--    the tag. Recency is a property of the COMMIT DATE, never of the row id:
--    row id runs in opposite directions for a batch-enrolled repository and a
--    grown one, so ordering by id was never a recency order. NULLABLE, because
--    every row that predates this column has no observation and a forge entry
--    may omit or mangle the field — NULL is "unknown", not "old".
--
-- 2. `build_bump_markers` — one row per movable tag some environment promotes
--    by. REBUILT by intake every pass from the same tag listing the candidates
--    come from: markers present are upserted, markers no longer present are
--    deleted. The table is therefore a projection of the forge, never history.
--
-- Plain SQL with no `$$` dollar quoting — this file reaches Postgres through
-- Bun.sql `unsafe()` in scripts/migrate.ts, which reads `$$` as a parameter
-- marker (sf#457, ledger L-061). Every statement is IF NOT EXISTS, so a re-run
-- is a no-op.
ALTER TABLE "build_bump_candidates" ADD COLUMN IF NOT EXISTS "tag_created_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "build_bump_candidates_status_tag_created_idx" ON "build_bump_candidates" USING btree ("status","tag_created_at" DESC,"id");
CREATE TABLE IF NOT EXISTS "build_bump_markers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"repository" text NOT NULL,
	"marker" text NOT NULL,
	"sha" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "build_bump_markers_repository_marker_key" ON "build_bump_markers" USING btree ("repository","marker");
