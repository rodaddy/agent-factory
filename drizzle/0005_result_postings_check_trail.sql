-- #157: persist the verified per-check trail alongside the accepted result so the
-- proposal pass can display what the ingest gate actually judged, rather than
-- re-reading the runner-writable share at proposal time.
ALTER TABLE "result_postings" ADD COLUMN "check_trail" text;
