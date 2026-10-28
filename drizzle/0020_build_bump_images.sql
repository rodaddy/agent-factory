-- sf#645: one repository, several images. A build-bump candidate now names the
-- IMAGE it builds and the Dockerfile it builds from, so one tag on a repository
-- declaring several images (rtech-mcps: four Containerfiles, four images) is
-- one row per image, and the dedupe key carries the image.
--
-- Backfill: every row that exists is the legacy single-image shape, so its
-- image is the repository's short name and its dockerfile the root one. The
-- column is added nullable, filled, then made NOT NULL, so the migration is
-- idempotent on a re-run (IF NOT EXISTS / WHERE image IS NULL / DROP IF EXISTS).
--
-- Plain SQL with no `$$` dollar quoting — this file reaches Postgres through
-- Bun.sql `unsafe()` in scripts/migrate.ts, which reads `$$` as a parameter
-- marker (sf#457, ledger L-061).
ALTER TABLE "build_bump_candidates" ADD COLUMN IF NOT EXISTS "image" text;
ALTER TABLE "build_bump_candidates" ADD COLUMN IF NOT EXISTS "dockerfile" text DEFAULT 'Dockerfile' NOT NULL;
UPDATE "build_bump_candidates" SET "image" = split_part("repository", '/', 2) WHERE "image" IS NULL;
ALTER TABLE "build_bump_candidates" ALTER COLUMN "image" SET NOT NULL;
DROP INDEX IF EXISTS "build_bump_candidates_repository_tag_sha_key";
CREATE UNIQUE INDEX IF NOT EXISTS "build_bump_candidates_repository_tag_sha_image_key" ON "build_bump_candidates" USING btree ("repository","tag","sha","image");
