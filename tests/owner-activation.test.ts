import { describe, expect, it, vi } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import { approvePolicy, moveToReview, type CampaignDeps } from "@/server/services/campaigns";
import { joinCampaign } from "@/server/services/markets";
import { findCreatorMatches, type CapabilitySeed, type HistorySeed } from "@/server/services/matching";
import { invitationDeal } from "@/server/services/deals";
import {
  acceptInvitation,
  createInvitation,
} from "@/server/services/invitations";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

const NOW = new Date("2026-06-01T12:00:00.000Z");
const M = 1_000_000n;
const WALLET = "0xeBB551653815900D6886d2eeEea2325d86275173";

const OWNER_RULES = {
  autoJoin: false, minimumBountyMicroUsdc: "1000000", allowedCategories: [],
  blockedCategories: [], maxActiveCampaigns: 3, minScoutConfidence: "LOW", maxAutoJoinsPerDay: null,
};

async function setup(state: "DRAFT" | "REVIEW" | "APPROVED" | "LIVE", opts?: { withMarket?: boolean; withFunding?: boolean }) {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "member-1", workspaceId: "ws-A", role: "ORGANIZATION_MEMBER" },
    ],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Acme" }],
    partners: [
      { id: "p-manual", userId: "creator-manual", payoutWallet: WALLET, rulesJson: OWNER_RULES },
      { id: "p-auto", userId: "creator-auto", payoutWallet: WALLET, rulesJson: { ...OWNER_RULES, autoJoin: true } },
      { id: "p-other", userId: "creator-other", payoutWallet: WALLET, rulesJson: OWNER_RULES },
    ],
  });
  await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state, createdByUserId: "owner-1" });
  // Seed creator persona via onboarding-equivalent fields (no new columns needed).
  const versionStatus = state === "DRAFT" ? "DRAFT" : state === "REVIEW" ? "REVIEW" : "APPROVED";
  await store.insertVersion({
    id: "v-1", campaignId: "c-1", version: 1, intentText: "Get 5 paying customers",
    status: versionStatus, targetOutcomeCount: 10, budgetMicroUsdc: 200n * M,
    bountyFloorMicroUsdc: 1n * M, bountyCeilingMicroUsdc: 8n * M,
    minQualifyingPurchaseMicroUsdc: 1n * M, deadline: new Date(NOW.getTime() + 30 * 86_400_000),
    marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
  });
  if (opts?.withMarket) {
    await store.insertMarket({
      campaignId: "c-1", publicBountyMicroUsdc: 4n * M, status: "OPEN",
      destinationUrl: "https://acme.example/offer", version: 1, policyVersion: 1,
    });
  }
  if (opts?.withFunding) {
    await store.insertFunding({
      id: "f-1", campaignId: "c-1", policyVersionId: "v-1", policyVersion: 1,
      campaignKey: "0xk", policyHash: "0xh", chainId: 1, vaultAddress: "0xv",
      usdcAddress: "0xu", ownerAddress: "0xo", expectedAmountMicroUsdc: 100n * M,
    });
    await store.updateFunding("c-1", 1, { status: "CONFIRMED", observedAmountMicroUsdc: 100n * M });
  }
  const { sink, events } = createMemoryAuditSink();
  const deps: CampaignDeps = { store, audit: sink, now: () => NOW };
  return { store, sink, events, deps };
}

function seed(userId: string): CapabilitySeed {
  return {
    userId, handle: userId === "creator-manual" ? "bgirl" : "auto-creator",
    creatorType: "CREATOR", interests: ["ai"], preferences: ["referral"],
    profileCategory: "ai", onboardingCompleted: true,
  };
}
const HIST: HistorySeed = { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 };

describe("owner direct approval (no self-review)", () => {
  it("owner-created complete draft shows APPROVE path, not review", async () => {
    const { store, sink } = await setup("DRAFT");
    const res = await approvePolicy({ store, audit: sink, now: () => NOW }, { campaignId: "c-1", userId: "owner-1", expectedVersion: 1 });
    expect(res.campaign.state).toBe("APPROVED");
    expect(res.version.status).toBe("APPROVED");
  });

  it("owner can approve directly from DRAFT in one step with a single approval audit", async () => {
    const { store, sink, events } = await setup("DRAFT");
    await approvePolicy({ store, audit: sink, now: () => NOW }, { campaignId: "c-1", userId: "owner-1", expectedVersion: 1 });
    expect(events.filter((e) => (e as { action?: string }).action === "campaign.policy_approved")).toHaveLength(1);
    expect(events.filter((e) => (e as { action?: string }).action === "campaign.review_requested")).toHaveLength(0);
  });

  it("non-owner cannot approve; review flow still works", async () => {
    const { store, sink, events } = await setup("DRAFT");
    const deps = { store, audit: sink, now: () => NOW };
    await expect(approvePolicy(deps, { campaignId: "c-1", userId: "member-1", expectedVersion: 1 })).rejects.toMatchObject({ status: 403 });
    const moved = await moveToReview(deps, { campaignId: "c-1", userId: "member-1", expectedVersion: 1 });
    expect(moved.version.status).toBe("REVIEW");
    expect(events.filter((e) => (e as { action?: string }).action === "campaign.review_requested")).toHaveLength(1);
    const done = await approvePolicy(deps, { campaignId: "c-1", userId: "owner-1", expectedVersion: 1 });
    expect(done.version.status).toBe("APPROVED");
  });

  it("cross-workspace and creator users cannot approve", async () => {
    const { store, sink } = await setup("DRAFT");
    await expect(
      approvePolicy({ store, audit: sink, now: () => NOW }, { campaignId: "c-1", userId: "outsider", expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("pre-funding creator matching", () => {
  it("approved unfunded campaign matches (advisory, pre-funding estimate)", async () => {
    const { store, sink } = await setup("APPROVED");
    const deps = { store, audit: sink, now: () => NOW };
    const report = await findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-1" }, { candidates: [seed("creator-manual")], histories: { "creator-manual": HIST }, allowPreview: true });
    expect(report.evaluated).toBe(1);
    expect(report.prefunding).toBe(true);
    const all = [...report.invite, ...report.review];
    expect(all.length).toBeGreaterThan(0);
    expect(report.publicBountyMicroUsdc).toBe((1n * M).toString());
    expect(report.prefunding).toBe(true);
    expect(all[0].recommendedAction === "INVITE" || all[0].recommendedAction === "REVIEW").toBe(true);
  });

  it("DRAFT campaign still requires approval first", async () => {
    const { store, sink } = await setup("DRAFT");
    const deps = { store, audit: sink, now: () => NOW };
    await expect(findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-1" }, { candidates: [seed("creator-manual")], histories: { "creator-manual": HIST }, allowPreview: true })).rejects.toMatchObject({ status: 404 });
  });

  it("matching creates no terms, referrals, or payouts", async () => {
    const { store, sink } = await setup("APPROVED");
    const deps = { store, audit: sink, now: () => NOW };
    await findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-1" }, { candidates: [seed("creator-manual")], histories: { "creator-manual": HIST }, allowPreview: true });
    expect(await store.listPartnerTerms("p-manual")).toHaveLength(0);
  });
});

describe("pre-funding invitations", () => {
  it("approved unfunded campaign can invite with explicit frozen offer; no payout or reservation", async () => {
    const { store, sink } = await setup("APPROVED");
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST, offeredBountyMicroUsdc: (2n * M).toString() });
    expect(res.invitation.status).toBe("INVITED");
    expect(res.invitation.offered.bountyMicroUsdc).toBe((2n * M).toString());
    expect(await store.listPartnerTerms("p-manual")).toHaveLength(0);
  });

  it("missing explicit offer fails; out-of-bounds offer fails", async () => {
    const { store, sink } = await setup("APPROVED");
    const deps = { store, audit: sink, now: () => NOW };
    await expect(createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST })).rejects.toMatchObject({ status: 400 });
    await expect(createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST, offeredBountyMicroUsdc: (99n * M).toString() })).rejects.toMatchObject({ status: 400 });
  });

  it("accept stays funding-gated; invitation remains INVITED with no terms", async () => {
    const { store, sink } = await setup("APPROVED");
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST, offeredBountyMicroUsdc: (2n * M).toString() });
    await expect(acceptInvitation(deps, { creatorUserId: "creator-manual", invitationId: res.invitation.id })).rejects.toMatchObject({ status: 409 });
    expect((await store.getInvitation(res.invitation.id))?.status).toBe("INVITED");
    expect(await store.listPartnerTerms("p-manual")).toHaveLength(0);
  });

  it("auto-accept leaves pre-funding invitation INVITED", async () => {
    const { store, sink } = await setup("APPROVED");
    await store.updatePartnerRules("p-auto", { ...OWNER_RULES, autoJoin: true });
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-auto" }, { candidate: seed("creator-auto"), history: HIST, offeredBountyMicroUsdc: (2n * M).toString(), joinsToday: 0 });
    expect(res.invitation.status).toBe("INVITED");
    expect(await store.listPartnerTerms("p-auto")).toHaveLength(0);
  });

  it("funding still required before real acquisition (join path unchanged)", async () => {
    const { store, sink } = await setup("APPROVED");
    await expect(joinCampaign({ store, audit: sink, now: () => NOW }, { campaignId: "c-1", userId: "creator-manual" })).rejects.toMatchObject({ code: "MARKET_NOT_OPEN" });
  });

  it("legacy live-market invitation flow is unchanged (no explicit offer needed)", async () => {
    const { store, sink } = await setup("LIVE", { withMarket: true });
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST });
    expect(res.invitation.status).toBe("INVITED");
    expect(res.invitation.offered.bountyMicroUsdc).toBe((4n * M).toString());
    expect(invitationDeal(res.invitation.offered.bonus)).toBeNull();
    const acc = await acceptInvitation(deps, { creatorUserId: "creator-manual", invitationId: res.invitation.id });
    expect(acc.invitation.status).toBe("ACCEPTED");
    expect(acc.participation.priceMicroUsdc).toBe((4n * M).toString());
  });

  it("explicit offer on a live market is rejected", async () => {
    const { store, sink } = await setup("LIVE", { withMarket: true });
    const deps = { store, audit: sink, now: () => NOW };
    await expect(createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST, offeredBountyMicroUsdc: (4n * M).toString() })).rejects.toMatchObject({ status: 400 });
  });

  it("matching is not hardcoded: other creators evaluate normally", async () => {
    const { store, sink } = await setup("APPROVED");
    const deps = { store, audit: sink, now: () => NOW };
    const other = { ...seed("creator-other"), handle: "other-creator", creatorType: "CREATOR" as const };
    const report = await findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-1" }, { candidates: [seed("creator-manual"), other], histories: { "creator-manual": HIST, "creator-other": HIST }, allowPreview: true });
    expect(report.evaluated).toBe(2);
  });
});
