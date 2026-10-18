import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  approvePolicy,
  createDraft,
  moveToReview,
} from "@/server/services/campaigns";
import type { CampaignDeps } from "@/server/services/campaigns";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import type { MarketStore } from "@/server/services/campaignStore";
import {
  confirmFunding,
  prepareFundingIntent,
  recordFundingSubmitted,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import type { ArcChainReader, ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import {
  getPublicMarketDetail,
  listCompletedMarkets,
  listPublicMarkets,
  openMarket,
  type MarketDeps,
} from "@/server/services/markets";

const OWNER_W = "0x1111111111111111111111111111111111111111" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEST = "https://acme.example/product";

const CONFIG: ArcConfig = {
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR,
  verifierAddress: VERIFIER,
  explorerBaseUrl: null,
};

class FakeReader implements ArcChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  vaultStates = new Map<string, VaultCampaignState>();
  async getChainId() {
    return 31337;
  }
  async getReceipt(txHash: Hex) {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async readVaultCampaign(_v: Address, key: Hex) {
    const s = this.vaultStates.get(key.toLowerCase());
    if (!s) {
      return {
        exists: false, owner: null, policyHash: null, budgetCap: 0n, bountyCeiling: 0n,
        deadline: 0n, executor: null, verifier: null, funded: 0n, spent: 0n,
        paused: false, closed: false, returned: false,
      };
    }
    return s;
  }
  async usdcBalanceOf() {
    return 0n;
  }
  async hasCode() {
    return true;
  }
}

const txFor = (n: number) => (`0x${String(n).repeat(64)}` as Hex);

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
  }) as MarketStore;
  const { sink } = createMemoryAuditSink();
  const marketDeps: MarketDeps = { store, audit: sink, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, marketDeps, campaignDeps, fundingDeps, reader };
}

async function liveCampaign(ctx: ReturnType<typeof setup>, tag = 1, overrides: Record<string, unknown> = {}) {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, ...overrides } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerCompanyWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: txFor(tag) });
  ctx.reader.receipts.set(txFor(tag).toLowerCase(), {
    status: "success",
    to: VAULT,
    blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 15_000_000n, totalFunded: 15_000_000n }],
  });
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
    funded: 15_000_000n, spent: 0n, paused: false, closed: false, returned: false,
  });
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
  return d.campaign.id;
}

async function openedCampaign(ctx: ReturnType<typeof setup>, tag = 1, overrides: Record<string, unknown> = {}) {
  const id = await liveCampaign(ctx, tag, overrides);
  await openMarket(ctx.marketDeps, {
    campaignId: id,
    userId: "owner-1",
    expectedPolicyVersion: 1,
    openingBountyMicroUsdc: "2000000",
    destinationUrl: DEST,
  });
  return id;
}

describe("public market discovery (logged-out feed)", () => {
  it("lists PUBLIC live markets and hides private ones", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1);
    await openedCampaign(ctx, 2, { marketVisibility: "PRIVATE" });
    const live = await listPublicMarkets(ctx.marketDeps);
    expect(live.markets.map((m) => m.campaignId)).toEqual([id]);
    expect(JSON.stringify(live)).not.toContain("allowedPartnerRulesJson");
  });

  it("moves expired markets to completed history without deleting them", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1);
    const futureDeps: MarketDeps = { ...ctx.marketDeps, now: () => new Date("2027-06-01T12:00:00.000Z") };
    const live = await listPublicMarkets(futureDeps);
    expect(live.markets).toEqual([]);
    const completed = await listCompletedMarkets(futureDeps);
    expect(completed.markets.map((m) => m.campaignId)).toEqual([id]);
    const item = completed.markets[0];
    expect(item.finalState).toBe("LIVE");
    expect(item.goal).toBeDefined();
  });

  it("keeps closed campaigns discoverable in completed", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1);
    await ctx.store.updateCampaign(id, { state: "CLOSED" });
    const live = await listPublicMarkets(ctx.marketDeps);
    expect(live.markets).toEqual([]);
    const completed = await listCompletedMarkets(ctx.marketDeps);
    expect(completed.markets.map((m) => m.campaignId)).toEqual([id]);
    expect(completed.markets[0].finalState).toBe("CLOSED");
  });

  it("omits uncomputable metrics instead of fabricating them", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1);
    const futureDeps: MarketDeps = { ...ctx.marketDeps, now: () => new Date("2027-06-01T12:00:00.000Z") };
    const completed = await listCompletedMarkets(futureDeps);
    const item = completed.markets[0];
    expect(item.verifiedOutcomes).toBe(0);
    expect(item.settledSpendMicroUsdc).toBe("0");
    expect(item.verifiedRevenueMicroUsdc).toBeNull();
    expect(item.realizedCacMicroUsdc).toBeNull();
  });
});

describe("public market detail (judge-proof, safe fields)", () => {
  it("exposes live state with safe fields only", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1);
    const detail = await getPublicMarketDetail(ctx.marketDeps, { campaignId: id });
    expect(detail.kind).toBe("live");
    expect(detail.objective).toContain("paying customers");
    expect(detail.publicBountyMicroUsdc).toBe("2000000");
    const raw = JSON.stringify(detail);
    for (const forbidden of [
      "allowedPartnerRulesJson",
      "customerKeyHash",
      "checkoutIntentId",
      "passwordHash",
      "PRIVATE_KEY",
      "rulesJson",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("404s PRIVATE campaigns without leaking", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1, { marketVisibility: "PRIVATE" });
    await expect(getPublicMarketDetail(ctx.marketDeps, { campaignId: id })).rejects.toMatchObject({ status: 404 });
    const completed = await listCompletedMarkets(ctx.marketDeps);
    expect(completed.markets).toEqual([]);
  });

  it("completed detail carries proof without fabricated numbers", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1);
    await ctx.store.updateCampaign(id, { state: "CLOSED" });
    const detail = await getPublicMarketDetail(ctx.marketDeps, { campaignId: id });
    expect(detail.kind).toBe("completed");
    if (detail.kind !== "completed") throw new Error("unreachable");
    expect(detail.finalOutcome.reachedTarget).toBe(false);
    expect(detail.payouts).toEqual([]);
    expect(detail.verifiedRevenueMicroUsdc).toBeNull();
    expect(detail.realizedCacMicroUsdc).toBeNull();
  });
});
