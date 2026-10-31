import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  approvePolicy,
  createDraft,
  moveToReview,
  type CampaignDeps,
} from "@/server/services/campaigns";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
  type FundingStore,
} from "@/server/services/campaignStore";
import {
  prepareFundingIntent,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import type { ArcConfig } from "@/server/chain/arc";
import { THESMA_VAULT_ADDRESS } from "@/lib/proof";
import { buildCompanyWalletMessage, fundingEntryState } from "@/lib/wallet";
import { registerTestWallet, signWalletRegistration, TEST_OWNER_PRIVATE_KEY } from "./wallet-fixtures";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * Organization company-wallet registration (production Northstar shape).
 *
 * Northstar reached APPROVED with company_wallet NULL while funding compared
 * against a null sender ("Wrong account" with nothing registered). This pins:
 * signature ownership proof, owner-only + cross-workspace authorization,
 * explicit change confirmation, and WALLET_NOT_REGISTERED-style entry gating
 * (service: COMPANY_WALLET_REQUIRED; client helper: REGISTER_REQUIRED).
 * Fixtures are synthetic; signatures use throwaway dev keys only.
 */

const root = join(__dirname, "..");
const OWNER_ADDR = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
const OTHER_KEY = generatePrivateKey();
const OTHER_ADDR = privateKeyToAccount(OTHER_KEY).address;
const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const CONFIG: ArcConfig = {
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  usdcAddress: "0x3600000000000000000000000000000000000000",
  vaultAddress: "0x2222222222222222222222222222222222222222",
  executorAddress: "0x3333333333333333333333333333333333333333",
  verifierAddress: "0x4444444444444444444444444444444444444444",
  explorerBaseUrl: null,
};

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "member-2", workspaceId: "ws-A", role: "ORGANIZATION_MEMBER" },
      { userId: "owner-1", workspaceId: "ws-B", role: "ORGANIZATION_OWNER" },
    ],
    workspaces: [
      { id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" },
      { id: "ws-B", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Other" },
    ],
  });
  const { sink, events } = createMemoryAuditSink();
  const fundingStore = store as unknown as FundingStore;
  const deps: FundingDeps = { store: fundingStore, audit: sink, config: CONFIG, reader: null, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  return { store, events, deps, campaignDeps };
}

async function approvedCampaign(campaignDeps: CampaignDeps, workspaceId = "ws-A") {
  const d = await createDraft(
    { ...campaignDeps },
    {
      workspaceId,
      userId: "owner-1",
      intentText: CANONICAL,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: "2026-12-31T23:59:59.999Z" },
    },
  );
  await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  return approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
}

async function fails(promise: Promise<unknown>): Promise<{ status?: number; code?: string; message: string }> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (e) {
    if ((e as Error).message === "expected rejection") throw e;
    return e as { status?: number; code?: string; message: string };
  }
}

describe("company wallet registration", () => {
  it("fixture key derives the shared test address (drift guard)", () => {
    expect(privateKeyToAccount(TEST_OWNER_PRIVATE_KEY).address).toBe(OWNER_ADDR);
  });

  it("fresh workspace has null company wallet (NOT REGISTERED)", async () => {
    const { store } = setup();
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
  });

  it("owner settings surface the registration flow only to owners", () => {
    const settings = readFileSync(join(root, "src/app/app/settings/page.tsx"), "utf8");
    expect(settings).toContain("CompanyWalletRegistration");
    expect(settings).toContain("ORGANIZATION_OWNER");
    expect(settings).toContain("Not registered");
    expect(settings).toContain("Campaign vault");
  });

  it("non-owners cannot register (member 403, outsider 403)", async () => {
    const { deps, store } = setup();
    const member = await fails(
      registerTestWallet(deps, { workspaceId: "ws-A", userId: "member-2" }),
    );
    expect(member.status).toBe(403);
    const outsider = await fails(
      registerTestWallet(deps, { workspaceId: "ws-A", userId: "stranger" }),
    );
    expect(outsider.status).toBe(403);
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
  });

  it("cross-workspace registration by non-member is denied", async () => {
    const { deps, store } = setup();
    const err = await fails(registerTestWallet(deps, { workspaceId: "ws-B", userId: "member-2" }));
    expect(err.status).toBe(403);
    expect((await store.getWorkspace("ws-B"))?.companyWallet).toBeNull();
  });

  it("arbitrary pasted addresses never register without a valid signature", async () => {
    const { deps, store } = setup();
    // Garbage signature.
    const garbage = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR, signature: "0x00" }),
    );
    expect(garbage.status).toBe(400);
    expect(garbage.code).toBe("INVALID_SIGNATURE");
    // Valid signature for a DIFFERENT address (wrong-key proof).
    const { signature } = await signWalletRegistration("ws-A", OTHER_ADDR, TEST_OWNER_PRIVATE_KEY);
    const wrongKey = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR, signature }),
    );
    expect(wrongKey.status).toBe(400);
    expect(wrongKey.code).toBe("INVALID_SIGNATURE");
    // Signature bound to another workspace does not transfer.
    const other = await signWalletRegistration("ws-B", OWNER_ADDR);
    const replay = await fails(
      registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR, signature: other.signature }),
    );
    expect(replay.code).toBe("INVALID_SIGNATURE");
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBeNull();
  });

  it("valid ownership proof registers the canonical checksummed address + audit", async () => {
    const { deps, events, store } = setup();
    const r = await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_ADDR.toLowerCase() });
    expect(r.workspace.companyWallet).toBe(getAddress(OWNER_ADDR));
    expect(events.some((e) => e.action === "workspace.company_wallet_registered")).toBe(true);
    const meta = events.find((e) => e.action === "workspace.company_wallet_registered")?.metadata as Record<string, unknown>;
    expect(meta.companyWallet).toBe(getAddress(OWNER_ADDR));
    expect(JSON.stringify(meta)).not.toContain("0xac0974");
  });

  it("re-registering the same address is idempotent (no confirmation needed)", async () => {
    const { deps, store } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const again = await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    expect(again.workspace.companyWallet).toBe(getAddress(OWNER_ADDR));
  });

  it("replacing a wallet requires explicit confirmation + fresh proof", async () => {
    const { deps, store } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const blocked = await fails(
      registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR, privateKey: OTHER_KEY }),
    );
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("WALLET_CHANGE_REQUIRES_CONFIRMATION");
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBe(getAddress(OWNER_ADDR));
    const changed = await registerTestWallet(deps, {
      workspaceId: "ws-A", userId: "owner-1", address: OTHER_ADDR, privateKey: OTHER_KEY, confirmChange: true,
    });
    expect(changed.workspace.companyWallet).toBe(getAddress(OTHER_ADDR));
  });

  it("registration sends zero USDC and creates zero funding/payout/referral rows", async () => {
    const { deps, store, campaignDeps } = setup();
    const a = await approvedCampaign(campaignDeps);
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    expect(await store.getFunding(a.campaign.id, 1)).toBeNull();
    expect(await store.getReferralByCode("anything")).toBeNull();
    expect(await store.getPayoutByOutcome("nope")).toBeNull();
  });

  it("funding intent without a wallet fails COMPANY_WALLET_REQUIRED, not WRONG_ACCOUNT", async () => {
    const { deps, campaignDeps } = setup();
    const a = await approvedCampaign(campaignDeps);
    const err = await fails(prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 }));
    expect(err.status).toBe(400);
    expect(err.code).toBe("COMPANY_WALLET_REQUIRED");
  });

  it("funding entry gate distinguishes REGISTER_REQUIRED / WRONG_ACCOUNT / OK", () => {
    expect(fundingEntryState({ expectedSender: null, connectedAccount: OTHER_ADDR }).valueOf()).toBe("REGISTER_REQUIRED");
    expect(fundingEntryState({ expectedSender: null, connectedAccount: null })).toBe("REGISTER_REQUIRED");
    expect(fundingEntryState({ expectedSender: OWNER_ADDR, connectedAccount: OTHER_ADDR })).toBe("WRONG_ACCOUNT");
    expect(fundingEntryState({ expectedSender: OWNER_ADDR, connectedAccount: null })).toBe("WRONG_ACCOUNT");
    expect(fundingEntryState({ expectedSender: OWNER_ADDR, connectedAccount: OWNER_ADDR.toLowerCase() })).toBe("OK");
  });

  it("registered wallet + matching intent reaches funding preview (unsigned actions)", async () => {
    const { deps, campaignDeps } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await approvedCampaign(campaignDeps);
    const intent = await prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 });
    expect(intent.actions.length).toBeGreaterThan(0);
    expect(intent.funding.status).toBe("PREPARED");
  });

  it("Thesma vault stays separate and unchanged", () => {
    expect(THESMA_VAULT_ADDRESS).toBe("0x0fA826256a58F19Ad24Fc9384d81D313f2266F79");
    expect(CONFIG.vaultAddress).not.toBe(OWNER_ADDR);
  });

  it("challenge message binds workspace + address", () => {
    const m = buildCompanyWalletMessage("ws-A", OWNER_ADDR);
    expect(m).toContain("workspace:ws-A");
    expect(m).toContain(`address:${OWNER_ADDR}`);
    expect(buildCompanyWalletMessage("ws-B", OWNER_ADDR)).not.toBe(m);
  });
});
