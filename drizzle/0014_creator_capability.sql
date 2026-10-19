ALTER TABLE "user_personas" ADD COLUMN "creator_type" text;
--> statement-breakpoint
ALTER TABLE "user_personas" ADD COLUMN "interests" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_personas" ADD COLUMN "preferences" text[] DEFAULT '{}' NOT NULL;
