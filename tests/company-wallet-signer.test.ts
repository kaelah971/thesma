import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
  type FundingStore,
} from "@/server/services/campaignStore";
import {
  proveCompanyWalletChallenge,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";
import {
  buildCompanyWalletTypedData,
  connectWallet,
  defaultSelectedAccount,
  discoverWallet,
  resolveAccountChange,
  selectChallengePayload,
  signCompanyWalletTypedData,
  type CompanyWalletTypedData,
  type InjectedProvider,
} from "@/lib/wallet";
import { normalizeAddress } from "@/server/chain/arc";
import { registerTestWallet, signWalletRegistration, TEST_OWNER_PRIVATE_KEY } from "./wallet-fixtures";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * Active-signer binding (production SIGNER_MISMATCH fix).
 *
 * Never assumes accounts[0] is the UI-selected account: the selection is
 * explicit, the SAME EIP-6963 provider is used for every call, the signer
 * param is exactly the frozen challenge wallet, and accountsChanged
 * invalidates the flow. Throwaway dev keys and mocked providers only.
 */

const root = join(__dirname, "..");
const OWNER_ADDR = privateKeyToAccount(TEST_OWNER_PRIVATE_KEY).address;
const SECOND_KEY = "0xfcf2618f3de1e44b52244479eaa31942a8ac78101d5cc581cc63f5c6e7377532" as const;
const SECOND_ADDR = privateKeyToAccount(SECOND_KEY).address;
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" }],
  }) as unknown as FundingStore;
  const { sink } = createMemoryAuditSink();
  const deps: FundingDeps = {
    store, audit: sink, config: null, reader: null, now: () => FIXED_NOW,
    challenges: createMemoryCompanyWalletChallengeStore(),
  };
  return { store, deps };
}

async function fails(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (e) {
    if ((e as Error).message === "expected rejection") throw e;
    return e as { status?: number; code?: string; message: string };
  }
}

/** Mock injected wallet that locally signs typed data with a test key. */
function signingMock(privateKey: `0x${string}`, calls: string[] = [], opts: { isMetaMask?: boolean; selectedAddress?: string } = {}): InjectedProvider {
  const account = privateKeyToAccount(privateKey);
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    isMetaMask: opts.isMetaMask ?? true,
    selectedAddress: opts.selectedAddress ?? account.address,
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
      if (method === "eth_chainId") return "0x13b2";
      if (method === "eth_signTypedData_v4") {
        const [signer, json] = (params ?? []) as [string, string];
        const payload = JSON.parse(String(json)) as CompanyWalletTypedData;
        if (signer.toLowerCase() !== account.address.toLowerCase()) {
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

describe("explicit account selection", () => {
  it("prefers the wallet UI-selected address when still permitted", () => {
    const list = [OWNER_ADDR, SECOND_ADDR];
    expect(defaultSelectedAccount(list, SECOND_ADDR)).toBe(SECOND_ADDR);
    expect(defaultSelectedAccount(list, SECOND_ADDR.toLowerCase())).toBe(SECOND_ADDR);
    expect(defaultSelectedAccount(list, undefined)).toBe(OWNER_ADDR);
    expect(defaultSelectedAccount(list, "0x0000000000000000000000000000000000000000")).toBe(OWNER_ADDR);
    expect(defaultSelectedAccount([], SECOND_ADDR)).toBeNull();
  });

  it("accountsChanged resolves to the wallet's freshly selected account", () => {
    expect(resolveAccountChange([OWNER_ADDR], [OWNER_ADDR])).toEqual({ changed: false, selection: null });
    expect(resolveAccountChange([OWNER_ADDR], [SECOND_ADDR, OWNER_ADDR])).toEqual({ changed: true, selection: SECOND_ADDR });
    expect(resolveAccountChange([OWNER_ADDR], [])).toEqual({ changed: true, selection: null });
    expect(resolveAccountChange([], [OWNER_ADDR])).toEqual({ changed: true, selection: OWNER_ADDR });
  });

  it("selected account outside the permitted list aborts", () => {
    const typedData = buildCompanyWalletTypedData({
      workspaceId: "ws-A", nonce: "n", issuedAt: FIXED_NOW.toISOString(), expiresAt: FIXED_NOW.toISOString(),
    });
    const challenge = { typedData, nonce: "n", issuedAt: "", expiresAt: "" };
    expect(selectChallengePayload({ challenge, workspaceId: "ws-A", selectedAccount: SECOND_ADDR, availableAccounts: [OWNER_ADDR] }))
      .toEqual({ error: "ACCOUNT_CHANGED" });
    expect(selectChallengePayload({ challenge, workspaceId: "ws-B", selectedAccount: OWNER_ADDR, availableAccounts: [OWNER_ADDR] }))
      .toEqual({ error: "WORKSPACE_MISMATCH" });
    expect(selectChallengePayload({ challenge: null, workspaceId: "ws-A", selectedAccount: OWNER_ADDR, availableAccounts: [OWNER_ADDR] }))
      .toEqual({ error: "NO_CHALLENGE" });
  });
});

describe("active signer end-to-end", () => {
  it("non-first permitted account registers when explicitly selected", async () => {
    const { deps, store } = setup();
    // The second key signs; the recovered signer (not any UI selection) is
    // what gets registered.
    const signed = await signWalletRegistration(deps, {
      workspaceId: "ws-A", userId: "owner-1", privateKey: SECOND_KEY,
    });
    const sel = selectChallengePayload({
      challenge: { typedData: signed.typedData, nonce: signed.nonce, issuedAt: "", expiresAt: "" },
      workspaceId: "ws-A",
      selectedAccount: SECOND_ADDR,
      availableAccounts: [OWNER_ADDR, SECOND_ADDR],
    });
    expect("typedData" in sel).toBe(true);
    const proved = await proveCompanyWalletChallenge(deps, {
      workspaceId: "ws-A", userId: "owner-1", nonce: signed.nonce, signature: signed.signature,
    });
    expect(proved.provedWallet).toBe(SECOND_ADDR);
    const r = await registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", nonce: signed.nonce });
    expect(r.workspace.companyWallet).toBe(SECOND_ADDR);
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBe(SECOND_ADDR);
  });

  it("same EIP-6963 provider is used for every call; window.ethereum never touched", async () => {
    const metaCalls: string[] = [];
    const otherCalls: string[] = [];
    const meta = signingMock(TEST_OWNER_PRIVATE_KEY, metaCalls, { selectedAddress: OWNER_ADDR });
    const other = signingMock(SECOND_KEY, otherCalls, { isMetaMask: false, selectedAddress: SECOND_ADDR });
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
      expect(found?.isMetaMask).toBe(true);
      expect(found?.provider).toBe(meta);
      const connected = await connectWallet(found!.provider);
      expect(connected).toEqual({ account: OWNER_ADDR });
      const typedData = buildCompanyWalletTypedData({
        workspaceId: "ws-A", nonce: "n",
        issuedAt: FIXED_NOW.toISOString(), expiresAt: FIXED_NOW.toISOString(),
      });
      const signed = await signCompanyWalletTypedData(found!.provider, OWNER_ADDR, typedData);
      expect("signature" in signed).toBe(true);
      expect(otherCalls).toEqual([]);
      expect(metaCalls).toContain("eth_signTypedData_v4");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("signer param is the explicitly selected account (never implicit)", async () => {
    const params: unknown[][] = [];
    const paramsProvider: InjectedProvider = {
      isMetaMask: true,
      async request({ method, params: p }: { method: string; params?: unknown }) {
        if (method === "eth_signTypedData_v4") {
          params.push((p ?? []) as unknown[]);
          return "0x00";
        }
        return null;
      },
    } as InjectedProvider;
    const typedData = buildCompanyWalletTypedData({
      workspaceId: "ws-A", nonce: "n",
      issuedAt: FIXED_NOW.toISOString(), expiresAt: FIXED_NOW.toISOString(),
    });
    // The selected account is passed explicitly — the challenge carries no
    // wallet, so nothing here can silently substitute an identity.
    await signCompanyWalletTypedData(paramsProvider, SECOND_ADDR, typedData);
    expect(params).toHaveLength(1);
    expect(params[0][0]).toBe(SECOND_ADDR);
    expect(JSON.parse(String(params[0][1])).message).not.toHaveProperty("wallet");
  });

  it("confirmation without proof fails closed with zero transactions", async () => {
    const calls: string[] = [];
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const err = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", nonce: signed.nonce }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("PROOF_REQUIRED");
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
    // The mock-provider signing path itself only ever calls eth_signTypedData_v4.
    const other = signingMock(SECOND_KEY, calls);
    const typedData = buildCompanyWalletTypedData({
      workspaceId: "ws-A", nonce: "n",
      issuedAt: FIXED_NOW.toISOString(), expiresAt: FIXED_NOW.toISOString(),
    });
    const res = await signCompanyWalletTypedData(other, SECOND_ADDR, typedData);
    expect("signature" in res).toBe(true);
    expect(calls).toEqual(["eth_signTypedData_v4"]);
    for (const c of calls) expect(c).not.toMatch(/eth_sendTransaction|approve|permit/);
  });

  it("component binds one provider, subscribes to account changes, and offers selection", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    expect(src).toContain("accountsChanged");
    // No direct reads of another extension's injected object (comments may name it).
    expect(src).not.toContain("window.ethereum.");
    expect(src).not.toContain("window as unknown");
    expect(src).toContain("company-wallet-account");
    expect(src).toContain("Restart registration");
    expect(src).toContain("selectChallengePayload");
    // Two-phase flow: prove first, explicit confirm registers.
    expect(src).toContain("/company-wallet/prove");
    expect(src).toContain("Register wallet");
    expect(src).toContain("Cancel");
    expect(src).not.toContain("SIGNER_MISMATCH");
  });
});
