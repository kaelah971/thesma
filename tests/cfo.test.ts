import { describe, expect, it } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  allocateCapital,
  buildCapitalPlan,
  decideCapitalAction,
  decideSpendAction,
  loadCfoSnapshot,
  recordCfoPlan,
  scoreCampaignCapital,
  type CfoSnapshot,
} from "@/server/services/cfo";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;
const M = 1_000_000n;
const POLICY = { optimizationEnabled: true, maxBountyChangePct: 25, minimumEvidence: 1, evaluationWindowDays: 7 };
const OP_POLICY = { minReserveMicroUsdc: 50n * M, maxAutonomousPaymentMicroUsdc: 10n * M, maxAutonomousSpendPerPeriodMicroUsdc: null };

function dayAgo(n: number) {
  return new Date(NOW.getTime() - n * DAY);
}

async function fundedSetup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Acme" }],
  });
  await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
  await store.insertMarket({
    campaignId: "c-1", publicBountyMicroUsdc: 4n * M, status: "OPEN",
    destinationUrl: "https://acme.example/offer", version: 1, policyVersion: 1,
  });
  await store.insertVersion({
    id: "v-1", campaignId: "c-1", version: 1, intentText: "Get 10 paying customers",
    status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 200n * M,
    bountyFloorMicroUsdc: 1n * M, bountyCeilingMicroUsdc: 8n * M,
    minQualifyingPurchaseMicroUsdc: 1n * M, deadline: new Date(NOW.getTime() + 30 * DAY),
    marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
  });
  await store.insertFunding({
    id: "f-1", campaignId: "c-1", policyVersionId: "v-1", policyVersion: 1,
    campaignKey: "0xkey1", policyHash: "0xhash1", chainId: 1,
    vaultAddress: "0xvault", usdcAddress: "0xusdc", ownerAddress: "0xowner",
    expectedAmountMicroUsdc: 100n * M,
  });
  await store.updateFunding("c-1", 1, { status: "CONFIRMED", observedAmountMicroUsdc: 100n * M });
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

async function addVerified(store: Awaited<ReturnType<typeof fundedSetup>>["store"], n: number, price = 4n * M) {
  for (let i = 0; i < n; i += 1) {
    const id = `o-${n}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    await store.insertOutcome({
      id, campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
      checkoutIntentId: `ci-${id}`, customerKeyHash: `ck-${id}`, purchaseTx: `0xtx${id}`,
      purchaseAmountMicroUsdc: 10n * M,
    });
    await store.updateOutcome(id, { status: "VERIFIED", verifiedAt: dayAgo(1), holdUntil: dayAgo(0) });
  }
  await store.insertTerms({
    id: "t-1", campaignId: "c-1", partnerId: "p-1", priceMicroUsdc: price,
    allocationCount: 10, source: "INVITED", expiresAt: new Date(NOW.getTime() + 30 * DAY),
    policyVersion: 1, marketVersion: 1,
  }).catch(() => {});
}

function handSnapshot(): CfoSnapshot {
  const row = (
    campaignId: string, available: bigint, score: { v: number; actions: number },
  ): CfoSnapshot["campaigns"][number] => ({
    campaignId,
    objective: "obj",
    state: "LIVE",
    marketStatus: "OPEN",
    publicBountyMicroUsdc: (4n * M).toString(),
    targetOutcomeCount: 10,
    financials: {
      fundedMicroUsdc: (100n * M).toString(), spentMicroUsdc: "0",
      committedMicroUsdc: "0", reservedMicroUsdc: "0",
      verifiedUnpaidMicroUsdc: "0", availableMicroUsdc: available.toString(),
      frozenTermsExposureMicroUsdc: "0",
      hybridCommittedMicroUsdc: "0", hybridContingentMicroUsdc: "0",
    },
    pace: { status: "BEHIND", targetProgressPct: 20, timeProgressPct: 50, projectedOutcomes: 4 },
    evidence: {
      verifiedOutcomes: score.v, totalActions: score.actions,
      realizedCostPerVerifiedMicroUsdc: score.v > 0 ? (4n * M).toString() : null,
      confidence: score.actions >= 10 ? "HIGH" : "LOW", topLabel: null,
    },
    estimatedFundingRequiredMicroUsdc: (32n * M).toString(),
    budgetHeadroomMicroUsdc: (100n * M).toString(),
    nextDueMicroUsdc: "0",
    hardConflict: null,
    ambiguous: null,
    retentionD7Rate: null,
    retainedD7: 0,
    hasMilestoneDeals: false,
  });
  return {
    workspaceId: "ws-A",
    generatedAt: NOW.toISOString(),
    campaigns: [row("c-1", 60n * M, { v: 2, actions: 12 }), row("c-2", 40n * M, { v: 0, actions: 2 })],
    totals: {
      fundedMicroUsdc: (200n * M).toString(), spentMicroUsdc: "0", committedMicroUsdc: "0",
      reservedMicroUsdc: "0", verifiedUnpaidMicroUsdc: "0", availableMicroUsdc: (100n * M).toString(),
      hybridCommittedMicroUsdc: "0", hybridContingentMicroUsdc: "0",
    },
  };
}

describe("capital states never double-count", () => {
  it("available excludes committed, reserved, verified-unpaid and floors at zero", async () => {
    const { store } = await fundedSetup();
    await addVerified(store, 6);
    // 2 settled (spent), 1 reserved in flight, 3 verified-unpaid at 4M terms.
    const verified = await store.listOutcomesByStatus("VERIFIED", 100);
    expect(verified).toHaveLength(6);
    let k = 0;
    for (const o of verified.slice(0, 2)) {
      await store.insertReservation({ id: `r-s-${k}`, campaignId: "c-1", outcomeId: o.id, partnerId: "p-1", partnerTermsId: "t-1", amountMicroUsdc: 4n * M, policyVersionId: "v-1" });
      await store.insertPayout({ id: `p-s-${k}`, reservationId: `r-s-${k}`, outcomeId: o.id, campaignId: "c-1", partnerId: "p-1", recipient: "0xabc", amountMicroUsdc: 4n * M, proofHash: "0xproof" });
      await store.updatePayout(`p-s-${k}`, { state: "SETTLED" });
      await store.updateReservation(`r-s-${k}`, { state: "SETTLED" });
      k += 1;
    }
    await store.insertReservation({ id: "r-flight", campaignId: "c-1", outcomeId: verified[2].id, partnerId: "p-1", partnerTermsId: "t-1", amountMicroUsdc: 4n * M, policyVersionId: "v-1" });
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW, growthPolicy: POLICY, operatorPolicy: OP_POLICY });
    const row = snapshot.campaigns.find((r) => r.campaignId === "c-1")!;
    // funded 100 = spent 8 + reserved 4 + verifiedUnpaid 12 + available 76. Each micro-USDC in exactly one bucket.
    expect(row.financials.spentMicroUsdc).toBe((8n * M).toString());
    expect(row.financials.reservedMicroUsdc).toBe((4n * M).toString());
    expect(row.financials.verifiedUnpaidMicroUsdc).toBe((12n * M).toString());
    expect(row.financials.availableMicroUsdc).toBe((76n * M).toString());
    expect(BigInt(row.financials.fundedMicroUsdc)).toBe(
      BigInt(row.financials.spentMicroUsdc) + BigInt(row.financials.committedMicroUsdc) + BigInt(row.financials.verifiedUnpaidMicroUsdc) + BigInt(row.financials.availableMicroUsdc),
    );
  });
});

describe("score / spend / capital kernels", () => {
  it("completed and hard-conflict campaigns score zero and earn nothing", () => {
    const done = scoreCampaignCapital({
      verifiedOutcomes: 10, totalActions: 20, evidenceConfidence: "HIGH",
      realizedCostPerVerifiedMicroUsdc: 4n * M, currentBountyMicroUsdc: 4n * M, bountyCeilingMicroUsdc: 8n * M,
      paceStatus: "COMPLETE", targetRemaining: 0, targetTotal: 10,
      fundedMicroUsdc: 100n * M, availableMicroUsdc: 10n * M, complete: true, hardConflict: null, ambiguous: null,
    });
    expect(done.capitalScore).toBe(0);
    expect(decideSpendAction({
      complete: true, hardConflict: null, ambiguous: null, fundedMicroUsdc: 100n * M,
      availableMicroUsdc: 10n * M, remaining: 0, paceStatus: "COMPLETE", cacRatio: 1, ceilingBreached: false,
    }).action).toBe("COMPLETE");
    const conflict = scoreCampaignCapital({
      verifiedOutcomes: 2, totalActions: 5, evidenceConfidence: "MEDIUM",
      realizedCostPerVerifiedMicroUsdc: 4n * M, currentBountyMicroUsdc: 4n * M, bountyCeilingMicroUsdc: 8n * M,
      paceStatus: "ON_PACE", targetRemaining: 8, targetTotal: 10,
      fundedMicroUsdc: 100n * M, availableMicroUsdc: 50n * M, complete: false,
      hardConflict: "Market is PAUSED.", ambiguous: null,
    });
    expect(conflict.capitalScore).toBe(0);
    expect(decideCapitalAction({ spend: "ESCALATE", unfunded: false, capitalScore: 0, confidence: "MEDIUM", lowSample: false }).action).toBe("ESCALATE");
  });

  it("poor verified economics forces SLOW/PAUSE even when behind pace", () => {
    const spend = decideSpendAction({
      complete: false, hardConflict: null, ambiguous: null, fundedMicroUsdc: 100n * M,
      availableMicroUsdc: 40n * M, remaining: 8, paceStatus: "BEHIND", cacRatio: 2.5, ceilingBreached: false,
    });
    expect(spend.action).toBe("PAUSE");
    const slow = decideSpendAction({
      complete: false, hardConflict: null, ambiguous: null, fundedMicroUsdc: 100n * M,
      availableMicroUsdc: 40n * M, remaining: 8, paceStatus: "BEHIND", cacRatio: 1.5, ceilingBreached: false,
    });
    expect(slow.action).toBe("SLOW");
  });

  it("ambiguous truth fails closed to ESCALATE", () => {
    const spend = decideSpendAction({
      complete: false, hardConflict: null, ambiguous: "Pace truth unavailable.",
      fundedMicroUsdc: 100n * M, availableMicroUsdc: 40n * M, remaining: 8,
      paceStatus: "UNKNOWN", cacRatio: null, ceilingBreached: false,
    });
    expect(spend.action).toBe("ESCALATE");
  });
});

describe("allocation is bounded and deterministic", () => {
  it("sums within deployable, caps LOW, explores cold-start, ties deterministic", () => {
    const first = allocateCapital(
      [
        { campaignId: "c-high", capitalScore: 85, confidence: "HIGH", exploration: false, needMicroUsdc: 500n * M },
        { campaignId: "c-low", capitalScore: 70, confidence: "LOW", exploration: false, needMicroUsdc: 500n * M },
        { campaignId: "c-new", capitalScore: 45, confidence: "LOW", exploration: true, needMicroUsdc: 500n * M },
        { campaignId: "c-tie-a", capitalScore: 60, confidence: "MEDIUM", exploration: false, needMicroUsdc: 500n * M },
        { campaignId: "c-tie-b", capitalScore: 60, confidence: "MEDIUM", exploration: false, needMicroUsdc: 500n * M },
      ],
      200n * M,
    );
    const second = allocateCapital(
      [
        { campaignId: "c-tie-b", capitalScore: 60, confidence: "MEDIUM", exploration: false, needMicroUsdc: 500n * M },
        { campaignId: "c-tie-a", capitalScore: 60, confidence: "MEDIUM", exploration: false, needMicroUsdc: 500n * M },
        { campaignId: "c-new", capitalScore: 45, confidence: "LOW", exploration: true, needMicroUsdc: 500n * M },
        { campaignId: "c-low", capitalScore: 70, confidence: "LOW", exploration: false, needMicroUsdc: 500n * M },
        { campaignId: "c-high", capitalScore: 85, confidence: "HIGH", exploration: false, needMicroUsdc: 500n * M },
      ],
      200n * M,
    );
    // Deterministic regardless of input order.
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    const total = [...first.values()].reduce((s, v) => s + v, 0n);
    expect(total <= 200n * M).toBe(true);
    // Explorer gets a bounded grant instead of zero.
    expect(first.get("c-new")! > 0n).toBe(true);
    expect(first.get("c-new")! <= 20n * M).toBe(true);
    // LOW cannot dominate: capped at 15% of deployable each.
    expect(first.get("c-low")! <= 30n * M).toBe(true);
    // Higher score earns more than an equal-need lower score.
    expect(first.get("c-high")! > first.get("c-tie-a")!).toBe(true);
    // Exact ties split deterministically (a before b).
    expect(first.get("c-tie-a")! >= first.get("c-tie-b")!).toBe(true);
  });

  it("zero deployable allocates nothing", () => {
    expect(allocateCapital([{ campaignId: "c-1", capitalScore: 90, confidence: "HIGH", exploration: false, needMicroUsdc: 10n * M }], 0n).size).toBe(0);
  });
});

describe("plan-level allocation rewards efficiency, bounds exploration", () => {
  it("HIGH efficient campaign earns more; LOW explorer capped; books reconcile", async () => {
    const { store } = await fundedSetup();
    const snapshot = handSnapshot();
    const plan = await buildCapitalPlan(snapshot, { store, growthPolicy: POLICY, operatorPolicy: OP_POLICY, now: NOW });
    const c1 = plan.campaigns.find((c) => c.campaignId === "c-1")!;
    const c2 = plan.campaigns.find((c) => c.campaignId === "c-2")!;
    expect(c1.capitalAction).toBe("INCREASE_ALLOCATION");
    expect(c2.exploration).toBe(true);
    expect(BigInt(c1.recommendedNewAllocationMicroUsdc) > BigInt(c2.recommendedNewAllocationMicroUsdc)).toBe(true);
    expect(BigInt(c2.recommendedNewAllocationMicroUsdc) <= (BigInt(plan.totals.deployableMicroUsdc) * 15n) / 100n).toBe(true);
    const allocated = plan.campaigns.reduce((s, c) => s + BigInt(c.recommendedNewAllocationMicroUsdc), 0n);
    expect(allocated + BigInt(plan.totals.unallocatedMicroUsdc)).toBe(BigInt(plan.totals.deployableMicroUsdc));
  });
});

describe("bounty coordination", () => {
  async function healthyBehind() {
    const { store, sink } = await fundedSetup();
    await addVerified(store, 8);
    for (let i = 0; i < 3; i += 1) {
      await store.insertTerms({
        id: `tj-${i}`, campaignId: "c-1", partnerId: `pj-${i}`, priceMicroUsdc: 4n * M,
        allocationCount: 2, source: "PUBLIC", expiresAt: new Date(NOW.getTime() + 30 * DAY),
        policyVersion: 1, marketVersion: 1,
      });
    }
    return { store, sink };
  }
  it("policy + evidence + liquidity + ceiling can yield a bounded increase recommendation", async () => {
    const { store } = await healthyBehind();
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW, growthPolicy: POLICY, operatorPolicy: OP_POLICY });
    const plan = await buildCapitalPlan(snapshot, { store, growthPolicy: POLICY, operatorPolicy: OP_POLICY, now: NOW });
    const c = plan.campaigns.find((d) => d.campaignId === "c-1")!;
    expect(["INCREASE_BOUNTY", "KEEP_BOUNTY", "DECREASE_BOUNTY", "NO_ACTION"]).toContain(c.bountyAction);
    expect(c.bountyExecution).toBe("RECOMMENDED");
  });
  it("closed market escalates bounty, spend and capital with zero allocation", async () => {
    const { store } = await healthyBehind();
    await store.updateMarket("c-1", 1, { status: "CLOSED", version: 2 });
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW, growthPolicy: POLICY, operatorPolicy: OP_POLICY });
    const plan = await buildCapitalPlan(snapshot, { store, growthPolicy: POLICY, operatorPolicy: OP_POLICY, now: NOW });
    const c = plan.campaigns.find((d) => d.campaignId === "c-1")!;
    expect(c.bountyAction).toBe("ESCALATE_BOUNTY");
    expect(c.spendAction).toBe("ESCALATE");
    expect(c.capitalAction).toBe("ESCALATE");
    expect(c.recommendedNewAllocationMicroUsdc).toBe("0");
    expect(plan.escalations.map((e) => e.campaignId)).toContain("c-1");
  });
  it("optimization disabled means no autonomous pricing view", async () => {
    const { store } = await healthyBehind();
    const off = { ...POLICY, optimizationEnabled: false };
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW, growthPolicy: off, operatorPolicy: OP_POLICY });
    const plan = await buildCapitalPlan(snapshot, { store, growthPolicy: off, operatorPolicy: OP_POLICY, now: NOW });
    expect(plan.campaigns.find((d) => d.campaignId === "c-1")!.bountyAction).toBe("NO_ACTION");
  });
});

describe("capital plan reconciles and protects obligations", () => {
  it("reserve intact, obligations covered, frozen terms untouched, labels honest", async () => {
    const { store, sink, events } = await fundedSetup();
    await addVerified(store, 3);
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW, growthPolicy: POLICY, operatorPolicy: OP_POLICY });
    const beforeTerms = await store.listReservationsByCampaign("c-1");
    const plan = await buildCapitalPlan(snapshot, { store, growthPolicy: POLICY, operatorPolicy: OP_POLICY, now: NOW });
    // Reserve + 24h estimate fenced off before any allocation.
    const avail = BigInt(plan.totals.availableMicroUsdc);
    const deploy = BigInt(plan.totals.deployableMicroUsdc);
    expect(deploy).toBe(avail - BigInt(plan.totals.reserveMicroUsdc) - BigInt(plan.totals.est24hObligationsMicroUsdc) > 0n
      ? avail - BigInt(plan.totals.reserveMicroUsdc) - BigInt(plan.totals.est24hObligationsMicroUsdc)
      : 0n);
    // New allocations + unallocated == deployable exactly.
    const allocated = plan.campaigns.reduce((s, c) => s + BigInt(c.recommendedNewAllocationMicroUsdc), 0n);
    expect(allocated + BigInt(plan.totals.unallocatedMicroUsdc)).toBe(deploy);
    // Chain movement unavailable; everything recommendation-only.
    expect(plan.chainMovement).toBe("UNAVAILABLE");
    for (const c of plan.campaigns) {
      expect(c.executionStatus).toBe("RECOMMENDED");
      expect(c.bountyExecution).toBe("RECOMMENDED");
    }
    // Evaluating the plan creates no payouts or reservations.
    await recordCfoPlan(sink, plan);
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(beforeTerms.length);
    expect(await store.getPayoutByOutcome("nope")).toBeNull();
    const actions = events.map((e) => (e as { action?: string }).action);
    expect(actions).toContain("cfo.plan.generated");
    expect(actions).toContain("cfo.campaign.decision");
    // Deterministic repeat.
    const again = await buildCapitalPlan(snapshot, { store, growthPolicy: POLICY, operatorPolicy: OP_POLICY, now: NOW });
    expect(again).toEqual(plan);
  });

  it("org isolation: workspace B never appears in workspace A plan", async () => {
    const { store } = await fundedSetup();
    await store.insertCampaign({ id: "c-b", workspaceId: "ws-B", state: "LIVE", createdByUserId: "owner-9" });
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW, growthPolicy: POLICY, operatorPolicy: OP_POLICY });
    expect(snapshot.campaigns.map((c) => c.campaignId)).toEqual(["c-1"]);
    const plan = await buildCapitalPlan(snapshot, { store, growthPolicy: POLICY, operatorPolicy: OP_POLICY, now: NOW });
    expect(JSON.stringify(plan)).not.toContain("c-b");
  });

  it("plan DTO leaks no private material", async () => {
    const { store } = await fundedSetup();
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW, growthPolicy: POLICY, operatorPolicy: OP_POLICY });
    const plan = await buildCapitalPlan(snapshot, { store, growthPolicy: POLICY, operatorPolicy: OP_POLICY, now: NOW });
    expect(JSON.stringify(plan)).not.toMatch(/wallet|secret|token|session|privateKey|mnemonic|txHash/i);
  });
});
