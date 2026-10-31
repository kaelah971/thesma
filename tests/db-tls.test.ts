import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPO_ROOT } from "./mainnet-preflight.test";
import {
  PRODUCTION_TLS_MESSAGE,
  assertProductionDbTls,
  isLocalDatabaseUrl,
  isProductionLike,
  isTestEnv,
  isVerifyFull,
  sslModeOf,
} from "@/server/db/tls";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const src = (f: string) => readFileSync(join(root, f), "utf8");

const PROD_URL = "postgres://app:secret@db.example.com:5432/thesma?sslmode=verify-full";

/** Simulate a real production process (no test-runner env leaking in). */
function prodEnv(): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_ENV" || k === "VITEST") continue;
    if (v !== undefined) env[k] = v;
  }
  return env;
}

describe("production database TLS validation", () => {
  it("accepts a production verify-full URL", () => {
    expect(() => assertProductionDbTls(PROD_URL, prodEnv())).not.toThrow();
    expect(isVerifyFull(PROD_URL)).toBe(true);
  });

  it("rejects production sslmode=disable", () => {
    const url = "postgres://app:secret@db.example.com:5432/thesma?sslmode=disable";
    expect(() => assertProductionDbTls(url, prodEnv())).toThrow(PRODUCTION_TLS_MESSAGE);
  });

  it("rejects a production URL with missing sslmode", () => {
    const url = "postgres://app:secret@db.example.com:5432/thesma";
    expect(sslModeOf(url)).toBeNull();
    expect(() => assertProductionDbTls(url, prodEnv())).toThrow(PRODUCTION_TLS_MESSAGE);
  });

  it.each(["prefer", "require", "verify-ca", "allow"])("rejects weaker production mode %s", (mode) => {
    const url = `postgres://app:secret@db.example.com:5432/thesma?sslmode=${mode}`;
    expect(isVerifyFull(url)).toBe(false);
    expect(() => assertProductionDbTls(url, prodEnv())).toThrow(PRODUCTION_TLS_MESSAGE);
  });

  it("never exposes DATABASE_URL, host, or secrets in errors", () => {
    const url = "postgres://operator:s3cret-pw-xyz@db.example.com:5432/thesma?sslmode=require";
    const err = (() => {
      try {
        assertProductionDbTls(url, prodEnv());
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toBe(PRODUCTION_TLS_MESSAGE);
    for (const secret of ["s3cret-pw-xyz", "operator", "db.example.com", "postgres://", "sslmode"]) {
      // "sslmode" legitimately names the required setting; nothing else leaks.
      if (secret === "sslmode") continue;
      expect(err!.message).not.toContain(secret);
    }
  });

  it("localhost development configuration remains intentionally supported", () => {
    for (const url of [
      "postgres://postgres:postgres@localhost:5432/thesma_dev",
      "postgres://postgres:postgres@127.0.0.1:5432/thesma_dev",
      "postgres://postgres:postgres@[::1]:5432/thesma_dev?sslmode=disable",
    ]) {
      expect(isLocalDatabaseUrl(url)).toBe(true);
      expect(() => assertProductionDbTls(url, prodEnv())).not.toThrow();
    }
  });

  it("test runs remain supported without production TLS", () => {
    expect(isTestEnv()).toBe(true); // vitest sets NODE_ENV=test / VITEST
    const bare = "postgres://app:secret@db.example.com:5432/thesma";
    expect(isProductionLike(bare)).toBe(false);
    expect(() => assertProductionDbTls(bare)).not.toThrow();
  });

  it("missing DATABASE_URL is not a TLS failure (absence stays UNCONFIGURED)", () => {
    expect(() => assertProductionDbTls(undefined, prodEnv())).not.toThrow();
  });
});

describe("preflight enforces production TLS without leaking secrets", () => {
  function runPreflight(env: Record<string, string | undefined>) {
    const scrubbed: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !["DATABASE_URL", "ARC_RPC_URL", "ARC_CHAIN_ID"].includes(k)) {
        scrubbed[k] = v;
      }
    }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete scrubbed[k];
      else scrubbed[k] = v;
    }
    return execFileAsync("npx", ["tsx", join(REPO_ROOT, "scripts", "mainnet-preflight.ts")], {
      cwd: REPO_ROOT,
      env: scrubbed as NodeJS.ProcessEnv,
      timeout: 60_000,
      shell: process.platform === "win32",
    }).then(
      (r) => ({ code: 0 as number, stdout: r.stdout }),
      (e: { code?: number; stdout?: string }) => ({ code: e.code ?? 1, stdout: e.stdout ?? "" }),
    );
  }

  it("fails closed on a production-like URL without verify-full", async () => {
    const r = await runPreflight({
      DATABASE_URL: "postgres://op:s3cret-preflight-pw@db.example.com:5432/thesma",
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL db:tls");
    expect(r.stdout).not.toContain("s3cret-preflight-pw");
  }, 60_000);

  it("passes the TLS check for verify-full even when the host is unreachable", async () => {
    const r = await runPreflight({
      DATABASE_URL: "postgres://op:s3cret-preflight-pw@invalid.invalid:5432/thesma?sslmode=verify-full",
    });
    expect(r.stdout).toContain("PASS db:tls");
    expect(r.stdout).not.toContain("s3cret-preflight-pw");
  }, 60_000);
});

describe("TLS gate is build-safe and leak-free at runtime", () => {
  it("db client enforces TLS lazily at first use, never at import", () => {
    const client = src("src/server/db/client.ts");
    expect(client).toContain("assertProductionDbTls(url)");
    expect(client).not.toMatch(/^assertProductionDbTls/m);
    expect(client).not.toMatch(/^getPool\(\)/m);
  });

  it("public error surfaces never render database config", () => {
    for (const f of ["src/app/markets/page.tsx", "src/app/demo/page.tsx", "src/app/markets/[campaignId]/page.tsx"]) {
      expect(src(f)).not.toContain(".message");
      expect(src(f)).not.toContain("DATABASE_URL");
    }
    // Unknown failures map to a generic INTERNAL error, never the raw error.
    expect(src("src/server/api/errors.ts")).toContain('errorResponse("INTERNAL", "Internal error", 500)');
  });

  it("production market/demo behavior is unchanged (runtime-backed reads)", () => {
    expect(src("src/app/markets/page.tsx")).toContain("listPublicMarkets");
    expect(src("src/app/demo/page.tsx")).toContain("getPublicMarketDetail");
    expect(src("src/app/markets/[campaignId]/page.tsx")).toContain("getPublicMarketDetail");
  });
});
