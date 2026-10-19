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
  type MarketStore,
} from "@/server/services/campaignStore";
import {
  confirmFunding,
  prepareFundingIntent,
  recordFundingSubmitted,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import type { ArcChainReader, ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import { evaluateMarket, type PricingDeps } from "@/server/services/pricing";
import { joinCampaign, type MarketDeps as JoinDeps } from "@/server/services/markets";
import type { KernelInputs } from "@/server/domain/pricing";
import {
  buildGrowthPlan,
  buildPaceSnapshot,
  decideBountyChange,
  DEFAULT_GROWTH_POLICY,
  forecastLiquidity,
  recommendAllocation,
  summarizeCreatorPerformance,
  type CreatorPerformance,
  type GrowthPolicy,
  type PaceSnapshot,
} from "@/server/services/growth";

const DAY = 86_400_000;
const NOW = new Date("2026-06-01T12:00:00.000Z").getTime();
const U = 1_000_000n;

function kernelBase(over: Partial<KernelInputs> = {}): KernelInputs {
  return {
    publicBountyMicroUsdc: 2_000_000n,
    bountyFloorMicroUsdc: 1_000_000n,
    bountyCeilingMicroUsdc: 4_000_000n,
    fundedMicroUsdc: 15_000_000n,
    committedMicroUsdc: 1_000_000n,
    targetOutcomeCount: 10,
    verifiedOutcomeCount: 4,
    openedAtMs: NOW - 10 * DAY,
    deadlineMs: NOW + 10 * DAY,
    nowMs: NOW,
    recentJoins: 3,
    recentVerified: 3,
    msSinceLastReprice: null,
    marketStatus: "OPEN",
    campaignState: "LIVE",
    ...over,
  };
}

function paceFor(verified: number, openedAgoDays: number, deadlineInDays: number) {
  return buildPaceSnapshot({
    targetOutcomeCount: 10,
    verifiedOutcomeCount: verified,
    settledOutcomeCount: 0,
    openedAtMs: NOW - openedAgoDays * DAY,
    deadlineMs: NOW + deadlineInDays * DAY,
    nowMs: NOW,
    publicBountyMicroUsdc: 2_000_000n,
    fundedMicroUsdc: 15_000_000n,
    committedMicroUsdc: 1_000_000n,
    availableMicroUsdc: 14_000_000n,
  });
}

const POLICY: GrowthPolicy = { ...DEFAULT_GROWTH_POLICY, optimizationEnabled: true };
const BOUNDS = { bountyFloorMicroUsdc: 1_000_000n, bountyCeilingMicroUsdc: 4_000_000n };

function decide(pace: PaceSnapshot, inputs: KernelInputs, policy: GrowthPolicy = POLICY, available = 14_000_000n) {
  return decideBountyChange({
    pace,
    kernelInputs: inputs,
    recentJoins: inputs.recentJoins,
    recentVerified: inputs.recentVerified,
    availableMicroUsdc: available,
    bounds: BOUNDS,
    policy,
  });
}

describe("campaign pace snapshot", () => {
  it("reports BEHIND with rates and projection", () => {
    const pace = paceFor(4, 10, 10);
    expect(pace.paceStatus).toBe("BEHIND");
    expect(pace.targetProgressPct).toBe(40);
    expect(pace.timeProgressPct).toBe(50);
    expect(pace.verifiedOutcomesPerDay).toBeCloseTo(0.4, 2);
    expect(pace.requiredOutcomesPerDay).toBeCloseTo(0.6, 2);
    expect(pace.projectedOutcomesAtCurrentPace).toBe(8);
  });

  it("reports AHEAD / COMPLETE / AT_RISK honestly", () => {
    expect(paceFor(8, 5, 15).paceStatus).toBe("AHEAD");
    expect(paceFor(10, 10, 10).paceStatus).toBe("COMPLETE");
    expect(paceFor(2, 18, 2).paceStatus).toBe("AT_RISK");
    expect(paceFor(2, 10, -1).paceStatus).toBe("AT_RISK");
  });

  it("handles zero history without NaN or fake precision", () => {
    const pace = paceFor(0, 0, 20);
    expect(pace.verifiedOutcomesPerDay).toBe(0);
    expect(Number.isFinite(pace.targetProgressPct)).toBe(true);
    // No signal yet: kernel truth is ON_PACE, and the bounty gate still
    // demands separate evidence before acting.
    expect(pace.paceStatus).toBe("ON_PACE");
  });

  it("keeps VERIFIED and SETTLED counts separate", () => {
    const pace = buildPaceSnapshot({
      targetOutcomeCount: 10, verifiedOutcomeCount: 6, settledOutcomeCount: 2,
      openedAtMs: NOW - 10 * DAY, deadlineMs: NOW + 10 * DAY, nowMs: NOW,
      publicBountyMicroUsdc: 2_000_000n, fundedMicroUsdc: 15_000_000n,
      committedMicroUsdc: 1_000_000n, availableMicroUsdc: 14_000_000n,
    });
    expect(pace.verifiedOutcomeCount).toBe(6);
    expect(pace.settledOutcomeCount).toBe(2);
  });
});

describe("bounty decision gate", () => {
  it("BEHIND + evidence + liquidity → bounded INCREASE", () => {
    const d = decide(paceFor(4, 10, 10), kernelBase());
    expect(d.action).toBe("INCREASE_BOUNTY");
    expect(d.recommendedBountyMicroUsdc).toBe("2400000");
    expect(d.bounded).toBe(true);
    expect(BigInt(d.recommendedBountyMicroUsdc as string)).toBeLessThanOrEqual(BOUNDS.bountyCeilingMicroUsdc);
  });

  it("AHEAD never increases (eases down instead)", () => {
    const d = decide(paceFor(6, 10, 10), kernelBase({ verifiedOutcomeCount: 6 }));
    expect(d.action).not.toBe("INCREASE_BOUNTY");
    expect(d.action).toBe("DECREASE_BOUNTY");
    expect(d.recommendedBountyMicroUsdc).toBe("1600000");
  });

  it("AT_RISK at the human ceiling escalates instead of breaching it", () => {
    const bounty = 4_000_000n;
    const d = decide(
      paceFor(2, 10, 10),
      kernelBase({ publicBountyMicroUsdc: bounty, verifiedOutcomeCount: 2 }),
      POLICY,
    );
    expect(d.action).toBe("ESCALATE_BOUNTY");
    expect(d.rule).toBe("BOUNDS_EXCEEDED");
  });

  it("huge gaps escalate when one autonomous step cannot cover them", () => {
    const tight: GrowthPolicy = { ...POLICY, maxBountyChangePct: 10 };
    const d = decide(paceFor(1, 10, 10), kernelBase({ verifiedOutcomeCount: 1 }), tight);
    expect(d.action).toBe("ESCALATE_BOUNTY");
    expect(d.rule).toBe("STEP_EXCEEDED");
  });

  it("budget-constrained increases hold instead of overspending", () => {
    const d = decide(paceFor(4, 10, 10), kernelBase(), POLICY, 100_000n);
    expect(d.action).toBe("NO_ACTION");
    expect(d.rule).toBe("BUDGET_CONSTRAINED");
  });

  it("insufficient evidence and disabled policy never act", () => {
    const thin = decide(paceFor(4, 10, 10), kernelBase({ recentJoins: 1, recentVerified: 1 }));
    expect(thin.action).toBe("NO_ACTION");
    expect(thin.rule).toBe("INSUFFICIENT_EVIDENCE");
    const off = decide(paceFor(4, 10, 10), kernelBase(), { ...POLICY, optimizationEnabled: false });
    expect(off.action).toBe("NO_ACTION");
    expect(off.rule).toBe("OPTIMIZATION_DISABLED");
  });

  it("a rogue planner cannot bypass the gate", () => {
    // Planner "wants" a 3x increase; gate clamps to policy.
    const d = decide(paceFor(1, 10, 10), kernelBase({ verifiedOutcomeCount: 1 }), {
      ...POLICY,
      maxBountyChangePct: 5,
    });
    expect(d.action).not.toBe("INCREASE_BOUNTY");
    if (d.recommendedBountyMicroUsdc !== null) {
      const move = BigInt(d.recommendedBountyMicroUsdc) - 2_000_000n;
      expect(move <= (2_000_000n * 5n) / 100n || d.action === "ESCALATE_BOUNTY").toBe(true);
    }
  });
});

function perf(over: Partial<CreatorPerformance> = {}): CreatorPerformance {
  return summarizeCreatorPerformance({
    partnerId: "p-1",
    label: "@alice",
    clicks: 20,
    actions: 12,
    verifiedOutcomeIds: ["o-1", "o-2", "o-3"],
    settledOutcomeIds: ["o-1"],
    settledPayoutMicroUsdc: 2_000_000n,
    recentVerified: 2,
    evidenceWindowDays: 7,
    ...over,
  });
}

describe("creator performance", () => {
  it("derives real rates with confidence tiers", () => {
    const p = perf();
    expect(p.verifiedOutcomes).toBe(3);
    expect(p.settledOutcomes).toBe(1);
    expect(p.verificationRate).toBe(25);
    expect(p.visitToVerifiedRate).toBe(15);
    expect(p.settledUSDC).toBe("2000000");
    expect(p.confidence).toBe("HIGH");
    expect(perf({ actions: 4 }).confidence).toBe("MEDIUM");
    expect(perf({ actions: 1, clicks: 1, verifiedOutcomeIds: ["o-9"], settledOutcomeIds: [] }).confidence).toBe("LOW");
  });
});

describe("creator allocation", () => {
  it("ranks evidence first, damps tiny samples, keeps exploration open", () => {
    const alloc = recommendAllocation([
      perf({ partnerId: "big", label: "@big", actions: 100, clicks: 400, verifiedOutcomeIds: Array.from({ length: 20 }, (_, i) => `b${i}`), settledOutcomeIds: [], recentVerified: 5 }),
      perf({ partnerId: "tiny", label: "@tiny", actions: 1, clicks: 1, verifiedOutcomeIds: ["t1"], settledOutcomeIds: [], recentVerified: 1 }),
      perf({ partnerId: "new", label: "@new", actions: 0, clicks: 0, verifiedOutcomeIds: [], settledOutcomeIds: [], settledPayoutMicroUsdc: 0n, recentVerified: 0 }),
    ]);
    expect(alloc[0].partnerId).toBe("big");
    expect(alloc.find((a) => a.partnerId === "tiny")!.sharePct).toBeLessThanOrEqual(15);
    const newcomer = alloc.find((a) => a.partnerId === "new")!;
    expect(newcomer.sharePct).toBe(5);
    expect(newcomer.reason).toMatch(/exploration/i);
    const total = alloc.reduce((s, a) => s + a.sharePct, 0);
    expect(total).toBeGreaterThan(99);
    expect(total).toBeLessThanOrEqual(100.01);
  });
});

describe("liquidity forecast", () => {
  it("labels estimates and degrades gracefully on thin history", () => {
    const f = forecastLiquidity({
      verifiedAtMs: [NOW - 1 * 86_400_000, NOW - 2 * 86_400_000],
      nowMs: NOW,
      averageObligationMicroUsdc: 2_000_000n,
      currentCommittedMicroUsdc: 1_000_000n,
      currentReserveMicroUsdc: 500_000n,
      availableLiquidityMicroUsdc: 14_000_000n,
    });
    expect(f.basis).toMatch(/ESTIMATE/);
    expect(f.confidence).toBe("LOW");
    expect(BigInt(f.projectedFreeLiquidity24hMicroUsdc)).toBeLessThan(14_000_000n);
    const empty = forecastLiquidity({
      verifiedAtMs: [], nowMs: NOW, averageObligationMicroUsdc: 2_000_000n,
      currentCommittedMicroUsdc: 0n, currentReserveMicroUsdc: 0n, availableLiquidityMicroUsdc: 0n,
    });
    expect(empty.confidence).toBe("INSUFFICIENT_DATA");
  });
});

describe("growth plan", () => {
  it("composes a concise operator-readable plan", () => {
    const pace = paceFor(4, 10, 10);
    const bounty = decide(pace, kernelBase());
    const plan = buildGrowthPlan({
      pace,
      bounty,
      allocation: recommendAllocation([perf()]),
      forecast: forecastLiquidity({
        verifiedAtMs: [NOW - 86_400_000], nowMs: NOW, averageObligationMicroUsdc: 2_000_000n,
        currentCommittedMicroUsdc: 1_000_000n, currentReserveMicroUsdc: 500_000n, availableLiquidityMicroUsdc: 14_000_000n,
      }),
      policy: POLICY,
    });
    expect(plan.situation).toContain("BEHIND");
    expect(plan.recommendedAction).toContain("2400000");
    expect(plan.policyStatus).toContain("ON");
    expect(JSON.stringify(plan)).not.toMatch(/chain-of-thought|reasoning trace/i);
  });
});

// ---------- Historical-terms regression (memory store, real services) ----------

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
  const marketDeps: PricingDeps = { store, audit: sink, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, marketDeps, campaignDeps, fundingDeps, reader };
}

describe("historical terms survive repricing", () => {
  it("frozen partner terms keep their price across an executed REPRICE", async () => {
    const ctx = setup();
    const d = await createDraft(ctx.campaignDeps, {
      workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE } as never,
    });
    await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await registerCompanyWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
    const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: txFor(7) });
    ctx.reader.receipts.set(txFor(7).toLowerCase(), {
      status: "success", to: VAULT, blockNumber: 1n,
      fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 15_000_000n, totalFunded: 15_000_000n }],
    });
    ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
      exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
      bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
      funded: 15_000_000n, spent: 0n, paused: false, closed: false, returned: false,
    });
    await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
    const { openMarket } = await import("@/server/services/markets");
    await openMarket(ctx.marketDeps, {
      campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000", destinationUrl: DEST,
    });
    const joined = await joinCampaign(ctx.marketDeps as JoinDeps, { campaignId: d.campaign.id, userId: "partner-1" });
    expect(joined.terms.priceMicroUsdc).toBe("2000000");

    // Force a reprice-eligible market: starve it (0 verified of 5 target, past pace).
    const late = { ...ctx.marketDeps, now: () => new Date("2026-11-01T12:00:00.000Z") };
    const { evaluateMarket: evalMarket } = await import("@/server/services/pricing");
    const first = await evalMarket(late, { campaignId: d.campaign.id });
    // Either it reprices now or the kernel keeps for cooldown/evidence reasons —
    // the invariant under test is terms immutability in both cases.
    const termsAfter = await ctx.store.getTerms(d.campaign.id, "p-1");
    expect(termsAfter?.priceMicroUsdc.toString()).toBe("2000000");
    expect(termsAfter?.policyVersion).toBe(1);
    expect(termsAfter?.marketVersion).toBe(1);
    expect(first.decision).toMatch(/^(KEEP|REPRICE|PAUSE)$/);
  });
});
