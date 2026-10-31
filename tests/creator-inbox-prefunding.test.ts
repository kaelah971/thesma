import { describe, expect, it, vi } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  acceptInvitation,
  cancelInvitation,
  createInvitation,
  declineInvitation,
  listCreatorInvitations,
  listCreatorOpportunities,
} from "@/server/services/invitations";
import { createMemoryNotificationStore } from "@/server/services/creatorNotifications";
import type { CapabilitySeed, HistorySeed } from "@/server/services/matching";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * Pre-funding creator-inbox visibility (production Northstar shape, generalized).
 *
 * Guards the real incident: an org-created pre-funding INVITED row
 * (APPROVED + UNFUNDED, no market) MUST be visible in the same creator's
 * /creator inbox. Funding gates ACCEPTANCE, never VISIBILITY. All fixtures
 * are synthetic — nothing here names a real creator, campaign or workspace.
 */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const WALLET = "0xeBB551653815900D6886d2eeEea2325d86275173";
const GOOD_RULES = {
  autoJoin: false,
  minimumBountyMicroUsdc: "500000",
  allowedCategories: [],
  blockedCategories: [],
  maxActiveCampaigns: 3,
  minScoutConfidence: "MEDIUM",
  maxAutoJoinsPerDay: null,
};

/** Legacy creator shape: onboarded, categorized, capability columns untouched. */
const LEGACY: CapabilitySeed = {
  userId: "creator-legacy",
  handle: "legacy-inbox",
  creatorType: null,
  interests: [],
  preferences: [],
  profileCategory: "ai",
  onboardingCompleted: true,
};

const OTHER: CapabilitySeed = {
  userId: "creator-other",
  handle: "other-inbox",
  creatorType: "CREATOR",
  interests: ["ai"],
  preferences: ["referral"],
  profileCategory: "ai",
  onboardingCompleted: true,
};

const ZERO_HISTORY: HistorySeed = { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 };

/** APPROVED + UNFUNDED campaign: approved policy, no market row, no funding row. */
async function prefundingSetup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Northstar-like Org" }],
    partners: [
      { id: "p-legacy", userId: "creator-legacy", payoutWallet: WALLET, rulesJson: GOOD_RULES },
      { id: "p-other", userId: "creator-other", payoutWallet: WALLET, rulesJson: GOOD_RULES },
    ],
  });
  await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "APPROVED", createdByUserId: "owner-1" });
  await store.insertVersion({
    id: "v-1", campaignId: "c-1", version: 1, intentText: "Get 5 paying customers",
    status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 50_000_000n,
    bountyFloorMicroUsdc: 500_000n, bountyCeilingMicroUsdc: 10_000_000n,
    minQualifyingPurchaseMicroUsdc: null, deadline: new Date(NOW.getTime() + 30 * 86_400_000),
    marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
  });
  const { sink } = createMemoryAuditSink();
  const notifications = createMemoryNotificationStore();
  const deps = { store, audit: sink, now: () => NOW, notifications } as never;
  return { store, sink, notifications, deps };
}

async function inviteLegacy(ctx: Awaited<ReturnType<typeof prefundingSetup>>) {
  const res = await createInvitation(
    ctx.deps as never,
    { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: LEGACY.userId },
    { candidate: LEGACY, history: ZERO_HISTORY, offeredBountyMicroUsdc: "5000000" },
  );
  expect(res.alreadyInvited).toBe(false);
  expect(res.invitation.status).toBe("INVITED");
  return res.invitation;
}

describe("pre-funding inbox visibility", () => {
  it("org-created pre-funding INVITED row is visible to the same creator", async () => {
    const ctx = await prefundingSetup();
    const invitation = await inviteLegacy(ctx);
    const opps = await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    expect(opps).toHaveLength(1);
    expect(opps[0].id).toBe(invitation.id);
    expect(opps[0].status).toBe("INVITED");
    expect(opps[0].creatorUserId).toBe(LEGACY.userId);
    // Frozen 5 USDC performance-only economics visible pre-funding.
    expect(opps[0].offered.bountyMicroUsdc).toBe("5000000");
    expect(opps[0].offered.policyVersion).toBe(1);
    expect(opps[0].offered.marketVersion).toBe(0);
    // Display truth marks the campaign as not yet live.
    expect(opps[0].campaign.state).toBe("APPROVED");
    expect(opps[0].campaign.marketStatus).not.toBe("OPEN");
  });

  it("creator identity mapping is canonical: partner id never substitutes for user id", async () => {
    const ctx = await prefundingSetup();
    await inviteLegacy(ctx);
    // The partner profile id is NOT the inbox key.
    const byPartnerId = await listCreatorOpportunities(ctx.deps as never, { creatorUserId: "p-legacy" });
    expect(byPartnerId).toHaveLength(0);
    // Only the canonical users.id-scoped persona user id resolves.
    const byUserId = await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    expect(byUserId).toHaveLength(1);
  });

  it("legacy creator shape sees the invitation; funding is not required for visibility", async () => {
    const ctx = await prefundingSetup();
    await inviteLegacy(ctx);
    // No market row, no funding row — the row is still listed.
    expect(await ctx.store.getMarket("c-1")).toBeNull();
    expect(await ctx.store.getFunding("c-1", 1)).toBeNull();
    const opps = await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    expect(opps).toHaveLength(1);
    expect(opps[0].campaign.fundingStatus).not.toBe("CONFIRMED");
  });

  it("visibility creates no participation, referral, payout or reservation", async () => {
    const ctx = await prefundingSetup();
    await inviteLegacy(ctx);
    await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    expect(await ctx.store.listPartnerTerms("p-legacy")).toHaveLength(0);
    expect(await ctx.store.getReferralByCode("anything")).toBeNull();
    expect(await ctx.store.getPayoutByOutcome("nope")).toBeNull();
  });

  it("reads create no duplicate invites or notifications", async () => {
    const ctx = await prefundingSetup();
    const invitation = await inviteLegacy(ctx);
    const before = await ctx.store.listInvitationsByCampaign("c-1");
    await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    await listCreatorInvitations(ctx.deps as never, { creatorUserId: LEGACY.userId });
    const after = await ctx.store.listInvitationsByCampaign("c-1");
    expect(after).toHaveLength(before.length);
    const notes = await ctx.notifications.listForCreator(LEGACY.userId, 50);
    expect(notes.filter((n) => n.dedupeKey === `invite:${invitation.id}`)).toHaveLength(1);
  });

  it("another creator cannot see this invitation; org caller sees only their own (empty) inbox", async () => {
    const ctx = await prefundingSetup();
    await inviteLegacy(ctx);
    expect(await listCreatorOpportunities(ctx.deps as never, { creatorUserId: OTHER.userId })).toHaveLength(0);
    expect(await listCreatorOpportunities(ctx.deps as never, { creatorUserId: "owner-1" })).toHaveLength(0);
  });

  it("acceptance stays blocked pre-funding with a truthful funding-pending error", async () => {
    const ctx = await prefundingSetup();
    const invitation = await inviteLegacy(ctx);
    await expect(
      acceptInvitation(ctx.deps as never, { creatorUserId: LEGACY.userId, invitationId: invitation.id }),
    ).rejects.toMatchObject({ status: 409, code: "FUNDING_PENDING" });
    // Blocked acceptance changed nothing.
    expect((await ctx.store.getInvitation(invitation.id))?.status).toBe("INVITED");
    expect(await ctx.store.listPartnerTerms("p-legacy")).toHaveLength(0);
  });

  it("after funding goes live the same invitation becomes acceptable at frozen economics", async () => {
    const ctx = await prefundingSetup();
    const invitation = await inviteLegacy(ctx);
    await ctx.store.updateCampaign("c-1", { state: "LIVE" });
    await ctx.store.insertMarket({
      campaignId: "c-1", publicBountyMicroUsdc: 5_000_000n, status: "OPEN",
      destinationUrl: "https://example.invalid/product", version: 1, policyVersion: 1,
    });
    const opps = await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    expect(opps).toHaveLength(1);
    expect(opps[0].campaign.state).toBe("LIVE");
    expect(opps[0].campaign.marketStatus).toBe("OPEN");
    const accepted = await acceptInvitation(ctx.deps as never, { creatorUserId: LEGACY.userId, invitationId: invitation.id });
    expect(accepted.invitation.status).toBe("ACCEPTED");
    expect(accepted.participation.priceMicroUsdc).toBe("5000000");
    expect(accepted.referral.path).toMatch(/^\/r\//);
  });

  it("cancelled invites render as non-accepting rows without participation", async () => {
    const ctx = await prefundingSetup();
    const invitation = await inviteLegacy(ctx);
    const cancelled = await cancelInvitation(ctx.deps as never, { callerUserId: "owner-1", invitationId: invitation.id });
    expect(cancelled.status).toBe("CANCELLED");
    const opps = await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    const row = opps.find((o) => o.id === invitation.id)!;
    expect(row.status).toBe("CANCELLED");
    expect(await ctx.store.listPartnerTerms("p-legacy")).toHaveLength(0);
    await expect(
      acceptInvitation(ctx.deps as never, { creatorUserId: LEGACY.userId, invitationId: invitation.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("accepted and declined states render with correct follow-ups", async () => {
    const ctx = await prefundingSetup();
    const invitation = await inviteLegacy(ctx);
    await ctx.store.updateCampaign("c-1", { state: "LIVE" });
    await ctx.store.insertMarket({
      campaignId: "c-1", publicBountyMicroUsdc: 5_000_000n, status: "OPEN",
      destinationUrl: "https://example.invalid/product", version: 1, policyVersion: 1,
    });
    await acceptInvitation(ctx.deps as never, { creatorUserId: LEGACY.userId, invitationId: invitation.id });
    const opps = await listCreatorOpportunities(ctx.deps as never, { creatorUserId: LEGACY.userId });
    expect(opps).toHaveLength(1);
    expect(opps[0].status).toBe("ACCEPTED");
    expect(opps[0].referral).not.toBeNull();

    const ctx2 = await prefundingSetup();
    const invitation2 = await inviteLegacy(ctx2);
    const declined = await declineInvitation(ctx2.deps as never, { creatorUserId: LEGACY.userId, invitationId: invitation2.id });
    expect(declined.status).toBe("DECLINED");
    const opps2 = await listCreatorOpportunities(ctx2.deps as never, { creatorUserId: LEGACY.userId });
    expect(opps2.find((o) => o.id === invitation2.id)?.status).toBe("DECLINED");
    expect(await ctx2.store.listPartnerTerms("p-legacy")).toHaveLength(0);
  });
});
