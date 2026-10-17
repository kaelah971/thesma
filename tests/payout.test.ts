import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
import type {
  ArcConfig,
  FundedEventEvidence,
  PaidEventEvidence,
  PayoutChainReader,
  TransferEvidence,
  TxReceiptSummary,
  VaultCampaignState,
} from "@/server/chain/arc";
import { joinCampaign, openMarket } from "@/server/services/markets";
import type { MarketDeps } from "@/server/services/markets";
import {
  createCheckoutIntent,
  mintAttributionSession,
  submitCheckoutTx,
  verifyCheckoutIntent,
  type CheckoutDeps,
} from "@/server/services/checkout";
import { LocalKeyProofSigner } from "@/server/chain/signers";
import type { OutcomeProofSigner, PayoutExecutor, PayoutSubmitArgs } from "@/server/chain/signers";
import { outcomeId32For } from "@/server/domain/payout";
import {
  getPayoutReceipt,
  processEligiblePayouts,
  reconcilePayout,
  reserveOutcomePayout,
  settleReservedPayout,
  type PayoutDeps,
} from "@/server/services/payouts";

const OWNER_W = "0x1111111111111111111111111111111111111111" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR_W = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER_KEY = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const VERIFIER_W = privateKeyToAccount(VERIFIER_KEY).address;
const CUSTOMER = "0x6666666666666666666666666666666666666666" as Address;
const CUSTOMER_2 = "0x7777777777777777777777777777777777777777" as Address;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const BLOCK_MS = new Date("2026-06-01T12:05:00.000Z").getTime();
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEST = "https://acme.example/product";

const CONFIG: ArcConfig = {
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR_W,
  verifierAddress: VERIFIER_W,
  explorerBaseUrl: null,
};

class FakePayoutReader implements PayoutChainReader {
  chainId = 31337;
  receipts = new Map<string, TxReceiptSummary>();
  evidence = new Map<string, TransferEvidence>();
  vaultStates = new Map<string, VaultCampaignState>();
  payoutEvidence = new Map<string, { status: "success" | "reverted"; to: Address | null; blockNumber: bigint; paid: PaidEventEvidence[] }>();
  consumed = new Set<string>();
  async getChainId() {
    return this.chainId;
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
  async getPayoutEvidence(txHash: Hex) {
    return this.payoutEvidence.get(txHash.toLowerCase()) ?? null;
  }
  async isOutcomeConsumed(_vault: Address, outcomeId: Hex) {
    return this.consumed.has(outcomeId.toLowerCase());
  }
}

class FakeExecutor implements PayoutExecutor {
  readonly address = EXECUTOR_W;
  calls: PayoutSubmitArgs[] = [];
  nextTx: Hex = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hex;
  async submitVerifiedOutcomePayout(args: PayoutSubmitArgs): Promise<Hex> {
    this.calls.push(args);
    return this.nextTx;
  }
}

const txFor = (s: string) => (`0x${s.padEnd(64, "0").slice(0, 64)}` as Hex);
let tag = 100;
const nextTx = () => {
  tag += 1;
  return txFor(`9${tag.toString(16)}`);
};

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [
      { id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} },
      { id: "p-2", userId: "partner-2", payoutWallet: PARTNER_W, rulesJson: {} },
    ],
  }) as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const now = () => FIXED_NOW;
  const campaignDeps: CampaignDeps = { store, audit: sink, now };
  const marketDeps: MarketDeps = { store, audit: sink, now };
  const reader = new FakePayoutReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now };
  const checkoutDeps: CheckoutDeps = { store, audit: sink, config: CONFIG, reader, now };
  const signer = new LocalKeyProofSigner(VERIFIER_KEY);
  const executor = new FakeExecutor();
  const payoutDeps: PayoutDeps = { store, audit: sink, config: CONFIG, reader, signer, executor, now };
  return { store, events, campaignDeps, marketDeps, fundingDeps, checkoutDeps, payoutDeps, reader, signer, executor };
}

async function verifiedOutcome(
  ctx: ReturnType<typeof setup>,
  opts: { customer?: Address; amount?: string; n?: number; draftOverrides?: Record<string, unknown>; bounty?: string; funded?: bigint } = {},
) {
  const funded = opts.funded ?? 15_000_000n;
  const n = opts.n ?? 1;
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, refundHoldSeconds: 0, ...(opts.draftOverrides ?? {}) } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerCompanyWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  const ftx = txFor(`f${n}`);
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: ftx });
  ctx.reader.receipts.set(ftx.toLowerCase(), {
    status: "success", to: VAULT, blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: funded, totalFunded: funded } as FundedEventEvidence],
  });
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR_W, verifier: VERIFIER_W,
    funded, spent: 0n, paused: false, closed: false, returned: false,
  });
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
  await openMarket(ctx.marketDeps, {
    campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1,
    openingBountyMicroUsdc: opts.bounty ?? "2000000", destinationUrl: DEST,
  });
  const j = await joinCampaign(ctx.marketDeps, { campaignId: d.campaign.id, userId: "partner-1" });
  const referral = await ctx.store.getReferralByCode(j.referral.code);
  const session = await mintAttributionSession(ctx.checkoutDeps, {
    referralId: referral!.id, campaignId: d.campaign.id, partnerId: "p-1",
    partnerTermsId: j.terms.id, expiresAt: new Date(Date.now() + 86_400_000),
  });
  const created = await createCheckoutIntent(ctx.checkoutDeps, {
    attributionHandle: session.handle,
    payerAddress: opts.customer ?? CUSTOMER,
    amountMicroUsdc: opts.amount ?? "10000000",
  });
  const ctxTx = nextTx();
  await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: ctxTx });
  const payer = (opts.customer ?? CUSTOMER) as Address;
  ctx.reader.receipts.set(ctxTx.toLowerCase(), { status: "success", to: USDC, blockNumber: 42n, fundedEvents: [] });
  ctx.reader.evidence.set(ctxTx.toLowerCase(), {
    sender: payer, blockTimestampMs: BLOCK_MS, blockNumber: 42n,
    transfers: [{ token: USDC, from: payer, to: OWNER_W, amount: BigInt(opts.amount ?? "10000000") }],
  });
  const v = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
  if (!v.verified) throw new Error("fixture failed to verify");
  const outcome = await ctx.store.getOutcomeByIntent(created.intent.id);
  // Onchain vault state for the payout path (funded, unspent).
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR_W, verifier: VERIFIER_W,
    funded, spent: 0n, paused: false, closed: false, returned: false,
  });
  return { campaignId: d.campaign.id, outcomeId: outcome!.id, funding: p };
}

function stageSettlement(ctx: ReturnType<typeof setup>, payoutTx: Hex, payout: { recipient: string; amountMicroUsdc: string; proofHash: string }, campaignKey: string, outcomeId: string) {
  ctx.reader.payoutEvidence.set(payoutTx.toLowerCase(), {
    status: "success",
    to: VAULT,
    blockNumber: 77n,
    paid: [{
      campaignKey: campaignKey as Hex,
      policyHash: "0x00" as Hex, // matched only on key/outcome/recipient/amount/proof below
      outcomeId: outcomeId32For(outcomeId),
      recipient: payout.recipient as Address,
      amount: BigInt(payout.amountMicroUsdc),
      proofHash: payout.proofHash as Hex,
    }],
  });
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

async function reservedFixture(ctx: ReturnType<typeof setup>, n: number) {
  const { outcomeId, funding } = await verifiedOutcome(ctx, { n });
  const r = await reserveOutcomePayout(ctx.payoutDeps, { outcomeId });
  if (!r.reserved || !r.reservation || !r.payout) throw new Error("expected reservation");
  return { outcomeId, reservation: r.reservation as { id: string }, payout: r.payout as { id: string }, funding };
}

describe("reservation (transactional, exact, idempotent)", () => {
  it("rejects unverified and hold-active outcomes", async () => {
    // PENDING (submitted, never verified) cannot reserve.
    const ctx = setup();
    const d = await createDraft(ctx.campaignDeps, { workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL });
    void d;
    const ctx2 = setup();
    const flow = await verifiedOutcome(ctx2, { n: 1 });
    void flow;
    // Build a second intent on the same campaign but stop before verification.
    const rejoin = await joinCampaign(ctx2.marketDeps, { campaignId: (await ctx2.store.listOutcomesByStatus("VERIFIED", 1))[0].campaignId, userId: "partner-1" });
    const refRow = await ctx2.store.getReferralByCode(rejoin.referral.code);
    const { mintAttributionSession: mint } = await import("@/server/services/checkout");
    const sess = await mint(ctx2.checkoutDeps, {
      referralId: refRow!.id, campaignId: refRow!.campaignId, partnerId: "p-1",
      partnerTermsId: refRow!.partnerTermsId, expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { createCheckoutIntent: mkIntent, submitCheckoutTx: submit } = await import("@/server/services/checkout");
    const second = await mkIntent(ctx2.checkoutDeps, { attributionHandle: sess.handle, payerAddress: CUSTOMER_2, amountMicroUsdc: "10000000" });
    await submit(ctx2.checkoutDeps, { intentId: second.intent.id, txHash: txFor("b1") });
    const pending = await ctx2.store.getOutcomeByIntent(second.intent.id);
    expect(pending?.status).toBe("PENDING");
    const notVerified = await fails(reserveOutcomePayout(ctx2.payoutDeps, { outcomeId: pending!.id }));
    expect(notVerified.code).toBe("NOT_VERIFIED");

    // VERIFIED but inside the refund hold cannot reserve.
    const ctx3 = setup();
    await verifiedOutcome(ctx3, { n: 2, draftOverrides: { refundHoldSeconds: 86_400 } });
    const held = (await ctx3.store.listOutcomesByStatus("VERIFIED", 10))[0];
    const res = await reserveOutcomePayout(ctx3.payoutDeps, { outcomeId: held.id });
    expect(res.reserved).toBe(false);
    expect((res as { reason?: string }).reason).toBe("HOLD_ACTIVE");
  });

  it("binds the frozen terms price snapshot (never reads the market)", async () => {
    const ctx = setup();
    const { campaignId } = await verifiedOutcome(ctx, { n: 1 });
    // No repricing API exists in S5, so the market bounty cannot move:
    // the reservation must equal the price frozen in PartnerTerms at join.
    const terms = await ctx.store.getTerms(campaignId, "p-1");
    expect(terms?.priceMicroUsdc).toBe(2_000_000n);
    const r = await reserveOutcomePayout(ctx.payoutDeps, { outcomeId: (await ctx.store.listOutcomesByStatus("VERIFIED", 1))[0].id });
    expect(r.reserved).toBe(true);
    if (r.reserved && r.reservation && r.payout) {
      expect(r.reservation.amountMicroUsdc).toBe(terms?.priceMicroUsdc.toString());
      expect(r.payout.amountMicroUsdc).toBe("2000000");
      expect(r.payout.recipient).toBe(PARTNER_W);
    } else throw new Error("expected reservation");
  });

  it("enforces allocation caps and funded-budget limits across outcomes", async () => {
    const tiny = {
      bountyFloorMicroUsdc: "1000000",
      bountyCeilingMicroUsdc: "4000000",
      minQualifyingPurchaseMicroUsdc: "1000000",
      targetOutcomeCount: 1,
      budgetMicroUsdc: "1000000",
      deadline: DEADLINE,
      refundHoldSeconds: 0,
    };
    // Second VERIFIED outcome on the SAME campaign + terms (fresh customer).
    const oneMoreOutcome = async (c: ReturnType<typeof setup>, campaignId: string, customer: Address, n: number) => {
      const { mintAttributionSession: mint2, createCheckoutIntent: mk2, submitCheckoutTx: sub2, verifyCheckoutIntent: ver2 } =
        await import("@/server/services/checkout");
      const rejoin = await joinCampaign(c.marketDeps, { campaignId, userId: "partner-1" });
      const refRow = await c.store.getReferralByCode(rejoin.referral.code);
      const sess = await mint2(c.checkoutDeps, {
        referralId: refRow!.id, campaignId, partnerId: "p-1",
        partnerTermsId: refRow!.partnerTermsId, expiresAt: new Date(Date.now() + 86_400_000),
      });
      const created = await mk2(c.checkoutDeps, { attributionHandle: sess.handle, payerAddress: customer, amountMicroUsdc: "1000000" });
      const ctxTx = nextTx();
      await sub2(c.checkoutDeps, { intentId: created.intent.id, txHash: ctxTx });
      c.reader.receipts.set(ctxTx.toLowerCase(), { status: "success", to: USDC, blockNumber: 42n, fundedEvents: [] });
      c.reader.evidence.set(ctxTx.toLowerCase(), {
        sender: customer, blockTimestampMs: BLOCK_MS, blockNumber: 42n,
        transfers: [{ token: USDC, from: customer, to: OWNER_W, amount: 1_000_000n }],
      });
      const v = await ver2(c.checkoutDeps, { intentId: created.intent.id });
      if (!v.verified) throw new Error("fixture failed to verify");
      return (await c.store.getOutcomeByIntent(created.intent.id))!.id;
    };
    const mkCampaign = async (c: ReturnType<typeof setup>, n: number, customer: Address) =>
      (await verifiedOutcome(c, { n, draftOverrides: tiny, bounty: "1000000", amount: "1000000", customer, funded: 1_000_000n })).outcomeId;
    // Default allocation is 1: the second outcome exhausts the terms.
    const ctx = setup();
    const first = await verifiedOutcome(ctx, { n: 1, draftOverrides: tiny, bounty: "1000000", amount: "1000000", customer: CUSTOMER, funded: 1_000_000n });
    expect((await reserveOutcomePayout(ctx.payoutDeps, { outcomeId: first.outcomeId })).reserved).toBe(true);
    const id2 = await oneMoreOutcome(ctx, first.campaignId, CUSTOMER_2, 2);
    const r2 = await reserveOutcomePayout(ctx.payoutDeps, { outcomeId: id2 });
    expect(r2.reserved).toBe(false);
    expect((r2 as { reason?: string }).reason).toBe("ALLOCATION_EXHAUSTED");

    // Wide allocation: the funded budget itself binds (1M funded, 1M each).
    const ctx2 = setup();
    await ctx2.store.updatePartnerRules("p-1", { maxAllocationCount: 10 });
    const w1 = await verifiedOutcome(ctx2, { n: 3, draftOverrides: tiny, bounty: "1000000", amount: "1000000", customer: CUSTOMER, funded: 1_000_000n });
    expect((await reserveOutcomePayout(ctx2.payoutDeps, { outcomeId: w1.outcomeId })).reserved).toBe(true);
    const w2 = await oneMoreOutcome(ctx2, w1.campaignId, CUSTOMER_2, 4);
    const over = await reserveOutcomePayout(ctx2.payoutDeps, { outcomeId: w2 });
    expect(over.reserved).toBe(false);
    expect((over as { reason?: string }).reason).toBe("INSUFFICIENT_BUDGET");
  });

  it("rejects over-ceiling frozen prices as corrupt policy data", async () => {
    // Join can never snapshot a price above the ceiling (the market bounty is
    // always within policy), so this guard only fires on corrupt DB state —
    // simulated here with direct inserts for a second profile.
    const ctx = setup();
    const { campaignId } = await verifiedOutcome(ctx, { n: 1 });
    await ctx.store.insertTerms({
      id: "t-bad", campaignId, partnerId: "p-2", priceMicroUsdc: 9_000_000n,
      allocationCount: 1, source: "PUBLIC", expiresAt: new Date(DEADLINE),
      policyVersion: 1, marketVersion: 1,
    });
    await ctx.store.insertOutcome({
      id: "o-bad", campaignId, partnerId: "p-2", partnerTermsId: "t-bad",
      checkoutIntentId: "ci-bad", customerKeyHash: "ck-bad", purchaseTx: txFor("bad"),
      purchaseAmountMicroUsdc: 10_000_000n,
    });
    await ctx.store.updateOutcome("o-bad", {
      status: "VERIFIED", proofHash: `0x${"ab".repeat(32)}`,
      occurredAt: new Date(BLOCK_MS), verifiedAt: FIXED_NOW, holdUntil: FIXED_NOW,
    });
    const err = await fails(reserveOutcomePayout(ctx.payoutDeps, { outcomeId: "o-bad" }));
    expect(err.code).toBe("POLICY_VIOLATION");
  });

  it("fails closed on signer identity mismatch without touching state", async () => {
    const ctx = setup();
    const { outcomeId } = await verifiedOutcome(ctx, { n: 1 });
    const r = await reserveOutcomePayout(ctx.payoutDeps, { outcomeId });
    if (!r.reserved || !r.reservation) throw new Error("expected reservation");
    const badSigner = { ...ctx.payoutDeps, signer: { ...ctx.signer, address: OWNER_W } as OutcomeProofSigner };
    const err = await fails(settleReservedPayout(badSigner, { reservationId: (r.reservation as { id: string }).id }));
    expect(err.code).toBe("SIGNER_MISMATCH");
    const reservation = await ctx.store.getReservation((r.reservation as { id: string }).id);
    const payout = await ctx.store.getPayoutByOutcome(outcomeId);
    expect(reservation?.state).toBe("RESERVED");
    expect(payout?.state).toBe("PREPARED");
    expect(payout?.txHash).toBeNull();
  });

  it("proves the EIP-712 digest is deterministic and amount-bound", async () => {
    const msg = {
      campaignKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
      policyHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
      outcomeId: outcomeId32For("outcome-1"),
      recipient: PARTNER_W,
      amount: 2_000_000n,
      proofHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex,
      occurredAt: 1_000_000n,
      validUntil: 2_000_000n,
    };
    const digest = (m: typeof msg) =>
      new LocalKeyProofSigner(VERIFIER_KEY).proofDigest({ chainId: 31337, vault: VAULT, message: m });
    const d1 = digest(msg);
    expect(digest(msg)).toBe(d1);
    expect(d1).toMatch(/^0x[a-f0-9]{64}$/);
    expect(digest({ ...msg, amount: 2_000_001n })).not.toBe(d1);
  });

  it("is idempotent per outcome and writes both audit events atomically", async () => {
    const ctx = setup();
    await verifiedOutcome(ctx, { n: 1 });
    const id = (await ctx.store.listOutcomesByStatus("VERIFIED", 1))[0].id;
    const first = await reserveOutcomePayout(ctx.payoutDeps, { outcomeId: id });
    const second = await reserveOutcomePayout(ctx.payoutDeps, { outcomeId: id });
    expect(second.reserved).toBe(true);
    expect((second as { alreadyReserved?: boolean }).alreadyReserved).toBe(true);
    expect((second.reservation as { id: string }).id).toBe((first.reservation as { id: string }).id);
    expect(ctx.events.filter((e) => e.action === "payout.reserved").length).toBe(1);
    expect(ctx.events.filter((e) => e.action === "payout.prepared").length).toBe(1);
  });
});

describe("execution (sign once, broadcast once, SUBMITTED != SETTLED)", () => {
  it("submits exact signed fields and stays SUBMITTED until reconciled", async () => {
    const ctx = setup();
    const { outcomeId, funding } = await reservedFixture(ctx, 1);
    const outcome = await ctx.store.getOutcome(outcomeId);
    const s = await settleReservedPayout(ctx.payoutDeps, {
      reservationId: (await ctx.store.getReservationByOutcome(outcomeId))!.id,
    });
    expect((s as { advanced?: boolean }).advanced).toBe(true);
    const payout = (s as { payout: { id: string } }).payout;
    const stored = await ctx.store.getPayout(payout.id);
    expect(stored?.state).toBe("SUBMITTED");
    expect(stored?.txHash).toBe(ctx.executor.nextTx);
    expect(stored?.verifierSignature).toMatch(/^0x[a-f0-9]+$/);
    const [call] = ctx.executor.calls;
    expect(call.vault).toBe(VAULT);
    expect(call.campaignKey.toLowerCase()).toBe(funding.campaignKey.toLowerCase());
    expect(call.outcomeId.toLowerCase()).toBe(outcomeId32For(outcomeId).toLowerCase());
    expect(call.recipient).toBe(PARTNER_W);
    expect(call.amount).toBe(2_000_000n);
    expect(call.proofHash.toLowerCase()).toBe(outcome!.proofHash!.toLowerCase());
    expect(call.occurredAt).toBe(BigInt(Math.floor(new Date(BLOCK_MS).getTime() / 1000)));
    expect(call.validUntil).toBe(BigInt(Math.floor(FIXED_NOW.getTime() / 1000)) + 1800n);
    expect(call.signature).toBe(stored?.verifierSignature);
    const reservation = await ctx.store.getReservationByOutcome(outcomeId);
    expect(reservation?.state).toBe("SUBMITTED");
    // Resubmitting the same reservation never rebroadcasts.
    const again = await settleReservedPayout(ctx.payoutDeps, { reservationId: reservation!.id });
    expect((again as { alreadySubmitted?: boolean }).alreadySubmitted).toBe(true);
    expect(ctx.executor.calls.length).toBe(1);
  });

  it("releases safely on recipient rotation before broadcast", async () => {
    const ctx = setup();
    const { outcomeId } = await reservedFixture(ctx, 1);
    const reservationId = (await ctx.store.getReservationByOutcome(outcomeId))!.id;
    await ctx.store.updatePartnerWallet("p-1", "0x9999999999999999999999999999999999999999");
    const s = await settleReservedPayout(ctx.payoutDeps, { reservationId });
    expect((s as { failureCode?: string }).failureCode).toBe("RECIPIENT_CHANGED");
    expect((await ctx.store.getReservation(reservationId))?.state).toBe("RELEASED");
    const payout = await ctx.store.getPayoutByOutcome(outcomeId);
    expect(payout?.state).toBe("FAILED");
    expect(ctx.executor.calls.length).toBe(0); // never broadcast
    // Retry reuses the same rows against the new wallet (one pair for life).
    const retry = await reserveOutcomePayout(ctx.payoutDeps, { outcomeId });
    expect(retry.reserved).toBe(true);
    expect((retry.reservation as { id: string }).id).toBe(reservationId);
    expect((retry.payout as { recipient: string }).recipient).toBe("0x9999999999999999999999999999999999999999");
    expect((await ctx.store.getReservation(reservationId))?.state).toBe("RESERVED");
  });
});

describe("reconciliation (canonical evidence only, never resend)", () => {
  async function settledFixture(ctx: ReturnType<typeof setup>, n: number, payoutTx?: Hex) {
    const { outcomeId, funding } = await reservedFixture(ctx, n);
    const reservationId = (await ctx.store.getReservationByOutcome(outcomeId))!.id;
    await settleReservedPayout(ctx.payoutDeps, { reservationId });
    const payout = (await ctx.store.getPayoutByOutcome(outcomeId))!;
    return { outcomeId, funding, payout };
  }

  it("settles on the exact OutcomePaid event and is idempotent", async () => {
    const ctx = setup();
    const { payout, funding } = await settledFixture(ctx, 1);
    ctx.reader.payoutEvidence.set(payout.txHash!.toLowerCase(), {
      status: "success",
      to: VAULT,
      blockNumber: 77n,
      paid: [{
        campaignKey: funding.campaignKey as Hex,
        policyHash: funding.policyHash as Hex,
        outcomeId: outcomeId32For(payout.outcomeId),
        recipient: PARTNER_W,
        amount: 2_000_000n,
        proofHash: payout.proofHash as Hex,
      }],
    });
    const r = await reconcilePayout(ctx.payoutDeps, { payoutId: payout.id });
    expect(r.settled).toBe(true);
    const stored = await ctx.store.getPayout(payout.id);
    expect(stored?.state).toBe("SETTLED");
    expect(stored?.blockNumber).toBe(77);
    expect((await ctx.store.getReservationByOutcome(payout.outcomeId))?.state).toBe("SETTLED");
    expect(ctx.events.filter((e) => e.action === "payout.settled").length).toBe(1);
    const again = await reconcilePayout(ctx.payoutDeps, { payoutId: payout.id });
    expect((again as { already?: boolean }).already).toBe(true);
    expect(ctx.events.filter((e) => e.action === "payout.settled").length).toBe(1);
  });

  it("fails with evidence on wrong events and reverts, releasing safely", async () => {
    const ctx = setup();
    const { payout } = await settledFixture(ctx, 1);
    // Successful tx to the vault without our event: nothing moved for us.
    ctx.reader.payoutEvidence.set(payout.txHash!.toLowerCase(), {
      status: "success", to: VAULT, blockNumber: 78n, paid: [],
    });
    const noEvent = await reconcilePayout(ctx.payoutDeps, { payoutId: payout.id });
    expect((noEvent as { settled?: boolean }).settled).toBe(false);
    expect((await ctx.store.getPayout(payout.id))?.state).toBe("FAILED");
    expect((await ctx.store.getReservationByOutcome(payout.outcomeId))?.state).toBe("RELEASED");

    const ctx2 = setup();
    const f2 = await settledFixture(ctx2, 2);
    ctx2.reader.payoutEvidence.set(f2.payout.txHash!.toLowerCase(), {
      status: "reverted", to: VAULT, blockNumber: 79n, paid: [],
    });
    await reconcilePayout(ctx2.payoutDeps, { payoutId: f2.payout.id });
    expect((await ctx2.store.getPayout(f2.payout.id))?.failureCode).toBe("TX_REVERTED");
    expect((await ctx2.store.getReservationByOutcome(f2.payout.outcomeId))?.state).toBe("RELEASED");
  });

  it("marks unknown receipts AMBIGUOUS without resending, then recovers", async () => {
    const ctx = setup();
    const { payout, funding } = await settledFixture(ctx, 1);
    const callsBefore = ctx.executor.calls.length;
    const amb = await reconcilePayout(ctx.payoutDeps, { payoutId: payout.id });
    expect((await ctx.store.getPayout(payout.id))?.state).toBe("AMBIGUOUS");
    expect(ctx.executor.calls.length).toBe(callsBefore); // no resend, ever
    const amb2 = await reconcilePayout(ctx.payoutDeps, { payoutId: payout.id });
    expect((amb2 as { already?: boolean }).already).toBe(true); // re-checked, still ambiguous, no new audit
    expect((await ctx.store.getPayout(payout.id))?.state).toBe("AMBIGUOUS");
    ctx.reader.payoutEvidence.set(payout.txHash!.toLowerCase(), {
      status: "success", to: VAULT, blockNumber: 80n,
      paid: [{
        campaignKey: funding.campaignKey as Hex,
        policyHash: funding.policyHash as Hex,
        outcomeId: outcomeId32For(payout.outcomeId),
        recipient: PARTNER_W,
        amount: 2_000_000n,
        proofHash: payout.proofHash as Hex,
      }],
    });
    const rec = await reconcilePayout(ctx.payoutDeps, { payoutId: payout.id });
    expect(rec.settled).toBe(true);
    void amb;
  });

  it("recovers a broadcast lost to a crash without double-paying", async () => {
    const ctx = setup();
    const { outcomeId } = await reservedFixture(ctx, 1);
    // Simulate: executor broadcast, process died before the hash persisted.
    // The payout row has no txHash; the outcome IS consumed onchain.
    ctx.reader.consumed.add(outcomeId32For(outcomeId).toLowerCase());
    const payout = (await ctx.store.getPayoutByOutcome(outcomeId))!;
    const r = await reconcilePayout(ctx.payoutDeps, { payoutId: payout.id });
    expect((await ctx.store.getPayout(payout.id))?.state).toBe("AMBIGUOUS");
    expect(ctx.executor.calls.length).toBe(0);
    void r;
  });
});

describe("worker (automatic, idempotent, receipt-truthful)", () => {
  async function stageEvidenceForBroadcast(ctx: ReturnType<typeof setup>) {
    // After the worker broadcasts, stage matching chain evidence for its tx.
    const calls = ctx.executor.calls;
    if (calls.length === 0) throw new Error("worker did not broadcast");
    const last = calls[calls.length - 1];
    const tx = ctx.executor.nextTx;
    const fundingRow = await ctx.store.getFunding(last.campaignKey ? "" : "", 0).catch(() => null);
    void fundingRow;
    ctx.reader.payoutEvidence.set(tx.toLowerCase(), {
      status: "success",
      to: VAULT,
      blockNumber: 90n,
      paid: [{
        campaignKey: last.campaignKey,
        policyHash: last.policyHash,
        outcomeId: last.outcomeId,
        recipient: last.recipient,
        amount: last.amount,
        proofHash: last.proofHash,
      }],
    });
  }

  it("pays each eligible outcome once across repeated runs", async () => {
    const ctx = setup();
    await verifiedOutcome(ctx, { n: 1 });
    const first = await processEligiblePayouts(ctx.payoutDeps, { limit: 10 });
    expect(first.submitted).toBe(1);
    expect(first.settled).toBe(0); // no evidence yet: honestly ambiguous
    expect(ctx.executor.calls.length).toBe(1);
    await stageEvidenceForBroadcast(ctx);
    const second = await processEligiblePayouts(ctx.payoutDeps, { limit: 10 });
    expect(second.settled).toBe(1);
    expect(ctx.executor.calls.length).toBe(1); // reconciled, never resent
    const third = await processEligiblePayouts(ctx.payoutDeps, { limit: 10 });
    expect(third.settled).toBe(0);
    expect(ctx.executor.calls.length).toBe(1);
    expect(third.skipped.some((s) => s.reason === "ALREADY_SETTLED")).toBe(true);
    const payouts = await ctx.store.getPayoutByOutcome((await ctx.store.listOutcomesByStatus("VERIFIED", 1))[0].id);
    expect(payouts?.state).toBe("SETTLED");
  });

  it("writes truthful receipts: SUBMITTED is never paid", async () => {
    const ctx = setup();
    await verifiedOutcome(ctx, { n: 1 });
    await processEligiblePayouts(ctx.payoutDeps, { limit: 10 });
    const payout = await ctx.store.getPayoutByOutcome((await ctx.store.listOutcomesByStatus("VERIFIED", 1))[0].id);
    const receipt = await getPayoutReceipt(ctx.store, { payoutId: payout!.id }, { explorerBaseUrl: "https://arc.example" });
    expect(receipt.payout.state).toBe("AMBIGUOUS");
    expect(receipt.settledMeansReconciled).toBe(false);
    expect(receipt.checks.holdCleared).toBe(true);
    expect(receipt.checks.amountMatchesTerms).toBe(true);
    expect(receipt.checks.policyFunded).toBe(true);
    expect(receipt.checks.recipientMatchesWallet).toBe(true);
    expect(receipt.payout.txHash).not.toBeNull();
    expect(receipt.explorerUrl).toContain(receipt.payout.txHash as string);
    // After evidence + reconcile, the receipt tells the truth the other way.
    await stageEvidenceForBroadcast(ctx);
    await processEligiblePayouts(ctx.payoutDeps, { limit: 10 });
    const settled = await getPayoutReceipt(ctx.store, { payoutId: payout!.id }, {});
    expect(settled.payout.state).toBe("SETTLED");
    expect(settled.settledMeansReconciled).toBe(true);
    expect(settled.payout.blockNumber).toBe(90);
  });
});
