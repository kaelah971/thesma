CREATE TYPE "public"."user_persona" AS ENUM('CUSTOMER', 'CREATOR', 'ORGANIZATION', 'DEVELOPER');--> statement-breakpoint
CREATE TABLE "user_personas" (
	"user_id" text PRIMARY KEY NOT NULL,
	"persona" "user_persona" NOT NULL,
	"handle" text,
	"bio" text,
	"category" text,
	"project" text,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "user_personas" ADD CONSTRAINT "user_personas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_personas_handle_unique" ON "user_personas" USING btree ("handle");
