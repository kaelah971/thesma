import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildCompanyWalletTypedData,
  collectEIP6963Announcements,
  diagnoseSelectedProvider,
  discoverWallet,
  labelProviderForLog,
  signCompanyWalletTypedData,
  snapshotWindowEthereum,
  summarizeAnnouncedProviders,
  wrapProviderWithRequestLog,
  type CompanyWalletTypedData,
  type EIP6963Detail,
  type InjectedProvider,
} from "@/lib/wallet";
import { hashCompanyWalletTypedData, recoverCompanyWalletSigner } from "@/lib/walletCrypto";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * P0 PROVIDER IDENTITY DIAGNOSTIC (temporary, owner-only).
 *
 * Production evidence: account param 0x15b8…53e7, client + server recovered
 * 0x6AE2…4F7D, identical typed-data hashes. Selection and hashing are
 * correct — the returned signature is inconsistent with the requested
 * account. This test pins the collision repro WITHOUT registering,
 * funding, or broadcasting:
 *
 * - window.ethereum points at a SECOND wallet (not MetaMask)
 * - EIP-6963 announces MetaMask (+ the second wallet)
 * - discovery must select the exact MetaMask object
 * - eth_signTypedData_v4 must hit THAT object and no other
 *
 * Throwaway dev keys and mocked providers only. No DB, no network.
 */

const root = join(__dirname, "..");

const META_KEY = "0x96d8b4d4a3d1e17a76d1c8114237cc46fb89196fe4db85aae2f9f14c8ba560d7" as const;
const SECOND_KEY = "0xfcf2618f3de1e44b52244479eaa31942a8ac78101d5cc581cc63f5c6e7377532" as const;
const META_ADDR = privateKeyToAccount(META_KEY).address;
const SECOND_ADDR = privateKeyToAccount(SECOND_KEY).address;

function signingProvider(
  privateKey: `0x${string}`,
  calls: string[],
  opts: { isMetaMask?: boolean; selectedAddress?: string; failOnUnknownSigner?: boolean } = {},
): InjectedProvider {
  const account = privateKeyToAccount(privateKey);
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    isMetaMask: opts.isMetaMask,
    selectedAddress: opts.selectedAddress ?? account.address,
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_chainId") return "0x13b2";
      if (method === "eth_signTypedData_v4") {
        const [signer, json] = (params ?? []) as [string, string];
        const payload = JSON.parse(String(json)) as CompanyWalletTypedData;
        if (opts.failOnUnknownSigner !== false && signer.toLowerCase() !== account.address.toLowerCase()) {
          throw Object.assign(new Error("unknown account"), { code: -32602 });
        }
        return account.signTypedData({
          domain: { ...payload.domain },
          types: payload.types,
          primaryType: "CompanyWalletRegistration",
          message: { ...payload.message },
        });
      }
      return null;
    },
    on: (event: string, handler: (...a: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeListener: (event: string, handler: (...a: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    },
  } as InjectedProvider;
}

function installCollisionWindow(meta: InjectedProvider, second: InjectedProvider) {
  const listeners = new Map<string, Set<EventListener>>();
  const win = {
    // window.ethereum points at the SECOND wallet — the collision case.
    ethereum: second,
    addEventListener: (t: string, l: EventListener) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(l);
    },
    removeEventListener: (t: string, l: EventListener) => listeners.get(t)?.delete(l),
    dispatchEvent: (e: Event) => {
      if (e.type === "eip6963:requestProvider") {
        const metaDetail: EIP6963Detail = {
          info: { uuid: "metamask-uuid-1", name: "MetaMask", icon: "", rdns: "io.metamask" },
          provider: meta,
        };
        const secondDetail: EIP6963Detail = {
          info: { uuid: "second-uuid-9", name: "Second Wallet", icon: "", rdns: "io.second.wallet" },
          provider: second,
        };
        for (const detail of [metaDetail, secondDetail]) {
          const announce = new CustomEvent("eip6963:announceProvider", { detail });
          listeners.get("eip6963:announceProvider")?.forEach((l) => l(announce));
        }
      }
      return true;
    },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("CustomEvent", CustomEvent);
  vi.stubGlobal("Event", Event);
  return win;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("provider collision repro (window.ethereum !== MetaMask)", () => {
  it("discovery selects the exact MetaMask object, not window.ethereum", async () => {
    const metaCalls: string[] = [];
    const secondCalls: string[] = [];
    const meta = signingProvider(META_KEY, metaCalls, { isMetaMask: true });
    const second = signingProvider(SECOND_KEY, secondCalls, { isMetaMask: false });
    installCollisionWindow(meta, second);

    const found = await discoverWallet(50);
    expect(found).not.toBeNull();
    // Exact object identity: the selected provider IS the MetaMask mock.
    expect(found!.provider).toBe(meta);
    expect(found!.provider).not.toBe(second);
    expect(found!.isMetaMask).toBe(true);
    expect(found!.source).toBe("eip6963");
    expect(found!.info?.rdns).toBe("io.metamask");
    expect(found!.info?.uuid).toBe("metamask-uuid-1");
    // window.ethereum is the other wallet — collision made visible.
    expect((window as unknown as { ethereum: unknown }).ethereum).toBe(second);
    expect(snapshotWindowEthereum(found!.provider).sameAsSelected).toBe(false);
  });

  it("the selected provider is exactly the object receiving eth_signTypedData_v4", async () => {
    const metaCalls: string[] = [];
    const secondCalls: string[] = [];
    const meta = signingProvider(META_KEY, metaCalls, { isMetaMask: true });
    const second = signingProvider(SECOND_KEY, secondCalls, { isMetaMask: false });
    installCollisionWindow(meta, second);

    const found = await discoverWallet(50);
    expect(found!.provider).toBe(meta);

    // Trace routing through the EXACT selected object (diagnostic wrapper).
    const log: { method: string; handledBy: string; sameAsSelected: boolean }[] = [];
    const traced = wrapProviderWithRequestLog(found!.provider, {
      label: labelProviderForLog(found!.provider, found!.info ?? null),
      info: found!.info ?? null,
      log,
    });
    expect(traced.__target).toBe(meta);
    expect(traced.__target).toBe(found!.provider);

    const typedData = buildCompanyWalletTypedData({
      workspaceId: "ws-collision",
      nonce: "collision-nonce",
      issuedAt: "2026-06-01T12:00:00.000Z",
      expiresAt: "2026-06-01T12:10:00.000Z",
    });
    // Account param is the MetaMask account (mirrors the UI-selected account).
    const accountParam = META_ADDR;
    const signed = await signCompanyWalletTypedData(traced, accountParam, typedData);
    expect("signature" in signed).toBe(true);

    // Proof by identity + call routing: MetaMask handled the sign, the
    // second wallet never saw eth_signTypedData_v4.
    expect(metaCalls).toContain("eth_signTypedData_v4");
    expect(secondCalls).not.toContain("eth_signTypedData_v4");
    expect(log.filter((e) => e.method === "eth_signTypedData_v4")).toHaveLength(1);
    expect(log.find((e) => e.method === "eth_signTypedData_v4")?.sameAsSelected).toBe(true);

    // Client recovery matches the signer that actually signed (no mismatch
    // in this controlled mock — the panel surfaces both values so a real
    // collision is provable in production).
    const clientHash = hashCompanyWalletTypedData(typedData);
    const clientRecovered = await recoverCompanyWalletSigner(typedData, (signed as { signature: string }).signature);
    expect(clientRecovered.toLowerCase()).toBe(META_ADDR.toLowerCase());
    expect(typeof clientHash).toBe("string");
    expect(clientHash.startsWith("0x")).toBe(true);
  });

  it("identity diagnostics expose accounts/chain without signatures or secrets", async () => {
    const metaCalls: string[] = [];
    const secondCalls: string[] = [];
    const meta = signingProvider(META_KEY, metaCalls, { isMetaMask: true });
    const second = signingProvider(SECOND_KEY, secondCalls, { isMetaMask: false });
    installCollisionWindow(meta, second);

    const found = await discoverWallet(50);
    const diag = await diagnoseSelectedProvider(found!.provider, {
      info: found!.info ?? null,
      source: found!.source ?? null,
    });
    expect(diag.infoName).toBe("MetaMask");
    expect(diag.infoRdns).toBe("io.metamask");
    expect(diag.infoUuid).toBe("metamask-uuid-1");
    expect(diag.isMetaMask).toBe(true);
    expect(diag.sameAsWindowEthereum).toBe(false);
    // window.ethereum has no providers[] array in this fixture.
    expect(diag.windowEthereumProvidersCount).toBeNull();
    expect(diag.accounts).toEqual([META_ADDR]);
    expect(diag.selectedAddress).toBe(META_ADDR);
    expect(diag.chainId).toBe("0x13b2");
    // No signature, nonce, or secret material in the diagnostic object.
    expect(JSON.stringify(diag)).not.toMatch(/0x[0-9a-f]{100,}/i);
    expect(JSON.stringify(diag).toLowerCase()).not.toContain("private");
    expect(JSON.stringify(diag).toLowerCase()).not.toContain("signature");
    expect(JSON.stringify(diag).toLowerCase()).not.toContain("mnemonic");
    // Diagnosing never signs: neither mock saw eth_signTypedData_v4.
    expect(metaCalls).not.toContain("eth_signTypedData_v4");
    expect(secondCalls).not.toContain("eth_signTypedData_v4");
  });

  it("multiple EIP-6963 announcements list without invoking signing", async () => {
    const metaCalls: string[] = [];
    const secondCalls: string[] = [];
    const meta = signingProvider(META_KEY, metaCalls, { isMetaMask: true });
    const second = signingProvider(SECOND_KEY, secondCalls, { isMetaMask: false });
    installCollisionWindow(meta, second);

    const details = await collectEIP6963Announcements(50);
    expect(details).toHaveLength(2);
    const summaries = summarizeAnnouncedProviders(details);
    expect(summaries).toHaveLength(2);
    const byRdns = new Map(summaries.map((s) => [s.rdns, s]));
    expect(byRdns.get("io.metamask")).toMatchObject({ name: "MetaMask", uuid: "metamask-uuid-1", isMetaMask: true });
    expect(byRdns.get("io.second.wallet")).toMatchObject({ name: "Second Wallet", uuid: "second-uuid-9", isMetaMask: false });
    // Listing never calls request on any provider (no eth_accounts, no sign).
    expect(metaCalls).toEqual([]);
    expect(secondCalls).toEqual([]);
  });

  it("request log records which provider handled each tracked method", async () => {
    const metaCalls: string[] = [];
    const secondCalls: string[] = [];
    const meta = signingProvider(META_KEY, metaCalls, { isMetaMask: true });
    const second = signingProvider(SECOND_KEY, secondCalls, { isMetaMask: false });
    installCollisionWindow(meta, second);

    const found = await discoverWallet(50);
    const log: { method: string; handledBy: string; sameAsSelected: boolean }[] = [];
    const traced = wrapProviderWithRequestLog(found!.provider, {
      label: "MetaMask (io.metamask)",
      info: found!.info ?? null,
      log,
    });
    await traced.request({ method: "eth_accounts" });
    await traced.request({ method: "eth_chainId" });
    const typedData = buildCompanyWalletTypedData({
      workspaceId: "ws-log",
      nonce: "log-nonce",
      issuedAt: "2026-06-01T12:00:00.000Z",
      expiresAt: "2026-06-01T12:10:00.000Z",
    });
    await signCompanyWalletTypedData(traced, META_ADDR, typedData);
    const methods = log.map((e) => e.method);
    expect(methods).toContain("eth_accounts");
    expect(methods).toContain("eth_chainId");
    expect(methods).toContain("eth_signTypedData_v4");
    for (const entry of log) {
      expect(entry.handledBy).toContain("MetaMask");
      expect(entry.sameAsSelected).toBe(true);
    }
    expect(secondCalls).toEqual([]);
  });
});

describe("production UX safety", () => {
  it("component shows a clean wallet UX with no diagnostic surfaces", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    for (const needle of [
      "Company wallet",
      "Verified",
      "Used to sign and fund campaigns.",
      "Change wallet",
      "truncateAddress(account)",
      "signingRef",
      "signFailureCopy",
      "discoverWallet()",
    ]) {
      expect(src).toContain(needle);
    }
    // No temporary debugging surfaces remain in production UX.
    expect(src).not.toMatch(/diagnostic/i);
    expect(src).not.toMatch(/temporary/i);
    expect(src).not.toMatch(/debug/i);
    expect(src).not.toContain("SIGNATURE REQUEST FAILED");
    expect(src).not.toContain("safe message");
    expect(src).not.toContain("classified as");
    expect(src).not.toContain("Request routing");
    expect(src).not.toContain("Injected providers discovered");
    expect(src).not.toContain("Selected provider");
    expect(src).not.toContain("EIP-712 diagnostic");
    // No signature value is ever interpolated into the UI.
    expect(src).not.toMatch(/\{signed\.signature\}/);
    expect(src).not.toMatch(/\{signature\}/);
    // Selection behavior untouched: exactly one discoverWallet call site.
    expect(src.match(/discoverWallet\(\)/g)?.length ?? 0).toBe(1);
    expect(src).not.toContain("Northstar");
    expect(src).not.toContain("eth_sendTransaction");
  });

  it("wallet helper stays dependency-free and never broadcasts", () => {
    const src = readFileSync(join(root, "src/lib/wallet.ts"), "utf8");
    expect(src).not.toContain("@/server");
    expect(src).not.toMatch(/method:\s*["']eth_sendTransaction["']/);
    expect(src).not.toContain("Northstar");
  });
});
