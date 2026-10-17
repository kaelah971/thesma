import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // drizzle-kit only needs this when pushing/migrating against a live DB.
    // Generation (`npm run db:generate`) works from the schema alone.
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/thesma_dev",
  },
});
