import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  approvePolicy,
  createDraft,
  moveToReview,
  type CampaignDeps,
} from "@/server/services/campaigns";
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
  joinCampaign,
  listCreatorLiveCampaigns,
  openMarket,
  resolveReferral,
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
    partners: [
      { id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} },
      { id: "p-2", userId: "partner-2", payoutWallet: PARTNER_W, rulesJson: {} },
    ],
  }) as MarketStore;
  const { sink } = createMemoryAuditSink();
  const marketDeps: MarketDeps = { store, audit: sink, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, marketDeps, campaignDeps, fundingDeps, reader };
}

async function liveCampaignId(ctx: ReturnType<typeof setup>, tag = 7) {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE } as never,
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

describe("creator live campaign cards (profile CTA foundation)", () => {
  it("exposes the joined live campaign with a tracked referral path, never the raw destination", async () => {
    const ctx = setup();
    const campaignId = await liveCampaignId(ctx);
    await openMarket(ctx.marketDeps, {
      campaignId,
      userId: "owner-1",
      expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000",
      destinationUrl: DEST,
    });
    const joined = await joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" });

    const { campaigns } = await listCreatorLiveCampaigns(ctx.marketDeps, { partnerId: "p-1" });
    expect(campaigns).toHaveLength(1);
    const [card] = campaigns;
    expect(card.campaignId).toBe(campaignId);
    expect(card.workspaceName).toBe("Acme");
    expect(card.category).toBe("media");
    expect(card.objective).toContain("paying customers");
    expect(card.publicBountyMicroUsdc).toBe("2000000");
    expect(card.campaignState).toBe("LIVE");
    expect(card.marketStatus).toBe("OPEN");
    expect(card.referralCode).toBe(joined.referral.code);
    expect(card.referralPath).toBe(`/r/${joined.referral.code}`);
    // The raw organization destination must not leak onto the card: the /r
    // route resolves it server-side after recording attribution.
    expect(card).not.toHaveProperty("destinationUrl");

    // The card CTA resolves through attribution to the org destination.
    const resolved = await resolveReferral(ctx.marketDeps, { code: joined.referral.code });
    expect(resolved.destinationUrl).toBe(DEST);
    expect(resolved.campaignId).toBe(campaignId);
    expect(resolved.partnerId).toBe("p-1");
  });

  it("returns an honest empty set for creators with no live participation", async () => {
    const ctx = setup();
    const campaignId = await liveCampaignId(ctx);
    await openMarket(ctx.marketDeps, {
      campaignId,
      userId: "owner-1",
      expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000",
      destinationUrl: DEST,
    });
    // p-2 joined nothing: no fabricated cards.
    const { campaigns } = await listCreatorLiveCampaigns(ctx.marketDeps, { partnerId: "p-2" });
    expect(campaigns).toEqual([]);
  });

  it("404s unknown creator profiles instead of inventing cards", async () => {
    const ctx = setup();
    await expect(listCreatorLiveCampaigns(ctx.marketDeps, { partnerId: "p-ghost" })).rejects.toMatchObject({
      status: 404,
      code: "PARTNER_NOT_FOUND",
    });
  });
});
