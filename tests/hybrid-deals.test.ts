import { describe, expect, it, vi } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  acceptInvitation,
  createInvitation,
  evaluateAndAutoAcceptInvitation,
  listCreatorInvitations,
} from "@/server/services/invitations";
import {
  awardMilestones,
  checkCapacity,
  classifyDeliverable,
  computeExposure,
  createHybridDeal,
  invitationDeal,
  parseDeal,
  recommendDeal,
  summarizeDeal,
  verifyBaseDeliverable,
  type CanonicalDeal,
} from "@/server/services/deals";
import { loadCfoSnapshot } from "@/server/services/cfo";
import type { CapabilitySeed, HistorySeed } from "@/server/services/matching";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

const NOW = new Date("2026-06-01T12:00:00.000Z");
const WALLET = "0xeBB551653815900D6886d2eeEea2325d86275173";
const M = 1_000_000n;
const GOOD_RULES = {
  autoJoin: false,
  minimumBountyMicroUsdc: "1000000",
  allowedCategories: [],
  blockedCategories: [],
  maxActiveCampaigns: 3,
  minScoutConfidence: "LOW",
  maxAutoJoinsPerDay: null,
};

async function liveSetup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Acme" }],
    partners: [{ id: "p-good", userId: "creator-good", payoutWallet: WALLET, rulesJson: GOOD_RULES }],
  });
  await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
  await store.insertMarket({
    campaignId: "c-1", publicBountyMicroUsdc: 4n * M, status: "OPEN",
    destinationUrl: "https://acme.example/product", version: 1, policyVersion: 1,
  });
  await store.insertVersion({
    id: "v-1", campaignId: "c-1", version: 1, intentText: "Get 10 paying customers",
    status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 200n * M,
    bountyFloorMicroUsdc: 1n * M, bountyCeilingMicroUsdc: 8n * M,
    minQualifyingPurchaseMicroUsdc: 1n * M, deadline: new Date(NOW.getTime() + 30 * 86_400_000),
    marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
  });
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

function seed(): CapabilitySeed {
  return { userId: "creator-good", handle: "bgirl", creatorType: "CREATOR", interests: ["ai"], preferences: ["referral"], profileCategory: "ai", onboardingCompleted: true };
}
const HIST: HistorySeed = { verifiedTotal: 5, settledCollaborations: 1, activeTermsCount: 0 };

const BASE_DEAL = {
  structure: "BASE_PLUS_PERFORMANCE" as const,
  baseAmountMicroUsdc: (25n * M).toString(),
  deliverable: { kind: "content", title: "Launch video" },
  performanceBountyMicroUsdc: (4n * M).toString(),
  allocationCount: 5,
};

const MILESTONE_DEAL = {
  structure: "MILESTONE_PLUS_PERFORMANCE" as const,
  performanceBountyMicroUsdc: (4n * M).toString(),
  milestones: [
    { threshold: 10, amountMicroUsdc: (20n * M).toString() },
    { threshold: 25, amountMicroUsdc: (50n * M).toString() },
  ],
  allocationCount: 30,
};

describe("deal kernel", () => {
  it("parses, classifies, and computes exact exposure", () => {
    expect(classifyDeliverable("content")).toBe("MANUAL_REVIEW_REQUIRED");
    expect(classifyDeliverable("purchase")).toBe("VERIFICATION_SUPPORTED");
    expect(classifyDeliverable("telepathy")).toBe("UNSUPPORTED");
    const bad = parseDeal({ structure: "BASE_PLUS_PERFORMANCE", baseAmountMicroUsdc: "100", deliverable: { kind: "telepathy", title: "X" }, performanceBountyMicroUsdc: "1", allocationCount: 2 });
    expect(bad.ok).toBe(false);
    const ok = parseDeal(BASE_DEAL);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const exposure = computeExposure(ok.deal);
    // 25 base + 4*5 performance + 0 milestones = 45M
    expect(exposure.maximumTotalMicroUsdc).toBe((45n * M).toString());
    expect(exposure.maximumBaseMicroUsdc).toBe((25n * M).toString());
    expect(exposure.maximumPerformanceMicroUsdc).toBe((20n * M).toString());
    expect(exposure.bounded).toBe(true);
    expect(checkCapacity(exposure, 45n * M).ok).toBe(true);
    expect(checkCapacity(exposure, 44n * M).ok).toBe(false);
    const unbounded = parseDeal({ structure: "PERFORMANCE_ONLY", performanceBountyMicroUsdc: "1" });
    expect(unbounded.ok).toBe(true);
    if (!unbounded.ok) return;
    expect(computeExposure(unbounded.deal).bounded).toBe(false);
    expect(checkCapacity(computeExposure(unbounded.deal), 10n ** 30n).ok).toBe(false);
  });

  it("recommends performance-only when headroom is tight", () => {
    expect(recommendDeal({ budgetHeadroomMicroUsdc: 5n * M, targetRemaining: 10, creatorMinimumBountyMicroUsdc: 4n * M, publicBountyMicroUsdc: 4n * M }).structure).toBe("PERFORMANCE_ONLY");
    expect(recommendDeal({ budgetHeadroomMicroUsdc: 200n * M, targetRemaining: 10, creatorMinimumBountyMicroUsdc: 4n * M, publicBountyMicroUsdc: 4n * M }).structure).toBe("MILESTONE_PLUS_PERFORMANCE");
  });

  it("summarizes without creators doing math", () => {
    const parsed = parseDeal({ ...BASE_DEAL, structure: "HYBRID_FULL", milestones: MILESTONE_DEAL.milestones });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s = summarizeDeal(parsed.deal);
    expect(s.earnLines.length).toBe(4);
    expect(s.maximumPayoutMicroUsdc).toBe((25n * M + 20n * M + 70n * M).toString());
    expect(s.qualifiesLines.join(" ")).toMatch(/human review/i);
    expect(s.whenPaidLines.join(" ")).toMatch(/not supported/i);
  });
});

describe("hybrid invitation freeze", () => {
  it("freezes the full offer; later repricing never mutates it", async () => {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: BASE_DEAL });
    expect(res.invitation.status).toBe("INVITED");
    expect(invitationDeal(res.invitation.offered.bonus)?.structure).toBe("BASE_PLUS_PERFORMANCE");
    await store.updateMarket("c-1", 1, { publicBountyMicroUsdc: 7n * M, version: 2 });
    const inbox = await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "creator-good" });
    const row = inbox.find((i) => i.id === res.invitation.id)!;
    expect(row.offered.bountyMicroUsdc).toBe((4n * M).toString());
    expect(invitationDeal(row.offered.bonus)?.baseAmountMicroUsdc).toBe((25n * M).toString());
  });

  it("rejects over-capacity and unbounded offers", async () => {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    const huge = { ...BASE_DEAL, baseAmountMicroUsdc: (500n * M).toString() };
    await expect(createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: huge }))
      .rejects.toMatchObject({ status: 409, code: "HYBRID_OVER_CAPACITY" });
    const unbounded = { structure: "PERFORMANCE_ONLY" as const, performanceBountyMicroUsdc: (4n * M).toString() };
    await expect(createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: unbounded }))
      .rejects.toMatchObject({ status: 409 });
  });

  it("rejects bounty-mismatched hybrid economics", async () => {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    const mismatch = { ...BASE_DEAL, performanceBountyMicroUsdc: (9n * M).toString() };
    await expect(createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: mismatch }))
      .rejects.toMatchObject({ status: 400, code: "DEAL_BOUNTY_MISMATCH" });
  });

  it("legacy performance-only invites are unchanged", async () => {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST });
    expect(invitationDeal(res.invitation.offered.bonus)).toBeNull();
    const accepted = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res.invitation.id });
    expect(accepted.invitation.status).toBe("ACCEPTED");
    expect(await store.getHybridDealByTerms(accepted.participation.termsId)).toBeNull();
  });
});

describe("hybrid acceptance creates obligations, never money", () => {
  async function acceptHybrid() {
    const { store, sink, events } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: BASE_DEAL });
    const accepted = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res.invitation.id });
    return { store, sink, events, deps, accepted };
  }

  it("base starts PENDING with no payout and no reservation", async () => {
    const { store, accepted } = await acceptHybrid();
    const deal = await store.getHybridDealByTerms(accepted.participation.termsId);
    expect(deal).not.toBeNull();
    expect(deal!.baseStatus).toBe("PENDING");
    expect(deal!.baseAmountMicroUsdc).toBe(25n * M);
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
    expect(await store.getPayoutByOutcome("nothing")).toBeNull();
    expect(accepted.participation.priceMicroUsdc).toBe((4n * M).toString());
  });

  it("repeat acceptance never rewrites history", async () => {
    const { store, deps, accepted } = await acceptHybrid();
    const before = await store.getHybridDealByTerms(accepted.participation.termsId);
    const again = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: accepted.invitation.id });
    expect(again.alreadyJoined).toBe(true);
    expect(await store.getHybridDealByTerms(accepted.participation.termsId)).toEqual(before);
  });

  it("conflicting economics are rejected, never rewritten", async () => {
    const { store, sink } = await acceptHybrid();
    const deps = { store, audit: sink, now: () => NOW };
    await store.updateMarket("c-1", 1, { publicBountyMicroUsdc: 9n * M, version: 2 });
    // Invitation 2 freezes the repriced bounty; existing 4M frozen terms win.
    const res2 = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST });
    expect(res2.invitation.offered.bountyMicroUsdc).toBe((9n * M).toString());
    await expect(acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res2.invitation.id }))
      .rejects.toMatchObject({ status: 409, code: "PARTICIPATION_CONFLICT" });
  });

  it("agent auto-accept fails to REVIEW on hybrid semantics", async () => {
    const { store, sink } = await liveSetup();
    await store.updatePartnerRules("p-good", { ...GOOD_RULES, autoJoin: true });
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: BASE_DEAL });
    // Immediate agent evaluation ran at create time and refused to auto-accept.
    expect(res.invitation.status).toBe("INVITED");
    const out = await evaluateAndAutoAcceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res.invitation.id });
    expect(out.result).toBe("REVIEW");
    expect(out.rule).toBe("HYBRID_REVIEW");
    expect((await store.getInvitation(res.invitation.id))?.status).toBe("INVITED");
    expect(await store.listPartnerTerms("p-good")).toHaveLength(0);
  });
});

describe("milestones trigger from VERIFIED counts only, once", () => {
  async function setupWithMilestones() {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: MILESTONE_DEAL });
    const accepted = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res.invitation.id });
    const deal = (await store.getHybridDealByTerms(accepted.participation.termsId))!;
    return { store, sink, deps, deal };
  }

  async function addOutcome(store: Awaited<ReturnType<typeof liveSetup>>["store"], i: number, verified: boolean) {
    const id = `o-${i}`;
    await store.insertOutcome({
      id, campaignId: "c-1", partnerId: "p-good", partnerTermsId: "t-x",
      checkoutIntentId: `ci-${id}`, customerKeyHash: `ck-${id}`, purchaseTx: `0xtx${id}`,
      purchaseAmountMicroUsdc: 10n * M,
    });
    if (verified) await store.updateOutcome(id, { status: "VERIFIED", verifiedAt: NOW });
  }

  it("no verified outcomes, no awards; threshold crossing awards once with unsupported-settlement truth", async () => {
    const { store, sink, deal } = await setupWithMilestones();
    for (let i = 0; i < 9; i += 1) await addOutcome(store, i, true);
    const none = await awardMilestones(store, sink, { campaignId: "c-1", partnerId: "p-good" });
    expect(none).toEqual({ awarded: 0, verifiedCount: 9 });
    await addOutcome(store, 9, true);
    const first = await awardMilestones(store, sink, { campaignId: "c-1", partnerId: "p-good" });
    expect(first).toEqual({ awarded: 1, verifiedCount: 10 });
    const awards = await store.listMilestoneAwardsByDeal(deal.id);
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({ milestoneIndex: 0, threshold: 10, status: "SETTLEMENT_NOT_SUPPORTED" });
    expect(awards[0].amountMicroUsdc).toBe(20n * M);
    // Idempotent: repeat evaluation awards nothing more.
    const repeat = await awardMilestones(store, sink, { campaignId: "c-1", partnerId: "p-good" });
    expect(repeat).toEqual({ awarded: 0, verifiedCount: 10 });
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
  });

  it("pending outcomes never trigger milestones", async () => {
    const { store, sink } = await setupWithMilestones();
    for (let i = 0; i < 30; i += 1) await addOutcome(store, i, false);
    const out = await awardMilestones(store, sink, { campaignId: "c-1", partnerId: "p-good" });
    expect(out).toEqual({ awarded: 0, verifiedCount: 0 });
  });
});

describe("base deliverable review", () => {
  it("PENDING + manual review verifies to SETTLEMENT_NOT_SUPPORTED, idempotently", async () => {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: BASE_DEAL });
    const accepted = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res.invitation.id });
    const deal = (await store.getHybridDealByTerms(accepted.participation.termsId))!;
    const v1 = await verifyBaseDeliverable(store, sink, { dealId: deal.id, reviewerUserId: "owner-1", workspaceId: "ws-A" });
    expect(v1.baseStatus).toBe("SETTLEMENT_NOT_SUPPORTED");
    const v2 = await verifyBaseDeliverable(store, sink, { dealId: deal.id, reviewerUserId: "owner-1", workspaceId: "ws-A" });
    expect(v2.baseStatus).toBe("SETTLEMENT_NOT_SUPPORTED");
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
  });
});

describe("CFO accounts hybrid exposure without double-counting", () => {
  it("committed base reduces available once; contingent is reported, not subtracted", async () => {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    await store.insertFunding({
      id: "f-1", campaignId: "c-1", policyVersionId: "v-1", policyVersion: 1,
      campaignKey: "0xk", policyHash: "0xh", chainId: 1, vaultAddress: "0xv",
      usdcAddress: "0xu", ownerAddress: "0xo", expectedAmountMicroUsdc: 100n * M,
    });
    await store.updateFunding("c-1", 1, { status: "CONFIRMED", observedAmountMicroUsdc: 100n * M });
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, { candidate: seed(), history: HIST, deal: BASE_DEAL });
    const accepted = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res.invitation.id });
    const deal = (await store.getHybridDealByTerms(accepted.participation.termsId))!;
    const before = await loadCfoSnapshot(store, "ws-A", { now: NOW });
    const rowBefore = before.snapshot.campaigns.find((r) => r.campaignId === "c-1")!;
    // Base PENDING: contingent 25, committed 0, available untouched by hybrid.
    expect(rowBefore.financials.hybridCommittedMicroUsdc).toBe("0");
    expect(rowBefore.financials.hybridContingentMicroUsdc).toBe((25n * M).toString());
    expect(rowBefore.financials.availableMicroUsdc).toBe((100n * M).toString());
    await verifyBaseDeliverable(store, sink, { dealId: deal.id, reviewerUserId: "owner-1", workspaceId: "ws-A" });
    const after = await loadCfoSnapshot(store, "ws-A", { now: NOW });
    const rowAfter = after.snapshot.campaigns.find((r) => r.campaignId === "c-1")!;
    expect(rowAfter.financials.hybridCommittedMicroUsdc).toBe((25n * M).toString());
    expect(rowAfter.financials.hybridContingentMicroUsdc).toBe("0");
    // 100 funded − 25 hybrid committed = 75 available. Single subtraction, no double-count.
    expect(rowAfter.financials.availableMicroUsdc).toBe((75n * M).toString());
    expect(BigInt(rowAfter.financials.fundedMicroUsdc)).toBe(
      BigInt(rowAfter.financials.spentMicroUsdc) + BigInt(rowAfter.financials.committedMicroUsdc) +
      BigInt(rowAfter.financials.verifiedUnpaidMicroUsdc) + BigInt(rowAfter.financials.hybridCommittedMicroUsdc) +
      BigInt(rowAfter.financials.availableMicroUsdc),
    );
  });
});
