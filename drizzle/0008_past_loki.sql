CREATE TYPE "public"."commitment_state" AS ENUM('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "supply_commitments" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"negotiation_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"partner_terms_id" text NOT NULL,
	"amount_micro_usdc" bigint NOT NULL,
	"state" "commitment_state" DEFAULT 'ACTIVE' NOT NULL,
	"consumed_by_outcome_id" text,
	"consumed_by_reservation_id" text,
	"released_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supply_commitments" ADD CONSTRAINT "supply_commitments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_commitments" ADD CONSTRAINT "supply_commitments_negotiation_id_negotiations_id_fk" FOREIGN KEY ("negotiation_id") REFERENCES "public"."negotiations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_commitments" ADD CONSTRAINT "supply_commitments_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supply_commitments" ADD CONSTRAINT "supply_commitments_partner_terms_id_partner_terms_id_fk" FOREIGN KEY ("partner_terms_id") REFERENCES "public"."partner_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supply_commitments_negotiation_unique" ON "supply_commitments" USING btree ("negotiation_id");--> statement-breakpoint
CREATE INDEX "supply_commitments_campaign_idx" ON "supply_commitments" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "supply_commitments_terms_idx" ON "supply_commitments" USING btree ("partner_terms_id");