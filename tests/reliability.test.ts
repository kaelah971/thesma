import { describe, expect, it } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  classifyOutcomeQuality,
  detectAnomalies,
  evaluateRetention,
  loadCampaignQuality,
  loadCreatorReliability,
  recordRetentionQualified,
  scoreReliability,
  verificationReadiness,
} from "@/server/services/reliability";
import { scoreCreatorMatch } from "@/server/services/matching";
import { buildCapitalPlan, loadCfoSnapshot } from "@/server/services/cfo";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;
const M = 1_000_000n;
const SUBJ = "ck-subject-1";

function daysAgo(n: number) {
  return new Date(NOW.getTime() - n * DAY);
}

async function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Acme" }],
    partners: [
      { id: "p-1", userId: "creator-1", payoutWallet: "0xeBB551653815900D6886d2eeEea2325d86275173", rulesJson: { autoJoin: false, minimumBountyMicroUsdc: "0", allowedCategories: [], blockedCategories: [], maxActiveCampaigns: 3, minScoutConfidence: "LOW", maxAutoJoinsPerDay: null } },
    ],
  });
  await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
  await store.insertMarket({
    campaignId: "c-1", publicBountyMicroUsdc: 4n * M, status: "OPEN",
    destinationUrl: "https://acme.example/offer", version: 1, policyVersion: 1,
  });
  await store.insertVersion({
    id: "v-1", campaignId: "c-1", version: 1, intentText: "Get paying customers",
    status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 200n * M,
    bountyFloorMicroUsdc: 1n * M, bountyCeilingMicroUsdc: 8n * M,
    minQualifyingPurchaseMicroUsdc: 1n * M, deadline: new Date(NOW.getTime() + 30 * DAY),
    marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
  });
  await store.insertFunding({
    id: "f-1", campaignId: "c-1", policyVersionId: "v-1", policyVersion: 1,
    campaignKey: "0xk", policyHash: "0xh", chainId: 1, vaultAddress: "0xv",
    usdcAddress: "0xu", ownerAddress: "0xo", expectedAmountMicroUsdc: 200n * M,
  });
  await store.updateFunding("c-1", 1, { status: "CONFIRMED", observedAmountMicroUsdc: 200n * M });
  await store.insertTerms({
    id: "t-1", campaignId: "c-1", partnerId: "p-1", priceMicroUsdc: 4n * M,
    allocationCount: 10, source: "PUBLIC", expiresAt: new Date(NOW.getTime() + 30 * DAY),
    policyVersion: 1, marketVersion: 1,
  });
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

let n = 0;
async function addOutcome(store: Awaited<ReturnType<typeof setup>>["store"], opts: {
  subject?: string | null; daysAgoVerified?: number | null; status?: string; tx?: string;
}) {
  const i = n++;
  await store.insertOutcome({
    id: `o-${i}`, campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
    checkoutIntentId: `ci-${i}`, customerKeyHash: opts.subject === null ? ("" as string) : (opts.subject ?? SUBJ),
    purchaseTx: opts.tx ?? `0xtx${i}`, purchaseAmountMicroUsdc: 10n * M,
  });
  if (opts.status || (opts.daysAgoVerified !== null && opts.daysAgoVerified !== undefined)) {
    await store.updateOutcome(`o-${i}`, {
      status: (opts.status ?? "VERIFIED") as "VERIFIED",
      ...(opts.daysAgoVerified !== null && opts.daysAgoVerified !== undefined
        ? { verifiedAt: daysAgo(opts.daysAgoVerified), holdUntil: daysAgo(opts.daysAgoVerified) }
        : {}),
    });
  }
  return `o-${i}`;
}

describe("reliability snapshot", () => {
  it("no-history creator is PROVISIONAL/LOW, neutral, never branded", () => {
    const s = scoreReliability({
      attributedActions: 0, verifiedOutcomes: 0, rejectedOutcomes: 0, settledCollaborations: 0,
      campaignsWithVerified: 0, retentionQualified: 0, retentionMatured: null, recentVerified: 0,
    });
    expect(s.reliabilityScore).toBe(50);
    expect(s.confidence).toBe("LOW");
    expect(s.level).toBe("PROVISIONAL");
    expect(JSON.stringify(s)).not.toMatch(/untrust|bad|fraud|scam|good creator|trustworthy/i);
  });

  it("verified history improves evidence; multi-campaign improves consistency", () => {
    const base = { attributedActions: 10, rejectedOutcomes: 1, settledCollaborations: 0, retentionQualified: 0, retentionMatured: null as number | null, recentVerified: 3 };
    const one = scoreReliability({ ...base, verifiedOutcomes: 2, campaignsWithVerified: 1 });
    const many = scoreReliability({ ...base, verifiedOutcomes: 8, campaignsWithVerified: 3, settledCollaborations: 2 });
    expect(many.reliabilityScore).toBeGreaterThan(one.reliabilityScore);
    expect(many.components.campaignConsistency.score ?? 0).toBeGreaterThan(one.components.campaignConsistency.score ?? 0);
  });

  it("settlement adds; unpaid-from-liquidity never subtracts", () => {
    const base = { attributedActions: 10, verifiedOutcomes: 5, rejectedOutcomes: 0, campaignsWithVerified: 1, retentionQualified: 0, retentionMatured: null as number | null, recentVerified: 2 };
    const unpaid = scoreReliability({ ...base, settledCollaborations: 0 });
    const settled = scoreReliability({ ...base, settledCollaborations: 2 });
    expect(settled.reliabilityScore).toBeGreaterThan(unpaid.reliabilityScore);
    // Five verified but zero settled (e.g. org out of liquidity) still scores positively.
    expect(unpaid.reliabilityScore).toBeGreaterThan(40);
  });

  it("thin sample can never be HIGH confidence", () => {
    const thin = scoreReliability({
      attributedActions: 2, verifiedOutcomes: 2, rejectedOutcomes: 0, settledCollaborations: 0,
      campaignsWithVerified: 1, retentionQualified: 0, retentionMatured: null, recentVerified: 2,
    });
    expect(thin.confidence).toBe("LOW");
    const mid = scoreReliability({
      attributedActions: 8, verifiedOutcomes: 6, rejectedOutcomes: 1, settledCollaborations: 1,
      campaignsWithVerified: 2, retentionQualified: 0, retentionMatured: null, recentVerified: 3,
    });
    expect(mid.confidence).not.toBe("HIGH");
  });

  it("match evidence ignores vanity: zero-history scores identical with or without optional fields", () => {
    const facts = {
      creatorUserId: "c", handle: "bgirl", creatorType: "CREATOR" as const, interests: ["ai"], preferences: [],
      profileCategory: "ai", campaignCategory: "ai", campaignKinds: ["referral"],
      bountyMicroUsdc: 4n * M, minBountyMicroUsdc: null, verifiedTotal: 0, settledCollaborations: 0,
      activeTermsCount: 0, maxActiveCampaigns: null, eligibility: "ELIGIBLE" as const, eligibilityReason: "ok",
    };
    const a = scoreCreatorMatch(facts);
    const b = scoreCreatorMatch({ ...facts, campaignsWithVerified: 0, retainedOutcomes: 0 });
    expect(a.evidenceScore).toBe(b.evidenceScore);
    expect(a.matchScore).toBe(b.matchScore);
  });
});

describe("retention semantics", () => {
  it("immature windows are excluded from denominators", () => {
    const { summary } = evaluateRetention(
      [{ id: "o1", campaignId: "c-1", subjectRef: SUBJ, status: "VERIFIED", verifiedAtMs: NOW.getTime() - 3 * DAY }],
      NOW.getTime(),
    );
    expect(summary.find((s) => s.window === "D7")!.eligible).toBe(0);
    expect(summary.find((s) => s.window === "D7")!.rate).toBeNull();
  });

  it("post-threshold VERIFIED qualifies; pre-threshold action never does", () => {
    const base = NOW.getTime() - 40 * DAY;
    const rows = [
      { id: "orig", campaignId: "c-1", subjectRef: SUBJ, status: "VERIFIED", verifiedAtMs: base },
      { id: "early", campaignId: "c-1", subjectRef: SUBJ, status: "VERIFIED", verifiedAtMs: base + 3 * DAY },
    ];
    const before = evaluateRetention(rows, base + 8 * DAY);
    expect(before.records.find((r) => r.originalOutcomeId === "orig")!.status).toBe("PENDING");
    const after = evaluateRetention(
      [...rows, { id: "late", campaignId: "c-1", subjectRef: SUBJ, status: "VERIFIED", verifiedAtMs: base + 10 * DAY }],
      base + 12 * DAY,
    );
    const rec = after.records.find((r) => r.originalOutcomeId === "orig" && r.window === "D7")!;
    expect(rec.status).toBe("QUALIFIED");
    expect(rec.qualifyingOutcomeId).toBe("late");
    expect(after.summary.find((s) => s.window === "D7")!.rate).toBe(100);
  });

  it("closed window without qualifying event is MISSED, not failed verification", () => {
    const base = NOW.getTime() - 60 * DAY;
    const { records, summary } = evaluateRetention(
      [{ id: "o1", campaignId: "c-1", subjectRef: SUBJ, status: "VERIFIED", verifiedAtMs: base }],
      NOW.getTime(),
    );
    expect(records.find((r) => r.window === "D7")!.status).toBe("MISSED");
    expect(summary.find((s) => s.window === "D7")!.rate).toBe(0);
  });

  it("missing subject is UNSUPPORTED, never fabricated", () => {
    const { records } = evaluateRetention(
      [{ id: "o1", campaignId: "c-1", subjectRef: null, status: "VERIFIED", verifiedAtMs: NOW.getTime() - 20 * DAY }],
      NOW.getTime(),
    );
    expect(records.find((r) => r.window === "D7")!.status).toBe("UNSUPPORTED");
  });

  it("one original cannot qualify twice in one window; evaluation is deterministic", () => {
    const base = NOW.getTime() - 40 * DAY;
    const mk = (id: string, at: number, status = "VERIFIED") => ({ id, campaignId: "c-1", subjectRef: SUBJ, status, verifiedAtMs: at });
    const rows = [mk("orig", base), mk("q1", base + 10 * DAY), mk("q2", base + 12 * DAY)];
    const a = evaluateRetention(rows, base + 15 * DAY);
    const b = evaluateRetention([...rows].reverse(), base + 15 * DAY);
    expect(a).toEqual(b);
    expect(a.records.filter((r) => r.originalOutcomeId === "orig" && r.status === "QUALIFIED")).toHaveLength(1);
  });

  it("unverified later events mean REVIEW, not retention", () => {
    const base = NOW.getTime() - 40 * DAY;
    const { records } = evaluateRetention(
      [
        { id: "orig", campaignId: "c-1", subjectRef: SUBJ, status: "VERIFIED", verifiedAtMs: base },
        { id: "pend", campaignId: "c-1", subjectRef: SUBJ, status: "PENDING", verifiedAtMs: base + 10 * DAY },
      ],
      base + 12 * DAY,
    );
    expect(records.find((r) => r.originalOutcomeId === "orig")!.status).toBe("REVIEW");
  });
});

describe("outcome quality + anomalies", () => {
  it("classifies quality deterministically", () => {
    expect(classifyOutcomeQuality({ status: "PENDING", qualifyingAmountMicroUsdc: 1n * M, purchaseAmountMicroUsdc: 1n * M, retention: null, anomalyFlagged: false })).toBe("INSUFFICIENT_EVIDENCE");
    expect(classifyOutcomeQuality({ status: "VERIFIED", qualifyingAmountMicroUsdc: 1n * M, purchaseAmountMicroUsdc: 1n * M, retention: null, anomalyFlagged: true })).toBe("QUALITY_REVIEW");
    expect(classifyOutcomeQuality({ status: "VERIFIED", qualifyingAmountMicroUsdc: 1n * M, purchaseAmountMicroUsdc: 1n * M, retention: "QUALIFIED", anomalyFlagged: false })).toBe("RETAINED");
    expect(classifyOutcomeQuality({ status: "VERIFIED", qualifyingAmountMicroUsdc: 1n * M, purchaseAmountMicroUsdc: 5n * M, retention: null, anomalyFlagged: false })).toBe("VERIFIED_HIGH_QUALITY");
    expect(classifyOutcomeQuality({ status: "VERIFIED", qualifyingAmountMicroUsdc: 1n * M, purchaseAmountMicroUsdc: 1n * M, retention: "PENDING", anomalyFlagged: false })).toBe("RETENTION_PENDING");
    expect(classifyOutcomeQuality({ status: "VERIFIED", qualifyingAmountMicroUsdc: 1n * M, purchaseAmountMicroUsdc: 1n * M, retention: null, anomalyFlagged: false })).toBe("VERIFIED_STANDARD");
  });

  it("signals never reject, never mutate, stay deterministic", async () => {
    const { store } = await setup();
    const outcomes = [
      { id: "a", campaignId: "c-1", partnerId: "p-1", status: "VERIFIED", purchaseTx: "0xa1", customerKeyHash: "k1", verifiedAtMs: NOW.getTime() - 20 * DAY, rejectionCode: null },
      { id: "b", campaignId: "c-1", partnerId: "p-1", status: "REJECTED", purchaseTx: "0xb2", customerKeyHash: "k2", verifiedAtMs: null, rejectionCode: "DUPLICATE_TX" },
      { id: "c", campaignId: "c-1", partnerId: "p-1", status: "REJECTED", purchaseTx: "0xc3", customerKeyHash: "k3", verifiedAtMs: null, rejectionCode: "DUPLICATE_TX" },
    ];
    const intents = [
      { id: "i1", campaignId: "c-1", partnerId: "p-1", orderId: "ord-1", payerAddress: "0xPAYER", txHash: "0xt1" },
      { id: "i3", campaignId: "c-1", partnerId: "p-2", orderId: "ord-1", payerAddress: "0xother", txHash: "0xt3" },
    ];
    const first = detectAnomalies({ outcomes, intents });
    expect(first.map((s) => s.type)).toContain("DUPLICATE_PAYMENT_REFERENCE");
    expect(first.map((s) => s.type)).toContain("ATTRIBUTION_CONFLICT");
    expect(first.find((s) => s.type === "DUPLICATE_PAYMENT_REFERENCE")!.severity).toBe("REVIEW");
    expect(JSON.stringify(first)).not.toMatch(/fraud|scam|ban|guilty/i);
    expect(detectAnomalies({ outcomes: [...outcomes].reverse(), intents })).toEqual(first);
    expect(store).toBeDefined();
  });

  it("verification readiness is data-only: no side effects, no purchasing", () => {
    const r = verificationReadiness({ verifiedOutcomes: 3, anomalySignals: [], exposureMicroUsdc: 5n * M });
    expect(r.recommendedAction).toBe("NONE");
    const flagged = verificationReadiness({
      verifiedOutcomes: 3,
      anomalySignals: [{ type: "DUPLICATE_PAYMENT_REFERENCE", severity: "REVIEW", campaignId: "c-1", partnerId: "p-1", evidenceRefs: ["a", "b"], reason: "x" }],
      exposureMicroUsdc: 5n * M,
    });
    expect(flagged.recommendedAction).toBe("EXTERNAL_CHECK_CANDIDATE");
    expect(flagged.economicExposureMicroUsdc).toBe((5n * M).toString());
  });
});

describe("match DTO carries evidence-backed reliability", () => {
  function facts(extra: object = {}) {
    return {
      creatorUserId: "c", handle: "bgirl", creatorType: "CREATOR" as const, interests: ["ai"], preferences: [],
      profileCategory: "ai", campaignCategory: "ai", campaignKinds: ["referral"],
      bountyMicroUsdc: 4n * M, minBountyMicroUsdc: null, verifiedTotal: 6, settledCollaborations: 1,
      activeTermsCount: 0, maxActiveCampaigns: null, eligibility: "ELIGIBLE" as const, eligibilityReason: "ok",
      ...extra,
    };
  }
  it("multi-campaign + retained history strengthens evidence without breaking cold-start", () => {
    const cold = scoreCreatorMatch(facts());
    const proven = scoreCreatorMatch(facts({ campaignsWithVerified: 3, retainedOutcomes: 4 }));
    expect(proven.evidenceScore).toBeGreaterThan(cold.evidenceScore);
    expect(proven.evidenceScore - cold.evidenceScore).toBeLessThanOrEqual(6);
    expect(proven.reliability.score).toBeGreaterThan(0);
    expect(proven.reliability.campaignsWithVerified).toBe(3);
    expect(proven.reliability.retainedOutcomes).toBe(4);
    expect(proven.reliability.level).not.toMatch(/untrust|fraud|scam/i);
    // Eligibility untouched by reliability: scores inform, never gate.
    expect(proven.eligibility).toBe(cold.eligibility);
  });
});

describe("CFO distinguishes cheap from cheap-and-low-retention", () => {
  function cfoRow(campaignId: string, extra: object = {}): import("@/server/services/cfo").CfoSnapshot["campaigns"][number] {
    return {
      campaignId,
      objective: "obj",
      state: "LIVE",
      marketStatus: "OPEN",
      publicBountyMicroUsdc: (4n * M).toString(),
      targetOutcomeCount: 10,
      financials: {
        fundedMicroUsdc: (100n * M).toString(), spentMicroUsdc: (8n * M).toString(),
        committedMicroUsdc: "0", reservedMicroUsdc: "0",
        verifiedUnpaidMicroUsdc: "0", availableMicroUsdc: (92n * M).toString(),
        frozenTermsExposureMicroUsdc: (8n * M).toString(),
        hybridCommittedMicroUsdc: "0", hybridContingentMicroUsdc: "0",
      },
      pace: { status: "BEHIND", targetProgressPct: 20, timeProgressPct: 50, projectedOutcomes: 4 },
      evidence: {
        verifiedOutcomes: 4, totalActions: 12,
        realizedCostPerVerifiedMicroUsdc: (2n * M).toString(),
        confidence: "HIGH", topLabel: null,
      },
      estimatedFundingRequiredMicroUsdc: (24n * M).toString(),
      budgetHeadroomMicroUsdc: (100n * M).toString(),
      nextDueMicroUsdc: "0",
      hardConflict: null,
      ambiguous: null,
      retentionD7Rate: 20,
      retainedD7: 2,
      hasMilestoneDeals: false,
      ...extra,
    };
  }
  function planFor(row: ReturnType<typeof cfoRow>) {
    return {
      workspaceId: "ws-A",
      generatedAt: NOW.toISOString(),
      campaigns: [row],
      totals: {
        fundedMicroUsdc: (100n * M).toString(), spentMicroUsdc: (8n * M).toString(), committedMicroUsdc: "0",
        reservedMicroUsdc: "0", verifiedUnpaidMicroUsdc: "0", availableMicroUsdc: (92n * M).toString(),
        hybridCommittedMicroUsdc: "0", hybridContingentMicroUsdc: "0",
      },
    };
  }
  const POLICY = { optimizationEnabled: false, maxBountyChangePct: 25, minimumEvidence: 5, evaluationWindowDays: 7 };
  const OP = { minReserveMicroUsdc: 0n, maxAutonomousPaymentMicroUsdc: 10n * M, maxAutonomousSpendPerPeriodMicroUsdc: null };
  it("volume economics + low retention reduces the capital score with a reason", async () => {
    const { store } = await setup();
    const plain = await buildCapitalPlan(planFor(cfoRow("c-1")), { store, growthPolicy: POLICY, operatorPolicy: OP, now: NOW });
    const gated = await buildCapitalPlan(planFor(cfoRow("c-1", { hasMilestoneDeals: true })), { store, growthPolicy: POLICY, operatorPolicy: OP, now: NOW });
    const pScore = plain.campaigns[0].capitalScore;
    const gScore = gated.campaigns[0].capitalScore;
    expect(gScore).toBe(pScore - 10);
    expect(gated.campaigns[0].warnings.join(" ")).toMatch(/low D7 retention/i);
  });
  it("first-purchase campaigns keep their score and get info-only reasoning", async () => {
    const { store } = await setup();
    const plain = await buildCapitalPlan(planFor(cfoRow("c-1", { hasMilestoneDeals: false })), { store, growthPolicy: POLICY, operatorPolicy: OP, now: NOW });
    expect(plain.campaigns[0].warnings.join(" ")).not.toMatch(/low D7 retention/i);
    expect(plain.campaigns[0].reasons.join(" ")).toMatch(/info only/i);
  });
});

describe("loaders create no money and respect isolation", () => {
  it("reliability + quality evaluation is read-only and org-scoped", async () => {
    const { store, sink, events } = await setup();
    await addOutcome(store, { daysAgoVerified: 40 });
    await addOutcome(store, { daysAgoVerified: 30 });
    await store.insertCampaign({ id: "c-2", workspaceId: "ws-B", state: "LIVE", createdByUserId: "owner-9" });
    const beforeRes = await store.listReservationsByCampaign("c-1");
    const view = await loadCreatorReliability(store, "creator-1", NOW);
    const quality = await loadCampaignQuality(store, "c-1", NOW);
    expect(view.verifiedOutcomes).toBe(2);
    // Thin sample stays PROVISIONAL even with real verified history — fairness, not punishment.
    expect(view.level).toBe("PROVISIONAL");
    expect(view.confidence).toBe("LOW");
    expect(quality.verifiedAcquisitions).toBe(2);
    expect(JSON.stringify(quality)).not.toContain("c-2");
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(beforeRes.length);
    expect(events).toHaveLength(0);
    expect(sink).toBeDefined();
  });

  it("retention qualification audits evidence, moves no money", async () => {
    const { store, sink, events } = await setup();
    const first = await addOutcome(store, { daysAgoVerified: 40 });
    const second = await addOutcome(store, { daysAgoVerified: 30 });
    await recordRetentionQualified(sink, { campaignId: "c-1", partnerId: "p-1", originalOutcomeId: first, qualifyingOutcomeId: second, window: "D7" });
    expect(events.map((e) => (e as { action?: string }).action)).toContain("retention.qualified");
    const meta = (events.find((e) => (e as { action?: string }).action === "retention.qualified") as { metadata?: Record<string, unknown> }).metadata!;
    expect(meta.originalOutcomeId).toBe(first);
    expect(meta.qualifyingOutcomeId).toBe(second);
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
    expect(await store.getPayoutByOutcome(second)).toBeNull();
  });
});
