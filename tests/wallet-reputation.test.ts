import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

function sources(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".next" || e.name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts")) {
        out.push({ name: p.slice(root.length + 1), src: readFileSync(p, "utf8") });
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "");

/**
 * Wallet-reputation static inventory (MetaMask/Blockaid false-positive guard).
 * Pins the absence of every drainer-like pattern on every CI run: no silent
 * prompts, no raw signing, no approvals/permits, no transaction outside the
 * three explicit, preview-gated call sites.
 */
describe("wallet reputation (no drainer patterns)", () => {
  const files = sources();
  const code = files.map((f) => stripComments(f.src)).join("\n");

  it("no personal_sign / eth_sign / watchAsset / Permit call sites", () => {
    expect(code).not.toMatch(/method:\s*["']personal_sign["']/);
    expect(code).not.toMatch(/method:\s*["']eth_sign["']/);
    expect(code).not.toMatch(/wallet_watchAsset/);
    expect(code).not.toMatch(/Permit2/);
    expect(code).not.toMatch(/[.\s]permit\s*\(/i);
  });

  it("eth_sendTransaction exists only at the three preview-gated sites", () => {
    const hits = code.split('method: "eth_sendTransaction"').length - 1;
    expect(hits).toBe(3);
  });

  it("no iframes, popup wallets, or location redirects in components", () => {
    expect(code).not.toContain("<iframe");
    expect(code).not.toContain("window.open(");
    expect(code).not.toContain("location.href =");
    expect(code).not.toContain("location.assign(");
    expect(code).not.toContain("location.replace(");
  });

  it("no third-party script origins and no unsafe CSP", () => {
    const csp = stripComments(readFileSync(join(root, "src/server/security/csp.ts"), "utf8"));
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(code).not.toContain("googletagmanager");
    expect(code).not.toContain("facebook.net");
    expect(code).not.toContain("hotjar");
  });

  it("account permission is never requested outside explicit handlers", () => {
    // Both call sites are click-gated (boot-path ban asserted separately in
    // security-trust.test.ts): the shared helper and the legacy checkout flow.
    const requesters = files
      .filter((f) => stripComments(f.src).includes("eth_requestAccounts"))
      .map((f) => f.name.split(/[\\/]/).slice(-2).join("/"));
    expect(requesters.sort()).toEqual(["buy/BuyCheckout.tsx", "lib/wallet.ts"]);
  });
});
