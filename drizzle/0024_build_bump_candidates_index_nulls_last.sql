-- sf#850: rebuild `build_bump_candidates_status_tag_created_idx` as
-- `tag_created_at DESC NULLS LAST`.
--
-- 0021 created it `DESC`, which Postgres stores as DESC NULLS FIRST. Both
-- readers (src/reconcile/build-bump-build.ts, build-bump-environments.ts) order
-- `tag_created_at DESC NULLS LAST` because NULL means "unknown", never "new"
-- (sf#719), so the index could not serve the ORDER BY it exists for. schema.ts
-- declares NULLS LAST; this makes the migrated database match it.
--
-- Plain SQL with no `$$` dollar quoting — this file reaches Postgres through
-- Bun.sql `unsafe()` in scripts/migrate.ts (sf#457, ledger L-061). Both
-- statements are guarded, so a re-run is a no-op rebuild.
DROP INDEX IF EXISTS "build_bump_candidates_status_tag_created_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "build_bump_candidates_status_tag_created_idx" ON "build_bump_candidates" USING btree ("status","tag_created_at" DESC NULLS LAST,"id");
