CREATE TABLE "runner_boxes" (
	"vmid" integer PRIMARY KEY NOT NULL,
	"band" text NOT NULL,
	"mac" text NOT NULL,
	"ip" text,
	"allocatable" boolean DEFAULT false NOT NULL,
	"held_by_job_id" text,
	"held_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runner_boxes_ip_key" ON "runner_boxes" USING btree ("ip");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_boxes_mac_key" ON "runner_boxes" USING btree ("mac");--> statement-breakpoint
CREATE INDEX "runner_boxes_band_allocatable_idx" ON "runner_boxes" USING btree ("band","allocatable");