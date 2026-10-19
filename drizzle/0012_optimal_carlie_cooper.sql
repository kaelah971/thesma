CREATE TABLE "creator_follows" (
	"follower_user_id" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_follows_follower_user_id_creator_user_id_pk" PRIMARY KEY("follower_user_id","creator_user_id")
);
--> statement-breakpoint
ALTER TABLE "creator_follows" ADD CONSTRAINT "creator_follows_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_follows" ADD CONSTRAINT "creator_follows_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_follows_creator_idx" ON "creator_follows" USING btree ("creator_user_id");