-- sf#542: build-bump tag intake — the candidate table.
--
-- A repository enrolled in the build-bump lane (a `build_bump` block in its
-- config entry, sf#541) has its tags re-read FROM THE FORGE each reconcile
-- cycle; every tag matching the block's `tag_pattern` is recorded here.
--
-- `sha` is the COMMIT sha the tag resolves to, never the tag object's own id:
-- for an annotated tag the two differ, and only the commit sha is something a
-- later lane can check out or build.
--
-- The unique index on (repository, tag, sha) IS the dedupe mechanism. Intake
-- re-reads the same page every cycle and inserts ON CONFLICT DO NOTHING, so a
-- tag already recorded produces no second row. The sha is part of the key
-- deliberately: a tag force-moved to a different commit is a NEW candidate.
--
-- Additive: no existing table or column is touched.
--
-- Plain SQL with no `$$` dollar quoting — this file reaches Postgres through
-- Bun.sql `unsafe()` in scripts/migrate.ts, which reads `$$` as a parameter
-- marker (sf#457, ledger L-061).
CREATE TABLE IF NOT EXISTS "build_bump_candidates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "build_bump_candidates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repository" text NOT NULL,
	"tag" text NOT NULL,
	"sha" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "build_bump_candidates_repository_tag_sha_key" ON "build_bump_candidates" USING btree ("repository","tag","sha");
