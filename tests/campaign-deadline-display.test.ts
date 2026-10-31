import { describe, expect, it, vi } from "vitest";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import { createInvitation, listCreatorOpportunities } from "@/server/services/invitations";
import { createMemoryNotificationStore } from "@/server/services/creatorNotifications";
import { formatCalendarDate, formatDate, formatDateTime } from "@/lib/format";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * Campaign deadline display truth (production Northstar shape).
 *
 * The org approves a CALENDAR date (2026-11-30); storage holds end of that
 * day in UTC (2026-11-30T23:59:59.999Z). Rendering that instant in a
 * viewer's local timezone shifts the day (Dec 1 in UTC+1), so date-only
 * business values must format against UTC. Real instants (createdAt,
 * settledAt, verifiedAt) stay timezone-aware. All fixtures are synthetic.
 */

const NORTHSTAR_DEADLINE_ISO = "2026-11-30T23:59:59.999Z";
const NOW = new Date("2026-06-01T12:00:00.000Z");
const WALLET = "0xeBB551653815900D6886d2eeEea2325d86275173";

const dayOpts = { month: "short", day: "numeric", year: "numeric" } as const;
const utcDay = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { ...dayOpts, timeZone: "UTC" }).format(new Date(iso));

describe("calendar-date deadline display", () => {
  it("stored 2026-11-30 end-of-day UTC renders Nov 30, 2026", () => {
    expect(formatCalendarDate(NORTHSTAR_DEADLINE_ISO)).toBe("Nov 30, 2026");
  });

  it("creator opportunity and org campaign render the exact same approved date", () => {
    // Both surfaces receive the same version.deadline ISO; one formatter serves both.
    expect(formatCalendarDate(NORTHSTAR_DEADLINE_ISO)).toBe(utcDay(NORTHSTAR_DEADLINE_ISO));
    expect(formatCalendarDate("2026-12-31T23:59:59.999Z")).toBe("Dec 31, 2026");
    expect(formatCalendarDate(null)).toBe("—");
  });

  it("timezone does not shift date-only values (UTC+10 / UTC-5 / UTC+1 equivalents)", () => {
    // Late-UTC instant: Auckland (UTC+12/+13) local rendering already shows Dec 1.
    const late = "2026-11-30T23:59:59.999Z";
    const auckland = new Intl.DateTimeFormat("en-US", { ...dayOpts, timeZone: "Pacific/Auckland" }).format(new Date(late));
    expect(auckland).toBe("Dec 1, 2026"); // documents the original bug mechanism
    expect(formatCalendarDate(late)).toBe("Nov 30, 2026");
    // Early-UTC instant: New York (UTC-5) local rendering shows the prior day.
    const early = "2026-06-01T01:00:00.000Z";
    const newYork = new Intl.DateTimeFormat("en-US", { ...dayOpts, timeZone: "America/New_York" }).format(new Date(early));
    expect(newYork).toBe("May 31, 2026");
    expect(formatCalendarDate(early)).toBe("Jun 1, 2026");
    // Lagos (UTC+1, creator tz): the exact production shift.
    const lagos = new Intl.DateTimeFormat("en-US", { ...dayOpts, timeZone: "Africa/Lagos" }).format(new Date(late));
    expect(lagos).toBe("Dec 1, 2026");
    expect(formatCalendarDate(late)).toBe("Nov 30, 2026");
  });

  it("timestamp fields remain timezone-aware and unchanged", () => {
    const out = formatDateTime("2026-06-01T12:00:00.000Z");
    expect(out).toMatch(/:/); // still carries a time part
    expect(typeof formatDate("2026-06-01T12:00:00.000Z")).toBe("string");
  });
});

describe("deadline truth end-to-end (no mutation)", () => {
  async function setup() {
    const store = createMemoryCampaignStore({
      memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
      workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Org" }],
      partners: [
        {
          id: "p-1", userId: "creator-1", payoutWallet: WALLET,
          rulesJson: { minBountyMicroUSDC: null, allowedCategories: [], blockedCategories: [], maxActiveCampaigns: 3, autoJoin: false, autoNegotiate: false, maxAllocation: null, minScoutConfidence: "MEDIUM", maxAutoJoinsPerDay: null },
        },
      ],
    });
    await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "APPROVED", createdByUserId: "owner-1" });
    await store.insertVersion({
      id: "v-1", campaignId: "c-1", version: 1, intentText: "Get 5 paying customers",
      status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 50_000_000n,
      bountyFloorMicroUsdc: 500_000n, bountyCeilingMicroUsdc: 10_000_000n,
      minQualifyingPurchaseMicroUsdc: null, deadline: new Date(NORTHSTAR_DEADLINE_ISO),
      marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
    });
    const { sink } = createMemoryAuditSink();
    const deps = { store, audit: sink, now: () => NOW, notifications: createMemoryNotificationStore() } as never;
    return { store, deps };
  }

  it("invitation DTO preserves the stored deadline ISO; display renders the approved date", async () => {
    const { store, deps } = await setup();
    const res = await createInvitation(
      deps,
      { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-1" },
      {
        candidate: { userId: "creator-1", handle: "deadline-creator", creatorType: null, interests: [], preferences: [], profileCategory: "ai", onboardingCompleted: true },
        history: { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 },
        offeredBountyMicroUsdc: "5000000",
      },
    );
    expect(res.invitation.offered.bountyMicroUsdc).toBe("5000000"); // frozen economics untouched
    const opps = await listCreatorOpportunities(deps, { creatorUserId: "creator-1" });
    expect(opps).toHaveLength(1);
    expect(opps[0].campaign.deadline).toBe(new Date(NORTHSTAR_DEADLINE_ISO).toISOString());
    expect(formatCalendarDate(opps[0].campaign.deadline)).toBe("Nov 30, 2026");
    // The stored policy row is untouched — the existing row needs no mutation.
    const version = await store.getVersion("c-1", 1);
    expect(version?.deadline?.toISOString()).toBe(NORTHSTAR_DEADLINE_ISO);
    // Display pass created no participation, referral, payout or reservation.
    expect(await store.listPartnerTerms("p-1")).toHaveLength(0);
    expect(await store.getReferralByCode("anything")).toBeNull();
  });
});
