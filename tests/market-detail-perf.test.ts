import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  approvePolicy,
  createDraft,
  moveToReview,
} from "@/server/services/campaigns";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
  type MarketStore,
} from "@/server/services/campaignStore";
import {
  confirmFunding,
  prepareFundingIntent,
  recordFundingSubmitted,
  type FundingDeps,
} from "@/server/services/fundings";
import { registerTestWallet } from "./wallet-fixtures";
import type { ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import {
  getPublicMarketDetail,
  joinCampaign,
  openMarket,
  updatePartnerRules,
  type MarketDeps,
} from "@/server/services/markets";
import { newId } from "@/server/auth/session";

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";

const CONFIG: ArcConfig = {
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR,
  verifierAddress: VERIFIER,
  explorerBaseUrl: "https://example-explorer.test",
};

class FakeReader {
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

const txFor = (n: number) => (`0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex);

describe("market detail fast path (no N+1, no duplicate reads)", () => {
  it("returns full proof with a bounded number of store reads", async () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const base = createMemoryCampaignStore({
      memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
      workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
      partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
    }) as MarketStore;
    const { sink } = createMemoryAuditSink();
    const campaignDeps = { store: base, audit: sink, now: () => now };
    const fundingDeps: FundingDeps = { store: base, audit: sink, config: CONFIG, reader: new FakeReader(), now: () => now };

    const d = await createDraft(campaignDeps, {
      workspaceId: "ws-A",
      userId: "owner-1",
      intentText: CANONICAL,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: "2026-12-31T23:59:59.999Z", targetOutcomeCount: 1 } as never,
    });
    await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await registerTestWallet(fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
    const id = d.campaign.id;
    const reader = fundingDeps.reader as FakeReader;
    const p = await prepareFundingIntent(fundingDeps, { campaignId: id, userId: "owner-1", expectedVersion: 1 });
    await recordFundingSubmitted(fundingDeps, { campaignId: id, userId: "owner-1", expectedVersion: 1, fundingTxHash: txFor(1) });
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
    await confirmFunding(fundingDeps, { campaignId: id, userId: "owner-1" });
    const marketDeps: MarketDeps = { store: base, audit: sink, now: () => now };
    await openMarket(marketDeps, {
      campaignId: id, userId: "owner-1", expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000", destinationUrl: "https://acme.example/product",
    });
    await updatePartnerRules(marketDeps, {
      userId: "partner-1",
      rules: {
        minimumBountyMicroUsdc: "100000", allowedCategories: ["media"], blockedCategories: [],
        maxActiveCampaigns: 5, autoJoin: true, autoNegotiate: false, maxAllocationCount: 1,
      },
    });
    await joinCampaign(marketDeps, { campaignId: id, userId: "partner-1" });
    const terms = await base.getTerms(id, "p-1");
    const outcomeId = newId();
    await base.insertOutcome({
      id: outcomeId, campaignId: id, partnerId: "p-1", partnerTermsId: terms!.id,
      checkoutIntentId: "ci-1", customerKeyHash: "ckh-1", purchaseTx: txFor(7), purchaseAmountMicroUsdc: 10_000_000n,
    });
    await base.updateOutcome(outcomeId, { status: "VERIFIED", proofHash: `0x${"cd".repeat(32)}`, verifiedAt: now, holdUntil: now });
    const version = await base.getVersion(id, 1);
    const reservation = await base.insertReservation({
      id: newId(), campaignId: id, outcomeId, partnerId: "p-1", partnerTermsId: terms!.id,
      amountMicroUsdc: 2_000_000n, policyVersionId: version!.id,
    });
    const payout = await base.insertPayout({
      id: newId(), reservationId: reservation.id, outcomeId, campaignId: id, partnerId: "p-1",
      recipient: PARTNER_W, amountMicroUsdc: 2_000_000n, proofHash: `0x${"cd".repeat(32)}`,
    });
    await base.updateReservation(reservation.id, { state: "SETTLED" });
    await base.updatePayout(payout.id, { state: "SETTLED", txHash: txFor(9), settledAt: now });

    const calls: Record<string, number> = {};
    const counting = new Proxy(base, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (typeof v === "function") {
          return (...a: unknown[]) => {
            calls[String(k)] = (calls[String(k)] ?? 0) + 1;
            return (v as (...a: unknown[]) => unknown).apply(t, a);
          };
        }
        return v;
      },
    }) as MarketStore;
    const detail = await getPublicMarketDetail(
      { store: counting, audit: sink, now: () => now },
      { campaignId: id, explorerBaseUrl: CONFIG.explorerBaseUrl },
    );

    // Full proof preserved.
    expect(detail.kind).toBe("completed");
    if (detail.kind !== "completed") throw new Error("unreachable");
    expect(detail.completionReason).toBe("TARGET_SETTLED");
    expect(detail.funding?.fundingTxHash).toBe(txFor(1));
    expect(detail.funding?.fundingExplorerUrl).toBe(`https://example-explorer.test/tx/${txFor(1)}`);
    expect(detail.purchaseTxs).toHaveLength(1);
    expect(detail.purchaseTxs[0]).toMatchObject({ txHash: txFor(7), amountMicroUsdc: "10000000" });
    expect(detail.outcomeProofs).toEqual([`0x${"cd".repeat(32)}`]);
    expect(detail.payouts).toHaveLength(1);
    expect(detail.payouts[0]).toMatchObject({ state: "SETTLED", txHash: txFor(9) });
    expect(detail.settledPayoutTotalMicroUsdc).toBe("2000000");
    expect(detail.displayNotes.length).toBeGreaterThan(0);

    // Bounded reads: one outcome + one payout fetch per reservation, no re-reads.
    expect(calls.getOutcome).toBe(1);
    expect(calls.getPayoutByReservation).toBe(1);
    expect(calls.getVersion).toBe(1);
    expect(calls.countVerifiedOutcomes).toBe(1);
    expect(calls.listReservationsByCampaign).toBe(1);
    expect(calls.getCampaign).toBe(1);
    expect(calls.getMarket).toBe(1);
    expect(calls.getFunding).toBe(1);
    expect(calls.getLatestPricingDecision).toBe(1);
    expect(calls.getWorkspace).toBe(1);
  });
});
