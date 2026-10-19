import { describe, expect, it, vi } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  findCreatorMatches,
  scoreCreatorMatch,
  type CapabilitySeed,
  type HistorySeed,
  type MatchCandidateFacts,
} from "@/server/services/matching";
import {
  normalizeCreatorType,
  normalizeInterests,
  normalizePreferences,
} from "@/server/services/personas";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/server/db/client", () => ({
  isDbConfigured: () => true,
  getDb: () => ({ update: () => ({ set: () => ({ where: async () => {} }) }) }),
}));
vi.mock("@/server/services/personas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/personas")>();
  return { ...actual, getPersonaByUserId: vi.fn(), upsertPersona: vi.fn() };
});
vi.mock("@/server/services/workspaces", () => ({ listUserWorkspaces: async () => [] }));
vi.mock("@/server/services/partners", () => ({
  getPartnerByUserId: vi.fn(),
  createPartnerProfile: vi.fn(),
}));

const NOW = new Date("2026-06-01T12:00:00.000Z");
const WALLET = "0x0000000000000000000000000000000000000001";

const GOOD_RULES = {
  autoJoin: false,
  minimumBountyMicroUsdc: "500000",
  allowedCategories: [],
  blockedCategories: [],
  maxActiveCampaigns: 3,
  minScoutConfidence: "MEDIUM",
  maxAutoJoinsPerDay: null,
};

function facts(over: Partial<MatchCandidateFacts> = {}): MatchCandidateFacts {
  return {
    creatorUserId: "u-1",
    handle: "endurance",
    creatorType: "CREATOR",
    interests: ["ai"],
    preferences: ["referral"],
    profileCategory: "ai",
    campaignCategory: "ai",
    campaignKinds: ["referral"],
    bountyMicroUsdc: 2_000_000n,
    minBountyMicroUsdc: 500_000n,
    verifiedTotal: 0,
    settledCollaborations: 0,
    activeTermsCount: 0,
    maxActiveCampaigns: 3,
    eligibility: "ELIGIBLE",
    eligibilityReason: "ok",
    ...over,
  };
}

function stubStore(over: Record<string, unknown> = {}) {
  return {
    async getCampaign() {
      return { id: "c-1", workspaceId: "ws-A", state: "LIVE" };
    },
    async getWorkspace() {
      return { id: "ws-A", name: "Acme", category: "ai" };
    },
    async getMembership(_ws: string, userId: string) {
      return userId === "owner-1" ? { userId, workspaceId: "ws-A", role: "ORGANIZATION_OWNER" } : null;
    },
    async getMarket() {
      return { campaignId: "c-1", publicBountyMicroUsdc: 2_000_000n, status: "OPEN", policyVersion: 1 };
    },
    async getVersion() {
      return { deadline: new Date(NOW.getTime() + 30 * 86_400_000), minQualifyingPurchaseMicroUsdc: null };
    },
    async getPartnerByUserId(userId: string) {
      return { id: `p-${userId}`, userId, payoutWallet: WALLET, categories: [], rulesJson: GOOD_RULES };
    },
    async listPartnerTerms() {
      return [];
    },
    ...over,
  };
}

const CAPS: CapabilitySeed[] = [
  {
    userId: "u-1", handle: "endurance", creatorType: "CREATOR", interests: ["ai"],
    preferences: ["referral"], profileCategory: "ai", onboardingCompleted: true,
  },
];
const HIST: Record<string, HistorySeed> = {
  "u-1": { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 },
};

describe("capability normalization", () => {
  it("normalizes creator type, interests and preferences safely", () => {
    expect(normalizeCreatorType("kol")).toBe("KOL");
    expect(normalizeCreatorType("Developer")).toBe("DEVELOPER");
    expect(normalizeCreatorType("influencer")).toBeNull();
    expect(normalizeCreatorType(null)).toBeNull();
    expect(normalizeInterests("ai, Fitness, ai, !!!")).toEqual(["ai", "fitness"]);
    expect(normalizeInterests(["  DeFi ", 42])).toEqual(["defi", "42"]);
    expect(normalizeInterests(null)).toEqual([]);
    expect(normalizePreferences("referral, purchase, airdrop")).toEqual(["referral", "purchase"]);
    expect(normalizePreferences("product testing")).toEqual(["product-testing"]);
    expect(normalizePreferences(null)).toEqual([]);
  });

  it("legacy creators without new fields remain valid", () => {
    const m = scoreCreatorMatch(facts({ creatorType: null, interests: [], preferences: [], profileCategory: null }));
    expect(m.recommendedAction).toBe("SKIP");
    expect(m.confidence).toBe("LOW");
  });
});

describe("match kernel", () => {
  it("strong-fit cold-start creators are discoverable (REVIEW, never silent)", () => {
    const m = scoreCreatorMatch(facts());
    expect(m.matchScore).toBe(70);
    expect(m.fitScore).toBe(30);
    expect(m.confidence).toBe("LOW");
    expect(m.recommendedAction).toBe("REVIEW");
    expect(m.warnings.join(" ")).toMatch(/provisional/);
  });

  it("verified history improves evidence and can earn INVITE", () => {
    const cold = scoreCreatorMatch(facts());
    const proven = scoreCreatorMatch(facts({ verifiedTotal: 18, settledCollaborations: 2 }));
    expect(proven.evidenceScore).toBeGreaterThan(cold.evidenceScore);
    expect(proven.matchScore).toBeGreaterThan(cold.matchScore);
    expect(proven.confidence).toBe("HIGH");
    expect(proven.recommendedAction).toBe("INVITE");
    expect(proven.reasons.join(" ")).toMatch(/18 historical verified/);
  });

  it("low sample lowers confidence without destroying the score", () => {
    expect(scoreCreatorMatch(facts({ verifiedTotal: 0 })).confidence).toBe("LOW");
    expect(scoreCreatorMatch(facts({ verifiedTotal: 5 })).confidence).toBe("MEDIUM");
    expect(scoreCreatorMatch(facts({ verifiedTotal: 12 })).confidence).toBe("HIGH");
  });

  it("ineligible creators never get INVITE", () => {
    const m = scoreCreatorMatch(facts({ eligibility: "NOT_ELIGIBLE", eligibilityReason: "blocked" }));
    expect(m.recommendedAction).toBe("NOT_ELIGIBLE");
    expect(m.matchScore).toBeGreaterThan(0);
  });

  it("kernel takes no follower input and explains itself", () => {
    const m = scoreCreatorMatch(facts());
    expect("followerCount" in m).toBe(false);
    expect(m.reasons.length).toBeGreaterThan(0);
    expect(m.reasons.join(" ")).toMatch(/category overlap/);
  });
});

describe("persona settings route", () => {
  it("accepts creator capability fields and normalizes them", async () => {
    const { getSessionUser } = await import("@/server/auth/guard");
    const { getPersonaByUserId, upsertPersona } = await import("@/server/services/personas");
    const { getPartnerByUserId } = await import("@/server/services/partners");
    vi.mocked(getSessionUser).mockResolvedValue({ userId: "u-1", name: "Endurance" } as never);
    vi.mocked(getPersonaByUserId).mockResolvedValue(null);
    vi.mocked(upsertPersona).mockResolvedValue({
      persona: "CREATOR", handle: "endurance", onboardingCompletedAt: new Date(),
    } as never);
    vi.mocked(getPartnerByUserId).mockResolvedValue(null as never);
    const { POST } = await import("@/app/api/persona/route");
    const res = await POST(
      new Request("http://x/api/persona", {
        method: "POST",
        body: JSON.stringify({
          persona: "creator", displayName: "Endurance", handle: "endurance",
          creatorType: "KOL", interests: "ai, Fitness", preferences: ["referral", "airdrop"],
          complete: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(upsertPersona).mock.calls[0][1]).toMatchObject({
      creatorType: "KOL",
      interests: "ai, Fitness",
      preferences: ["referral", "airdrop"],
    });
  });

  it("rejects unknown creator types with 400", async () => {
    const { getSessionUser } = await import("@/server/auth/guard");
    vi.mocked(getSessionUser).mockResolvedValue({ userId: "u-1", name: "Endurance" } as never);
    const { POST } = await import("@/app/api/persona/route");
    const res = await POST(
      new Request("http://x/api/persona", {
        method: "POST",
        body: JSON.stringify({ persona: "creator", creatorType: "INFLUENCER" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("match service", () => {
  it("ranks deterministically with stable tie-breaking", async () => {
    const { sink } = createMemoryAuditSink();
    const store = createMemoryCampaignStore({}) as never;
    void store;
    const deps = { store: stubStore() as never, audit: sink, now: () => NOW };
    const candidates: CapabilitySeed[] = [
      { ...CAPS[0], userId: "u-b", handle: "bravo" },
      { ...CAPS[0], userId: "u-a", handle: "alpha" },
      { ...CAPS[0], userId: "u-c", handle: null },
    ];
    const histories: Record<string, HistorySeed> = {
      "u-a": { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 },
      "u-b": { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 },
      "u-c": { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 },
    };
    const first = await findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-1" }, { candidates, histories });
    const second = await findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-1" }, { candidates, histories });
    expect(first.review.map((m) => m.creatorUserId)).toEqual(["u-a", "u-b", "u-c"]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("blocked categories, low bounties and full capacity never invite", async () => {
    const { sink } = createMemoryAuditSink();
    const blockedStore = stubStore({
      async getPartnerByUserId(userId: string) {
        return {
          id: `p-${userId}`, userId, payoutWallet: WALLET, categories: [],
          rulesJson: { ...GOOD_RULES, blockedCategories: ["ai"] },
        };
      },
    });
    const blocked = await findCreatorMatches(
      { store: blockedStore as never, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: CAPS, histories: HIST },
    );
    expect(blocked.invite).toHaveLength(0);
    expect(blocked.notEligible).toHaveLength(1);

    const poorStore = stubStore({
      async getMarket() {
        return { campaignId: "c-1", publicBountyMicroUsdc: 100_000n, status: "OPEN", policyVersion: 1 };
      },
    });
    const poor = await findCreatorMatches(
      { store: poorStore as never, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: CAPS, histories: HIST },
    );
    expect(poor.invite).toHaveLength(0);
    expect(poor.notEligible[0].eligibilityReason).toMatch(/minimum|bounty/i);

    const full = await findCreatorMatches(
      { store: stubStore() as never, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1" },
      {
        candidates: CAPS,
        histories: { "u-1": { verifiedTotal: 20, settledCollaborations: 5, activeTermsCount: 3 } },
      },
    );
    expect(full.invite).toHaveLength(0);
    expect(full.notEligible).toHaveLength(1);
  });

  it("organization DTO leaks no private creator data", async () => {
    const { sink, events } = createMemoryAuditSink();
    const report = await findCreatorMatches(
      { store: stubStore() as never, audit: sink, now: () => NOW },
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: CAPS, histories: HIST },
    );
    const all = [...report.invite, ...report.review, ...report.skip, ...report.notEligible];
    expect(all.length).toBe(1);
    expect(Object.keys(all[0]).sort()).toEqual(
      ["availabilityScore", "confidence", "creatorType", "creatorUserId", "economicsScore", "eligibility", "eligibilityReason", "evidenceScore", "fitScore", "handle", "matchScore", "reasons", "recommendedAction", "warnings"].sort(),
    );
    const serialized = JSON.stringify(all);
    expect(serialized).not.toMatch(/wallet|email|rulesJson|payout|secret|token|session/i);
    expect(events.filter((e) => (e as { action?: string }).action === "match_engine.run")).toHaveLength(1);
  });

  it("rejects non-members and creator-role callers with 403", async () => {
    const { sink } = createMemoryAuditSink();
    const deps = { store: stubStore() as never, audit: sink, now: () => NOW };
    await expect(
      findCreatorMatches(deps, { callerUserId: "stranger", campaignId: "c-1" }, { candidates: CAPS, histories: HIST }),
    ).rejects.toMatchObject({ status: 403 });
    const partnerCaller = stubStore({
      async getMembership() {
        return { userId: "u-1", workspaceId: "ws-A", role: "PARTNER" };
      },
    });
    await expect(
      findCreatorMatches({ store: partnerCaller as never, audit: sink, now: () => NOW }, { callerUserId: "u-1", campaignId: "c-1" }, { candidates: CAPS, histories: HIST }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
