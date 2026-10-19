import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import { getPartnerRules, updatePartnerRules } from "@/server/services/markets";
import { parsePartnerRules } from "@/server/domain/market";
import { runScoutAutoJoin } from "@/server/services/scout";
import { serverErrorMessage } from "@/lib/api";
import { getPublicCreatorProfile } from "@/server/services/creatorProfiles";
import { normalizeHandle } from "@/server/services/personas";

const NOW = new Date("2026-06-01T12:00:00.000Z");

/** Exact stored shape of the real production row that 500'd Run Scout. */
const LEGACY_NULL_RULES = {
  autoJoin: false,
  autoNegotiate: false,
  maxAllocation: null,
  allowedCategories: [],
  blockedCategories: [],
  maxActiveCampaigns: null,
  maxAutoJoinsPerDay: null,
  minBountyMicroUSDC: null,
  minScoutConfidence: "MEDIUM",
};

describe("stored legacy-null rules never 500", () => {
  it("parses to safe defaults (null = absent)", () => {
    const parsed = parsePartnerRules(LEGACY_NULL_RULES);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rules.autoJoin).toBe(false);
      expect(parsed.rules.minimumBountyMicroUsdc).toBe(0n);
      expect(parsed.rules.minScoutConfidence).toBe("MEDIUM");
      expect(parsed.rules.maxActiveCampaigns).toBeNull();
      expect(parsed.rules.maxAutoJoinsPerDay).toBeNull();
    }
  });

  it("genuinely malformed rules still fail closed", () => {
    expect(parsePartnerRules({ minimumBountyMicroUsdc: "abc" }).ok).toBe(false);
    expect(parsePartnerRules({ minScoutConfidence: "EXTREME" }).ok).toBe(false);
  });

  it("Run Scout no longer throws for the poisoned row shape", async () => {
    const store = createMemoryCampaignStore({
      partners: [{ id: "p-1", userId: "partner-1", payoutWallet: "0x0000000000000000000000000000000000000001", rulesJson: LEGACY_NULL_RULES }],
    });
    const { sink } = createMemoryAuditSink();
    const res = await runScoutAutoJoin(
      { store, audit: sink, now: () => NOW } as never,
      "partner-1",
      { joinsTodayByPartner: async () => 0 },
    );
    expect(res.evaluated).toBe(0);
    expect(res.joined).toHaveLength(0);
  });
});

describe("auto-join toggle persists without weakening rules", () => {
  async function rulesStore(autoJoin: boolean, minimumBountyMicroUsdc = "500000") {
    const store = createMemoryCampaignStore({
      partners: [{
        id: "p-1", userId: "partner-1", payoutWallet: "0x0000000000000000000000000000000000000001",
        rulesJson: {
          autoJoin, minimumBountyMicroUsdc, allowedCategories: ["media"], blockedCategories: [],
          maxActiveCampaigns: 3, minScoutConfidence: "MEDIUM", maxAutoJoinsPerDay: 5,
        },
      }],
    });
    const { sink } = createMemoryAuditSink();
    return { store, sink };
  }

  it("flipping ON keeps every other rule intact", async () => {
    const { store, sink } = await rulesStore(false);
    const before = await getPartnerRules({ store, audit: sink } as never, { userId: "partner-1" });
    await updatePartnerRules({ store, audit: sink } as never, {
      userId: "partner-1",
      rules: { ...before.rules, autoJoin: true },
    });
    const after = await getPartnerRules({ store, audit: sink } as never, { userId: "partner-1" });
    expect(after.rules.autoJoin).toBe(true);
    expect(after.rules.minimumBountyMicroUsdc).toBe(before.rules.minimumBountyMicroUsdc);
    expect(after.rules.allowedCategories).toEqual(["media"]);
    expect(after.rules.maxActiveCampaigns).toBe(3);
  });

  it("toggle OFF never joins even for recommended candidates", async () => {
    const { store, sink } = await rulesStore(false);
    const res = await runScoutAutoJoin({ store, audit: sink, now: () => NOW } as never, "partner-1", {
      joinsTodayByPartner: async () => 0,
      snapshot: {
        candidates: [{
          facts: {
            campaignId: "c-1", workspaceName: "Acme", objective: "Get customers", category: "media",
            bountyMicroUsdc: "2000000", targetOutcomeCount: 10, verifiedOutcomes: 0,
            deadline: new Date(NOW.getTime() + 10 * 86_400_000),
            campaignState: "LIVE", marketStatus: "OPEN", minQualifyingMicroUsdc: "500000", holdSeconds: 60,
            alreadyJoined: false, referralPath: null, creatorVerifiedTotal: 4, creatorVerifiedRecent: 2,
            creatorActions: 12, creatorSettledTotalMicroUsdc: "0", paceStatus: null,
          },
          eligibility: "ELIGIBLE", eligibilityReason: "ok", score: 80, rank: 1,
          decision: "RECOMMEND", reason: "Strong match", confidence: "HIGH",
          evidenceUsed: ["4-verified/12-actions"], earningsEstimateMicroUsdc: null, earningsNote: "",
        }],
        plan: { topOpportunities: [], watchlist: [], joined: [], notEligible: [], summary: "" },
      },
    });
    expect(res.joined).toHaveLength(0);
    expect(res.recommendedOnly.length).toBeGreaterThan(0);
  });

  it("toggle ON does not bypass the minimum-bounty rule", async () => {
    const { store, sink } = await rulesStore(true, "9000000");
    const res = await runScoutAutoJoin({ store, audit: sink, now: () => NOW } as never, "partner-1", {
      joinsTodayByPartner: async () => 0,
      snapshot: {
        candidates: [{
          facts: {
            campaignId: "c-1", workspaceName: "Acme", objective: "Get customers", category: "media",
            bountyMicroUsdc: "2000000", targetOutcomeCount: 10, verifiedOutcomes: 0,
            deadline: new Date(NOW.getTime() + 10 * 86_400_000),
            campaignState: "LIVE", marketStatus: "OPEN", minQualifyingMicroUsdc: "500000", holdSeconds: 60,
            alreadyJoined: false, referralPath: null, creatorVerifiedTotal: 4, creatorVerifiedRecent: 2,
            creatorActions: 12, creatorSettledTotalMicroUsdc: "0", paceStatus: null,
          },
          eligibility: "ELIGIBLE", eligibilityReason: "ok", score: 80, rank: 1,
          decision: "RECOMMEND", reason: "Strong match", confidence: "HIGH",
          evidenceUsed: ["4-verified/12-actions"], earningsEstimateMicroUsdc: null, earningsNote: "",
        }],
        plan: { topOpportunities: [], watchlist: [], joined: [], notEligible: [], summary: "" },
      },
    });
    expect(res.joined).toHaveLength(0);
    expect(res.refused[0].rule).toBe("MIN_BOUNTY");
  });
});

describe("inline errors are always render-safe strings", () => {
  it("never returns an object (the black-screen vector)", () => {
    expect(serverErrorMessage({ error: { code: "INTERNAL", message: "Stored Partner rules are invalid" } } as never, "fallback")).toBe(
      "Stored Partner rules are invalid",
    );
    expect(serverErrorMessage({ error: "plain" }, "fallback")).toBe("plain");
    expect(serverErrorMessage({ error: {} }, "fallback")).toBe("fallback");
    expect(serverErrorMessage(null, "fallback")).toBe("fallback");
  });
});

describe("encoded handle params", () => {
  it("decodes %40 before matching; malformed sequences stay rejected", async () => {
    const { decodeHandleParam } = await import("@/app/[handle]/page");
    expect(normalizeHandle(decodeHandleParam("%40bgirl"))).toBe("bgirl");
    expect(normalizeHandle(decodeHandleParam("@bgirl"))).toBe("bgirl");
    expect(normalizeHandle(decodeHandleParam("bgirl"))).toBe("bgirl");
    expect(normalizeHandle(decodeHandleParam("%E0%A4%A"))).toBeNull();
  });
});

describe("public profile loop", () => {
  const source = {
    async findPersonaByHandle(handle: string) {
      return handle === "endurance"
        ? {
            userId: "u-creator", persona: "CREATOR", handle: "endurance", bio: "Fitness deals",
            category: "Fitness", onboardingCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
          }
        : null;
    },
    async getUser() {
      return { id: "u-creator", name: "Endurance", createdAt: new Date("2025-12-01T00:00:00.000Z") };
    },
  };
  const emptyStore = { async listOutcomesByStatus() { return []; } } as never;

  it("exposes creatorUserId for self-rendering, still no private fields", async () => {
    const { createMemoryFollowStore } = await import("@/server/services/creatorProfiles");
    const profile = await getPublicCreatorProfile("endurance", {
      store: emptyStore, source, follows: createMemoryFollowStore(), viewerUserId: "u-fan",
    });
    expect(profile?.creatorUserId).toBe("u-creator");
    expect(profile?.isFollowing).toBe(false);
    expect(profile).not.toHaveProperty("userId");
    expect(profile).not.toHaveProperty("payoutWallet");
    expect(JSON.stringify(profile)).not.toMatch(/password|wallet|token|session|secret/i);
  });

  it("a fan can follow and unfollow; self-follow stays rejected", async () => {
    const { createMemoryFollowStore } = await import("@/server/services/creatorProfiles");
    const follows = createMemoryFollowStore();
    expect(await follows.isFollowing("u-fan", "u-creator")).toBe(false);
    await follows.follow("u-fan", "u-creator");
    expect(await follows.isFollowing("u-fan", "u-creator")).toBe(true);
    expect(await follows.followerCount("u-creator")).toBe(1);
    await expect(follows.follow("u-creator", "u-creator")).rejects.toMatchObject({ status: 400 });
    await follows.unfollow("u-fan", "u-creator");
    expect(await follows.isFollowing("u-fan", "u-creator")).toBe(false);
  });
});

describe("creator copy guards", () => {
  const root = join(__dirname, "..");
  it("no hourly background copy remains on creator surfaces", () => {
    for (const f of [
      "src/components/start/CreatorNotificationsPanel.tsx",
      "src/app/creator/page.tsx",
    ]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src).not.toMatch(/hourly/i);
    }
  });

  it("creator home links the public profile and browse flow", () => {
    const src = readFileSync(join(root, "src/app/creator/page.tsx"), "utf8");
    expect(src).toContain("View public profile →");
    expect(src).toMatch(/href=\{`\/\$\{row\.handle\}`\}/);
    expect(src).toContain("Browse campaigns");
    expect(src).toContain('href="/markets"');
    expect(src).not.toContain("reserved for your public profile");
    expect(src).not.toContain("complete the creator profile");
  });
});
