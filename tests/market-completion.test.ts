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
import type { ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import {
  finalizeMarketIfTargetSettled,
  getPublicMarketDetail,
  joinCampaign,
  listCompletedMarkets,
  listPublicMarkets,
  openMarket,
  resolveReferral,
  updatePartnerRules,
  type MarketDeps,
} from "@/server/services/markets";
import { reconcilePayout, type PayoutDeps } from "@/server/services/payouts";
import { runSupplyAgentWorker } from "@/server/services/supplyAgent";
import { newId } from "@/server/auth/session";

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

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
  }) as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const marketDeps: MarketDeps = { store, audit: sink, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, events, marketDeps, campaignDeps, fundingDeps, reader };
}

async function liveCampaign(ctx: ReturnType<typeof setup>, tag = 1, target = 1) {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, targetOutcomeCount: target } as never,
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

async function openedCampaign(ctx: ReturnType<typeof setup>, tag = 1, target = 1) {
  const id = await liveCampaign(ctx, tag, target);
  await openMarket(ctx.marketDeps, {
    campaignId: id,
    userId: "owner-1",
    expectedPolicyVersion: 1,
    openingBountyMicroUsdc: "2000000",
    destinationUrl: DEST,
  });
  return id;
}

const OPEN_RULES = {
  minimumBountyMicroUsdc: "100000",
  allowedCategories: ["media"],
  blockedCategories: [],
  maxActiveCampaigns: 5,
  autoJoin: true,
  autoNegotiate: false,
  maxAllocationCount: 1,
};

let tagCounter = 1000;
async function verifiedOutcome(ctx: ReturnType<typeof setup>, campaignId: string) {
  let terms = await ctx.store.getTerms(campaignId, "p-1");
  if (!terms) {
    await joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" });
    terms = await ctx.store.getTerms(campaignId, "p-1");
  }
  tagCounter += 1;
  const id = newId();
  await ctx.store.insertOutcome({
    id,
    campaignId,
    partnerId: "p-1",
    partnerTermsId: terms!.id,
    checkoutIntentId: `ci-${tagCounter}`,
    customerKeyHash: `ckh-${tagCounter}`,
    purchaseTx: txFor(tagCounter),
    purchaseAmountMicroUsdc: 10_000_000n,
  });
  await ctx.store.updateOutcome(id, { status: "VERIFIED", verifiedAt: FIXED_NOW, holdUntil: FIXED_NOW });
  return id;
}

async function payoutInState(
  ctx: ReturnType<typeof setup>,
  campaignId: string,
  outcomeId: string,
  state: "PREPARED" | "SUBMITTED" | "AMBIGUOUS" | "SETTLED",
) {
  const outcome = await ctx.store.getOutcome(outcomeId);
  const version = await ctx.store.getVersion(campaignId, 1);
  const reservation = await ctx.store.insertReservation({
    id: newId(),
    campaignId,
    outcomeId,
    partnerId: "p-1",
    partnerTermsId: outcome!.partnerTermsId,
    amountMicroUsdc: 2_000_000n,
    policyVersionId: version!.id,
  });
  const payout = await ctx.store.insertPayout({
    id: newId(),
    reservationId: reservation.id,
    outcomeId,
    campaignId,
    partnerId: "p-1",
    recipient: PARTNER_W,
    amountMicroUsdc: 2_000_000n,
    proofHash: `0x${"ab".repeat(32)}`,
  });
  if (state !== "PREPARED") {
    await ctx.store.updateReservation(reservation.id, { state: state === "SETTLED" ? "SETTLED" : "SUBMITTED" });
    await ctx.store.updatePayout(payout.id, {
      state,
      txHash: state === "SETTLED" ? txFor(9000) : txFor(9001),
      settledAt: state === "SETTLED" ? FIXED_NOW : null,
    });
  }
  return payout.id;
}

describe("market completion lifecycle", () => {
  it("target 1, verified 0, settled 0 stays live", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const res = await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    expect(res.finalized).toBe(false);
    const live = await listPublicMarkets(ctx.marketDeps);
    expect(live.markets.map((m) => m.campaignId)).toContain(id);
    expect((await ctx.store.getMarket(id))?.status).toBe("OPEN");
  });

  it.each(["PREPARED", "SUBMITTED", "AMBIGUOUS"] as const)(
    "target 1, verified 1, payout %s is not completed",
    async (state) => {
      const ctx = setup();
      const id = await openedCampaign(ctx, 2, 1);
      await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
      const outcomeId = await verifiedOutcome(ctx, id);
      await payoutInState(ctx, id, outcomeId, state);
      const res = await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
      expect(res.finalized).toBe(false);
      expect((await ctx.store.getMarket(id))?.status).toBe("OPEN");
      const live = await listPublicMarkets(ctx.marketDeps);
      expect(live.markets.map((m) => m.campaignId)).toContain(id);
    },
  );

  it("target 1, verified 1, payout SETTLED closes the market", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 3, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const outcomeId = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, outcomeId, "SETTLED");
    const before = await ctx.store.getMarket(id);
    const res = await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    expect(res).toMatchObject({ finalized: true, target: 1, verified: 1, settledPayouts: 1 });
    const after = await ctx.store.getMarket(id);
    expect(after?.status).toBe("CLOSED");
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    const completions = (ctx.events as Array<{ action: string }>).filter((e) => e.action === "market.completed");
    expect(completions).toHaveLength(1);
  });

  it("target 2 with only 1 settled payout stays open; 2 settled closes", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 4, 2);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const o1 = await verifiedOutcome(ctx, id);
    const o2 = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, o1, "SETTLED");
    await payoutInState(ctx, id, o2, "SUBMITTED");
    expect(await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id })).toMatchObject({
      finalized: false,
    });
    expect((await ctx.store.getMarket(id))?.status).toBe("OPEN");
    await ctx.store.updatePayout(
      (await ctx.store.getPayoutByOutcome(o2))!.id,
      { state: "SETTLED", settledAt: FIXED_NOW },
    );
    await ctx.store.updateReservation(
      (await ctx.store.getReservationByOutcome(o2))!.id,
      { state: "SETTLED" },
    );
    const res = await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    expect(res.finalized).toBe(true);
    expect((await ctx.store.getMarket(id))?.status).toBe("CLOSED");
  });

  it("repeated finalization emits no duplicate audit and no extra version bump", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 5, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const outcomeId = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, outcomeId, "SETTLED");
    await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    const versionAfterFirst = (await ctx.store.getMarket(id))?.version;
    const second = await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    expect(second.finalized).toBe(false);
    expect((await ctx.store.getMarket(id))?.version).toBe(versionAfterFirst);
    const completions = (ctx.events as Array<{ action: string }>).filter((e) => e.action === "market.completed");
    expect(completions).toHaveLength(1);
  });

  it("already-settled legacy market heals through reconcile without resend", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 6, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const outcomeId = await verifiedOutcome(ctx, id);
    const payoutId = await payoutInState(ctx, id, outcomeId, "SETTLED");
    const deps = {
      store: ctx.store,
      audit: ctx.marketDeps.audit,
      config: null,
      reader: null,
      signer: null,
      executor: null,
    } as unknown as PayoutDeps;
    const rec = await reconcilePayout(deps, { payoutId });
    expect(rec.settled).toBe(true);
    expect((await ctx.store.getMarket(id))?.status).toBe("CLOSED");
    // No new payout, no transaction hash minted by the healing path.
    expect(await ctx.store.getPayoutByOutcome(outcomeId)).toMatchObject({ id: payoutId, txHash: txFor(9000) });
  });

  it("completed market leaves Live, appears under Completed, keeps permanent proof", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 7, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const outcomeId = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, outcomeId, "SETTLED");
    await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    expect((await listPublicMarkets(ctx.marketDeps)).markets).toEqual([]);
    const completed = await listCompletedMarkets(ctx.marketDeps);
    expect(completed.markets.map((m) => m.campaignId)).toEqual([id]);
    expect(completed.markets[0]).toMatchObject({ completionReason: "TARGET_SETTLED" });
    const detail = await getPublicMarketDetail(ctx.marketDeps, { campaignId: id });
    expect(detail.kind).toBe("completed");
    if (detail.kind !== "completed") throw new Error("unreachable");
    expect(detail.payouts.length).toBe(1);
    expect(detail.purchaseTxs.length).toBe(1);
    expect(detail.settledPayoutTotalMicroUsdc).toBe("2000000");
  });

  it("supply auto-join does not join a completed market", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 8, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const outcomeId = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, outcomeId, "SETTLED");
    // Row still says OPEN: discovery itself must exclude the settled market.
    expect((await ctx.store.getMarket(id))?.status).toBe("OPEN");
    const run = await runSupplyAgentWorker(ctx.marketDeps);
    expect(run.marketsEvaluated).toBe(0);
    expect(run.joined).toEqual([]);
    expect((await listPublicMarkets(ctx.marketDeps)).markets).toEqual([]);
  });

  it("manual join rejects a target-settled market", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 9, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    const outcomeId = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, outcomeId, "SETTLED");
    await ctx.store.updatePartnerRules("p-1", { ...OPEN_RULES });
    await expect(joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" })).rejects.toMatchObject({
      status: 403,
      code: "TARGET_REACHED",
    });
  });

  it("checkout preparation is rejected after completion", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 11, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" });
    const terms = await ctx.store.getTerms(id, "p-1");
    const referral = await ctx.store.getReferralByTerms(terms!.id);
    const outcomeId = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, outcomeId, "SETTLED");
    await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    const { mintAttributionSession, createCheckoutIntent } = await import("@/server/services/checkout");
    const checkoutDeps = { ...ctx.marketDeps, config: CONFIG, reader: null } as never;
    const session = await mintAttributionSession(checkoutDeps, {
      referralId: referral!.id,
      campaignId: id,
      partnerId: "p-1",
      partnerTermsId: terms!.id,
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    await expect(
      createCheckoutIntent(checkoutDeps, {
        attributionHandle: session.handle,
        payerAddress: "0x6666666666666666666666666666666666666666",
        amountMicroUsdc: "10000000",
      }),
    ).rejects.toMatchObject({ status: 403, code: "TARGET_REACHED" });
  });

  it("referral is non-attributable after completion", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 10, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: OPEN_RULES });
    await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" });
    const terms = await ctx.store.getTerms(id, "p-1");
    const referral = await ctx.store.getReferralByTerms(terms!.id);
    const before = await resolveReferral(ctx.marketDeps, { code: referral!.code });
    expect(before.attributable).toBe(true);
    const outcomeId = await verifiedOutcome(ctx, id);
    await payoutInState(ctx, id, outcomeId, "SETTLED");
    await finalizeMarketIfTargetSettled(ctx.store, ctx.marketDeps.audit, { campaignId: id });
    const after = await resolveReferral(ctx.marketDeps, { code: referral!.code });
    expect(after.attributable).toBe(false);
  });
});
