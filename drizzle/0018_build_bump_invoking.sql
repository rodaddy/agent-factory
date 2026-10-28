-- sf#553: make a build-bump invocation claim visible across watcher processes.
-- A stale invoking row is returned to pending by the reconciliation sweep, or
-- failed when its retry budget has already been spent.
ALTER TABLE "build_bump_bumps" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
