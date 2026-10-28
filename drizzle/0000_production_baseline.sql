CREATE TABLE "audit_schedule_slots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_schedule_slots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repository_id" integer NOT NULL,
	"audit_name" text NOT NULL,
	"slot_key" text NOT NULL,
	"job_id" integer,
	"missed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repository_id" integer NOT NULL,
	"kind" text NOT NULL,
	"number" integer NOT NULL,
	"head_sha" text,
	"state" text NOT NULL,
	"title" text,
	"github_updated_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_postings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_postings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_id" integer NOT NULL,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"external_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_postings_job_kind_target_key" UNIQUE("job_id","kind","target")
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_id" integer NOT NULL,
	"runner_job_id" text,
	"runner_vmid" integer,
	"status" text DEFAULT 'submitted' NOT NULL,
	"failure_summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repository_id" integer NOT NULL,
	"item_id" integer,
	"sha" text DEFAULT '' NOT NULL,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_repo_item_sha_type_key" UNIQUE("repository_id","item_id","sha","job_type")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_cursors" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reconciliation_cursors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repository_id" integer NOT NULL,
	"resource" text NOT NULL,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repositories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"full_name" text NOT NULL,
	"checks" text DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_postings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "result_postings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_id" integer NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_ref" text,
	"output_path" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_postings_job_target_key" UNIQUE("job_id","target")
);
--> statement-breakpoint
-- schema_migrations is runner-owned: scripts/migrate.ts creates it before
-- loading this baseline. Its full shape remains in meta/0000_snapshot.json so
-- future Drizzle generations still model the real schema.
CREATE TABLE "shadow_publications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shadow_publications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"posting_id" integer NOT NULL,
	"job_id" integer NOT NULL,
	"kind" text NOT NULL,
	"action" text,
	"repository" text NOT NULL,
	"item_number" integer,
	"sha" text,
	"would_action" text NOT NULL,
	"target" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"conclusion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shadow_publications_posting_action_key" UNIQUE("posting_id","would_action")
);
--> statement-breakpoint
ALTER TABLE "audit_schedule_slots" ADD CONSTRAINT "audit_schedule_slots_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_slots" ADD CONSTRAINT "audit_schedule_slots_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_items" ADD CONSTRAINT "github_items_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_postings" ADD CONSTRAINT "github_postings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_item_id_github_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."github_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_cursors" ADD CONSTRAINT "reconciliation_cursors_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_postings" ADD CONSTRAINT "result_postings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_publications" ADD CONSTRAINT "shadow_publications_posting_id_github_postings_id_fk" FOREIGN KEY ("posting_id") REFERENCES "public"."github_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_publications" ADD CONSTRAINT "shadow_publications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_schedule_slots_repo_audit_slot_key" ON "audit_schedule_slots" USING btree ("repository_id","audit_name","slot_key");--> statement-breakpoint
CREATE INDEX "audit_schedule_slots_repo_audit_idx" ON "audit_schedule_slots" USING btree ("repository_id","audit_name");--> statement-breakpoint
CREATE UNIQUE INDEX "github_items_repo_kind_number_key" ON "github_items" USING btree ("repository_id","kind","number");--> statement-breakpoint
CREATE INDEX "github_items_repo_state_idx" ON "github_items" USING btree ("repository_id","state");--> statement-breakpoint
CREATE INDEX "github_postings_status_idx" ON "github_postings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_runner_job_id_key" ON "job_attempts" USING btree ("runner_job_id") WHERE "job_attempts"."runner_job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_attempts_job_idx" ON "job_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_cursors_repo_resource_key" ON "reconciliation_cursors" USING btree ("repository_id","resource");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_full_name_key" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "result_postings_job_idx" ON "result_postings" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "shadow_publications_job_id_id_idx" ON "shadow_publications" USING btree ("job_id","id");
