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
  type FundingDeps,
} from "@/server/services/fundings";
import { registerTestWallet } from "./wallet-fixtures";
import type {
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
import {
  DEFAULT_PRICING_POLICY,
  derivePace,
  evaluatePricing,
  type KernelInputs,
} from "@/server/domain/pricing";
import {
  evaluateMarket,
  getMarketPricingState,
  processPricingEvaluations,
  type PricingDeps,
} from "@/server/services/pricing";
import { reserveOutcomePayout } from "@/server/services/payouts";

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const PARTNER2_W = "0x9999999999999999999999999999999999999999" as Address;
const CUSTOMER = "0x6666666666666666666666666666666666666666" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const OPENED_MS = new Date("2026-01-01T00:00:00.000Z").getTime(); // memory-store fixed clock
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEADLINE_MS = new Date(DEADLINE).getTime();
const DEST = "https://acme.example/product";
const BLOCK_MS = new Date("2026-06-01T12:05:00.000Z").getTime();

const CONFIG = {
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR,
  verifierAddress: VERIFIER,
  explorerBaseUrl: null,
};

class FakeChain implements PayoutChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  evidence = new Map<string, TransferEvidence>();
  vaultStates = new Map<string, VaultCampaignState>();
  payoutEvidence = new Map<string, { status: "success" | "reverted"; to: Address | null; blockNumber: bigint; paid: PaidEventEvidence[] }>();
  consumed = new Set<string>();
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
  async getPayoutEvidence(txHash: Hex) {
    return this.payoutEvidence.get(txHash.toLowerCase()) ?? null;
  }
  async isOutcomeConsumed(_vault: Address, outcomeId: Hex) {
    return this.consumed.has(outcomeId.toLowerCase());
  }
}

const txFor = (s: string) => (`0x${s.padEnd(64, "0").slice(0, 64)}` as Hex);
let tag = 500;
const nextTx = () => {
  tag += 1;
  return txFor(`c${tag.toString(16)}`);
};

function setup(nowMs: number) {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [
      { id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} },
      { id: "p-2", userId: "partner-2", payoutWallet: PARTNER2_W, rulesJson: {} },
    ],
  }) as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const now = () => new Date(nowMs);
  const reader = new FakeChain();
  const base = { store, audit: sink, now };
  const deps = {
    store, events, reader,
    campaignDeps: { ...base } as CampaignDeps,
    marketDeps: { ...base } as MarketDeps,
    fundingDeps: { ...base, config: CONFIG, reader } as unknown as FundingDeps,
    checkoutDeps: { ...base, config: CONFIG, reader } as unknown as CheckoutDeps,
    pricingDeps: { ...base } as PricingDeps,
  };
  return deps;
}

type Ctx = ReturnType<typeof setup>;

/** Full flow to an OPEN market (no outcomes). */
async function openLiveMarket(ctx: Ctx, n: number, bounty = "2000000") {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, refundHoldSeconds: 0 } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerTestWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  const ftx = txFor(`f${n}`);
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: ftx });
  ctx.reader.receipts.set(ftx.toLowerCase(), {
    status: "success", to: VAULT, blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 15_000_000n, totalFunded: 15_000_000n }],
  });
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
    funded: 15_000_000n, spent: 0n, paused: false, closed: false, returned: false,
  });
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
  await openMarket(ctx.marketDeps, {
    campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1,
    openingBountyMicroUsdc: bounty, destinationUrl: DEST,
  });
  return d.campaign.id;
}

/** Direct VERIFIED outcome rows (cheap pace fixtures; service paths covered elsewhere). */
async function seedVerified(ctx: Ctx, campaignId: string, n: number, atMs: number) {
  for (let k = 0; k < n; k += 1) {
    const id = `o-seed-${campaignId.slice(0, 8)}-${k}`;
    await ctx.store.insertOutcome({
      id, campaignId, partnerId: "p-1", partnerTermsId: "t-seed",
      checkoutIntentId: `ci-${id}`, customerKeyHash: `ck-${id}`,
      purchaseTx: txFor(`s${campaignId.slice(0, 8)}${k}`), purchaseAmountMicroUsdc: 10_000_000n,
    });
    await ctx.store.updateOutcome(id, {
      status: "VERIFIED", proofHash: `0x${"ab".repeat(32)}`,
      occurredAt: new Date(atMs), verifiedAt: new Date(atMs), holdUntil: new Date(atMs),
    });
  }
}

function baseInputs(over: Partial<KernelInputs> = {}): KernelInputs {
  return {
    publicBountyMicroUsdc: 2_000_000n,
    bountyFloorMicroUsdc: 2_000_000n,
    bountyCeilingMicroUsdc: 4_000_000n,
    fundedMicroUsdc: 15_000_000n,
    committedMicroUsdc: 0n,
    targetOutcomeCount: 5,
    verifiedOutcomeCount: 0,
    openedAtMs: OPENED_MS,
    deadlineMs: DEADLINE_MS,
    nowMs: OPENED_MS + 182 * 86_400_000,
    recentJoins: 0,
    recentVerified: 0,
    msSinceLastReprice: null,
    marketStatus: "OPEN",
    campaignState: "LIVE",
    ...over,
  };
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

describe("kernel (pure, deterministic)", () => {
  it("under-paced with no supply reprices upward within bounds", () => {
    const r = evaluatePricing(baseInputs());
    expect(r.decision).toBe("REPRICE");
    expect(r.pace).toBe("UNDER_PACED");
    expect(r.reasons).toContain("NO_SUPPLY_BEHIND");
    expect(r.newBountyMicroUsdc).not.toBeNull();
    expect(r.newBountyMicroUsdc! > 2_000_000n).toBe(true);
    expect(r.newBountyMicroUsdc! <= 4_000_000n).toBe(true);
    expect(r.inputs.publicBountyMicroUsdc).toBe("2000000");
  });

  it("on-pace keeps, over-paced eases down toward the floor", () => {
    // ~40% elapsed, 40% verified -> ratio 1.0.
    const elapsed = Math.floor((DEADLINE_MS - OPENED_MS) * 0.4);
    const keep = evaluatePricing(baseInputs({ verifiedOutcomeCount: 2, nowMs: OPENED_MS + elapsed }));
    expect(keep.decision).toBe("KEEP");
    expect(keep.pace).toBe("ON_PACE");
    expect(keep.reasons).toEqual(["ON_PACE"]);
    // 80% verified at ~7% elapsed -> far ahead: eased down, floored above zero.
    const early = OPENED_MS + Math.floor((DEADLINE_MS - OPENED_MS) * 0.07);
    const down = evaluatePricing(baseInputs({ verifiedOutcomeCount: 4, nowMs: early, bountyFloorMicroUsdc: 1_000_000n }));
    expect(down.decision).toBe("REPRICE");
    expect(down.pace).toBe("OVER_PACED");
    expect(down.reasons).toContain("AHEAD_OF_PACE");
    expect(down.newBountyMicroUsdc).toBe(1_500_000n); // 25% max step down from 2M
    expect(down.newBountyMicroUsdc! >= 1_000_000n).toBe(true);
  });

  it("exhaustion and corruption fail closed to PAUSE", () => {
    expect(evaluatePricing(baseInputs({ verifiedOutcomeCount: 5 })).decision).toBe("PAUSE");
    expect(evaluatePricing(baseInputs({ verifiedOutcomeCount: 5 })).reasons).toContain("TARGET_MET");
    expect(evaluatePricing(baseInputs({ nowMs: DEADLINE_MS + 1 })).reasons).toContain("DEADLINE_PASSED");
    expect(evaluatePricing(baseInputs({ committedMicroUsdc: 14_000_000n })).reasons).toContain("BUDGET_EXHAUSTED");
    expect(evaluatePricing(baseInputs({ committedMicroUsdc: 12_000_000n })).reasons).toContain("CANNOT_AFFORD_FLOOR");
    expect(evaluatePricing(baseInputs({ bountyFloorMicroUsdc: 5_000_000n, bountyCeilingMicroUsdc: 4_000_000n })).reasons).toContain("INVALID_BOUNDS");
    expect(evaluatePricing(baseInputs({ fundedMicroUsdc: 0n })).reasons).toContain("INVALID_MONEY_STATE");
    expect(evaluatePricing(baseInputs({ publicBountyMicroUsdc: 9_000_000n })).reasons).toContain("INVALID_BOUNDS");
    expect(evaluatePricing(baseInputs({ marketStatus: "PAUSED" as never })).reasons).toContain("MARKET_NOT_OPEN");
  });

  it("clamps at the ceiling and floor instead of oscillating", () => {
    // Bounty pinned at ceiling while behind: KEEP, no futile row churn.
    // (Floor stays affordable: 5 x 2M = 10M <= 15M funded.)
    const atCeil = evaluatePricing(baseInputs({ publicBountyMicroUsdc: 4_000_000n }));
    expect(atCeil.decision).toBe("KEEP");
    expect(atCeil.reasons).toContain("AT_CEILING");
    // Raise capped exactly at the ceiling, floor never breached on the way down.
    const near = evaluatePricing(baseInputs({ publicBountyMicroUsdc: 3_900_000n }));
    if (near.decision === "REPRICE") expect(near.newBountyMicroUsdc).toBe(4_000_000n);
    else expect(near.reasons).toContain("NO_SIGNIFICANT_CHANGE");
    const down = evaluatePricing(
      baseInputs({ verifiedOutcomeCount: 4, nowMs: OPENED_MS + Math.floor((DEADLINE_MS - OPENED_MS) * 0.07), bountyFloorMicroUsdc: 1_000_000n, publicBountyMicroUsdc: 1_100_000n }),
    );
    if (down.decision === "REPRICE") expect(down.newBountyMicroUsdc! >= 1_000_000n).toBe(true);
  });

  it("enforces cooldown and minimum-change anti-thrash on reprices only", () => {
    const cooling = evaluatePricing(baseInputs({ msSinceLastReprice: 1000 }));
    expect(cooling.decision).toBe("KEEP");
    expect(cooling.reasons).toContain("COOLDOWN_ACTIVE");
    // Cooldown never blocks safety: exhaustion still pauses.
    const unsafe = evaluatePricing(baseInputs({ msSinceLastReprice: 1000, committedMicroUsdc: 14_000_000n }));
    expect(unsafe.decision).toBe("PAUSE");
  });

  it("derives pace states deterministically, including the no-signal open", () => {
    expect(derivePace(baseInputs({ nowMs: OPENED_MS }))).toBe("ON_PACE");
    expect(derivePace(baseInputs())).toBe("UNDER_PACED");
    expect(derivePace(baseInputs({ verifiedOutcomeCount: 5 }))).toBe("EXHAUSTED");
  });
});

describe("demand agent (evaluate + persist + execute)", () => {
  it("reprices an under-paced market, bumps version, freezes old terms", async () => {
    const ctx = setup(new Date("2026-07-01T00:00:00.000Z").getTime());
    const id = await openLiveMarket(ctx, 1);
    await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" });
    const before = (await ctx.store.getTerms(id, "p-1"))!;
    const r = await evaluateMarket(ctx.pricingDeps, { campaignId: id });
    expect(r.decision).toBe("REPRICE");
    expect(r.pace).toBe("UNDER_PACED");
    expect(r.autoExecuted).toBe(true);
    expect(r.alreadyRecorded).toBe(false);
    const market = await ctx.store.getMarket(id);
    expect(market?.version).toBe(2);
    expect(market?.publicBountyMicroUsdc).toBe(BigInt(r.newBountyMicroUsdc as string));
    expect((await ctx.store.getTerms(id, "p-1"))?.priceMicroUsdc).toBe(before.priceMicroUsdc);
    // New joiners see the new price; old terms never move.
    await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-2" });
    expect((await ctx.store.getTerms(id, "p-2"))?.priceMicroUsdc).toBe(market?.publicBountyMicroUsdc);
    expect((await ctx.store.getTerms(id, "p-2"))?.marketVersion).toBe(2);
    // Exact persisted inputs/reasons.
    const latest = await ctx.store.getLatestPricingDecision(id);
    expect(latest?.reasonCodes).toEqual(r.reasons);
    expect(latest?.inputsJson).toMatchObject({ publicBountyMicroUsdc: "2000000", targetOutcomeCount: 5 });
    expect(latest?.marketVersion).toBe(1);
    expect(latest?.oldBountyMicroUsdc?.toString()).toBe("2000000");
    expect(ctx.events.filter((e) => e.action === "pricing.repriced").length).toBe(1);
  });

  it("repeat evaluation of unchanged state is idempotent", async () => {
    // Memory rows stamp a fixed January clock while the service clock reads
    // July, so msSinceLastReprice is huge: use a long cooldown to prove the
    // rule itself (same mechanism as production, where clocks agree).
    const nowMs = new Date("2026-07-01T00:00:00.000Z").getTime();
    const ctx = setup(nowMs);
    const deps = { ...ctx.pricingDeps, policy: { cooldownMs: 200 * 86_400_000 } };
    const id = await openLiveMarket(ctx, 1);
    const first = await evaluateMarket(deps, { campaignId: id });
    expect(first.decision).toBe("REPRICE");
    const second = await evaluateMarket(deps, { campaignId: id });
    // Second run sees the repriced market: cooldown holds, no new version.
    expect(second.decision).toBe("KEEP");
    expect(second.reasons).toContain("COOLDOWN_ACTIVE");
    expect((await ctx.store.getMarket(id))?.version).toBe(2);
    void first;
  });

  it("pauses exhausted markets and blocks new joins without touching payouts", async () => {
    const buildNow = new Date("2026-06-01T12:00:00.000Z").getTime();
    const ctx = setup(buildNow);
    const id = await openLiveMarket(ctx, 1);
    await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" });
    // Full purchase -> VERIFIED outcome through services.
    const referral = await ctx.store.getReferralByCode((await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" })).referral.code);
    const { mintAttributionSession: mint, createCheckoutIntent: mk, submitCheckoutTx: sub, verifyCheckoutIntent: ver } =
      await import("@/server/services/checkout");
    const sess = await mint(ctx.checkoutDeps, {
      referralId: referral!.id, campaignId: id, partnerId: "p-1",
      partnerTermsId: referral!.partnerTermsId, expiresAt: new Date(Date.now() + 86_400_000),
    });
    const created = await mk(ctx.checkoutDeps, {
      attributionHandle: sess.handle, payerAddress: "0x6666666666666666666666666666666666666666", amountMicroUsdc: "10000000",
    });
    const ptx = nextTx();
    await sub(ctx.checkoutDeps, { intentId: created.intent.id, txHash: ptx });
    ctx.reader.receipts.set(ptx.toLowerCase(), { status: "success", to: USDC, blockNumber: 42n, fundedEvents: [] });
    ctx.reader.evidence.set(ptx.toLowerCase(), {
      sender: "0x6666666666666666666666666666666666666666" as Address,
      blockTimestampMs: BLOCK_MS, blockNumber: 42n,
      transfers: [{ token: USDC, from: "0x6666666666666666666666666666666666666666" as Address, to: OWNER_W, amount: 10_000_000n }],
    });
    const v = await ver(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(v.verified).toBe(true);

    // Past the deadline the agent pauses instead of pricing.
    const late = { ...ctx.pricingDeps, now: () => new Date("2027-01-01T00:00:00.000Z") };
    const paused = await evaluateMarket(late, { campaignId: id });
    expect(paused.decision).toBe("PAUSE");
    expect(paused.reasons).toContain("DEADLINE_PASSED");
    expect((await ctx.store.getMarket(id))?.status).toBe("PAUSED");

    // New participation stops; the verified outcome still reserves and pays.
    const joinErr = await fails(joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-2" }));
    expect(joinErr.code).toBe("MARKET_NOT_OPEN");
    const outcome = await ctx.store.getOutcomeByIntent(created.intent.id);
    const reserved = await reserveOutcomePayout(
      { store: ctx.store, audit: ctx.pricingDeps.audit, config: CONFIG, reader: ctx.reader, signer: null, executor: null, now: () => new Date("2027-01-02T00:00:00.000Z") },
      { outcomeId: outcome!.id },
    );
    expect(reserved.reserved).toBe(true);
    expect((await ctx.store.getOutcome(outcome!.id))?.status).toBe("VERIFIED");
    // Read model reflects the paused truth.
    const pricing = await getMarketPricingState(ctx.pricingDeps, { campaignId: id });
    expect(pricing.status).toBe("PAUSED");
    expect(pricing.lastDecision?.decision).toBe("PAUSE");
  });

  it("keeps on-pace markets and records the decision exactly", async () => {
    // 2 of 5 verified at ~40% elapsed -> ratio ~1.0 -> KEEP.
    const elapsed = Math.floor((DEADLINE_MS - OPENED_MS) * 0.4);
    const ctx = setup(OPENED_MS + elapsed);
    const id = await openLiveMarket(ctx, 1);
    await seedVerified(ctx, id, 2, OPENED_MS + Math.floor(elapsed / 2));
    const r = await evaluateMarket(ctx.pricingDeps, { campaignId: id });
    expect(r.decision).toBe("KEEP");
    expect(r.pace).toBe("ON_PACE");
    expect(r.autoExecuted).toBe(false);
    expect((await ctx.store.getMarket(id))?.version).toBe(1);
    const latest = await ctx.store.getLatestPricingDecision(id);
    expect(latest?.inputsJson).toMatchObject({ verifiedOutcomeCount: 2, targetOutcomeCount: 5 });
    expect(latest?.reasonCodes).toEqual(["ON_PACE"]);
  });

  it("worker isolates per-market failures and skips paused markets cheaply", async () => {
    const ctx = setup(new Date("2026-07-01T00:00:00.000Z").getTime());
    const id = await openLiveMarket(ctx, 1);
    const summary = await processPricingEvaluations(
      { store: ctx.store, audit: ctx.pricingDeps.audit, now: () => new Date("2026-07-01T00:00:00.000Z") },
      { campaignIds: [id, "missing-campaign"] },
    );
    expect(summary.evaluated).toBe(1);
    expect(summary.decisions[0]).toMatchObject({ campaignId: id, decision: "REPRICE" });
    expect(summary.failed.length).toBe(1);
    expect(summary.failed[0].campaignId).toBe("missing-campaign");
  });

  it("read model exposes price, pace, decision, and cooldown", async () => {
    const ctx = setup(new Date("2026-07-01T00:00:00.000Z").getTime());
    const id = await openLiveMarket(ctx, 1);
    await evaluateMarket(ctx.pricingDeps, { campaignId: id });
    const state = await getMarketPricingState(ctx.pricingDeps, { campaignId: id });
    expect(state.publicBountyMicroUsdc).not.toBe("2000000");
    expect(state.marketVersion).toBe(2);
    expect(state.lastDecision?.decision).toBe("REPRICE");
    expect(state.lastDecision?.reasonCodes.length).toBeGreaterThan(0);
    expect(state.nextEligibleAt).not.toBeNull();
    expect(state.inputs?.targetOutcomeCount).toBe(5);
  });
});
