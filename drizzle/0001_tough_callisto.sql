CREATE TYPE "public"."campaign_state" AS ENUM('DRAFT', 'REVIEW', 'APPROVED', 'FUNDING', 'LIVE', 'PAUSED', 'CLOSING', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."market_visibility" AS ENUM('PUBLIC', 'PRIVATE');--> statement-breakpoint
CREATE TYPE "public"."policy_version_status" AS ENUM('DRAFT', 'REVIEW', 'APPROVED');--> statement-breakpoint
CREATE TABLE "campaign_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"version" integer NOT NULL,
	"intent_text" text NOT NULL,
	"target_outcome_count" integer,
	"budget_micro_usdc" bigint,
	"bounty_floor_micro_usdc" bigint,
	"bounty_ceiling_micro_usdc" bigint,
	"min_qualifying_purchase_micro_usdc" bigint,
	"deadline" timestamp with time zone,
	"market_visibility" "market_visibility" DEFAULT 'PUBLIC' NOT NULL,
	"allowed_partner_rules_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refund_hold_seconds" integer DEFAULT 0 NOT NULL,
	"escalation_rules_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "policy_version_status" DEFAULT 'DRAFT' NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"state" "campaign_state" DEFAULT 'DRAFT' NOT NULL,
	"current_policy_version_id" text,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_policy_versions" ADD CONSTRAINT "campaign_policy_versions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_policy_versions" ADD CONSTRAINT "campaign_policy_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_policy_versions_campaign_version_unique" ON "campaign_policy_versions" USING btree ("campaign_id","version");--> statement-breakpoint
CREATE INDEX "campaign_policy_versions_campaign_idx" ON "campaign_policy_versions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_workspace_idx" ON "campaigns" USING btree ("workspace_id");