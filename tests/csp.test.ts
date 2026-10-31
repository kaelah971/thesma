import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce } from "@/server/security/csp";

/**
 * Production CSP unit contract (fast, deterministic).
 *
 * End-to-end propagation (header → rendered nonce → browser acceptance →
 * hydration) is covered by the real-browser smoke test
 * (`npm run test:browser`), which fails on any blocked first-party script.
 */

const NONCE = "dGVzdG5vbmNlMTIzNDU2Nzg=";

describe("production CSP builder", () => {
  it("emits a complete, restrictive policy around the request nonce", () => {
    const csp = buildCsp(NONCE);
    expect(csp).toContain(`'nonce-${NONCE}'`);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("font-src 'self' data:");
  });

  it("script-src uses nonce + strict-dynamic without unsafe-inline or eval", () => {
    const csp = buildCsp(NONCE);
    const script = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;
    expect(script).toContain("'strict-dynamic'");
    expect(script).toContain(`'nonce-${NONCE}'`);
    expect(script).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("never allows wildcard script sources", () => {
    const csp = buildCsp(NONCE);
    const script = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;
    expect(script).not.toContain("*");
  });

  it("style-src keeps unsafe-inline for React style attributes (documented, no external styles)", () => {
    const csp = buildCsp(NONCE);
    const style = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("style-src"))!;
    expect(style).toContain("'unsafe-inline'");
    expect(style).not.toContain("http");
  });

  it("generates a fresh, well-formed nonce per request", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    for (const n of [a, b, NONCE]) {
      expect(n).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(buildCsp(n)).toContain(`'nonce-${n}'`);
    }
  });
});
