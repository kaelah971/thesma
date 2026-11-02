CREATE TABLE "growth_attribution_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"growth_program_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"public_code" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "growth_attribution_identities_status_check" CHECK ("growth_attribution_identities"."status" IN ('ACTIVE','REVOKED'))
);
--> statement-breakpoint
CREATE TABLE "growth_program_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"growth_program_id" text NOT NULL,
	"participant_type" text NOT NULL,
	"creator_user_id" text,
	"external_partner_id" text,
	"display_name" text NOT NULL,
	"handle" text,
	"status" text DEFAULT 'INVITED' NOT NULL,
	"participation_source" text DEFAULT 'INVITE' NOT NULL,
	"reward_policy_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"joined_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_program_participants_type_check" CHECK ("growth_program_participants"."participant_type" IN ('CREATOR','REFERRAL_PARTNER')),
	CONSTRAINT "growth_program_participants_status_check" CHECK ("growth_program_participants"."status" IN ('INVITED','APPLIED','APPROVED','ACTIVE','PAUSED','DECLINED','REMOVED')),
	CONSTRAINT "growth_program_participants_source_check" CHECK ("growth_program_participants"."participation_source" IN ('INVITE','OPEN_JOIN','EXTERNAL'))
);
--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD COLUMN "attribution_identity_id" text;--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD COLUMN "attribution_status" text DEFAULT 'UNATTRIBUTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "growth_attribution_identities" ADD CONSTRAINT "growth_attribution_identities_growth_program_id_developer_growth_programs_id_fk" FOREIGN KEY ("growth_program_id") REFERENCES "public"."developer_growth_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_attribution_identities" ADD CONSTRAINT "growth_attribution_identities_participant_id_growth_program_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."growth_program_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_program_participants" ADD CONSTRAINT "growth_program_participants_growth_program_id_developer_growth_programs_id_fk" FOREIGN KEY ("growth_program_id") REFERENCES "public"."developer_growth_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_program_participants" ADD CONSTRAINT "growth_program_participants_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "growth_attribution_identities_code_unique" ON "growth_attribution_identities" USING btree ("public_code");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_attribution_identities_program_participant_active_unique" ON "growth_attribution_identities" USING btree ("growth_program_id","participant_id") WHERE "growth_attribution_identities"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "growth_attribution_identities_program_idx" ON "growth_attribution_identities" USING btree ("growth_program_id");--> statement-breakpoint
CREATE INDEX "growth_attribution_identities_participant_idx" ON "growth_attribution_identities" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "growth_program_participants_program_idx" ON "growth_program_participants" USING btree ("growth_program_id");--> statement-breakpoint
CREATE INDEX "growth_program_participants_creator_idx" ON "growth_program_participants" USING btree ("creator_user_id");--> statement-breakpoint
CREATE INDEX "growth_program_participants_external_idx" ON "growth_program_participants" USING btree ("external_partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_program_participants_program_creator_unique" ON "growth_program_participants" USING btree ("growth_program_id","creator_user_id") WHERE "growth_program_participants"."creator_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "growth_program_participants_program_external_unique" ON "growth_program_participants" USING btree ("growth_program_id","external_partner_id") WHERE "growth_program_participants"."external_partner_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD CONSTRAINT "external_outcome_events_attribution_identity_id_growth_attribution_identities_id_fk" FOREIGN KEY ("attribution_identity_id") REFERENCES "public"."growth_attribution_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_outcome_events_attribution_idx" ON "external_outcome_events" USING btree ("attribution_identity_id");--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD CONSTRAINT "external_outcome_events_attribution_status_check" CHECK ("external_outcome_events"."attribution_status" IN ('DIRECT_ATTRIBUTION','UNATTRIBUTED','INVALID_ATTRIBUTION','AMBIGUOUS'));