-- sf#465 R4: runner artifacts delivered over the NATS `FACTORY_JOBS` stream.
--
-- A runner publishes each artifact it produced to
-- `factory.jobs.<job_runner_id>.result` (bounded to 1 MiB), and the watcher's
-- consumer drains that stream into this table. The reconciler reads this table
-- AHEAD of the collab share, so a job whose artifacts arrived over the bus
-- needs no share mount, while a job whose runner still writes to the share
-- reconciles exactly as before.
--
-- Rows are per (job, host, artifact), never per job. Results are per (job,
-- host) — a key on "job_runner_id" alone would read one host's artifact for
-- another host's attempt — and per artifact because one host writes several
-- (the wrapper-owned result.json, a lane's own named artifact, the wrapper
-- verdict/envelope, the optional event stream).
--
-- The unique index on ("job_runner_id","hostname","artifact") IS the re-publish
-- guard: a redelivered NATS message inserts `ON CONFLICT DO NOTHING`, so the
-- second copy of an artifact is dropped rather than duplicating a host in the
-- reconciler's view.
--
-- "body" is UNTRUSTED runner output stored verbatim. Nothing here decides
-- anything: the existing ingest pipeline (byte cap, strict schema validation,
-- named-artifact selection) is unchanged and remains the only judge of it.
--
-- Additive: no existing table or column is touched.
CREATE TABLE "bus_results" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bus_results_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_runner_id" text NOT NULL,
	"hostname" text NOT NULL,
	"artifact" text NOT NULL,
	"body" text NOT NULL,
	"msg_id" text NOT NULL,
	"subject" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bus_results_job_host_artifact_key" ON "bus_results" USING btree ("job_runner_id","hostname","artifact");
