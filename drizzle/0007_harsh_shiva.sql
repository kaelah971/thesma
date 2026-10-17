CREATE TYPE "public"."negotiation_decision" AS ENUM('ACCEPT', 'COUNTER', 'REJECT', 'HOLD');--> statement-breakpoint
CREATE TABLE "negotiation_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"negotiation_id" text NOT NULL,
	"round" integer NOT NULL,
	"decision" "negotiation_decision" NOT NULL,
	"reason_codes" text[] DEFAULT '{}' NOT NULL,
	"inputs_json" jsonb NOT NULL,
	"inputs_hash" text NOT NULL,
	"ask_micro_usdc" bigint NOT NULL,
	"counter_micro_usdc" bigint,
	"auto_executed" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "negotiations" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"ask_micro_usdc" bigint NOT NULL,
	"reference_bounty_micro_usdc" bigint NOT NULL,
	"counter_micro_usdc" bigint,
	"policy_version" integer NOT NULL,
	"market_version" integer NOT NULL,
	"allocation_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "negotiation_decisions" ADD CONSTRAINT "negotiation_decisions_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "negotiation_decisions_inputs_unique" ON "negotiation_decisions" USING btree ("negotiation_id","inputs_hash");--> statement-breakpoint
CREATE INDEX "negotiation_decisions_negotiation_idx" ON "negotiation_decisions" USING btree ("negotiation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "negotiations_pair_active_unique" ON "negotiations" USING btree ("campaign_id","partner_id") WHERE status IN ('OPEN', 'COUNTERED', 'HOLD');--> statement-breakpoint
CREATE INDEX "negotiations_campaign_idx" ON "negotiations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "negotiations_status_idx" ON "negotiations" USING btree ("status");