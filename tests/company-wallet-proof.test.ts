import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
  type FundingStore,
} from "@/server/services/campaignStore";
import {
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";
import {
  buildCompanyWalletTypedData,
  COMPANY_WALLET_DOMAIN,
  discoverWallet,
  isAccountChanged,
  signCompanyWalletTypedData,
  type CompanyWalletTypedData,
  type InjectedProvider,
} from "@/lib/wallet";
import { normalizeAddress } from "@/server/chain/arc";
import { registerTestWallet, signWalletRegistration, TEST_OWNER_PRIVATE_KEY } from "./wallet-fixtures";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * EIP-712 company-wallet ownership proof (production high-risk-warning fix).
 *
 * The old opaque personal_sign blob triggered MetaMask high-risk warnings
 * and failed recovery; registration now signs structured typed data against
 * a server-issued single-use challenge. Every test uses throwaway dev keys
 * and mocked providers — no transaction, approval, permit, or mainnet call.
 */

const OWNER_ADDR = privateKeyToAccount(TEST_OWNER_PRIVATE_KEY).address;
const OTHER_KEY = "0x6061243ad54fe37befb72e5dbff3eb7aa1ad825e45f9c20508f72a01d372dcc9" as const;
const OTHER_ADDR = "0x9C92Aee7336C0f7521AE41659D19415E9e978fC4";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "owner-1", workspaceId: "ws-B", role: "ORGANIZATION_OWNER" },
    ],
    workspaces: [
      { id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" },
      { id: "ws-B", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Other" },
    ],
  });
  const { sink, events } = createMemoryAuditSink();
  const deps: FundingDeps = {
    store: store as unknown as FundingStore,
    audit: sink,
    config: null,
    reader: null,
    now: () => FIXED_NOW,
    challenges: createMemoryCompanyWalletChallengeStore(),
  };
  return { store, events, deps };
}

async function fails(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (e) {
    if ((e as Error).message === "expected rejection") throw e;
    return e as { status?: number; code?: string; message: string; details?: { recovered?: string } };
  }
}

/** Mock injected provider that locally signs typed data (test key only). */
function signingMockProvider(privateKey: `0x${string}`, calls: string[] = []): InjectedProvider {
  const account = privateKeyToAccount(privateKey);
  return {
    isMetaMask: true,
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
  } as InjectedProvider;
}

describe("EIP-712 ownership proof", () => {
  it("selected account signs and the recovered signer equals the selected wallet", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR });
    const recovered = await recoverTypedDataAddress({
      domain: { ...signed.typedData.domain },
      types: signed.typedData.types,
      primaryType: "CompanyWalletRegistration",
      message: { ...signed.typedData.message },
      signature: signed.signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(OWNER_ADDR.toLowerCase());
    const r = await registerCompanyWallet(deps, {
      workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR, nonce: signed.nonce, signature: signed.signature,
    });
    expect(r.workspace.companyWallet).toBe(OWNER_ADDR);
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBe(OWNER_ADDR);
  });

  it("wrong-wallet signature is rejected as SIGNER_MISMATCH (identity proven, authorization denied)", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR });
    const err = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR, nonce: signed.nonce, signature: signed.signature }),
    );
    expect(err.status).toBe(403);
    expect(err.code).toBe("SIGNER_MISMATCH");
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
  });

  it("workspace A challenge cannot register workspace B", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR });
    const err = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-B", userId: "owner-1", address: OWNER_ADDR, nonce: signed.nonce, signature: signed.signature }),
    );
    expect(err.code).toBe("CHALLENGE_MISMATCH");
    expect((await store.getWorkspace("ws-B"))?.companyWallet).toBeNull();
  });

  it("expired challenges are rejected", async () => {
    const ctx = setup();
    const signed = await signWalletRegistration(ctx.deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR });
    const late = {
      ...ctx.deps,
      now: () => new Date(FIXED_NOW.getTime() + 11 * 60 * 1000),
    };
    const err = await fails(
      registerCompanyWallet(late, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR, nonce: signed.nonce, signature: signed.signature }),
    );
    expect(err.status).toBe(410);
    expect(err.code).toBe("CHALLENGE_EXPIRED");
  });

  it("a challenge cannot be replayed", async () => {
    const { deps } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR });
    const params = { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR, nonce: signed.nonce, signature: signed.signature };
    await registerCompanyWallet(deps, params);
    const err = await fails(registerCompanyWallet(deps, params));
    expect(err.status).toBe(409);
    expect(err.code).toBe("CHALLENGE_USED");
  });

  it("unknown nonces fail closed", async () => {
    const { deps } = setup();
    const err = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR, nonce: "nope", signature: "0x00" }),
    );
    expect(err.status).toBe(404);
    expect(err.code).toBe("CHALLENGE_NOT_FOUND");
  });

  it("account change between selection and signing aborts", () => {
    expect(isAccountChanged(OWNER_ADDR, OWNER_ADDR.toLowerCase())).toBe(false);
    expect(isAccountChanged(OTHER_ADDR, OWNER_ADDR)).toBe(true);
    expect(isAccountChanged(null, OWNER_ADDR)).toBe(true);
  });

  it("user rejection maps to USER_REJECTED (never NOT_INSTALLED)", async () => {
    const rejecting: InjectedProvider = {
      async request({ method }: { method: string }) {
        if (method === "eth_signTypedData_v4") throw Object.assign(new Error("User rejected the request"), { code: 4001 });
        return null;
      },
    } as InjectedProvider;
    const typed = buildCompanyWalletTypedData({
      workspaceId: "ws-A", wallet: OWNER_ADDR, nonce: "n", issuedAt: FIXED_NOW.toISOString(), expiresAt: FIXED_NOW.toISOString(),
    });
    const res = await signCompanyWalletTypedData(rejecting, OWNER_ADDR, typed);
    expect(res).toEqual({ failure: "USER_REJECTED" });
  });

  it("signing uses only eth_signTypedData_v4 — no transactions, approvals, or permits", async () => {
    const calls: string[] = [];
    const provider = signingMockProvider(TEST_OWNER_PRIVATE_KEY, calls);
    const typed = buildCompanyWalletTypedData({
      workspaceId: "ws-A", wallet: normalizeAddress(OWNER_ADDR), nonce: "n", issuedAt: FIXED_NOW.toISOString(), expiresAt: FIXED_NOW.toISOString(),
    });
    const res = await signCompanyWalletTypedData(provider, OWNER_ADDR, typed);
    expect("signature" in res).toBe(true);
    expect(calls).toEqual(["eth_signTypedData_v4"]);
    for (const c of calls) {
      expect(c).not.toMatch(/eth_sendTransaction|eth_signTransaction|approve|permit/);
    }
  });

  it("EIP-6963 MetaMask announcement resolves to the actual signer", async () => {
    const calls: string[] = [];
    const provider = signingMockProvider(TEST_OWNER_PRIVATE_KEY, calls);
    const listeners = new Map<string, Set<EventListener>>();
    vi.stubGlobal("window", {
      ethereum: undefined,
      addEventListener: (t: string, l: EventListener) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(l);
      },
      removeEventListener: (t: string, l: EventListener) => listeners.get(t)?.delete(l),
      dispatchEvent: (e: Event) => {
        if (e.type === "eip6963:requestProvider") {
          listeners.get("eip6963:announceProvider")?.forEach((l) =>
            l(new CustomEvent("eip6963:announceProvider", {
              detail: { info: { uuid: "u", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider },
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
      expect(found?.source).toBe("eip6963");
      const typed = buildCompanyWalletTypedData({
        workspaceId: "ws-A", wallet: normalizeAddress(OWNER_ADDR), nonce: "n", issuedAt: FIXED_NOW.toISOString(), expiresAt: FIXED_NOW.toISOString(),
      });
      const signed = await signCompanyWalletTypedData(found!.provider, OWNER_ADDR, typed);
      expect("signature" in signed).toBe(true);
      expect(calls).toEqual(["eth_signTypedData_v4"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("address casing never falsely fails (lowercase input registers checksummed)", async () => {
    const { deps, store } = setup();
    const r = await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR.toLowerCase() });
    expect(r.workspace.companyWallet).toBe(OWNER_ADDR);
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBe(OWNER_ADDR);
  });

  it("client and server enforce the exact same typed-data schema", () => {
    const args = { workspaceId: "ws-A", wallet: OWNER_ADDR, nonce: "fixed-nonce", issuedAt: "2026-06-01T12:00:00.000Z", expiresAt: "2026-06-01T12:10:00.000Z" };
    const clientSide = buildCompanyWalletTypedData(args);
    const serverSide = buildCompanyWalletTypedData(args);
    expect(JSON.stringify(clientSide)).toBe(JSON.stringify(serverSide));
    expect(clientSide.domain).toMatchObject({ name: "Thesma", version: "1", chainId: 5042 });
    expect(clientSide.primaryType).toBe("CompanyWalletRegistration");
    expect(Object.keys(clientSide.message)).toEqual(["workspaceId", "wallet", "purpose", "nonce", "issuedAt", "expiresAt"]);
    expect(COMPANY_WALLET_DOMAIN.chainId).toBe(5042);
  });

  it("registration stores only the public address plus safe metadata", async () => {
    const { deps, store, events } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const ws = (await store.getWorkspace("ws-A")) as unknown as Record<string, unknown>;
    expect(ws.companyWallet).toBe(OWNER_ADDR);
    const blob = JSON.stringify(ws);
    expect(blob).not.toContain("signature");
    expect(blob).not.toContain("nonce");
    expect(blob).not.toContain("private");
    const meta = events.find((e) => e.action === "workspace.company_wallet_registered")?.metadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["changed", "companyWallet", "workspaceId"]);
    expect(JSON.stringify(events)).not.toContain("signature");
  });
});
