-- sf#424: Forgejo webhook delivery replay key.
--
-- Forgejo retries a delivery it could not confirm, and the retry carries the
-- SAME `X-Forgejo-Delivery` id. Without a durable key the second copy is
-- indistinguishable from a second event, so the receiver would wake
-- reconciliation twice for one push.
--
-- The unique index on ("provider","delivery_id") IS the dedupe mechanism: the
-- receiver inserts `ON CONFLICT DO NOTHING RETURNING id`, and zero returned rows
-- means the delivery was already stored. Duplicates are answered 200 and
-- dropped — no wake, no error.
--
-- `provider` is carried explicitly because delivery ids are unique only WITHIN a
-- forge; a bare `delivery_id` key would collide across forge families.
--
-- Additive: no existing table or column is touched, so every pre-sf#424 row and
-- code path behaves exactly as before. Observational only — nothing reads this
-- table to make a dispatch, verification, or publication decision.
CREATE TABLE "forge_deliveries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "forge_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"repository" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "forge_deliveries_provider_delivery_id_key" ON "forge_deliveries" USING btree ("provider","delivery_id");
