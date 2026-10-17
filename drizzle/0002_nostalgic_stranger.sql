CREATE TYPE "public"."funding_status" AS ENUM('PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'AMBIGUOUS');--> statement-breakpoint
CREATE TABLE "campaign_fundings" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"campaign_key" text NOT NULL,
	"policy_hash" text NOT NULL,
	"chain_id" integer NOT NULL,
	"vault_address" text NOT NULL,
	"usdc_address" text NOT NULL,
	"owner_address" text NOT NULL,
	"expected_amount_micro_usdc" bigint NOT NULL,
	"status" "funding_status" DEFAULT 'PREPARED' NOT NULL,
	"create_tx_hash" text,
	"approve_tx_hash" text,
	"funding_tx_hash" text,
	"block_number" integer,
	"observed_amount_micro_usdc" bigint,
	"failure_code" text,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_fundings" ADD CONSTRAINT "campaign_fundings_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_fundings" ADD CONSTRAINT "campaign_fundings_policy_version_id_campaign_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."campaign_policy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_fundings_campaign_version_unique" ON "campaign_fundings" USING btree ("campaign_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_fundings_funding_tx_unique" ON "campaign_fundings" USING btree ("funding_tx_hash");--> statement-breakpoint
CREATE INDEX "campaign_fundings_campaign_idx" ON "campaign_fundings" USING btree ("campaign_id");