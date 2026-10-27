CREATE TABLE "verification_procurement_policies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_cost_per_check_micro_usdc" bigint NOT NULL,
	"max_spend_per_period_micro_usdc" bigint NOT NULL,
	"period_days" integer DEFAULT 30 NOT NULL,
	"max_cost_bps_of_exposure" integer DEFAULT 200 NOT NULL,
	"allowed_providers_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_check_types_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_approval_threshold_micro_usdc" bigint,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_procurements" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"outcome_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"check_type" text NOT NULL,
	"economic_exposure_micro_usdc" bigint NOT NULL,
	"quoted_cost_micro_usdc" bigint NOT NULL,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"pay_to" text NOT NULL,
	"resource_url" text NOT NULL,
	"quote_version" text NOT NULL,
	"quote_expires_at" timestamp with time zone NOT NULL,
	"decision" text NOT NULL,
	"state" text DEFAULT 'CANDIDATE' NOT NULL,
	"dedupe_key" text NOT NULL,
	"payment_reference" text,
	"response_hash" text,
	"normalized_result" text,
	"reason_codes_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_at" timestamp with time zone,
	"purchased_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_procurements_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "verification_procurements_state_format" CHECK ("verification_procurements"."state" IN ('CANDIDATE','QUOTED','REFUSED','ESCALATED','APPROVED','PAYMENT_AUTHORIZED','PURCHASED','RESULT_RECEIVED','AMBIGUOUS','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "verification_procurement_policies" ADD CONSTRAINT "verification_procurement_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_procurement_policies" ADD CONSTRAINT "verification_procurement_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_procurements" ADD CONSTRAINT "verification_procurements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_procurements" ADD CONSTRAINT "verification_procurements_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_procurements" ADD CONSTRAINT "verification_procurements_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_procurements_campaign_idx" ON "verification_procurements" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "verification_procurements_workspace_idx" ON "verification_procurements" USING btree ("workspace_id");