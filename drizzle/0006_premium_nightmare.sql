CREATE TYPE "public"."pricing_decision" AS ENUM('KEEP', 'REPRICE', 'PAUSE');--> statement-breakpoint
CREATE TABLE "market_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"market_version" integer NOT NULL,
	"decision" "pricing_decision" NOT NULL,
	"pace_state" text NOT NULL,
	"reason_codes" text[] DEFAULT '{}' NOT NULL,
	"inputs_json" jsonb NOT NULL,
	"inputs_hash" text NOT NULL,
	"old_bounty_micro_usdc" bigint,
	"new_bounty_micro_usdc" bigint,
	"auto_executed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_decisions" ADD CONSTRAINT "market_decisions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_decisions_campaign_hash_unique" ON "market_decisions" USING btree ("campaign_id","inputs_hash");--> statement-breakpoint
CREATE INDEX "market_decisions_campaign_idx" ON "market_decisions" USING btree ("campaign_id");