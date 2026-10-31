import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createMemoryAuditSink,
} from "@/server/services/campaignStore";
import {
  findCreatorMatches,
  type CapabilitySeed,
  type HistorySeed,
} from "@/server/services/matching";
import { matchesEmptyMessage } from "@/components/app/CreatorMatches";

/**
 * Legacy / cold-start creator discovery (production @bgirl shape, generalized).
 *
 * Guards the real production incident: a valid onboarded CREATOR persona with
 * legacy capability columns (creator_type NULL, interests [], preferences [])
 * and no prior participation must remain discoverable pre-funding — as a
 * provisional LOW-confidence match, never silently erased. Nothing here names
 * a real creator or a real category: all fixtures use synthetic handles.
 */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const WALLET = "0x0000000000000000000000000000000000000001";
const FLOOR = 5_000_000n;

const GOOD_RULES = {
  autoJoin: false,
  minimumBountyMicroUsdc: "500000",
  allowedCategories: [],
  blockedCategories: [],
  maxActiveCampaigns: 3,
  minScoutConfidence: "MEDIUM",
  maxAutoJoinsPerDay: null,
};

/** Production legacy shape: onboarded, categorized, but capability columns untouched by Slice 1. */
const LEGACY: CapabilitySeed = {
  userId: "u-legacy",
  handle: "legacy-creator",
  creatorType: null,
  interests: [],
  preferences: [],
  profileCategory: "ai",
  onboardingCompleted: true,
};

const FULL: CapabilitySeed = {
  userId: "u-full",
  handle: "full-creator",
  creatorType: "CREATOR",
  interests: ["ai"],
  preferences: ["referral"],
  profileCategory: "ai",
  onboardingCompleted: true,
};

const INCOMPLETE: CapabilitySeed = {
  ...LEGACY,
  userId: "u-incomplete",
  handle: "incomplete-creator",
  onboardingCompleted: false,
};

const ZERO_HISTORY: HistorySeed = {
  verifiedTotal: 0,
  settledCollaborations: 0,
  activeTermsCount: 0,
};

/** APPROVED + UNFUNDED campaign (no market row) with an APPROVED policy floor. */
function prefundingStore(over: Record<string, unknown> = {}) {
  return {
    async getCampaign() {
      return { id: "c-1", workspaceId: "ws-A", state: "APPROVED" };
    },
    async getWorkspace() {
      return { id: "ws-A", name: "Northstar", category: "ai" };
    },
    async getMembership(_ws: string, userId: string) {
      return userId === "owner-1" ? { userId, workspaceId: "ws-A", role: "ORGANIZATION_OWNER" } : null;
    },
    async getMarket() {
      return null;
    },
    async getCurrentVersion() {
      return {
        version: 1,
        status: "APPROVED",
        bountyFloorMicroUsdc: FLOOR,
        bountyCeilingMicroUsdc: 10_000_000n,
        minQualifyingPurchaseMicroUsdc: null,
        deadline: new Date(NOW.getTime() + 30 * 86_400_000),
        refundHoldSeconds: 3600,
      };
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

function deps(store: ReturnType<typeof prefundingStore>) {
  const { sink, events } = createMemoryAuditSink();
  return { deps: { store: store as never, audit: sink, now: () => NOW }, events };
}

describe("legacy creator discovery (pre-funding)", () => {
  it("legacy persona with null creator_type and empty interests/preferences remains discoverable", async () => {
    const { deps: d } = deps(prefundingStore());
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    expect(report.prefunding).toBe(true);
    expect(report.evaluated).toBe(1);
    expect(report.review.map((m) => m.handle)).toEqual(["legacy-creator"]);
    expect(report.review[0].matchScore).toBe(62);
  });

  it("zero-history creator is provisional LOW confidence, never erased", async () => {
    const { deps: d } = deps(prefundingStore());
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    const m = report.review[0];
    expect(m.confidence).toBe("LOW");
    expect(m.warnings.join(" ")).toMatch(/provisional/);
    expect(m.eligibility).toBe("NOT_ELIGIBLE");
    expect(m.eligibilityReason).toMatch(/Advisory match/);
  });

  it("autoJoin OFF does not remove a creator from matching", async () => {
    const { deps: d } = deps(
      prefundingStore({
        async getPartnerByUserId(userId: string) {
          return { id: `p-${userId}`, userId, payoutWallet: WALLET, categories: [], rulesJson: { ...GOOD_RULES, autoJoin: false } };
        },
      }),
    );
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    expect(report.review).toHaveLength(1);
    expect(report.notEligible).toHaveLength(0);
  });

  it("creator with no partner row and no history is still discoverable (advisory)", async () => {
    const { deps: d } = deps(
      prefundingStore({
        async getPartnerByUserId() {
          return null;
        },
      }),
    );
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    expect(report.evaluated).toBe(1);
    expect(report.review.map((m) => m.handle)).toEqual(["legacy-creator"]);
    expect(report.review[0].confidence).toBe("LOW");
    expect(report.review[0].warnings.join(" ")).toMatch(/no participation history yet/);
    expect(report.review[0].matchScore).toBe(49);
  });

  it("creator with invalid legacy rules is scored on open defaults, not erased", async () => {
    const { deps: d } = deps(
      prefundingStore({
        async getPartnerByUserId(userId: string) {
          return { id: `p-${userId}`, userId, payoutWallet: null, categories: [], rulesJson: { minimumBountyMicroUsdc: "not-a-number" } };
        },
      }),
    );
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    expect(report.evaluated).toBe(1);
    expect(report.review).toHaveLength(1);
    expect(report.review[0].warnings.join(" ")).toMatch(/open defaults/);
  });

  it("optional capability data enriches ranking but its absence never erases the candidate", async () => {
    const { deps: d } = deps(prefundingStore());
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      {
        candidates: [FULL, LEGACY],
        histories: { "u-full": ZERO_HISTORY, "u-legacy": ZERO_HISTORY },
        allowPreview: true,
      },
    );
    expect(report.evaluated).toBe(2);
    const full = report.review.find((m) => m.handle === "full-creator")!;
    const legacy = report.review.find((m) => m.handle === "legacy-creator")!;
    expect(full.matchScore).toBeGreaterThan(legacy.matchScore);
    expect(full.fitScore).toBeGreaterThan(legacy.fitScore);
  });

  it("category fit drives ranking generically — no category is special-cased", async () => {
    const { deps: d } = deps(prefundingStore());
    const fitness: CapabilitySeed = { ...LEGACY, userId: "u-fit", handle: "fitness-creator", profileCategory: "fitness" };
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      {
        candidates: [LEGACY, fitness],
        histories: { "u-legacy": ZERO_HISTORY, "u-fit": ZERO_HISTORY },
        allowPreview: true,
      },
    );
    const legacy = [...report.invite, ...report.review, ...report.skip].find((m) => m.handle === "legacy-creator")!;
    const other = [...report.invite, ...report.review, ...report.skip].find((m) => m.handle === "fitness-creator")!;
    expect(legacy.fitScore).toBeGreaterThan(other.fitScore);
    expect(legacy.reasons.join(" ")).toMatch(/category overlap/);
  });

  it("genuinely incomplete creators stay excluded; live join-readiness still enforced", async () => {
    const { deps: d } = deps(prefundingStore());
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      {
        candidates: [LEGACY, INCOMPLETE],
        histories: { "u-legacy": ZERO_HISTORY, "u-incomplete": ZERO_HISTORY },
        allowPreview: true,
      },
    );
    expect(report.evaluated).toBe(1);
    expect([...report.invite, ...report.review, ...report.skip, ...report.notEligible].map((m) => m.handle)).not.toContain(
      "incomplete-creator",
    );
  });

  it("APPROVED + UNFUNDED campaign matches the legacy creator (Northstar shape)", async () => {
    const { deps: d } = deps(
      prefundingStore({
        async getPartnerByUserId() {
          return null;
        },
      }),
    );
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    expect(report.prefunding).toBe(true);
    expect(report.evaluated).toBe(1);
    expect(report.review[0].recommendedAction).toBe("REVIEW");
    expect(report.publicBountyMicroUsdc).toBe(FLOOR.toString());
  });

  it("fully-populated creator matching is unchanged (proven history still earns INVITE)", async () => {
    const { deps: d } = deps(prefundingStore());
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      {
        candidates: [FULL],
        histories: {
          "u-full": {
            verifiedTotal: 18,
            settledCollaborations: 2,
            activeTermsCount: 0,
            campaignsWithVerified: 2,
            retainedOutcomes: 1,
          },
        },
        allowPreview: true,
      },
    );
    expect(report.invite).toHaveLength(1);
    expect(report.invite[0].confidence).toBe("HIGH");
    expect(report.invite[0].reasons.join(" ")).toMatch(/18 historical verified/);
  });

  it("cold-start reliability snapshot stays Slice-7 compliant (counts, never accusations)", async () => {
    const { deps: d } = deps(prefundingStore());
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    const rel = report.review[0].reliability;
    expect(rel.verifiedOutcomes).toBe(0);
    expect(rel.campaignsWithVerified).toBe(0);
    expect(rel.retainedOutcomes).toBe(0);
    expect(rel.settledCollaborations).toBe(0);
    expect(rel.confidence).toBe("LOW");
    expect(JSON.stringify(rel)).not.toMatch(/fraud|sybil|fake|ban/i);
  });

  it("matching creates no funding, reservation, referral or payout — read-only plus one audit row", async () => {
    const calls: string[] = [];
    const base = prefundingStore();
    const tracking = new Proxy(base, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (typeof v !== "string" && typeof v === "function") {
          return (...a: unknown[]) => {
            calls.push(String(p));
            return (v as (...args: unknown[]) => unknown)(...a);
          };
        }
        return v;
      },
    });
    const { deps: d, events } = deps(tracking as ReturnType<typeof prefundingStore>);
    await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    const READ_METHODS = new Set([
      "getCampaign",
      "getWorkspace",
      "getMembership",
      "getMarket",
      "getCurrentVersion",
      "getPartnerByUserId",
      "listPartnerTerms",
    ]);
    for (const c of calls) expect(READ_METHODS.has(c)).toBe(true);
    expect(calls.some((c) => /insert|create|fund|reserv|payout|referral|rewards/i.test(c))).toBe(false);
    expect(events.filter((e) => (e as { action?: string }).action === "match_engine.run")).toHaveLength(1);
  });

  it("cross-workspace privacy holds: strangers get 403 and DTOs leak nothing", async () => {
    const { deps: d } = deps(prefundingStore());
    await expect(
      findCreatorMatches(
        d,
        { callerUserId: "stranger", campaignId: "c-1" },
        { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      { candidates: [LEGACY], histories: { "u-legacy": ZERO_HISTORY }, allowPreview: true },
    );
    const serialized = JSON.stringify([...report.invite, ...report.review, ...report.skip, ...report.notEligible]);
    expect(serialized).not.toMatch(/wallet|email|rulesJson|payout|secret|token|session/i);
  });

  it("no creator handle and no category is hardcoded in the discovery path", async () => {
    const { deps: d } = deps(prefundingStore());
    // Two synthetic handles prove handle-agnostic behavior (no allowlist).
    const second: CapabilitySeed = { ...LEGACY, userId: "u-second", handle: "second-creator" };
    const report = await findCreatorMatches(
      d,
      { callerUserId: "owner-1", campaignId: "c-1" },
      {
        candidates: [LEGACY, second],
        histories: { "u-legacy": ZERO_HISTORY, "u-second": ZERO_HISTORY },
        allowPreview: true,
      },
    );
    expect(report.evaluated).toBe(2);
    for (const f of [
      "src/server/services/matching.ts",
      "src/server/services/invitations.ts",
      "src/components/app/CreatorMatches.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/bgirl/i);
    }
    const kernel = readFileSync("src/server/services/matching.ts", "utf8");
    expect(kernel).not.toMatch(/['"]ai['"]/);
  });
});

describe("match empty-state copy", () => {
  it("distinguishes no registered creators from no eligible matches", () => {
    expect(matchesEmptyMessage(0, 0)).toMatch(/No registered creators to match yet/);
    expect(matchesEmptyMessage(0, 0)).toMatch(/complete onboarding/);
    expect(matchesEmptyMessage(3, 0)).toBe("No eligible matches for this campaign yet.");
    expect(matchesEmptyMessage(3, 0)).not.toMatch(/onboarding/);
    expect(matchesEmptyMessage(3, 2)).toBeNull();
  });
});
