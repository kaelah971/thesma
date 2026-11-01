import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCompanyWalletTypedData,
  classifySignError,
  normalizeSignError,
  safeSignMessage,
  signCompanyWalletTypedDataDetailed,
  signFailureCopy,
  signRpcCodeOf,
  type InjectedProvider,
} from "@/lib/wallet";

/**
 * P0 COMPANY-WALLET SIGNATURE FAILURE DIAGNOSIS.
 *
 * Clean-profile production state: correct MetaMask account, Arc Mainnet,
 * provider discovery = MetaMask, EIP-712 hashes proven identical, no
 * provider collision. The remaining failure is opaque:
 * "MetaMask could not sign. Try again."
 *
 * These tests pin truthful, diagnostic signing failures WITHOUT changing
 * account selection, EIP-712 schema, server recovery, challenge
 * architecture, or provider selection. Exactly one eth_signTypedData_v4
 * per click; no retry; no fallback method; no transaction; no
 * registration or funding on failure. Throwaway values only.
 */

const root = join(__dirname, "..");
const ACCOUNT = "0x15b8605e7ce72e114abeaf1d8b3315c0874b53e7";

function typedData() {
  return buildCompanyWalletTypedData({
    workspaceId: "ws-A",
    nonce: "00000000-0000-0000-0000-000000000000",
    issuedAt: "2026-06-01T12:00:00.000Z",
    expiresAt: "2026-06-01T12:10:00.000Z",
  });
}

function coded(code: unknown, message = "provider boom"): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

function rejectingProvider(err: unknown, calls: string[] = []): InjectedProvider {
  return {
    async request({ method }: { method: string; params?: unknown }) {
      calls.push(method);
      if (method === "eth_signTypedData_v4") throw err;
      return null;
    },
  } as InjectedProvider;
}

function captureProvider(calls: string[] = [], seen: { method: string; params: unknown }[] = []): InjectedProvider {
  return {
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      seen.push({ method, params });
      if (method === "eth_signTypedData_v4") return "0x" + "ab".repeat(65);
      if (method === "eth_accounts") return [ACCOUNT];
      if (method === "eth_chainId") return "0x13b2";
      return null;
    },
  } as InjectedProvider;
}

describe("sign error classification", () => {
  it("1. 4001 → USER_REJECTED", () => {
    expect(classifySignError(coded(4001, "User rejected the request"))).toBe("USER_REJECTED");
    const safe = normalizeSignError(coded(4001, "User rejected the request"));
    expect(safe.code).toBe(4001);
    expect(safe.rpcCode).toBeNull();
    expect(safe.classification).toBe("USER_REJECTED");
    expect(signFailureCopy("USER_REJECTED")).toBe("Signature request was rejected. Nothing was registered.");
  });

  it("2. outer code 53 + rpcCode 4001 → USER_REJECTED (wrapped cancellation)", () => {
    const flat = Object.assign(new Error("canceled"), { code: 53, rpcCode: 4001 });
    expect(signRpcCodeOf(flat)).toBe(4001);
    expect(classifySignError(flat)).toBe("USER_REJECTED");
    const nested = Object.assign(new Error("canceled"), { code: 53, data: { rpcCode: 4001 } });
    expect(signRpcCodeOf(nested)).toBe(4001);
    expect(classifySignError(nested)).toBe("USER_REJECTED");
    expect(normalizeSignError(flat).classification).toBe("USER_REJECTED");
  });

  it("3. -32002 → REQUEST_ALREADY_PENDING", () => {
    expect(classifySignError(coded(-32002, "Already processing"))).toBe("REQUEST_ALREADY_PENDING");
    expect(signFailureCopy("REQUEST_ALREADY_PENDING")).toBe(
      "A MetaMask signature request is already open. Finish or cancel it in MetaMask, then try again.",
    );
  });

  it("4. 4100 → UNAUTHORIZED", () => {
    expect(classifySignError(coded(4100, "Unauthorized"))).toBe("UNAUTHORIZED");
    expect(signFailureCopy("UNAUTHORIZED")).toBe(
      "MetaMask has not authorized this account for the site. Reconnect the wallet and try again.",
    );
  });

  it("5. 4200 → UNSUPPORTED_METHOD", () => {
    expect(classifySignError(coded(4200, "Unsupported method"))).toBe("UNSUPPORTED_METHOD");
    expect(signFailureCopy("UNSUPPORTED_METHOD")).toBe(
      "MetaMask did not support this signing request. No wallet was registered.",
    );
  });

  it("6. -32602 → INVALID_PARAMS", () => {
    expect(classifySignError(coded(-32602, "Invalid params"))).toBe("INVALID_PARAMS");
    expect(signFailureCopy("INVALID_PARAMS")).toBe(
      "The signing request was rejected as invalid. No wallet was registered.",
    );
  });

  it("7. -32603 → PROVIDER_INTERNAL_ERROR", () => {
    expect(classifySignError(coded(-32603, "Internal error"))).toBe("PROVIDER_INTERNAL_ERROR");
    expect(signFailureCopy("PROVIDER_INTERNAL_ERROR")).toBe(
      "MetaMask returned an internal signing error. No wallet was registered.",
    );
  });

  it("8. phishing/deceptive/malicious/security text → SECURITY_BLOCKED, never bypass copy", () => {
    for (const message of [
      "This site shows signs of phishing and is blocked",
      "Deceptive site ahead",
      "Blocked for malicious behavior",
      "Security threat detected by the wallet",
      "Suspicious site blocked",
    ]) {
      expect(classifySignError(new Error(message))).toBe("SECURITY_BLOCKED");
    }
    // Security text wins over a generic internal code.
    expect(classifySignError(coded(-32603, "Request blocked: security policy"))).toBe("SECURITY_BLOCKED");
    const copy = signFailureCopy("SECURITY_BLOCKED");
    expect(copy).toBe("MetaMask's security layer prevented the signature request. No wallet was registered.");
    expect(copy.toLowerCase()).not.toContain("bypass");
    expect(copy.toLowerCase()).not.toContain("connect anyway");
    expect(copy.toLowerCase()).not.toContain("turn off");
    expect(copy.toLowerCase()).not.toContain("disable");
  });

  it("9. unknown error → UNKNOWN_SIGNING_ERROR", () => {
    expect(classifySignError(new Error("weird transport boom"))).toBe("UNKNOWN_SIGNING_ERROR");
    expect(classifySignError(null)).toBe("UNKNOWN_SIGNING_ERROR");
    expect(classifySignError(undefined)).toBe("UNKNOWN_SIGNING_ERROR");
    expect(signFailureCopy("UNKNOWN_SIGNING_ERROR")).toBe("MetaMask could not sign. Try again.");
  });

  it("account-change text → ACCOUNT_CHANGED", () => {
    expect(classifySignError(new Error("unknown account"))).toBe("ACCOUNT_CHANGED");
    expect(signFailureCopy("ACCOUNT_CHANGED")).toBe("Your active wallet changed. Re-select the company wallet.");
  });

  it("safe fields only: code, rpcCode, message, classification", () => {
    const safe = normalizeSignError(coded(4001, "User rejected the request"));
    expect(Object.keys(safe).sort()).toEqual(["classification", "code", "message", "rpcCode"]);
    expect(JSON.stringify(safe)).not.toContain("stack");
    expect("stack" in safe).toBe(false);
    expect("signature" in safe).toBe(false);
  });

  it("safe message redacts hex material, collapses whitespace, truncates", () => {
    const hex = `0x${"ab".repeat(65)}`;
    expect(safeSignMessage(new Error(`boom ${hex} end`))).toBe("boom [redacted] end");
    expect(safeSignMessage(new Error("  a\n  b  "))).toBe("a b");
    const long = safeSignMessage(new Error("x".repeat(500)));
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.endsWith("…")).toBe(true);
    expect(safeSignMessage(new Error(""))).toContain("no message");
  });
});

describe("sign call truth (single exact-shape request)", () => {
  it("13. exactly one eth_signTypedData_v4 per click, even on failure", async () => {
    const failCalls: string[] = [];
    const failed = await signCompanyWalletTypedDataDetailed(
      rejectingProvider(coded(4001, "User rejected the request"), failCalls),
      ACCOUNT,
      typedData(),
    );
    expect("signError" in failed).toBe(true);
    expect(failCalls).toEqual(["eth_signTypedData_v4"]);

    const okCalls: string[] = [];
    const ok = await signCompanyWalletTypedDataDetailed(captureProvider(okCalls), ACCOUNT, typedData());
    expect("signature" in ok).toBe(true);
    expect(okCalls).toEqual(["eth_signTypedData_v4"]);
  });

  it("sign request shape is exactly [selected account, frozen typedData JSON]", async () => {
    const calls: string[] = [];
    const seen: { method: string; params: unknown }[] = [];
    const typed = typedData();
    const res = await signCompanyWalletTypedDataDetailed(captureProvider(calls, seen), ACCOUNT, typed);
    expect("signature" in res).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("eth_signTypedData_v4");
    const params = seen[0].params as [string, string];
    expect(params[0]).toBe(ACCOUNT);
    expect(params[1]).toBe(JSON.stringify(typed));
    expect(JSON.parse(params[1])).toEqual(JSON.parse(JSON.stringify(typed)));
    expect(JSON.parse(params[1]).domain).toMatchObject({ name: "Thesma", version: "1", chainId: 5042 });
  });

  it("17. failure carries no signature, so no proof or registration can follow", async () => {
    const res = await signCompanyWalletTypedDataDetailed(
      rejectingProvider(coded(-32603, "Internal error")),
      ACCOUNT,
      typedData(),
    );
    expect("signature" in res).toBe(false);
    if ("signError" in res) {
      expect(res.signError.classification).toBe("PROVIDER_INTERNAL_ERROR");
      expect(JSON.stringify(res)).not.toMatch(/0x[0-9a-fA-F]{64,}/);
    } else {
      throw new Error("expected a normalized sign error");
    }
  });
});

describe("component + helper safety rails", () => {
  it("10. failures surface as normal product errors, never raw provider data", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    // No failure panel with safe-field dumps remains in production UX.
    expect(src).not.toContain("SIGNATURE REQUEST FAILED");
    expect(src).not.toContain("safe message");
    expect(src).not.toContain("classified as");
    expect(src).not.toContain("rpcCode");
    // The classification still drives a friendly product error.
    expect(src).toContain("signFailureCopy(signed.signError.classification");
    expect(src).toContain("form-error");
    expect(src).not.toContain("JSON.stringify(err");
    expect(src).not.toContain("String(err");
  });

  it("11. signature never logged", () => {
    for (const file of ["src/components/app/CompanyWalletRegistration.tsx", "src/lib/wallet.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toMatch(/console\.(log|debug|info|warn|error)/);
    }
  });

  it("12. no diagnostic panels remain in production UX", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    expect(src).not.toMatch(/diagnostic/i);
    expect(src).not.toMatch(/temporary/i);
    expect(src).not.toMatch(/debug/i);
    expect(src).not.toContain("EIP-712 diagnostic");
    expect(src).not.toContain("Request routing");
    expect(src).not.toContain("Injected providers discovered");
    expect(src).not.toContain("client typed-data hash");
    expect(src).not.toContain("server typed-data hash");
  });

  it("14/15. no fallback signing methods in component or helper", () => {
    for (const file of ["src/components/app/CompanyWalletRegistration.tsx", "src/lib/wallet.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toMatch(/method:\s*[\"']personal_sign[\"']/);
      expect(src).not.toMatch(/method:\s*[\"']eth_sign[\"']/);
    }
    const component = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    expect(component).not.toContain("personal_sign");
  });

  it("16. no transactions on the signing path", async () => {
    const walletSrc = readFileSync(join(root, "src/lib/wallet.ts"), "utf8");
    expect(walletSrc).not.toMatch(/method:\s*[\"']eth_sendTransaction[\"']/);
    const component = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    expect(component).not.toContain("eth_sendTransaction");
    const calls: string[] = [];
    await signCompanyWalletTypedDataDetailed(captureProvider(calls), ACCOUNT, typedData());
    expect(calls).toEqual(["eth_signTypedData_v4"]);
    await signCompanyWalletTypedDataDetailed(rejectingProvider(coded(4001, "no"), calls), ACCOUNT, typedData());
    expect(calls).toEqual(["eth_signTypedData_v4", "eth_signTypedData_v4"]);
    for (const c of calls) expect(c).not.toMatch(/eth_sendTransaction|approve|permit/);
  });

  it("17/18. failure path cannot reach prove/register/funding endpoints", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    // Single detailed sign call site, ordered before prove; the failure
    // branch throws before any proof request.
    expect(src.split("signCompanyWalletTypedDataDetailed").length - 1).toBe(2);
    expect(src.indexOf("signCompanyWalletTypedDataDetailed")).toBeLessThan(src.indexOf("/company-wallet/prove"));
    const failStart = src.indexOf('if ("signError" in signed)');
    const throwAt = src.indexOf("throw new Error(signFailureCopy", failStart);
    expect(failStart).toBeGreaterThan(-1);
    expect(throwAt).toBeGreaterThan(failStart);
    const failHead = src.slice(failStart, throwAt);
    expect(failHead).not.toContain("postJson");
    expect(throwAt).toBeLessThan(src.indexOf("/company-wallet/prove"));
    // Exactly one registration call site (confirm), never in register().
    expect(src.split("`/api/workspaces/${workspaceId}/company-wallet`").length - 1).toBe(1);
    for (const endpoint of ["funding/actions", "funding-confirm", "funding-submitted", "funding-intent"]) {
      expect(src).not.toContain(endpoint);
    }
    // No retry loop: one guarded click, pending control disabled.
    expect(src).toContain("signingRef");
    expect(src).toContain("signPending");
    expect(src).toContain("disabled={signPending}");
  });
});
