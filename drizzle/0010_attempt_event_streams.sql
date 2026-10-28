-- sf#183: the DURABLE home of one attempt's raw agent event stream.
--
-- The ticket asked for a "durable watcher-owned artifact path"; there is no such
-- path. The collab share's per-job directories carry NO retention guarantee
-- (rtech-infra, 2026-08-17), so a watcher-owned copy on that same share is the
-- same no-guarantee class plus a second unmanaged store. Postgres is the one
-- store this process already treats as durable state and already backs up. The
-- files stay the raw record while they live; this table is the copy that
-- outlives them.
--
-- `attempt_id` is the PRIMARY KEY, not a plain index, and that is the
-- first-writer-wins mechanism: results are per (job, host) and a restart
-- re-reads the same DONE, so the write is `ON CONFLICT DO NOTHING` and the FIRST
-- stream read becomes the durable record. A nullable unique index would not do —
-- PostgreSQL does not deduplicate NULLs in one.
--
-- ON DELETE NO ACTION, deliberately, NOT cascade: the whole point of the row is
-- to survive, and a cascade would hand it the lifetime the share already fails
-- to guarantee. The single attempt-row delete in this codebase
-- (`retireAllocationIntent`) is scoped to an `allocating` intent row whose verb
-- refused before any runner ran, and such an attempt never has a stream row.
--
-- Additive: no existing table or column is touched, so every pre-#183 row and
-- code path behaves exactly as before. Observational only — nothing reads this
-- to make a dispatch, verification, or publication decision.
CREATE TABLE "attempt_event_streams" (
	"attempt_id" integer PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_event_streams" ADD CONSTRAINT "attempt_event_streams_attempt_id_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE no action ON UPDATE no action;
