-- #184: record the Langfuse trace id an attempt's run was emitted under, so a
-- db row reaches its trace in ONE query instead of re-deriving the id format.
-- Written by the ingest observer from `traceIdFor` (the emitter's own function),
-- in the same UPDATE that stamps `observed_model`, first-writer-wins.
-- Host-qualified `attempt-N-<host>` because results — and therefore traces —
-- are per (job, host). IDS ONLY: the Langfuse base URL is LAN-internal
-- environment, resolved at render time, never stored in a column. Nullable —
-- every pre-#184 row predates the column and an unobserved attempt has no
-- trace. Observational only.
ALTER TABLE "job_attempts" ADD COLUMN "trace_id" text;
