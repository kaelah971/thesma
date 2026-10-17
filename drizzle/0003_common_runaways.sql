CREATE TYPE "public"."market_status" AS ENUM('OPEN', 'THIN_SUPPLY', 'ON_PACE', 'BEHIND_PACE', 'BUDGET_PRESSURE', 'TARGET_REACHED', 'PAUSED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "market_states" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"public_bounty_micro_usdc" bigint NOT NULL,
	"status" "market_status" DEFAULT 'OPEN' NOT NULL,
	"destination_url" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"policy_version" integer NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"price_micro_usdc" bigint NOT NULL,
	"allocation_count" integer NOT NULL,
	"source" text DEFAULT 'PUBLIC' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"policy_version" integer NOT NULL,
	"market_version" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_events" (
	"id" text PRIMARY KEY NOT NULL,
	"referral_id" text NOT NULL,
	"event_type" text NOT NULL,
	"anonymous_visitor_hash" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"partner_terms_id" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_states" ADD CONSTRAINT "market_states_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_invites" ADD CONSTRAINT "private_invites_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_invites" ADD CONSTRAINT "private_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_partner_terms_id_partner_terms_id_fk" FOREIGN KEY ("partner_terms_id") REFERENCES "public"."partner_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_states_status_idx" ON "market_states" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_terms_campaign_partner_unique" ON "partner_terms" USING btree ("campaign_id","partner_id");--> statement-breakpoint
CREATE INDEX "partner_terms_campaign_idx" ON "partner_terms" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "partner_terms_partner_idx" ON "partner_terms" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "private_invites_token_hash_unique" ON "private_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "private_invites_campaign_idx" ON "private_invites" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "referral_events_referral_idx" ON "referral_events" USING btree ("referral_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_code_unique" ON "referrals" USING btree ("code");--> statement-breakpoint
CREATE INDEX "referrals_campaign_idx" ON "referrals" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "referrals_partner_idx" ON "referrals" USING btree ("partner_id");