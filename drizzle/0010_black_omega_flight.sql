CREATE TABLE "operator_policies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"min_reserve_micro_usdc" text DEFAULT '0' NOT NULL,
	"max_autonomous_payment_micro_usdc" text DEFAULT '10000000' NOT NULL,
	"max_autonomous_spend_per_period_micro_usdc" text,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "operator_policies" ADD CONSTRAINT "operator_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_policies" ADD CONSTRAINT "operator_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;