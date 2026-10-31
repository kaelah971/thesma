import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeDestinationUrl } from "@/server/domain/market";
import { buildCsp } from "@/server/security/csp";

const PROD = { allowLocalhost: false };
const DEV = { allowLocalhost: true };

describe("referral destination validation (no open redirect)", () => {
  it("accepts stored https destinations, preserving path and query", () => {
    expect(assertSafeDestinationUrl("https://acme.example/product?ref=1", PROD)).toBe(
      "https://acme.example/product?ref=1",
    );
  });

  it("rejects executable and non-web protocols", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<h1>phish</h1>",
      "file:///etc/passwd",
      "blob:https://acme.example/abc",
      "ftp://acme.example/file",
    ]) {
      expect(() => assertSafeDestinationUrl(bad, PROD)).toThrow();
      expect(() => assertSafeDestinationUrl(bad, DEV)).toThrow();
    }
  });

  it("requires https in production, allows http only for local dev", () => {
    expect(() => assertSafeDestinationUrl("http://acme.example/product", PROD)).toThrow(/https/);
    expect(assertSafeDestinationUrl("http://localhost:3000/product", DEV)).toContain("localhost");
    expect(() => assertSafeDestinationUrl("http://localhost:3000/product", PROD)).toThrow();
    expect(() => assertSafeDestinationUrl("http://127.0.0.1:3000/x", PROD)).toThrow();
  });

  it("rejects credential-embedded, hostless, and malformed destinations", () => {
    expect(() => assertSafeDestinationUrl("https://user:pass@acme.example/", PROD)).toThrow();
    expect(() => assertSafeDestinationUrl("not a url", PROD)).toThrow();
    expect(() => assertSafeDestinationUrl("/relative/path", PROD)).toThrow();
    expect(() => assertSafeDestinationUrl("", PROD)).toThrow();
  });
});

describe("security headers baseline", () => {
  const middlewareSrc = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
  const configSrc = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  const cspSrc = readFileSync(join(process.cwd(), "src/server/security/csp.ts"), "utf8");
  const layoutSrc = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");

  it("issues a per-request CSP with a fresh nonce (static script-src would freeze streamed routes)", () => {
    // Next.js streams page data as inline scripts: only a nonce stamped via
    // the request CSP keeps first-party execution without killing hydration.
    // Policy shape lives in the pure builder; middleware propagates it.
    expect(middlewareSrc).toContain("x-nonce");
    expect(middlewareSrc).toContain("buildCsp");
    expect(middlewareSrc).toContain("generateNonce");
    // Framework nonce extraction reads the REQUEST CSP — without this line
    // no framework script gets a nonce and every streamed route stays blocked.
    expect(middlewareSrc).toContain('headers.set("Content-Security-Policy"');
    expect(middlewareSrc).toContain('response.headers.set("Content-Security-Policy"');
    expect(cspSrc).toContain("'nonce-${nonce}'");
    expect(cspSrc).toContain("'strict-dynamic'");
    expect(cspSrc).toContain("frame-ancestors 'none'");
    expect(cspSrc).toContain("object-src 'none'");
    expect(cspSrc).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(middlewareSrc).not.toContain("unsafe-eval");
    // The issued policy itself never grants eval.
    expect(buildCsp("dGVzdG5vbmNlMTIzNDU2Nzg=")).not.toContain("unsafe-eval");
    // No second static policy in next.config: two policies intersect and break.
    expect(configSrc).not.toContain('key: "Content-Security-Policy"');
  });

  it("forces dynamic rendering so static HTML can never ship a stale nonce", () => {
    // Per-request nonces cannot survive prerendering: the root layout stays
    // dynamic so every route renders per-request with the request's nonce.
    expect(layoutSrc).toContain('export const dynamic = "force-dynamic"');
  });

  it("serves hardening headers on all routes and hides the fingerprint", () => {
    expect(configSrc).toContain('source: "/:path*"');
    expect(configSrc).toContain("X-Content-Type-Options");
    expect(configSrc).toContain("nosniff");
    expect(configSrc).toContain("Referrer-Policy");
    expect(configSrc).toContain("Permissions-Policy");
    expect(configSrc).toContain("poweredByHeader: false");
  });
});

describe("public trust surface ships with the app", () => {
  const root = process.cwd();

  it("exposes robots, sitemap, security.txt, and a security page", () => {
    for (const f of [
      "src/app/robots.ts",
      "src/app/sitemap.ts",
      "src/app/.well-known/security.txt/route.ts",
      "src/app/security/page.tsx",
    ]) {
      expect(readFileSync(join(root, f), "utf8").length).toBeGreaterThan(0);
    }
    const robots = readFileSync(join(root, "src/app/robots.ts"), "utf8");
    expect(robots).toContain("/api/");
    const securityTxt = readFileSync(join(root, "src/app/.well-known/security.txt/route.ts"), "utf8");
    expect(securityTxt).toContain("Contact:");
    expect(securityTxt).not.toMatch(/@gmail|@thesma\.(com|io)/);
  });

  it("never triggers a wallet from a public page without a click", () => {
    // Static guarantee: the only wallet-request call sites live in explicit
    // click handlers, never in effects or module scope.
    const buy = readFileSync(join(root, "src/components/buy/BuyCheckout.tsx"), "utf8");
    const funding = readFileSync(join(root, "src/components/app/CampaignFunding.tsx"), "utf8");
    // Funding discovery lives in a shared helper invoked only from click
    // handlers (begin/switchChain/execute) — the same boot-path ban applies.
    const walletLib = readFileSync(join(root, "src/lib/wallet.ts"), "utf8");
    for (const [name, src] of [["BuyCheckout", buy], ["CampaignFunding", funding], ["wallet helper", walletLib]] as const) {
      // No request call inside a useEffect boot path.
      const effects = src.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[/g) ?? [];
      for (const e of effects) expect(e, `${name} effect`).not.toContain("eth_requestAccounts");
    }
    // Wallet requests exist and live behind explicit user gestures:
    // BuyCheckout calls the provider directly; CampaignFunding reaches it
    // only through the shared helper invoked from click handlers.
    expect(buy.split("eth_requestAccounts").length - 1, "BuyCheckout wallet requests").toBeGreaterThan(0);
    const fundingRequests =
      funding.split("eth_requestAccounts").length - 1 + walletLib.split("eth_requestAccounts").length - 1;
    expect(fundingRequests, "CampaignFunding wallet requests (component + helper)").toBeGreaterThan(0);
    expect(funding, "CampaignFunding uses the shared discovery helper").toContain("discoverWallet");
    // Nobody asks for the one thing a wallet must never reveal.
    for (const [name, src] of [["BuyCheckout", buy], ["CampaignFunding", funding], ["wallet helper", walletLib]] as const) {
      expect(src.toLowerCase(), name).not.toContain("seed phrase");
      expect(src.toLowerCase(), name).not.toContain("recovery phrase");
      expect(src.toLowerCase(), name).not.toContain("private key");
    }
  });
});
