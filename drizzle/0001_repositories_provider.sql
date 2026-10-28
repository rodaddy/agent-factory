-- Dual-forge support (#54): give every managed repository a durable forge
-- provider and qualify its uniqueness by (provider, full_name).
--
-- This is an ADDITIVE, backfill-safe migration:
--   1. Add `provider` with a `github` default so every EXISTING row (all of
--      which are GitHub repositories) is backfilled to `github` in place, with
--      no NULL window and no data rewrite beyond the default fill.
--   2. Replace the bare `repositories_full_name_key` unique index with the
--      provider-qualified `repositories_provider_full_name_key`, so the SAME
--      `owner/repo` may exist once per forge. Dropping then creating the index is
--      safe because the backfilled `(github, full_name)` pairs are exactly as
--      unique as the old `full_name` values were.
--
-- No table is added or renamed; only the `repositories` table gains a column and
-- swaps one unique index.
ALTER TABLE "repositories" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "repositories_full_name_key";--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_full_name_key" ON "repositories" USING btree ("provider","full_name");
