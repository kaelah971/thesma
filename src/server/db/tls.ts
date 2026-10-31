/**
 * Production Postgres TLS gate.
 *
 * pg's `sslmode` handling has shifted across releases (and may move closer
 * to libpq semantics in the future), so production must not rely on
 * ambiguous defaults. Only `sslmode=verify-full` proves BOTH certificate
 * chain verification and hostname verification — `prefer`, `require`, and
 * `verify-ca` do not guarantee the latter.
 *
 * Pure + side-effect free: no pg import, no env reads at module scope, no
 * logging. Safe to import from tests, scripts, and the DB client alike.
 * The URL itself is never included in any message thrown or returned here.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** True inside unit tests / CI test runs, where no real TLS applies. */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || Boolean(env.VITEST);
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/** Lowercase `sslmode` query value, or null when absent/unparseable. */
export function sslModeOf(url: string): string | null {
  try {
    const raw = new URL(url).searchParams.get("sslmode");
    return raw ? raw.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Loopback URLs are intentionally exempt: local Postgres may not have
 * public-CA TLS, and there is no network adversary on loopback.
 */
export function isLocalDatabaseUrl(url: string): boolean {
  const host = hostnameOf(url);
  return host !== null && LOCAL_HOSTS.has(host);
}

/**
 * Production-like = configured, non-loopback, outside test runs.
 * Unparseable URLs fail closed (treated as production-like: they must
 * carry verify-full or be rejected).
 */
export function isProductionLike(url: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!url) return false;
  if (isTestEnv(env)) return false;
  return !isLocalDatabaseUrl(url);
}

/** Only verify-full guarantees chain + hostname verification in pg. */
export function isVerifyFull(url: string): boolean {
  return sslModeOf(url) === "verify-full";
}

export const PRODUCTION_TLS_MESSAGE = "Production DATABASE_URL must use sslmode=verify-full.";

/**
 * Fail closed for production-like URLs without verify-full.
 * Local + test URLs always pass. Never throws for missing/empty input
 * (absence is reported separately as UNCONFIGURED, not as a TLS failure).
 * The thrown message is static — it never echoes the URL, host, or secrets.
 */
export function assertProductionDbTls(url: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!url) return;
  if (!isProductionLike(url, env)) return;
  if (!isVerifyFull(url)) throw new Error(PRODUCTION_TLS_MESSAGE);
}
