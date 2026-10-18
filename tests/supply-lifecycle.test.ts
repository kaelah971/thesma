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
import type { ArcConfig, TransferEvidence, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import type { VerifierChainReader } from "@/server/chain/arc";
import {
  getPublicMarketDetail,
  listCompletedMarkets,
  listPublicMarkets,
  openMarket,
  resolveReferral,
  updatePartnerRules,
  type MarketDeps,
} from "@/server/services/markets";
import {
  createCheckoutIntent,
  mintAttributionSession,
  submitCheckoutTx,
  verifyCheckoutIntent,
  type CheckoutDeps,
} from "@/server/services/checkout";
import { processEligiblePayouts, type PayoutDeps } from "@/server/services/payouts";
import { runSupplyAgentWorker } from "@/server/services/supplyAgent";

const OWNER_W = "0x1111111111111111111111111111111111111111" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const CUSTOMER_W = "0x6666666666666666666666666666666666666666" as Address;
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

class FakeReader implements VerifierChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  evidence = new Map<string, TransferEvidence>();
  vaultStates = new Map<string, VaultCampaignState>();
  async getChainId() {
    return 31337;
  }
  async getReceipt(txHash: Hex) {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async getTransferEvidence(txHash: Hex) {
    return this.evidence.get(txHash.toLowerCase()) ?? null;
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

describe("production campaign flow smoke (local fixtures only, no mainnet)", () => {
  it("org -> policy -> funding -> LIVE -> discovery -> autoJoin -> referral -> checkout -> verify -> payout scan -> completed proof", async () => {
    const store = createMemoryCampaignStore({
      memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
      workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
      partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
    }) as MarketStore;
    const { sink } = createMemoryAuditSink();
    const deps = { store, audit: sink, now: () => FIXED_NOW };
    const campaignDeps: CampaignDeps = deps;
    const reader = new FakeReader();
    const fundingDeps: FundingDeps = { ...deps, config: CONFIG, reader };
    const marketDeps: MarketDeps = deps;
    const checkoutDeps: CheckoutDeps = { ...deps, config: CONFIG, reader };

    // organization -> approved policy -> funding -> LIVE
    const d = await createDraft(campaignDeps, {
      workspaceId: "ws-A",
      userId: "owner-1",
      intentText: CANONICAL,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE } as never,
    });
    await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await registerCompanyWallet(fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
    const p = await prepareFundingIntent(fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await recordFundingSubmitted(fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: txFor(1) });
    reader.receipts.set(txFor(1).toLowerCase(), {
      status: "success",
      to: VAULT,
      blockNumber: 1n,
      fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 15_000_000n, totalFunded: 15_000_000n }],
    });
    reader.vaultStates.set(p.campaignKey.toLowerCase(), {
      exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
      bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
      funded: 15_000_000n, spent: 0n, paused: false, closed: false, returned: false,
    });
    await confirmFunding(fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
    const campaignId = d.campaign.id;

    // LIVE market + public discovery
    await openMarket(marketDeps, {
      campaignId, userId: "owner-1", expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000", destinationUrl: DEST,
    });
    const live = await listPublicMarkets(marketDeps);
    expect(live.markets.map((m) => m.campaignId)).toContain(campaignId);
    const detail = await getPublicMarketDetail(marketDeps, { campaignId });
    expect(detail.kind).toBe("live");

    // Partner autoJoin evaluation -> referral generated
    await updatePartnerRules(marketDeps, {
      userId: "partner-1",
      rules: {
        minimumBountyMicroUsdc: "200000",
        allowedCategories: ["media"],
        blockedCategories: [],
        maxActiveCampaigns: 5,
        autoJoin: true,
        autoNegotiate: false,
        maxAllocationCount: 1,
      },
    });
    const run = await runSupplyAgentWorker(marketDeps);
    expect(run.joined.map((j) => j.campaignId)).toContain(campaignId);
    const referralCode = run.joined.find((j) => j.campaignId === campaignId)!.referralCode;
    const resolved = await resolveReferral(marketDeps, { code: referralCode });
    expect(resolved.attributable).toBe(true);

    // real customer checkout path -> verified outcome path
    const terms = await store.getTerms(campaignId, "p-1");
    const session = await mintAttributionSession(marketDeps, {
      referralId: resolved.referral.id,
      campaignId,
      partnerId: "p-1",
      partnerTermsId: terms!.id,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    const { intent } = await createCheckoutIntent(checkoutDeps, {
      attributionHandle: session.handle,
      payerAddress: CUSTOMER_W,
      amountMicroUsdc: "10000000",
    });
    const purchaseTx = txFor(7);
    await submitCheckoutTx(checkoutDeps, { intentId: intent.id, txHash: purchaseTx });
    reader.receipts.set(purchaseTx.toLowerCase(), { status: "success", to: USDC, blockNumber: 2n, fundedEvents: [] });
    reader.evidence.set(purchaseTx.toLowerCase(), {
      sender: CUSTOMER_W,
      blockTimestampMs: FIXED_NOW.getTime(),
      blockNumber: 2n,
      transfers: [{ token: USDC, from: CUSTOMER_W, to: OWNER_W, amount: 10_000_000n }],
    });
    const verified = await verifyCheckoutIntent(checkoutDeps, { intentId: intent.id });
    expect(verified.outcome?.status).toBe("VERIFIED");

    // payout path available: the worker picks the outcome up (hold arithmetic decides next step)
    const payoutDeps = { ...deps, config: CONFIG, reader, signer: null, executor: null } as unknown as PayoutDeps;
    const scan = await processEligiblePayouts(payoutDeps, { limit: 25 });
    expect(scan.scanned).toBe(1);
    expect([...scan.skipped, ...scan.failed].length).toBe(1);

    // completed campaign stays publicly inspectable at its permanent URL
    await store.updateCampaign(campaignId, { state: "CLOSED" });
    expect((await listPublicMarkets(marketDeps)).markets).toEqual([]);
    const history = await listCompletedMarkets(marketDeps);
    expect(history.markets.map((m) => m.campaignId)).toContain(campaignId);
    const done = await getPublicMarketDetail(marketDeps, { campaignId });
    expect(done.kind).toBe("completed");
    if (done.kind === "completed") {
      expect(done.purchaseTxs.length).toBe(1);
      expect(done.purchaseTxs[0].amountMicroUsdc).toBe("10000000");
    }
  });
});
