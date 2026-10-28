-- sf#457: retire the factory `forge` band 9101-9150.
--
-- Ruling (Rico, 2026-08-28): nothing pins VMID 9101, CI images live in the 9900
-- range, and the old runner container is already destroyed. The band is a pin with no fleet behind
-- it, so it is RETIRED rather than moved.
--
-- `seedRunnerBoxes` (src/db/repos.ts) upserts from `src/runner/bands.ts` and
-- deliberately never deletes, so removing the band from the inventory source
-- leaves the previously-seeded rows in place, still flagged allocatable. This
-- migration is the only thing that removes them.
--
-- Only unheld rows are deleted: a box some job is holding is the reconciler's
-- to release, never a migration's to drop from under it.
DELETE FROM "runner_boxes" WHERE "band" = 'forge' AND "held_by_job_id" IS NULL;
-- A held forge row must not survive a migration that is then recorded as
-- applied, because scripts/migrate.ts skips an applied file forever (review
-- F5 on PR #475). Plain SQL rather than a DO block: Bun.sql's unsafe() reads
-- `$$` as a parameter marker. Division by zero raises when any forge row is
-- left, the transaction rolls back, and the file stays unapplied until the
-- holder is released and a rerun deletes every row.
SELECT 1 / (CASE WHEN (SELECT count(*) FROM "runner_boxes" WHERE "band" = 'forge') = 0 THEN 1 ELSE 0 END)
  AS forge_band_fully_retired;
