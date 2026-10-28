-- sf#620: record the observed readiness of the deploy each bump produced, so the
-- auto-rollback window is computed from what the app actually does rather than
-- from a hand-set number.
--
-- All three are NULLABLE WITH NO DEFAULT, deliberately. NULL means "never
-- measured"; 0 means "measured and instant". A DEFAULT 0 would make every
-- existing row claim an instant deploy it never had, and the rolling average
-- would read zero for the whole fleet.
ALTER TABLE "build_bump_bumps" ADD COLUMN IF NOT EXISTS "ready_seconds" integer;
ALTER TABLE "build_bump_bumps" ADD COLUMN IF NOT EXISTS "ready_restart_count" integer;
ALTER TABLE "build_bump_bumps" ADD COLUMN IF NOT EXISTS "ready_sample_count" integer;
