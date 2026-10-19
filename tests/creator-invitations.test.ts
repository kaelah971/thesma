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
      ["createdAt", "campaignId", "creatorHandle", "creatorUserId", "id", "match", "offered", "respondedAt", "status"].sort(),
    );
    expect(JSON.stringify(res.invitation)).not.toMatch(/wallet|email|rulesJson|secret|token|session|payoutWallet/i);
    const inbox = await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "creator-good" });
    expect(inbox).toHaveLength(1);
    expect(inbox[0].id).toBe(res.invitation.id);
    expect(await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "someone-else" })).toHaveLength(0);
  });

  it("accept/decline are Slice 3 stubs, not silent no-ops", async () => {
    const { store, sink } = await liveSetup();
    await expect(
      acceptInvitation({ store, audit: sink }, { creatorUserId: "creator-good", invitationId: "x" }),
    ).rejects.toMatchObject({ status: 501 });
    await expect(
      declineInvitation({ store, audit: sink }, { creatorUserId: "creator-good", invitationId: "x" }),
    ).rejects.toMatchObject({ status: 501 });
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
