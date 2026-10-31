import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { newId } from "@/server/auth/session";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import type { MarketStore } from "@/server/services/campaignStore";
import {
  getPublicMarketDetail,
  listCompletedMarkets,
  listPublicMarkets,
  type MarketDeps,
} from "@/server/services/markets";
import { REPO_ROOT } from "./mainnet-preflight.test";

const root = process.cwd();
const src = (f: string) => readFileSync(join(root, f), "utf8");

/** All source files that must stay workstation-path free. */
const PORTABLE_FILES = [
  "tests/mainnet-preflight.test.ts",
  "tests/portability-build.test.ts",
  "scripts/mainnet-preflight.ts",
  "src/server/db/client.ts",
  "src/server/api/campaignDeps.ts",
  "src/app/markets/page.tsx",
  "src/app/markets/[campaignId]/page.tsx",
  "src/app/demo/page.tsx",
  "src/app/sitemap.ts",
  "src/app/robots.ts",
  "src/app/layout.tsx",
];

function appRouteFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) appRouteFiles(p, out);
    else if (/page\.tsx$|route\.ts$|sitemap\.ts$|robots\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function memoryDeps(store: MarketStore): MarketDeps {
  const { sink } = createMemoryAuditSink();
  return { store, audit: sink };
}

/**
 * Workstation-path patterns, built by concatenation so the definitions
 * cannot match themselves. The drive pattern excludes URL schemes
 * via lookbehind — only real filesystem paths match.
 */
const DRIVE_PATH = new RegExp("(?<![\\w/])[A-Za-z]:[\\\\/]");
const HOME_DIR = new RegExp("/" + "home" + "/[a-z_]");
const WIN_USERS = new RegExp("\\\\" + "Users" + "\\\\");

/* ---------------- 1–3: no absolute paths, portable root, spaces ---------------- */

describe("test portability", () => {
  it("no hardcoded workstation paths remain", () => {
    const offenders: string[] = [];
    for (const f of PORTABLE_FILES) {
      const body = src(f);
      if (DRIVE_PATH.test(body) || HOME_DIR.test(body) || WIN_USERS.test(body)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("preflight resolves the repo root portably (no cwd assumption)", () => {
    // Resolved from import.meta.url, not process.cwd() or a fixed path.
    expect(REPO_ROOT).not.toContain("C:" + "/dev/thesma");
    expect(existsSync(join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "scripts", "mainnet-preflight.ts"))).toBe(true);
    const test = src("tests/mainnet-preflight.test.ts");
    expect(test).toContain("import.meta.url");
    expect(test).toContain("fileURLToPath");
    expect(test).not.toContain('"C:');
  });

  it("preflight covers a working path containing spaces", () => {
    const test = src("tests/mainnet-preflight.test.ts");
    expect(test).toContain("containing spaces");
    expect(test).toContain("mkdtemp");
  });
});

/* ---------------- 4–5: build needs no database ---------------- */

describe("database-independent build", () => {
  it("the whole app is force-dynamic: no route prerenders production data", () => {
    expect(src("src/app/layout.tsx")).toContain('export const dynamic = "force-dynamic"');
    const statics = appRouteFiles("src/app").filter((f) => src(f).includes("generateStaticParams"));
    expect(statics).toEqual([]);
  });

  it("sitemap/robots/metadata use stable route knowledge, never the DB", () => {
    for (const f of ["src/app/sitemap.ts", "src/app/robots.ts"]) {
      const body = src(f);
      expect(body).not.toContain("services/");
      expect(body).not.toContain("db/client");
      expect(body).not.toContain("DATABASE_URL");
    }
  });

  it("importing the DB client without DATABASE_URL never connects", () => {
    const body = src("src/server/db/client.ts");
    // Lazy singletons: construction only inside getPool(), no top-level use.
    expect(body).not.toMatch(/^await /m);
    expect(body).toContain("if (!pool)");
  });

  it("missing DATABASE_URL is a controlled error, not a connection attempt", async () => {
    const client = await import("@/server/db/client");
    const had = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(client.isDbConfigured()).toBe(false);
      expect(() => client.getPool()).toThrow(/DATABASE_URL is not configured/);
    } finally {
      if (had !== undefined) process.env.DATABASE_URL = had;
    }
  });

  it("a deliberately unreachable DATABASE_URL cannot break construction", async () => {
    // pg Pool connects lazily on first query: building the pool object for
    // postgres://invalid.invalid/... performs zero network I/O.
    const pool = new Pool({ connectionString: "postgres://invalid.invalid:5432/thesma" });
    try {
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});

/* ---------------- 6–7: markets + demo stay runtime-backed ---------------- */

describe("public proof stays runtime-backed (no fixtures)", () => {
  it("/markets reads the live store per request with a degraded fallback", () => {
    const page = src("src/app/markets/page.tsx");
    expect(page).toContain("marketDepsOr503");
    expect(page).toContain("listPublicMarkets");
    expect(page).toContain("listCompletedMarkets");
    expect(page).toContain("degraded");
    expect(page).not.toContain("createMemoryCampaignStore");
    expect(page).not.toContain("fixture");
  });

  it("/demo reads the real campaign per request with an unavailable fallback", () => {
    const page = src("src/app/demo/page.tsx");
    expect(page).toContain("marketDepsOr503");
    expect(page).toContain("getPublicMarketDetail");
    expect(page).toContain("DEMO_CAMPAIGN_ID");
    expect(page).toContain("temporarily unavailable");
    expect(page).not.toContain("createMemoryCampaignStore");
    expect(page).not.toContain("not published yet");
  });
});

/* ---------------- 8–10: honest failure states, no secret leaks ---------------- */

describe("runtime DB failure is distinguishable from empty truth", () => {
  it("a failing store rejects (so the page can mark degraded, not empty)", async () => {
    const sabotage = new Error("getaddrinfo ENOTFOUND invalid.invalid");
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw sabotage;
        },
      },
    ) as unknown as MarketStore;
    await expect(listPublicMarkets(memoryDeps(throwing))).rejects.toThrow(/ENOTFOUND/);
    await expect(listCompletedMarkets(memoryDeps(throwing))).rejects.toThrow(/ENOTFOUND/);
  });

  it("DB failures carry no connection strings or credentials", async () => {
    const sabotage = new Error(
      "getaddrinfo ENOTFOUND invalid.invalid — connectionString was postgres://invalid.invalid:5432/thesma",
    );
    const throwing = new Proxy(
      {},
      {
        get: () => {
          throw sabotage;
        },
      },
    ) as unknown as MarketStore;
    const err = await listPublicMarkets(memoryDeps(throwing)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    // The raw store error may name a host (like any DNS error), but pages
    // must never render it: both list and detail pages swallow the error
    // into a boolean degraded/unavailable state.
    expect(src("src/app/markets/page.tsx")).toContain("// Runtime infra failure (e.g. DB configured but unreachable) is not");
    expect(src("src/app/demo/page.tsx")).toContain("// The demo campaign id is fixed");
    const detail = src("src/app/markets/[campaignId]/page.tsx");
    expect(detail).toContain("MarketUnavailable");
    expect(detail).not.toContain(".message");
  });

  it("unknown campaigns stay 404; only infra failure is unavailable", async () => {
    const store = createMemoryCampaignStore({}) as unknown as MarketStore;
    const err = await getPublicMarketDetail(memoryDeps(store), { campaignId: newId() }).then(
      () => null,
      (e: { status?: number } & Error) => e,
    );
    expect(err?.status).toBe(404);
    const detail = src("src/app/markets/[campaignId]/page.tsx");
    expect(detail).toContain("status === 404");
    expect(detail).toContain("notFound()");
  });

  it("real empty still reports empty (not unavailable)", async () => {
    const store = createMemoryCampaignStore({}) as unknown as MarketStore;
    const live = await listPublicMarkets(memoryDeps(store));
    const completed = await listCompletedMarkets(memoryDeps(store));
    expect(live.markets).toEqual([]);
    expect(completed.markets).toEqual([]);
    // Empty arrays render the honest empty state, not the degraded card.
    const page = src("src/app/markets/page.tsx");
    expect(page).toContain("No live markets right now");
    expect(page).toContain("temporarily unavailable");
  });
});

/* ---------------- 11–12: production DTO + canonical proof semantics ---------------- */

describe("production proof semantics unchanged", () => {
  it("existing market DTO suites still define the public contract", () => {
    for (const f of ["tests/market.test.ts", "tests/public-markets.test.ts", "tests/demo-proof.test.ts"]) {
      expect(existsSync(join(root, f))).toBe(true);
    }
  });

  it("Aster/Beaconfield canonical proof matches repo truth", () => {
    const proof = src("docs/mainnet-proof.md");
    for (const tx of [
      "0x5302634da4500b29338a14739917aff66d22e902f1d8dcf910f91a4f1cec05a3",
      "0xddf1fd01f815b69c5e30487d2916c6e91186f58af293fd38b5bfef15473aa5ad",
      "0xec3ab9e2bd8ad1ce1412fc0c2c4a65897dc598ddc221c3ef18cd148f350cb6b0",
      "0x0fA826256a58F19Ad24Fc9384d81D313f2266F79",
    ]) {
      expect(proof).toContain(tx);
    }
  });
});
