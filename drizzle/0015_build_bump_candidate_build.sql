-- sf#543: build-bump Kaniko build — the per-candidate build columns.
--
-- The candidate table (0014) recorded WHICH tags exist. These four columns
-- record what the build pass did about one: the Job it created or adopted, when
-- it started, when a terminal condition was observed, and why a failure failed.
--
-- Status vocabulary on build_bump_candidates.status:
--   pending -> building -> built | failed
-- `failed` is TERMINAL. The build pass never retries or re-creates a failed
-- candidate: a Kaniko failure is deterministic (backoffLimit is 0), so a retry
-- would burn the same build again and hide the failure behind a churn loop.
--
-- All four are NULLABLE and that is the whole compatibility story: every row
-- inserted by 0014's intake predates the build pass and leaves them NULL, which
-- is exactly what `pending` means.
--
-- Additive: no existing column is altered or dropped.
--
-- Plain SQL with no `$$` dollar quoting — this file reaches Postgres through
-- Bun.sql `unsafe()` in scripts/migrate.ts, which reads `$$` as a parameter
-- marker (sf#457, ledger L-061).
ALTER TABLE "build_bump_candidates" ADD COLUMN IF NOT EXISTS "build_job_name" text;
ALTER TABLE "build_bump_candidates" ADD COLUMN IF NOT EXISTS "build_started_at" timestamp with time zone;
ALTER TABLE "build_bump_candidates" ADD COLUMN IF NOT EXISTS "build_finished_at" timestamp with time zone;
ALTER TABLE "build_bump_candidates" ADD COLUMN IF NOT EXISTS "build_reason" text;
