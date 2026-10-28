CREATE TABLE "forge_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "forge_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo" text NOT NULL,
	"workflow" text NOT NULL,
	"run_id" bigint,
	"target_sha" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"state" text DEFAULT 'dispatched' NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "forge_runs_repo_run_id_key" ON "forge_runs" USING btree ("repo","run_id") WHERE "forge_runs"."run_id" IS NOT NULL;