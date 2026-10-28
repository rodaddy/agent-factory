ALTER TABLE "jobs" ADD COLUMN "kboard_task_id" text;--> statement-breakpoint
CREATE INDEX "jobs_kboard_task_id_idx" ON "jobs" USING btree ("kboard_task_id") WHERE "jobs"."kboard_task_id" IS NOT NULL;