CREATE TABLE "developer_growth_programs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"integration_id" text,
	"outcome_definition_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"objective_outcome_type" text NOT NULL,
	"max_verified_cac_micro_usdc" bigint NOT NULL,
	"participant_types" text[] DEFAULT '{}' NOT NULL,
	"reward_structure" text DEFAULT 'PERFORMANCE_ONLY' NOT NULL,
	"operator_mode" text DEFAULT 'SHADOW' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"participation_status" text DEFAULT 'CLOSED' NOT NULL,
	"attribution_status" text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "developer_growth_programs_outcome_type_check" CHECK ("developer_growth_programs"."objective_outcome_type" IN ('PURCHASE','ACTIVATED_USER','QUALIFIED_REFERRAL','SUBSCRIPTION_STARTED')),
	CONSTRAINT "developer_growth_programs_cac_check" CHECK ("developer_growth_programs"."max_verified_cac_micro_usdc" > 0),
	CONSTRAINT "developer_growth_programs_reward_structure_check" CHECK ("developer_growth_programs"."reward_structure" IN ('PERFORMANCE_ONLY','BASE_PLUS_PERFORMANCE','MILESTONE_PLUS_PERFORMANCE','HYBRID_FULL')),
	CONSTRAINT "developer_growth_programs_operator_mode_check" CHECK ("developer_growth_programs"."operator_mode" IN ('SHADOW','REVIEW','AUTONOMOUS')),
	CONSTRAINT "developer_growth_programs_status_check" CHECK ("developer_growth_programs"."status" IN ('DRAFT','READY','LIVE','PAUSED','COMPLETED')),
	CONSTRAINT "developer_growth_programs_participation_check" CHECK ("developer_growth_programs"."participation_status" IN ('CLOSED','INVITE_ONLY','OPEN')),
	CONSTRAINT "developer_growth_programs_attribution_check" CHECK ("developer_growth_programs"."attribution_status" IN ('NOT_CONFIGURED','CONFIGURED'))
);
--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD COLUMN "growth_program_id" text;--> statement-breakpoint
ALTER TABLE "developer_growth_programs" ADD CONSTRAINT "developer_growth_programs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_growth_programs" ADD CONSTRAINT "developer_growth_programs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_growth_programs" ADD CONSTRAINT "developer_growth_programs_policy_version_id_campaign_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."campaign_policy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_growth_programs" ADD CONSTRAINT "developer_growth_programs_integration_id_developer_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."developer_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_growth_programs" ADD CONSTRAINT "developer_growth_programs_outcome_definition_id_external_outcome_definitions_id_fk" FOREIGN KEY ("outcome_definition_id") REFERENCES "public"."external_outcome_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_growth_programs" ADD CONSTRAINT "developer_growth_programs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "developer_growth_programs_workspace_slug_unique" ON "developer_growth_programs" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "developer_growth_programs_workspace_idx" ON "developer_growth_programs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "developer_growth_programs_campaign_idx" ON "developer_growth_programs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "developer_growth_programs_definition_idx" ON "developer_growth_programs" USING btree ("outcome_definition_id");--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD CONSTRAINT "external_outcome_events_growth_program_id_developer_growth_programs_id_fk" FOREIGN KEY ("growth_program_id") REFERENCES "public"."developer_growth_programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_outcome_events_program_idx" ON "external_outcome_events" USING btree ("growth_program_id");