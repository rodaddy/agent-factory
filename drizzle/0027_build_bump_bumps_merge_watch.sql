-- sf#1076 (sf#417 rows 0c/0d): merge-watch state on `build_bump_bumps`.
--
-- The factory opens a bump PR on the deploy repository and records it as
-- `opened`, then never looks at it again. The merge watch needs durable
-- per-row state: after a bump PR merges, the factory hard-refreshes the Argo
-- app once, and while a recent bump PR is still open it re-runs a pass.
--
--   merged_at         -- the forge's merge time of the bump PR, set once when
--                        the watch sees `merged: true`.
--   pr_closed_at      -- set when the PR is observed closed WITHOUT merging;
--                        stops the watch for that row.
--   argo_refreshed_at -- when the factory's Argo hard refresh for this
--                        app_dir answered 2xx after the merge.
--
-- All nullable with no default: NULL means "not observed", the honest value
-- for every pre-existing row.
--
-- Plain SQL with no `$$` dollar quoting — this file reaches Postgres through
-- Bun.sql `unsafe()` in scripts/migrate.ts, which reads `$$` as a parameter
-- marker (sf#457, ledger L-061). Every statement is IF NOT EXISTS, so a re-run
-- is a no-op.
ALTER TABLE "build_bump_bumps" ADD COLUMN IF NOT EXISTS "merged_at" timestamp with time zone;
ALTER TABLE "build_bump_bumps" ADD COLUMN IF NOT EXISTS "pr_closed_at" timestamp with time zone;
ALTER TABLE "build_bump_bumps" ADD COLUMN IF NOT EXISTS "argo_refreshed_at" timestamp with time zone;
