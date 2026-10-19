CREATE TABLE "growth_policies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"optimization_enabled" boolean DEFAULT false NOT NULL,
	"max_bounty_change_pct" integer DEFAULT 25 NOT NULL,
	"minimum_evidence" integer DEFAULT 5 NOT NULL,
	"evaluation_window_days" integer DEFAULT 7 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "growth_policies" ADD CONSTRAINT "growth_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_policies" ADD CONSTRAINT "growth_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;