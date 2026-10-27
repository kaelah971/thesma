CREATE TABLE "hybrid_deals" (
	"id" text PRIMARY KEY NOT NULL,
	"terms_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"invitation_id" text NOT NULL,
	"structure" text NOT NULL,
	"base_amount_micro_usdc" bigint NOT NULL,
	"base_status" text DEFAULT 'PENDING' NOT NULL,
	"deliverable_json" jsonb,
	"performance_bounty_micro_usdc" bigint NOT NULL,
	"milestones_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"maximum_total_exposure_micro_usdc" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hybrid_deals_terms_id_unique" UNIQUE("terms_id"),
	CONSTRAINT "hybrid_deals_base_status_format" CHECK ("hybrid_deals"."base_status" IN ('PENDING', 'VERIFIED', 'SETTLEMENT_NOT_SUPPORTED', 'PAID'))
);
--> statement-breakpoint
CREATE TABLE "milestone_awards" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"milestone_index" integer NOT NULL,
	"threshold" integer NOT NULL,
	"amount_micro_usdc" bigint NOT NULL,
	"status" text DEFAULT 'SETTLEMENT_NOT_SUPPORTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestone_awards_status_format" CHECK ("milestone_awards"."status" IN ('SETTLEMENT_NOT_SUPPORTED', 'PAID'))
);
--> statement-breakpoint
ALTER TABLE "hybrid_deals" ADD CONSTRAINT "hybrid_deals_terms_id_partner_terms_id_fk" FOREIGN KEY ("terms_id") REFERENCES "public"."partner_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hybrid_deals" ADD CONSTRAINT "hybrid_deals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hybrid_deals" ADD CONSTRAINT "hybrid_deals_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hybrid_deals" ADD CONSTRAINT "hybrid_deals_invitation_id_campaign_creator_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."campaign_creator_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestone_awards" ADD CONSTRAINT "milestone_awards_deal_id_hybrid_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."hybrid_deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hybrid_deals_campaign_idx" ON "hybrid_deals" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "hybrid_deals_partner_idx" ON "hybrid_deals" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_awards_once_unique" ON "milestone_awards" USING btree ("deal_id","milestone_index");--> statement-breakpoint
CREATE INDEX "milestone_awards_deal_idx" ON "milestone_awards" USING btree ("deal_id");
