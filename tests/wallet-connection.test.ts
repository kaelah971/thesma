import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  connectWallet,
  connectionFailureCopy,
  discoverWallet,
  signCompanyWalletTypedData,
  buildCompanyWalletTypedData,
  type InjectedProvider,
  type WalletFailure,
} from "@/lib/wallet";
import { normalizeAddress } from "@/server/chain/arc";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * Truthful wallet-connection states (production "could not connect" fix).
 *
 * The old code collapsed every connect failure into "unlock MetaMask".
 * These tests pin the real mapping: silent probe first, explicit request
 * only on user action, precise failure codes, neutral copy, one provider
 * throughout, and zero transactions/approvals on the whole path.
 */

const root = join(__dirname, "..");
const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";

function mockProvider(onRequest: (method: string, params?: unknown) => unknown, calls: string[] = []): InjectedProvider {
  return {
    isMetaMask: true,
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      return onRequest(method, params);
    },
  } as InjectedProvider;
}

function throwingProvider(code: unknown, message: string, emptyProbe = true): { provider: InjectedProvider; calls: string[] } {
  const calls: string[] = [];
  const provider = mockProvider((method) => {
    if (method === "eth_accounts") return emptyProbe ? [] : [ACCOUNT];
    if (method === "eth_requestAccounts") throw Object.assign(new Error(message), code === undefined ? {} : { code });
    return null;
  }, calls);
  return { provider, calls };
}

describe("connection states", () => {
  it("available account connects with no permission prompt", async () => {
    const calls: string[] = [];
    const provider = mockProvider(() => [ACCOUNT], calls);
    await expect(connectWallet(provider)).resolves.toEqual({ account: ACCOUNT });
    expect(calls).toEqual(["eth_accounts"]);
  });

  it("empty probe triggers exactly one explicit request", async () => {
    const calls: string[] = [];
    const provider = mockProvider((m) => (m === "eth_accounts" ? [] : [ACCOUNT]), calls);
    await expect(connectWallet(provider)).resolves.toEqual({ account: ACCOUNT });
    expect(calls.filter((c) => c === "eth_requestAccounts")).toHaveLength(1);
  });

  it.each([
    [4001, "USER_REJECTED", "Connection request was rejected. Try again when ready."],
    [-32002, "REQUEST_ALREADY_PENDING", "A wallet connection request is already open. Finish or cancel it in the wallet, then try again."],
    [4100, "PERMISSION_REQUIRED", "did not grant access"],
    [4900, "PROVIDER_DISCONNECTED", "disconnected"],
    [4901, "PROVIDER_DISCONNECTED", "disconnected"],
  ])("code %s maps to %s with truthful copy", async (code, failure, copyFragment) => {
    const { provider, calls } = throwingProvider(code, `provider error ${code}`);
    await expect(connectWallet(provider)).resolves.toEqual({ failure });
    expect(calls.filter((c) => c === "eth_requestAccounts")).toHaveLength(1);
    expect(connectionFailureCopy(failure as WalletFailure, "MetaMask")).toContain(copyFragment);
  });

  it("unauthorized message maps to PERMISSION_REQUIRED", async () => {
    const { provider } = throwingProvider(undefined, "The requested method has not been authorized");
    await expect(connectWallet(provider)).resolves.toEqual({ failure: "PERMISSION_REQUIRED" });
  });

  it("disconnected message maps to PROVIDER_DISCONNECTED", async () => {
    const { provider } = throwingProvider(undefined, "Provider disconnected");
    await expect(connectWallet(provider)).resolves.toEqual({ failure: "PROVIDER_DISCONNECTED" });
  });

  it("security-block message maps to SECURITY_BLOCKED with neutral copy", async () => {
    const { provider } = throwingProvider(undefined, "This site shows signs of phishing and is blocked");
    await expect(connectWallet(provider)).resolves.toEqual({ failure: "SECURITY_BLOCKED" });
    const copy = connectionFailureCopy("SECURITY_BLOCKED", "MetaMask");
    expect(copy).toContain("preventing this site from connecting");
    expect(copy.toLowerCase()).not.toContain("bypass");
    expect(copy.toLowerCase()).not.toContain("unlock");
  });

  it("empty account result never claims the wallet is locked", async () => {
    const calls: string[] = [];
    const provider = mockProvider(() => [], calls);
    await expect(connectWallet(provider)).resolves.toEqual({ failure: "NO_ACCOUNT" });
    const copy = connectionFailureCopy("NO_ACCOUNT", "MetaMask");
    expect(copy.toLowerCase()).not.toContain("unlock");
    expect(copy.toLowerCase()).not.toContain("locked");
  });

  it("generic provider failure never claims unlock", async () => {
    const { provider } = throwingProvider(undefined, "weird transport boom");
    await expect(connectWallet(provider)).resolves.toEqual({ failure: "PROVIDER_ERROR" });
    expect(connectionFailureCopy("PROVIDER_ERROR", "MetaMask").toLowerCase()).not.toContain("unlock");
  });

  it("USER_REJECTED copy stays actionable without unlock claims", () => {
    expect(connectionFailureCopy("USER_REJECTED", "MetaMask")).toContain("Try again");
  });

  it("failure results carry no account, no signature, no transaction", async () => {
    const { provider, calls } = throwingProvider(4001, "User rejected the request");
    const res = await connectWallet(provider);
    expect(res).toEqual({ failure: "USER_REJECTED" });
    expect(JSON.stringify(res)).not.toContain("0x");
    for (const c of calls) {
      expect(c).not.toMatch(/eth_sendTransaction|eth_sign|approve|permit/);
    }
  });

  it("same EIP-6963 provider is used for probe, connect, and sign", async () => {
    const metaCalls: string[] = [];
    const otherCalls: string[] = [];
    const meta = mockProvider((m) => {
      if (m === "eth_signTypedData_v4") return "0x" + "ab".repeat(65);
      return [ACCOUNT];
    }, metaCalls);
    (meta as { isMetaMask?: boolean }).isMetaMask = true;
    const other = mockProvider(() => [ACCOUNT], otherCalls);
    (other as { isMetaMask?: boolean }).isMetaMask = false;
    const listeners = new Map<string, Set<EventListener>>();
    vi.stubGlobal("window", {
      ethereum: other,
      addEventListener: (t: string, l: EventListener) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(l);
      },
      removeEventListener: (t: string, l: EventListener) => listeners.get(t)?.delete(l),
      dispatchEvent: (e: Event) => {
        if (e.type === "eip6963:requestProvider") {
          listeners.get("eip6963:announceProvider")?.forEach((l) =>
            l(new CustomEvent("eip6963:announceProvider", {
              detail: { info: { uuid: "u", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: meta },
            })),
          );
        }
        return true;
      },
    });
    vi.stubGlobal("CustomEvent", CustomEvent);
    vi.stubGlobal("Event", Event);
    try {
      const found = await discoverWallet(50);
      expect(found?.provider).toBe(meta);
      const connected = await connectWallet(found!.provider);
      expect(connected).toEqual({ account: ACCOUNT });
      const typedData = buildCompanyWalletTypedData({
        workspaceId: "ws-A", nonce: "n",
        issuedAt: "2026-06-01T12:00:00.000Z", expiresAt: "2026-06-01T12:10:00.000Z",
      });
      const signed = await signCompanyWalletTypedData(found!.provider, normalizeAddress(ACCOUNT), typedData);
      expect("signature" in signed).toBe(true);
      expect(otherCalls).toEqual([]);
      expect(metaCalls).not.toContain("eth_sendTransaction");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("connect path never requests accounts on render and never loops", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    expect(src).not.toContain("eth_requestAccounts");
    expect(src).not.toContain("eth_sendTransaction");
    expect(src).not.toContain("personal_sign");
    // No auto-connect effect: effects only subscribe to account changes.
    const effects = src.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/g) ?? [];
    for (const e of effects) {
      expect(e).not.toContain("connectWallet(");
      expect(e).not.toContain("discoverWallet(");
    }
  });

  it("wallet helper is dependency-free (no store, no network, no funds)", () => {
    const src = readFileSync(join(root, "src/lib/wallet.ts"), "utf8");
    expect(src).not.toContain("@/server");
    expect(src).not.toContain("getDb");
    expect(src).not.toMatch(/method:\s*["']personal_sign["']/);
    expect(src).not.toMatch(/method:\s*["']eth_sign["']/);
    expect(src).not.toContain("wallet_watchAsset");
    expect(src).not.toMatch(/[.\s]permit\s*\(/i);
    expect(src).not.toContain("Permit2");
  });
});
