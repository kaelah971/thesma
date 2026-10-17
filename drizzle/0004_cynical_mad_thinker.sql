CREATE TYPE "public"."checkout_status" AS ENUM('PREPARED', 'SUBMITTED', 'CONFIRMED', 'REJECTED', 'AMBIGUOUS');--> statement-breakpoint
CREATE TYPE "public"."outcome_status" AS ENUM('PENDING', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "attribution_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"referral_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"partner_terms_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkout_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"partner_terms_id" text NOT NULL,
	"attribution_session_id" text,
	"payer_address" text NOT NULL,
	"merchant_address" text NOT NULL,
	"amount_micro_usdc" bigint NOT NULL,
	"chain_id" integer NOT NULL,
	"usdc_address" text NOT NULL,
	"status" "checkout_status" DEFAULT 'PREPARED' NOT NULL,
	"tx_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"partner_terms_id" text NOT NULL,
	"checkout_intent_id" text NOT NULL,
	"customer_key_hash" text NOT NULL,
	"purchase_tx" text NOT NULL,
	"purchase_amount_micro_usdc" bigint NOT NULL,
	"status" "outcome_status" DEFAULT 'PENDING' NOT NULL,
	"proof_hash" text,
	"block_number" integer,
	"occurred_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"hold_until" timestamp with time zone,
	"rejection_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribution_sessions" ADD CONSTRAINT "attribution_sessions_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_sessions" ADD CONSTRAINT "attribution_sessions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_sessions" ADD CONSTRAINT "attribution_sessions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_sessions" ADD CONSTRAINT "attribution_sessions_partner_terms_id_partner_terms_id_fk" FOREIGN KEY ("partner_terms_id") REFERENCES "public"."partner_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_policy_version_id_campaign_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."campaign_policy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_partner_terms_id_partner_terms_id_fk" FOREIGN KEY ("partner_terms_id") REFERENCES "public"."partner_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_attribution_session_id_attribution_sessions_id_fk" FOREIGN KEY ("attribution_session_id") REFERENCES "public"."attribution_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_partner_terms_id_partner_terms_id_fk" FOREIGN KEY ("partner_terms_id") REFERENCES "public"."partner_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_checkout_intent_id_checkout_intents_id_fk" FOREIGN KEY ("checkout_intent_id") REFERENCES "public"."checkout_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attribution_sessions_campaign_idx" ON "attribution_sessions" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_intents_order_unique" ON "checkout_intents" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_intents_tx_unique" ON "checkout_intents" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "checkout_intents_campaign_idx" ON "checkout_intents" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_intent_unique" ON "outcomes" USING btree ("checkout_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_purchase_tx_unique" ON "outcomes" USING btree ("purchase_tx");--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_campaign_customer_unique" ON "outcomes" USING btree ("campaign_id","customer_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_proof_unique" ON "outcomes" USING btree ("proof_hash");--> statement-breakpoint
CREATE INDEX "outcomes_campaign_idx" ON "outcomes" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "outcomes_partner_idx" ON "outcomes" USING btree ("partner_id");