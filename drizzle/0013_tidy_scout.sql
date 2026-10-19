CREATE TABLE "creator_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"creator_user_id" text NOT NULL,
	"type" text NOT NULL,
	"campaign_id" text,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"metadata_json" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "creator_notifications" ADD CONSTRAINT "creator_notifications_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_notifications_user_dedupe_unique" ON "creator_notifications" USING btree ("creator_user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "creator_notifications_user_created_idx" ON "creator_notifications" USING btree ("creator_user_id","created_at");
