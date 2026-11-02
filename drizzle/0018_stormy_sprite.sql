CREATE TABLE "developer_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"api_key_id" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"api_key_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "developer_integrations_api_key_id_unique" UNIQUE("api_key_id"),
	CONSTRAINT "developer_integrations_api_key_digest_unique" UNIQUE("api_key_digest"),
	CONSTRAINT "developer_integrations_status_check" CHECK ("developer_integrations"."status" IN ('ACTIVE','REVOKED'))
);
--> statement-breakpoint
CREATE TABLE "external_outcome_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"outcome_type" text NOT NULL,
	"unit_value_micro_usdc" bigint NOT NULL,
	"asset" text DEFAULT 'USDC' NOT NULL,
	"evidence_schema_version" integer NOT NULL,
	"evidence_schema_json" jsonb NOT NULL,
	"verification_policy_id" text NOT NULL,
	"hold_seconds" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_outcome_definitions_value_check" CHECK ("external_outcome_definitions"."unit_value_micro_usdc" > 0),
	CONSTRAINT "external_outcome_definitions_hold_check" CHECK ("external_outcome_definitions"."hold_seconds" >= 0 AND "external_outcome_definitions"."hold_seconds" <= 2592000)
);
--> statement-breakpoint
CREATE TABLE "external_outcome_events" (
	"id" text PRIMARY KEY NOT NULL,
	"receipt_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"external_event_id" text NOT NULL,
	"external_subject_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"schema_version" integer NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"normalized_evidence_json" jsonb NOT NULL,
	"evidence_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"verification_state" text DEFAULT 'SUBMITTED' NOT NULL,
	"hold_state" text DEFAULT 'NOT_HELD' NOT NULL,
	"settlement_state" text DEFAULT 'NOT_ELIGIBLE' NOT NULL,
	"execution_state" text DEFAULT 'NOT_REQUESTED' NOT NULL,
	"decision_reasons_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"procurement_recommendation" text DEFAULT 'NOT_NEEDED' NOT NULL,
	"rejection_code" text,
	"hold_until" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_outcome_events_receipt_id_unique" UNIQUE("receipt_id"),
	CONSTRAINT "external_outcome_events_verification_state_check" CHECK ("external_outcome_events"."verification_state" IN ('SUBMITTED','REVIEW','VERIFIED','REFUSED')),
	CONSTRAINT "external_outcome_events_hold_state_check" CHECK ("external_outcome_events"."hold_state" IN ('NOT_HELD','HELD','RELEASED')),
	CONSTRAINT "external_outcome_events_settlement_state_check" CHECK ("external_outcome_events"."settlement_state" IN ('NOT_ELIGIBLE','HELD','ELIGIBLE_NOT_REQUESTED','SHADOW_BLOCKED','SETTLED'))
);
--> statement-breakpoint
ALTER TABLE "developer_integrations" ADD CONSTRAINT "developer_integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_outcome_definitions" ADD CONSTRAINT "external_outcome_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD CONSTRAINT "external_outcome_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD CONSTRAINT "external_outcome_events_integration_id_developer_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."developer_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_outcome_events" ADD CONSTRAINT "external_outcome_events_definition_id_external_outcome_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."external_outcome_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "developer_integrations_workspace_idx" ON "developer_integrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_outcome_definitions_workspace_slug_version_unique" ON "external_outcome_definitions" USING btree ("workspace_id","slug","evidence_schema_version");--> statement-breakpoint
CREATE INDEX "external_outcome_definitions_workspace_slug_idx" ON "external_outcome_definitions" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "external_outcome_events_workspace_event_unique" ON "external_outcome_events" USING btree ("workspace_id","external_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_outcome_events_workspace_definition_idempotency_unique" ON "external_outcome_events" USING btree ("workspace_id","definition_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "external_outcome_events_workspace_idx" ON "external_outcome_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "external_outcome_events_integration_idx" ON "external_outcome_events" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "external_outcome_events_definition_idx" ON "external_outcome_events" USING btree ("definition_id");