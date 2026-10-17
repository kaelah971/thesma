CREATE TYPE "public"."payout_state" AS ENUM('PREPARED', 'SUBMITTED', 'SETTLED', 'FAILED', 'AMBIGUOUS');--> statement-breakpoint
CREATE TYPE "public"."reservation_state" AS ENUM('RESERVED', 'SUBMITTED', 'SETTLED', 'FAILED', 'AMBIGUOUS', 'RELEASED');--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_id" text NOT NULL,
	"outcome_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"recipient" text NOT NULL,
	"amount_micro_usdc" bigint NOT NULL,
	"proof_hash" text NOT NULL,
	"verifier_signature" text,
	"tx_hash" text,
	"state" "payout_state" DEFAULT 'PREPARED' NOT NULL,
	"block_number" integer,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"outcome_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"partner_terms_id" text NOT NULL,
	"amount_micro_usdc" bigint NOT NULL,
	"policy_version_id" text NOT NULL,
	"state" "reservation_state" DEFAULT 'RESERVED' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_reservation_id_spend_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."spend_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_partner_terms_id_partner_terms_id_fk" FOREIGN KEY ("partner_terms_id") REFERENCES "public"."partner_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_reservations" ADD CONSTRAINT "spend_reservations_policy_version_id_campaign_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."campaign_policy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_reservation_unique" ON "payouts" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_outcome_unique" ON "payouts" USING btree ("outcome_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_tx_unique" ON "payouts" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "payouts_campaign_idx" ON "payouts" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "payouts_outcome_idx" ON "payouts" USING btree ("outcome_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_reservations_outcome_unique" ON "spend_reservations" USING btree ("outcome_id");--> statement-breakpoint
CREATE INDEX "spend_reservations_campaign_idx" ON "spend_reservations" USING btree ("campaign_id");