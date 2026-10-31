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
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";
import {
  buildCompanyWalletTypedData,
  selectChallengePayload,
  type RegistrationChallengePayload,
} from "@/lib/wallet";
import { signWalletRegistration, TEST_OWNER_PRIVATE_KEY } from "./wallet-fixtures";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * Frozen-challenge regression (production "changed unexpectedly" failure).
 *
 * The client rebuilt the wallet field from the raw connected account while
 * the server verified the normalized challenge wallet — any checksum-case
 * divergence falsely failed the flow. The server payload is now frozen and
 * signed verbatim. Fixtures use throwaway dev keys only; no transactions.
 */

const root = join(__dirname, "..");
const OWNER_ADDR = privateKeyToAccount(TEST_OWNER_PRIVATE_KEY).address;
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" }],
  }) as unknown as FundingStore;
  const { sink } = createMemoryAuditSink();
  const deps: FundingDeps = {
    store,
    audit: sink,
    config: null,
    reader: null,
    now: () => FIXED_NOW,
    challenges: createMemoryCompanyWalletChallengeStore(),
  };
  return { store, deps };
}

function frozenChallenge(): RegistrationChallengePayload {
  const typedData = buildCompanyWalletTypedData({
    workspaceId: "ws-A",
    wallet: OWNER_ADDR,
    nonce: "frozen-nonce",
    issuedAt: FIXED_NOW.toISOString(),
    expiresAt: new Date(FIXED_NOW.getTime() + 10 * 60 * 1000).toISOString(),
  });
  return { typedData, nonce: "frozen-nonce", issuedAt: typedData.message.issuedAt, expiresAt: typedData.message.expiresAt };
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

describe("frozen challenge payload", () => {
  it("server payload passes through byte-identical (the production failure shape)", () => {
    const challenge = frozenChallenge();
    const raw = JSON.stringify(challenge.typedData);
    // JSON round-trip (fetch wire format) preserves byte identity.
    const revived = JSON.parse(raw) as typeof challenge.typedData;
    expect(JSON.stringify(revived)).toBe(raw);
    const sel = selectChallengePayload({
      challenge: { ...challenge, typedData: revived },
      workspaceId: "ws-A",
      selectedAccount: OWNER_ADDR,
      availableAccounts: [OWNER_ADDR],
    });
    expect("typedData" in sel).toBe(true);
    if ("typedData" in sel) expect(JSON.stringify(sel.typedData)).toBe(raw);
  });

  it("lowercase selected account does not mutate the checksummed challenge (prod bug)", () => {
    const challenge = frozenChallenge();
    const sel = selectChallengePayload({
      challenge,
      workspaceId: "ws-A",
      selectedAccount: OWNER_ADDR.toLowerCase(),
      availableAccounts: [OWNER_ADDR.toLowerCase()],
    });
    expect("typedData" in sel).toBe(true);
    if ("typedData" in sel) {
      expect(sel.typedData.message.wallet).toBe(OWNER_ADDR);
      expect(JSON.stringify(sel.typedData)).toBe(JSON.stringify(challenge.typedData));
    }
  });

  it("nonce/issuedAt/expiresAt/workspaceId/wallet/purpose survive frozen", () => {
    const challenge = frozenChallenge();
    const sel = selectChallengePayload({
      challenge,
      workspaceId: "ws-A",
      selectedAccount: OWNER_ADDR,
      availableAccounts: [OWNER_ADDR],
    });
    expect("typedData" in sel).toBe(true);
    if ("typedData" in sel) {
      expect(sel.typedData.message).toMatchObject({
        workspaceId: "ws-A",
        wallet: OWNER_ADDR,
        nonce: "frozen-nonce",
        issuedAt: FIXED_NOW.toISOString(),
      });
      expect(sel.typedData.message.purpose).toContain("never moves funds");
    }
  });

  it("rerender purity: same inputs always select the identical payload object", () => {
    const challenge = frozenChallenge();
    const args = { challenge, workspaceId: "ws-A", selectedAccount: OWNER_ADDR, availableAccounts: [OWNER_ADDR] };
    const first = selectChallengePayload(args);
    const second = selectChallengePayload(args);
    expect(first).toEqual(second);
    if ("typedData" in first && "typedData" in second) {
      expect(first.typedData).toBe(second.typedData);
    }
  });

  it("missing challenge, workspace mismatch, and account changes fail closed", () => {
    const challenge = frozenChallenge();
    expect(selectChallengePayload({ challenge: null, workspaceId: "ws-A", selectedAccount: OWNER_ADDR, availableAccounts: [OWNER_ADDR] }))
      .toEqual({ error: "NO_CHALLENGE" });
    expect(selectChallengePayload({ challenge, workspaceId: "ws-B", selectedAccount: OWNER_ADDR, availableAccounts: [OWNER_ADDR] }))
      .toEqual({ error: "WORKSPACE_MISMATCH" });
    expect(selectChallengePayload({ challenge, workspaceId: "ws-A", selectedAccount: OWNER_ADDR, availableAccounts: ["0x0000000000000000000000000000000000000001"] }))
      .toEqual({ error: "ACCOUNT_CHANGED" });
    expect(selectChallengePayload({ challenge, workspaceId: "ws-A", selectedAccount: OWNER_ADDR, availableAccounts: [] }))
      .toEqual({ error: "ACCOUNT_CHANGED" });
  });

  it("stale challenge wallet differing from the live account aborts", () => {
    const challenge = frozenChallenge();
    expect(selectChallengePayload({
      challenge,
      workspaceId: "ws-A",
      selectedAccount: "0x0000000000000000000000000000000000000001",
      availableAccounts: ["0x0000000000000000000000000000000000000001"],
    })).toEqual({ error: "ACCOUNT_CHANGED" });
  });

  it("frozen end-to-end: lowercase selection signs server payload and registers", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR.toLowerCase() });
    const sel = selectChallengePayload({
      challenge: { typedData: signed.typedData, nonce: signed.nonce, issuedAt: "", expiresAt: "" },
      workspaceId: "ws-A",
      selectedAccount: OWNER_ADDR.toLowerCase(),
      availableAccounts: [OWNER_ADDR],
    });
    expect("typedData" in sel).toBe(true);
    const r = await registerCompanyWallet(deps, {
      workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR.toLowerCase(), nonce: signed.nonce, signature: signed.signature,
    });
    expect(r.workspace.companyWallet).toBe(OWNER_ADDR);
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBe(OWNER_ADDR);
  });

  it("tampered payload after selection still fails closed", async () => {
    const { deps, store } = setup();
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR });
    const other = "0x0000000000000000000000000000000000000001";
    const err = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: other, nonce: signed.nonce, signature: signed.signature }),
    );
    expect(["CHALLENGE_MISMATCH", "SIGNER_MISMATCH"]).toContain(err.code);
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
  });

  it("component never rebuilds challenge fields (single source of truth)", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    // The only effect subscribes to accountsChanged; the challenge fetch
    // lives solely in the Sign click handler (StrictMode-safe: no effect fetch).
    expect(src).toContain("accountsChanged");
    // Exactly one challenge request site (the Sign click handler).
    expect(src.split("company-wallet/challenge").length - 1).toBe(1);
    const effectStart = src.indexOf("useEffect(() => {");
    const effectEnd = src.indexOf("}, [wallet, phase]);");
    const effectBody = effectStart >= 0 && effectEnd > effectStart ? src.slice(effectStart, effectEnd) : "";
    expect(effectBody).not.toContain("company-wallet/challenge");
    expect(effectBody).not.toContain("postJson");
    // The client must not recompute signed timestamps.
    expect(src).not.toContain("Date.now()");
    // Double-submit guard: one challenge per explicit Sign click.
    expect(src).toContain("signingRef");
    // Explicit restart path discards stale challenges.
    expect(src).toContain("Restart registration");
    // Frozen payload selector is the only path to signing.
    expect(src).toContain("selectChallengePayload");
  });
});
