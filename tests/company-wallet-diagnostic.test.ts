import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
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
import { POST } from "@/app/api/workspaces/[id]/company-wallet/route";
import { signWalletRegistration, TEST_OWNER_PRIVATE_KEY } from "./wallet-fixtures";

const mockBox = vi.hoisted(() => ({ deps: undefined as unknown as FundingDeps, userId: "owner-1" }));
vi.mock("@/server/auth/guard", () => ({
  getSessionUser: vi.fn(),
  requireUser: async () => ({ userId: mockBox.userId, email: "owner@example.invalid", name: null }),
}));
vi.mock("@/server/api/campaignDeps", () => ({
  fundingDepsOr503: () => ({ deps: mockBox.deps }),
  marketDepsOr503: vi.fn(),
}));

/**
 * SIGNER_MISMATCH diagnostics (production debug slice, diagnostic-only).
 *
 * On a real mismatch the owner sees four PUBLIC addresses and nothing else.
 * Behavior and verification rules are unchanged — only the error payload
 * for this one code gains safe, owner-authenticated diagnostic truth.
 * Throwaway dev keys only; no transactions, no secrets.
 */

const OWNER_ADDR = privateKeyToAccount(TEST_OWNER_PRIVATE_KEY).address;
const OTHER_KEY = "0x6061243ad54fe37befb72e5dbff3eb7aa1ad825e45f9c20508f72a01d372dcc9" as const;
const OTHER_ADDR = privateKeyToAccount(OTHER_KEY).address;
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "member-2", workspaceId: "ws-A", role: "ORGANIZATION_MEMBER" },
    ],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" }],
  }) as unknown as FundingStore;
  const { sink } = createMemoryAuditSink();
  const deps: FundingDeps = {
    store, audit: sink, config: null, reader: null, now: () => FIXED_NOW,
    challenges: createMemoryCompanyWalletChallengeStore(),
  };
  mockBox.deps = deps;
  mockBox.userId = "owner-1";
  return { store, deps };
}

function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "ws-A" }) };

async function failsRegister(deps: FundingDeps, params: Record<string, unknown>) {
  try {
    await registerCompanyWallet(deps, params as never);
    throw new Error("expected rejection");
  } catch (e) {
    if ((e as Error).message === "expected rejection") throw e;
    return e as { status?: number; code?: string; message: string; details?: Record<string, unknown> };
  }
}

describe("SIGNER_MISMATCH diagnostics", () => {
  it("service error carries only the four public addresses", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR });
    const err = await failsRegister(deps, {
      workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR,
      nonce: signed.nonce, signature: signed.signature, signingAccount: OTHER_ADDR.toLowerCase(),
    });
    expect(err.status).toBe(403);
    expect(err.code).toBe("SIGNER_MISMATCH");
    const d = err.details ?? {};
    expect(Object.keys(d).sort()).toEqual(["challengeWallet", "recoveredSigner", "selectedWallet", "signingAccount"]);
    expect(d.selectedWallet).toBe(OTHER_ADDR);
    expect(d.challengeWallet).toBe(OTHER_ADDR);
    expect(d.signingAccount).toBe(OTHER_ADDR);
    expect(d.recoveredSigner).toBe(OWNER_ADDR);
    const blob = JSON.stringify(err);
    expect(blob).not.toContain(signed.signature);
    expect(blob).not.toContain(signed.nonce);
    expect(blob.toLowerCase()).not.toContain("private");
    expect(blob.toLowerCase()).not.toContain("session");
    expect(blob.toLowerCase()).not.toContain("token");
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
  });

  it("route returns diagnostics on mismatch and nothing secret", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR });
    const res = await POST(
      post("/api/workspaces/ws-A/company-wallet", {
        address: OTHER_ADDR, nonce: signed.nonce, signature: signed.signature, signingAccount: OTHER_ADDR,
      }),
      ctx,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; details?: Record<string, unknown> } };
    expect(json.error.code).toBe("SIGNER_MISMATCH");
    expect(Object.keys(json.error.details ?? {}).sort()).toEqual(
      ["challengeWallet", "recoveredSigner", "selectedWallet", "signingAccount"],
    );
    expect(json.error.details?.recoveredSigner).toBe(OWNER_ADDR);
    const blob = JSON.stringify(json);
    expect(blob).not.toContain(signed.signature);
    expect(blob).not.toContain(signed.nonce);
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
    expect(await store.getFunding("nope", 1)).toBeNull();
  });

  it("non-owner sees no diagnostics", async () => {
    setup();
    mockBox.userId = "member-2";
    const res = await POST(
      post("/api/workspaces/ws-A/company-wallet", { address: OWNER_ADDR, nonce: "unused-owner-check-runs-first", signature: "0x00" }),
      ctx,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: Record<string, unknown> };
    expect(json.error.code).toBe("FORBIDDEN");
    expect(json.error.details).toBeUndefined();
  });

  it("successful registration exposes no diagnostics", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR });
    const res = await POST(
      post("/api/workspaces/ws-A/company-wallet", { address: OWNER_ADDR, nonce: signed.nonce, signature: signed.signature }),
      ctx,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("error");
    expect(JSON.stringify(json)).not.toContain("details");
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBe(OWNER_ADDR);
  });
});
