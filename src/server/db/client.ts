import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Provider-neutral Postgres boundary: the only thing that touches
 * DATABASE_URL. Domain/services code imports `getDb()` — never `pg`
 * directly — so Neon/Supabase/local remain interchangeable.
 *
 * Build-safe: importing this module without DATABASE_URL does NOT throw.
 * Routes that need the DB return 503 (unconfigured) instead of crashing
 * the production build.
 */

let pool: Pool | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | null = null;

export function getDb(): Db {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}
