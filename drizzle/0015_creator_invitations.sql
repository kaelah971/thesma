CREATE TYPE "invitation_status" AS ENUM('INVITED', 'ACCEPTED', 'DECLINED', 'CANCELLED');
--> statement-breakpoint
CREATE TABLE "campaign_creator_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"organization_user_id" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"status" "invitation_status" DEFAULT 'INVITED' NOT NULL,
	"offered_outcome_kind" text NOT NULL,
	"offered_bounty_micro_usdc" bigint NOT NULL,
	"offered_min_qualifying_micro_usdc" bigint,
	"offered_hold_seconds" integer,
	"offered_policy_version" integer NOT NULL,
	"offered_market_version" integer NOT NULL,
	"offered_bonus_json" jsonb DEFAULT '{}' NOT NULL,
	"match_score" integer NOT NULL,
	"match_confidence" text NOT NULL,
	"match_action" text NOT NULL,
	"match_reasons" jsonb DEFAULT '[]' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_creator_invitations" ADD CONSTRAINT "campaign_creator_invitations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_creator_invitations" ADD CONSTRAINT "campaign_creator_invitations_organization_user_id_users_id_fk" FOREIGN KEY ("organization_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_creator_invitations" ADD CONSTRAINT "campaign_creator_invitations_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_invitations_active_unique" ON "campaign_creator_invitations" USING btree ("campaign_id","creator_user_id") WHERE status = 'INVITED';--> statement-breakpoint
CREATE INDEX "creator_invitations_campaign_idx" ON "campaign_creator_invitations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "creator_invitations_creator_idx" ON "campaign_creator_invitations" USING btree ("creator_user_id");
