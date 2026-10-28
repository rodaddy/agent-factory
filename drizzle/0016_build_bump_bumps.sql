-- sf#544: build-bump bump call — one row per (candidate, app_dir) invocation.
--
-- A CHILD TABLE, not columns on build_bump_candidates: an enrolled repository
-- declares up to 10 app_dirs (sf#541), the bump script is invoked once per
-- entry, and each invocation succeeds or refuses on its own. Columns on the
-- candidate row would keep only the last app's answer.
--
-- Status vocabulary on build_bump_bumps.status:
--   pending -> opened | refused | failed
-- `refused` and `failed` are both TERMINAL for the pair. A refusal is
-- deterministic in its inputs, so a retry burns the same work; `failed` is the
-- exhausted-harness end state after the caller's single retry.
--
-- `reason` holds FIXED strings only — a refusal token or one of the lane's own
-- harness strings. Script output text never lands here: it is untrusted and can
-- quote a request whose environment carries the forge token.
--
-- The unique index on (candidate_id, app_dir) is what makes terminality
-- enforceable: the pass re-reads Complete candidates every cycle, so the insert
-- is ON CONFLICT DO NOTHING and an already-judged pair produces no second row.
--
-- Additive: no existing table or column is altered or dropped.
--
-- Plain SQL with no `$$` dollar quoting — this file reaches Postgres through
-- Bun.sql `unsafe()` in scripts/migrate.ts, which reads `$$` as a parameter
-- marker (sf#457, ledger L-061).
CREATE TABLE IF NOT EXISTS "build_bump_bumps" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
	"candidate_id" integer NOT NULL REFERENCES "build_bump_candidates"("id"),
	"app_dir" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pr" integer,
	"url" text,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "build_bump_bumps_candidate_app_key" ON "build_bump_bumps" ("candidate_id","app_dir");
