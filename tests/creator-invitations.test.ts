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
  inviteCreators,
  listCreatorInvitations,
  listInvitations,
} from "@/server/services/invitations";
import { joinCampaign } from "@/server/services/markets";
import type { CapabilitySeed, HistorySeed } from "@/server/services/matching";
import { createMemoryNotificationStore, type NotificationStore } from "@/server/services/creatorNotifications";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

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

async function liveSetup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Acme" }],
    partners: [
      { id: "p-good", userId: "creator-good", payoutWallet: WALLET, rulesJson: GOOD_RULES },
      { id: "p-blocked", userId: "creator-blocked", payoutWallet: WALLET, rulesJson: { ...GOOD_RULES, blockedCategories: ["ai"] } },
      { id: "p-full", userId: "creator-full", payoutWallet: WALLET, rulesJson: GOOD_RULES },
    ],
  });
  await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
  await store.insertMarket({
    campaignId: "c-1", publicBountyMicroUsdc: 2_000_000n, status: "OPEN",
    destinationUrl: "https://acme.example/product", version: 1, policyVersion: 1,
  });
  await store.insertVersion({
    id: "v-1", campaignId: "c-1", version: 1, intentText: "Get 5 paying customers",
    status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 15_000_000n,
    bountyFloorMicroUsdc: 500_000n, bountyCeilingMicroUsdc: 4_000_000n,
    minQualifyingPurchaseMicroUsdc: 500_000n, deadline: new Date(NOW.getTime() + 30 * 86_400_000),
    marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
  });
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

function seed(userId: string, handle: string | null = null): CapabilitySeed {
  return {
    userId, handle: handle ?? userId, creatorType: "CREATOR", interests: ["ai"],
    preferences: ["referral"], profileCategory: "ai", onboardingCompleted: true,
  };
}

const HIST: Record<string, HistorySeed> = {
  "creator-good": { verifiedTotal: 5, settledCollaborations: 1, activeTermsCount: 0 },
  "creator-blocked": { verifiedTotal: 5, settledCollaborations: 1, activeTermsCount: 0 },
  "creator-full": { verifiedTotal: 20, settledCollaborations: 5, activeTermsCount: 3 },
};

describe("invitation lifecycle", () => {
  it("INVITE creates one durable invitation with frozen economics", async () => {
    const { store, sink } = await liveSetup();
    const res = await createInvitation(
      { store, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" },
      { candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"] },
    );
    expect(res.alreadyInvited).toBe(false);
    expect(res.invitation.status).toBe("INVITED");
    expect(res.invitation.offered.bountyMicroUsdc).toBe("2000000");
    expect(res.invitation.offered.outcomeKind).toBe("purchase");
    expect(res.invitation.offered.minQualifyingMicroUsdc).toBe("500000");
    expect(res.invitation.offered.holdSeconds).toBe(3600);
    expect(res.invitation.offered.policyVersion).toBe(1);
    expect(res.invitation.offered.marketVersion).toBe(1);
    expect(res.invitation.match.score).toBeGreaterThanOrEqual(60);
    expect(res.invitation.match.reasons.length).toBeGreaterThan(0);

    // Retry is idempotent — no duplicate row.
    const again = await createInvitation(
      { store, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" },
      { candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"] },
    );
    expect(again.alreadyInvited).toBe(true);
    expect(again.invitation.id).toBe(res.invitation.id);
    expect((await store.listInvitationsByCampaign("c-1"))).toHaveLength(1);
  });

  it("later bounty changes do not mutate the frozen offer", async () => {
    const { store, sink } = await liveSetup();
    const res = await createInvitation(
      { store, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" },
      { candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"] },
    );
    await store.updateMarket("c-1", 1, { publicBountyMicroUsdc: 3_000_000n, version: 2 });
    const stored = await store.getInvitation(res.invitation.id);
    expect(stored?.offeredBountyMicroUsdc).toBe(2_000_000n);
    expect(stored?.offeredMarketVersion).toBe(1);
    expect(stored?.matchScore).toBe(res.invitation.match.score);
  });

  it("invite creates no participation, referral, payout or reservation", async () => {
    const { store, sink } = await liveSetup();
    await createInvitation(
      { store, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" },
      { candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"] },
    );
    expect(await store.listPartnerTerms("p-good")).toHaveLength(0);
    expect(await store.getReferralByCode("anything")).toBeNull();
    expect(await store.getPayoutByOutcome("nope")).toBeNull();
    // The open join path still works afterward on the same live market.
    const joined = await joinCampaign(
      { store, audit: sink, now: () => NOW } as never,
      { campaignId: "c-1", userId: "creator-good" },
    );
    expect(joined.referral.code.length).toBeGreaterThan(0);
    expect(joined.alreadyJoined).toBe(false);
  });

  it("bulk invite isolates failures per creator", async () => {
    const { store, sink } = await liveSetup();
    const out = await inviteCreators(
      { store, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserIds: ["creator-good", "creator-blocked", "ghost", "creator-good"] },
      {
        candidates: {
          "creator-good": seed("creator-good", "bgirl"),
          "creator-blocked": seed("creator-blocked", "nope"),
        },
        histories: HIST,
      },
    );
    expect(out.results).toHaveLength(3);
    const byId = Object.fromEntries(out.results.map((r) => [r.creatorUserId, r]));
    expect(byId["creator-good"].status).toBe("INVITED");
    expect(byId["creator-blocked"].status).toBe("NOT_ELIGIBLE");
    expect(byId["ghost"].status).toBe("NOT_ELIGIBLE");
    expect(out.invited).toBe(1);
    expect((await store.listInvitationsByCampaign("c-1"))).toHaveLength(1);
  });

  it("blocked and full-capacity creators can never be invited", async () => {
    const { store, sink } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    await expect(
      createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-blocked" }, {
        candidate: seed("creator-blocked"), history: HIST["creator-blocked"],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-full" }, {
        candidate: seed("creator-full"), history: HIST["creator-full"],
      }),
    ).rejects.toMatchObject({ status: 409, code: "NOT_ELIGIBLE" });
    expect(await store.listInvitationsByCampaign("c-1")).toHaveLength(0);
  });

  it("outsiders cannot invite, list or cancel; owners can cancel idempotently", async () => {
    const { store, sink, events } = await liveSetup();
    const deps = { store, audit: sink, now: () => NOW };
    await expect(
      createInvitation(deps, { callerUserId: "stranger", campaignId: "c-1", creatorUserId: "creator-good" }, {
        candidate: seed("creator-good"), history: HIST["creator-good"],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listInvitations(deps, { callerUserId: "stranger", campaignId: "c-1" }),
    ).rejects.toMatchObject({ status: 403 });
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, {
      candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"],
    });
    await expect(
      cancelInvitation({ store, audit: sink }, { callerUserId: "stranger", invitationId: res.invitation.id }),
    ).rejects.toMatchObject({ status: 403 });
    const cancelled = await cancelInvitation({ store, audit: sink }, { callerUserId: "owner-1", invitationId: res.invitation.id });
    expect(cancelled.status).toBe("CANCELLED");
    const again = await cancelInvitation({ store, audit: sink }, { callerUserId: "owner-1", invitationId: res.invitation.id });
    expect(again.status).toBe("CANCELLED");
    const actions = events.map((e) => (e as { action?: string }).action);
    expect(actions).toContain("creator.invitation.created");
    expect(actions).toContain("creator.invitation.cancelled");
  });

  it("self-invite is rejected and accepted invitations lock cancellation", async () => {
    const { store, sink } = await liveSetup();
    await expect(
      createInvitation({ store, audit: sink, now: () => NOW }, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "owner-1" }),
    ).rejects.toMatchObject({ status: 400 });
    const res = await createInvitation(
      { store, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" },
      { candidate: seed("creator-good"), history: HIST["creator-good"] },
    );
    await store.updateInvitationStatus(res.invitation.id, "ACCEPTED");
    await expect(
      cancelInvitation({ store, audit: sink }, { callerUserId: "owner-1", invitationId: res.invitation.id }),
    ).rejects.toMatchObject({ status: 409, code: "INVITATION_LOCKED" });
  });

  it("invitation DTO excludes private creator data; creator inbox is own-scoped", async () => {
    const { store, sink } = await liveSetup();
    const res = await createInvitation(
      { store, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" },
      { candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"] },
    );
    expect(Object.keys(res.invitation).sort()).toEqual(
      ["acceptedBy", "createdAt", "campaignId", "creatorHandle", "creatorUserId", "id", "match", "offered", "respondedAt", "status"].sort(),
    );
    expect(JSON.stringify(res.invitation)).not.toMatch(/wallet|email|rulesJson|secret|token|session|payoutWallet/i);
    const inbox = await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "creator-good" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].id).toBe(res.invitation.id);
    expect(await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "someone-else" })).toHaveLength(0);
  });

  it("unknown invitation ids fail closed with 404", async () => {
    const { store, sink } = await liveSetup();
    await expect(
      acceptInvitation({ store, audit: sink }, { creatorUserId: "creator-good", invitationId: "x" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      declineInvitation({ store, audit: sink }, { creatorUserId: "creator-good", invitationId: "x" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("creator accept / decline", () => {
  async function invited(ctx: Awaited<ReturnType<typeof liveSetup>>, notifications?: NotificationStore) {
    const { store, sink } = ctx;
    const deps = { store, audit: sink, now: () => NOW, ...(notifications ? { notifications } : {}) };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, {
      candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"],
    });
    return { deps, invitationId: res.invitation.id };
  }

  it("accept creates one participation + referral at the frozen bounty", async () => {
    const ctx = await liveSetup();
    const { store, sink } = ctx;
    const { deps, invitationId } = await invited(ctx);
    await store.updateMarket("c-1", 1, { publicBountyMicroUsdc: 3_000_000n, version: 2 });
    const res = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId });
    expect(res.invitation.status).toBe("ACCEPTED");
    expect(res.alreadyJoined).toBe(false);
    expect(res.participation.priceMicroUsdc).toBe("2000000");
    expect(res.participation.policyVersion).toBe(1);
    expect(res.participation.marketVersion).toBe(1);
    expect(res.referral.path).toMatch(/^\/r\//);
    const terms = await store.listPartnerTerms("p-good");
    expect(terms).toHaveLength(1);
    expect(terms[0].priceMicroUsdc).toBe(2_000_000n);
    expect(terms[0].source).toBe("INVITED");
  });

  it("accept retry creates no duplicate participation or referral", async () => {
    const ctx = await liveSetup();
    const { store } = ctx;
    const { deps, invitationId } = await invited(ctx);
    const first = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId });
    const second = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId });
    expect(second.alreadyJoined).toBe(true);
    expect(second.participation.termsId).toBe(first.participation.termsId);
    expect(second.referral.code).toBe(first.referral.code);
    expect(await store.listPartnerTerms("p-good")).toHaveLength(1);
  });

  it("accept creates no payout or reservation", async () => {
    const ctx = await liveSetup();
    const { store } = ctx;
    const { deps, invitationId } = await invited(ctx);
    const res = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId });
    expect(await store.getPayoutByOutcome("anything")).toBeNull();
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
    expect(res.invitation.status).toBe("ACCEPTED");
  });

  it("decline creates nothing and is idempotent", async () => {
    const ctx = await liveSetup();
    const { store } = ctx;
    const { deps, invitationId } = await invited(ctx);
    const res = await declineInvitation(deps, { creatorUserId: "creator-good", invitationId });
    expect(res.status).toBe("DECLINED");
    expect(await store.listPartnerTerms("p-good")).toHaveLength(0);
    expect(await store.getReferralByCode("anything")).toBeNull();
    const again = await declineInvitation(deps, { creatorUserId: "creator-good", invitationId });
    expect(again.status).toBe("DECLINED");
  });

  it("terminal states lock: accepted cannot decline, declined/cancelled cannot accept", async () => {
    const ctx = await liveSetup();
    const { store } = ctx;
    const { deps, invitationId } = await invited(ctx);
    await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId });
    await expect(declineInvitation(deps, { creatorUserId: "creator-good", invitationId })).rejects.toMatchObject({
      status: 409, code: "INVITATION_LOCKED",
    });
    const { invitationId: id2 } = await invited(ctx);
    await declineInvitation(deps, { creatorUserId: "creator-good", invitationId: id2 });
    await expect(acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: id2 })).rejects.toMatchObject({
      status: 409, code: "ALREADY_DECLINED",
    });
  });

  it("outsiders cannot respond to another creator's invitation", async () => {
    const ctx = await liveSetup();
    const { deps, invitationId } = await invited(ctx);
    await expect(acceptInvitation(deps, { creatorUserId: "stranger", invitationId })).rejects.toMatchObject({ status: 403 });
    await expect(declineInvitation(deps, { creatorUserId: "stranger", invitationId })).rejects.toMatchObject({ status: 403 });
  });

  it("closed campaigns cannot be accepted", async () => {
    const ctx = await liveSetup();
    const { store } = ctx;
    const { deps, invitationId } = await invited(ctx);
    await store.updateMarket("c-1", 1, { status: "CLOSED", version: 2 });
    await expect(acceptInvitation(deps, { creatorUserId: "creator-good", invitationId })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("conflicting pre-existing participation is never rewritten", async () => {
    const ctx = await liveSetup();
    const { store, sink } = ctx;
    const deps = { store, audit: sink, now: () => NOW };
    // Invite frozen at 2M, then the market reprices and the creator joins openly at 3M.
    const { invitationId } = await invited(ctx);
    await store.updateMarket("c-1", 1, { publicBountyMicroUsdc: 3_000_000n, version: 2 });
    await joinCampaign({ store, audit: sink, now: () => NOW } as never, { campaignId: "c-1", userId: "creator-good" });
    await expect(acceptInvitation(deps, { creatorUserId: "creator-good", invitationId })).rejects.toMatchObject({
      status: 409,
      code: "PARTICIPATION_CONFLICT",
    });
    const terms = await store.listPartnerTerms("p-good");
    expect(terms).toHaveLength(1);
    expect(terms[0].priceMicroUsdc).toBe(3_000_000n);
    // Compatible history resolves idempotently instead (same 2M economics).
    const ctx2 = await liveSetup();
    const deps2 = { store: ctx2.store, audit: ctx2.sink, now: () => NOW };
    const r2 = await createInvitation(deps2, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, {
      candidate: seed("creator-good"), history: HIST["creator-good"],
    });
    await joinCampaign({ store: ctx2.store, audit: ctx2.sink, now: () => NOW } as never, {
      campaignId: "c-1", userId: "creator-good",
      frozenOffer: { bountyMicroUsdc: 2_000_000n, policyVersion: 1, marketVersion: 1 },
    });
    const ok = await acceptInvitation(deps2, { creatorUserId: "creator-good", invitationId: r2.invitation.id });
    expect(ok.alreadyJoined).toBe(true);
    expect((await ctx2.store.listPartnerTerms("p-good"))).toHaveLength(1);
  });

  it("invitation notification is created once and marked read on response", async () => {
    const notifications = createMemoryNotificationStore();
    const ctx = await liveSetup();
    const { deps, invitationId } = await invited(ctx, notifications);
    // Retry the invite: still exactly one alert.
    await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, {
      candidate: seed("creator-good"), history: HIST["creator-good"],
    });
    const items = await notifications.listForCreator("creator-good");
    expect(items.filter((n) => n.type === "CAMPAIGN_INVITED")).toHaveLength(1);
    const alert = items.find((n) => n.type === "CAMPAIGN_INVITED")!;
    expect(alert.dedupeKey).toBe(`invite:${invitationId}`);
    expect(alert.metadataJson).toMatchObject({ invitationId });
    expect(alert.message).toMatch(/2 USDC per verified purchase/);
    await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId });
    const after = await notifications.listForCreator("creator-good");
    expect(after.find((n) => n.id === alert.id)?.readAt).not.toBeNull();
  });

  it("org sees ACCEPTED/DECLINED and DTOs leak nothing private", async () => {
    const ctx = await liveSetup();
    const { store, sink, events } = ctx;
    const deps = { store, audit: sink, now: () => NOW };
    const a = await invited(ctx);
    await acceptInvitation(a.deps, { creatorUserId: "creator-good", invitationId: a.invitationId });
    const b = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-full" }, {
      candidate: seed("creator-full"), history: { verifiedTotal: 20, settledCollaborations: 5, activeTermsCount: 0 },
    });
    await declineInvitation(deps, { creatorUserId: "creator-full", invitationId: b.invitation.id });
    const rows = await listInvitations(deps, { callerUserId: "owner-1", campaignId: "c-1" });
    expect(rows.map((r) => r.status).sort()).toEqual(["ACCEPTED", "DECLINED"]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/wallet|email|rulesJson|secret|token|session|password/i);
    const actions = events.map((e) => (e as { action?: string }).action);
    expect(actions).toContain("creator.invitation.accepted");
    expect(actions).toContain("creator.invitation.declined");
  });

  it("creator lists only own opportunities with frozen economics", async () => {
    const ctx = await liveSetup();
    const { store, sink } = ctx;
    const deps = { store, audit: sink, now: () => NOW };
    await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, {
      candidate: seed("creator-good", "bgirl"), history: HIST["creator-good"],
    });
    const { listCreatorOpportunities } = await import("@/server/services/invitations");
    const mine = await listCreatorOpportunities(deps, { creatorUserId: "creator-good" });
    expect(mine).toHaveLength(1);
    expect(mine[0].offered.bountyMicroUsdc).toBe("2000000");
    expect(mine[0].offered.outcomeKind).toBe("purchase");
    expect(mine[0].campaign.workspaceName).toBe("Acme");
    expect(mine[0].campaign.objective).toMatch(/paying customers/);
    await store.updateMarket("c-1", 1, { publicBountyMicroUsdc: 9_000_000n, version: 2 });
    const after = await listCreatorOpportunities(deps, { creatorUserId: "creator-good" });
    expect(after[0].offered.bountyMicroUsdc).toBe("2000000");
    expect(await listCreatorOpportunities(deps, { creatorUserId: "stranger" })).toHaveLength(0);
  });
});

describe("creator agent auto-accept", () => {
  const ON = { ...GOOD_RULES, autoJoin: true, minScoutConfidence: "LOW" as const };
  function snap(decision: "RECOMMEND" | "WATCH" = "RECOMMEND", confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH") {
    return {
      candidates: [{
        facts: {
          campaignId: "c-1", workspaceName: "Acme", objective: "Get customers", category: "ai",
          bountyMicroUsdc: "2000000", targetOutcomeCount: 10, verifiedOutcomes: 0,
          deadline: new Date(NOW.getTime() + 10 * 86_400_000),
          campaignState: "LIVE", marketStatus: "OPEN", minQualifyingMicroUsdc: "500000", holdSeconds: 3600,
          alreadyJoined: false, referralPath: null, creatorVerifiedTotal: 0, creatorVerifiedRecent: 0,
          creatorActions: 0, creatorSettledTotalMicroUsdc: "0", paceStatus: null,
        },
        eligibility: "ELIGIBLE", eligibilityReason: "ok", score: 80, rank: 1,
        decision, reason: "Strong match", confidence, evidenceUsed: [],
        earningsEstimateMicroUsdc: null, earningsNote: "",
      }],
      plan: { topOpportunities: [], watchlist: [], joined: [], notEligible: [], summary: "" },
    };
  }
  async function onSetup() {
    const ctx = await liveSetup();
    await ctx.store.updatePartnerRules("p-good", ON);
    return ctx;
  }
  function inviteOpts() {
    return {
      candidate: seed("creator-good", "bgirl"),
      history: HIST["creator-good"],
      snapshot: snap() as never,
      joinsToday: 0,
    };
  }

  it("autoJoin OFF means REVIEW with no accept", async () => {
    const ctx = await liveSetup();
    const { store, sink } = ctx;
    const deps = { store, audit: sink, now: () => NOW };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, {
      candidate: seed("creator-good"), history: HIST["creator-good"],
    });
    expect(res.invitation.status).toBe("INVITED");
    expect(await store.listPartnerTerms("p-good")).toHaveLength(0);
    const { evaluateInvitationAuthority } = await import("@/server/services/scout");
    const assessment = await evaluateInvitationAuthority(
      { store, now: () => NOW },
      { creatorUserId: "creator-good", campaignId: "c-1", invitationId: res.invitation.id, invitationStatus: "INVITED", offeredBountyMicroUsdc: 2_000_000n },
      { joinsToday: 0, snapshot: snap() as never },
    );
    expect(assessment.result).toBe("REVIEW");
    expect(assessment.rule).toBe("AUTOJOIN_DISABLED");
    // Human override still works on the REVIEW row.
    const manual = await acceptInvitation(deps, { creatorUserId: "creator-good", invitationId: res.invitation.id });
    expect(manual.invitation.status).toBe("ACCEPTED");
    expect(manual.alreadyJoined).toBe(false);
  });

  it("autoJoin ON with passing rules auto-accepts once with full proof", async () => {
    const { createMemoryNotificationStore } = await import("@/server/services/creatorNotifications");
    const notifications = createMemoryNotificationStore();
    const ctx = await onSetup();
    const { store, sink, events } = ctx;
    const deps = { store, audit: sink, now: () => NOW, notifications };
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, inviteOpts());
    expect(res.invitation.status).toBe("ACCEPTED");
    expect(res.invitation.acceptedBy).toBe("AGENT");
    const terms = await store.listPartnerTerms("p-good");
    expect(terms).toHaveLength(1);
    expect(terms[0].priceMicroUsdc).toBe(2_000_000n);
    expect(terms[0].source).toBe("INVITED");
    expect(await store.getPayoutByOutcome("anything")).toBeNull();
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
    // Audit-backed acceptedBy resolution needs a real DB; in unit tests the
    // direct return carries the mode while list resolution stays best-effort.
    const org = await listInvitations(deps, { callerUserId: "owner-1", campaignId: "c-1" });
    expect(org.find((r) => r.id === res.invitation.id)?.status).toBe("ACCEPTED");
    const alerts = await notifications.listForCreator("creator-good");
    const joined = alerts.filter((n) => n.type === "AUTO_JOINED");
    expect(joined).toHaveLength(1);
    expect(joined[0].dedupeKey).toBe(`autoaccept:${res.invitation.id}`);
    expect(joined[0].message).toMatch(/satisfied your Scout rules/);
    expect(alerts.find((n) => n.dedupeKey === `invite:${res.invitation.id}`)?.readAt).not.toBeNull();
    const actions = events.map((e) => (e as { action?: string }).action);
    expect(actions).toContain("creator.invitation.agent_evaluated");
    expect(actions).toContain("creator.invitation.accepted");
    // Repeat recovery is quiet: no new participation, alerts, or audits.
    const { recoverCreatorInvitations } = await import("@/server/services/invitations");
    const auditCount = events.length;
    const second = await recoverCreatorInvitations(deps, { creatorUserId: "creator-good" });
    expect(second).toEqual({ accepted: 0, evaluated: 0 });
    expect(await store.listPartnerTerms("p-good")).toHaveLength(1);
    expect((await notifications.listForCreator("creator-good")).filter((n) => n.type === "AUTO_JOINED")).toHaveLength(1);
    expect(events.length).toBe(auditCount);
  });

  it("authority uses the frozen bounty, never the current one", async () => {
    const ctx = await onSetup();
    const { store, sink } = ctx;
    const deps = { store, audit: sink, now: () => NOW };
    const { evaluateInvitationAuthority } = await import("@/server/services/scout");
    const base = { creatorUserId: "creator-good", campaignId: "c-1", invitationId: "x", invitationStatus: "INVITED" };
    // Frozen 2M below a 4M minimum refuses.
    await store.updatePartnerRules("p-good", { ...ON, minimumBountyMicroUsdc: "4000000" });
    const refused = await evaluateInvitationAuthority(
      { store, now: () => NOW },
      { ...base, offeredBountyMicroUsdc: 2_000_000n },
      { joinsToday: 0, snapshot: snap() as never },
    );
    expect(refused.result).toBe("REFUSE");
    expect(refused.rule).toBe("MIN_BOUNTY");
    // Frozen 5M still satisfies the same minimum after the live market drops.
    const ok = await evaluateInvitationAuthority(
      { store, now: () => NOW },
      { ...base, offeredBountyMicroUsdc: 5_000_000n },
      { joinsToday: 0, snapshot: snap() as never },
    );
    expect(ok.result).toBe("AUTO_ACCEPT");
    void deps;
  });

  it("blocked categories, low confidence, full capacity and daily caps never auto-accept", async () => {
    const { evaluateInvitationAuthority } = await import("@/server/services/scout");
    const ctx = await onSetup();
    const { store, sink } = ctx;
    const deps = { store, audit: sink, now: () => NOW };
    const base = { creatorUserId: "creator-good", campaignId: "c-1", invitationId: "x", invitationStatus: "INVITED", offeredBountyMicroUsdc: 2_000_000n };
    // Blocked category.
    await store.updatePartnerRules("p-good", { ...ON, blockedCategories: ["ai"] });
    expect((await evaluateInvitationAuthority({ store, now: () => NOW }, base, { joinsToday: 0, snapshot: snap() as never })).result).toBe("REFUSE");
    // Low confidence vs HIGH threshold.
    await store.updatePartnerRules("p-good", { ...ON, minScoutConfidence: "HIGH" });
    const low = await evaluateInvitationAuthority({ store, now: () => NOW }, base, { joinsToday: 0, snapshot: snap("RECOMMEND", "LOW") as never });
    expect(low.result).toBe("REVIEW");
    // Daily rate cap.
    await store.updatePartnerRules("p-good", { ...ON, maxAutoJoinsPerDay: 1 });
    const capped = await evaluateInvitationAuthority({ store, now: () => NOW }, base, { joinsToday: 1, snapshot: snap() as never });
    expect(capped.result).toBe("REFUSE");
    expect(capped.rule).toBe("RATE_LIMITED");
    // Full active capacity (three other campaigns; none for c-1 itself).
    await store.updatePartnerRules("p-good", ON);
    for (let i = 0; i < 3; i += 1) {
      await store.insertTerms({
        id: `t-${i}`, campaignId: `c-other-${i}`, partnerId: "p-good", priceMicroUsdc: 2_000_000n,
        allocationCount: 1, source: "PUBLIC", expiresAt: new Date(NOW.getTime() + 86400000),
        policyVersion: 1, marketVersion: 1,
      });
    }
    const full = await evaluateInvitationAuthority({ store, now: () => NOW }, base, { joinsToday: 0, snapshot: snap() as never });
    expect(full.result).toBe("REFUSE");
    expect(full.rule).toBe("MAX_ACTIVE");
    void deps;
  });

  it("REFUSE never declines; background recovery accepts later when permitted", async () => {
    const { createMemoryNotificationStore } = await import("@/server/services/creatorNotifications");
    const { recoverCreatorInvitations } = await import("@/server/services/invitations");
    const notifications = createMemoryNotificationStore();
    const ctx = await liveSetup();
    const { store, sink } = ctx;
    const deps = { store, audit: sink, now: () => NOW, notifications };
    // Invite while OFF: REVIEW, row stays INVITED, nothing joined.
    const res = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-good" }, {
      candidate: seed("creator-good"), history: HIST["creator-good"],
    });
    expect(res.invitation.status).toBe("INVITED");
    expect(await store.listPartnerTerms("p-good")).toHaveLength(0);
    // Creator enables auto-join later: background recovery accepts once.
    await store.updatePartnerRules("p-good", ON);
    const first = await recoverCreatorInvitations(deps, { creatorUserId: "creator-good" }, { joinsToday: 0, snapshot: snap() as never });
    expect(first).toEqual({ accepted: 1, evaluated: 1 });
    expect((await store.getInvitation(res.invitation.id))?.status).toBe("ACCEPTED");
    expect((await store.listPartnerTerms("p-good"))).toHaveLength(1);
    // Closed markets fail closed without crashing the batch.
    await store.updateMarket("c-1", 1, { status: "CLOSED", version: 2 });
    const closed = await recoverCreatorInvitations(deps, { creatorUserId: "creator-good" }, { joinsToday: 0, snapshot: snap() as never });
    expect(closed).toEqual({ accepted: 0, evaluated: 0 });
  });
});

describe("invitation routes", () => {
  it("unauthenticated callers get 401; outsiders get 403; bad bodies get 400", async () => {
    const { getSessionUser, requireUser } = await import("@/server/auth/guard");
    const { marketDepsOr503 } = await import("@/server/api/campaignDeps");
    const { store, sink } = await liveSetup();
    vi.mocked(marketDepsOr503).mockReturnValue({ deps: { store, audit: sink } } as never);
    const { GET, POST, DELETE } = await import("@/app/api/campaigns/[id]/invitations/route");
    const { GET: getMatches } = await import("@/app/api/campaigns/[id]/matches/route");

    const authed = { userId: "owner-1" } as never;
    const stranger = { userId: "stranger" } as never;
    const unauth = Object.assign(new Error("Unauthorized"), { status: 401, code: "UNAUTHORIZED" });
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(requireUser).mockRejectedValue(unauth);
    expect((await getMatches(new Request("http://x"), { params: Promise.resolve({ id: "c-1" }) })).status).toBe(401);
    expect((await POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "c-1" }) })).status).toBe(401);

    vi.mocked(getSessionUser).mockResolvedValue(stranger);
    vi.mocked(requireUser).mockResolvedValue(stranger);
    expect((await getMatches(new Request("http://x"), { params: Promise.resolve({ id: "c-1" }) })).status).toBe(403);

    vi.mocked(getSessionUser).mockResolvedValue(authed);
    vi.mocked(requireUser).mockResolvedValue(authed);
    const bad = await POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ nope: 1 }) }),
      { params: Promise.resolve({ id: "c-1" }) },
    );
    expect(bad.status).toBe(400);
    const badCancel = await DELETE(
      new Request("http://x", { method: "DELETE", body: JSON.stringify({}) }),
      { params: Promise.resolve({ id: "c-1" }) },
    );
    expect(badCancel.status).toBe(400);
  });
});
