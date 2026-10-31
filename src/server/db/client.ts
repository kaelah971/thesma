import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { assertProductionDbTls } from "./tls";

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
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured");
  }
  // Fail closed: production-like URLs without sslmode=verify-full are
  // rejected before any socket is opened. Local/test URLs are exempt, and
  // the error never echoes the URL or credentials.
  assertProductionDbTls(url);
  if (!pool) {
    pool = new Pool({ connectionString: url });
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
