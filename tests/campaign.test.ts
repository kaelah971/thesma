import { describe, expect, it } from "vitest";
import {
  analyzePolicyFields,
  assertS1Transition,
  campaignFieldOverridesSchema,
} from "@/server/domain/campaign";
import { LocalIntentInterpreter } from "@/server/services/intent";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  approvePolicy,
  createDraft,
  getCampaign,
  listWorkspaceCampaigns,
  moveToReview,
  reviseDraft,
  type CampaignDeps,
} from "@/server/services/campaigns";

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const FUTURE_DEADLINE = "2026-12-31T23:59:59.999Z";

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "member-2", workspaceId: "ws-A", role: "ORGANIZATION_MEMBER" },
    ],
  });
  const { sink, events } = createMemoryAuditSink();
  const deps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  return { store, events, deps };
}

async function completeDraft(deps: CampaignDeps, userId = "owner-1", overrides: Record<string, unknown> = {}) {
  return createDraft(deps, {
    workspaceId: "ws-A",
    userId,
    intentText: CANONICAL,
    overrides: {
      bountyFloorMicroUsdc: "2000000",
      deadline: FUTURE_DEADLINE,
      ...overrides,
    } as never,
  });
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

describe("intent interpreter (deterministic, provider-agnostic)", () => {
  it("turns the canonical demo sentence into the expected structured draft", async () => {
    const r = await new LocalIntentInterpreter().interpret({ text: CANONICAL });
    expect(r.fields.targetOutcomeCount).toBe(5);
    expect(r.fields.budgetMicroUsdc).toBe("15000000");
    expect(r.fields.bountyCeilingMicroUsdc).toBe("4000000");
    expect(r.fields.minQualifyingPurchaseMicroUsdc).toBe("10000000");
    expect(r.missing).toEqual(["bountyFloorMicroUsdc", "deadline"]);
    expect(r.notes.some((n) => /relative date/i.test(n))).toBe(true);
  });

  it("returns every required field as missing for an empty objective", async () => {
    const r = await new LocalIntentInterpreter().interpret({ text: "hello" });
    expect(r.missing).toEqual([
      "targetOutcomeCount",
      "budgetMicroUsdc",
      "bountyFloorMicroUsdc",
      "bountyCeilingMicroUsdc",
      "minQualifyingPurchaseMicroUsdc",
      "deadline",
    ]);
  });

  it("never throws on surplus-precision money; leaves the field missing instead", async () => {
    const r = await new LocalIntentInterpreter().interpret({ text: "Get 5 customers. Budget 15.1234567 USDC." });
    expect(r.fields.budgetMicroUsdc).toBeUndefined();
    expect(r.missing).toContain("budgetMicroUsdc");
  });

  it("parses explicit ISO deadlines and floor phrasing without guessing", async () => {
    const r = await new LocalIntentInterpreter().interpret({
      text: "Get 3 customers. Budget 10 USDC. Max 4 USDC. Floor 2 USDC. Only purchases of at least 10 USDC count. Deadline 2026-12-31.",
    });
    expect(r.fields.targetOutcomeCount).toBe(3);
    expect(r.fields.bountyFloorMicroUsdc).toBe("2000000");
    expect(r.fields.minQualifyingPurchaseMicroUsdc).toBe("10000000");
    expect(r.fields.deadline).toBe("2026-12-31T23:59:59.999Z");
    expect(r.missing).toEqual([]);
  });
});

describe("policy validation (pure, deterministic)", () => {
  it("rejects malformed money at the wire boundary", () => {
    expect(campaignFieldOverridesSchema.safeParse({ budgetMicroUsdc: "2.5" }).success).toBe(false);
    expect(campaignFieldOverridesSchema.safeParse({ budgetMicroUsdc: "-100" }).success).toBe(false);
    expect(campaignFieldOverridesSchema.safeParse({ targetOutcomeCount: -1 }).success).toBe(false);
    expect(campaignFieldOverridesSchema.safeParse({ targetOutcomeCount: 1.5 }).success).toBe(false);
    expect(campaignFieldOverridesSchema.safeParse({ budgetMicroUsdc: "15000000" }).success).toBe(true);
  });

  it("rejects floor above ceiling and unaffordable minimum economics", () => {
    const range = analyzePolicyFields({
      targetOutcomeCount: 5,
      budgetMicroUsdc: 15_000_000n,
      bountyFloorMicroUsdc: 5_000_000n,
      bountyCeilingMicroUsdc: 4_000_000n,
      minQualifyingPurchaseMicroUsdc: 10_000_000n,
      deadline: new Date("2026-12-31T00:00:00Z"),
      marketVisibility: "PUBLIC",
      allowedPartnerRulesJson: {},
      refundHoldSeconds: 0,
      escalationRulesJson: {},
    });
    expect(range.issues.some((i) => i.code === "RANGE")).toBe(true);

    const broke = analyzePolicyFields({
      targetOutcomeCount: 5,
      budgetMicroUsdc: 15_000_000n,
      bountyFloorMicroUsdc: 4_000_000n, // 5 x 4 = 20 > 15 budget
      bountyCeilingMicroUsdc: 4_000_000n,
      minQualifyingPurchaseMicroUsdc: 10_000_000n,
      deadline: new Date("2026-12-31T00:00:00Z"),
      marketVisibility: "PUBLIC",
      allowedPartnerRulesJson: {},
      refundHoldSeconds: 0,
      escalationRulesJson: {},
    });
    expect(broke.issues.some((i) => i.code === "UNAFFORDABLE")).toBe(true);
  });

  it("S1 transitions allow DRAFT->REVIEW->APPROVED only; FUNDING/LIVE are unreachable", () => {
    expect(() => assertS1Transition("DRAFT", "REVIEW")).not.toThrow();
    expect(() => assertS1Transition("REVIEW", "APPROVED")).not.toThrow();
    expect(() => assertS1Transition("DRAFT", "APPROVED")).toThrow();
    for (const target of ["FUNDING", "LIVE", "PAUSED", "CLOSING", "CLOSED"] as const) {
      expect(() => assertS1Transition("DRAFT", target)).toThrow();
      expect(() => assertS1Transition("REVIEW", target)).toThrow();
      expect(() => assertS1Transition("APPROVED", target)).toThrow();
    }
  });
});

describe("campaign service (workspace-isolated, owner-approved)", () => {
  it("DRAFT -> REVIEW -> APPROVED works and records approver + timestamp", async () => {
    const { deps } = setup();
    const d = await completeDraft(deps);
    expect(d.campaign.state).toBe("DRAFT");
    expect(d.version.version).toBe(1);

    const r = await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    expect(r.campaign.state).toBe("REVIEW");
    expect(r.version.status).toBe("REVIEW");

    const a = await approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    expect(a.campaign.state).toBe("APPROVED");
    expect(a.version.status).toBe("APPROVED");
    expect(a.version.approvedByUserId).toBe("owner-1");
    expect(a.version.approvedAt).toEqual(FIXED_NOW);
  });

  it("blocks review while required fields are missing, naming them explicitly", async () => {
    const { deps } = setup();
    const d = await createDraft(deps, { workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL });
    expect(d.missing).toContain("bountyFloorMicroUsdc");
    const err = await fails(moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 }));
    expect(err.status).toBe(400);
    expect(err.details.missing).toContain("bountyFloorMicroUsdc");
  });

  it("rejects a DRAFT -> APPROVED jump: review is required", async () => {
    const { deps } = setup();
    const d = await completeDraft(deps);
    const err = await fails(approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 }));
    expect(err.status).toBe(400);
  });

  it("non-owner cannot approve; member may draft and request review", async () => {
    const { deps } = setup();
    const d = await completeDraft(deps, "member-2");
    const r = await moveToReview(deps, { campaignId: d.campaign.id, userId: "member-2", expectedVersion: 1 });
    expect(r.version.status).toBe("REVIEW");
    const err = await fails(approvePolicy(deps, { campaignId: d.campaign.id, userId: "member-2", expectedVersion: 1 }));
    expect(err.status).toBe(403);
  });

  it("denies cross-workspace access", async () => {
    const { deps } = setup();
    const d = await completeDraft(deps);
    const err = await fails(getCampaign(deps, { campaignId: d.campaign.id, userId: "outsider-9" }));
    expect(err.status).toBe(403);
    const listErr = await fails(listWorkspaceCampaigns(deps, { workspaceId: "ws-A", userId: "outsider-9" }));
    expect(listErr.status).toBe(403);
  });

  it("approved policy is immutable: revision creates a new version", async () => {
    const { store, deps } = setup();
    const d = await completeDraft(deps);
    await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });

    const rev = await reviseDraft(deps, {
      campaignId: d.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
      patch: { budgetMicroUsdc: "20000000" },
    });
    expect(rev.createdNewVersion).toBe(true);
    expect(rev.version.version).toBe(2);
    expect(rev.version.status).toBe("DRAFT");
    expect(rev.campaign.state).toBe("DRAFT");

    const v1 = await store.getVersion(d.campaign.id, 1);
    expect(v1?.status).toBe("APPROVED");
    expect(v1?.budgetMicroUsdc).toBe(15_000_000n); // untouched
    expect(rev.version.budgetMicroUsdc).toBe(20_000_000n);
  });

  it("rejects stale version writes", async () => {
    const { deps } = setup();
    const d = await completeDraft(deps);
    const err = await fails(
      reviseDraft(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 99, patch: { targetOutcomeCount: 7 } }),
    );
    expect(err.status).toBe(409);
    await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    const stale = await fails(approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 99 }));
    expect(stale.status).toBe(409);
  });

  it("repeated approval is idempotent, not duplicated", async () => {
    const { events, deps } = setup();
    const d = await completeDraft(deps);
    await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    const first = await approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    expect(first.alreadyApproved).toBe(false);
    const count = events.length;
    const second = await approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    expect(second.alreadyApproved).toBe(true);
    expect(events.length).toBe(count); // no duplicate audit event
  });

  it("rejects approval once the deadline has passed", async () => {
    const { deps } = setup();
    const d = await completeDraft(deps, "owner-1", { deadline: "2026-01-02T00:00:00.000Z" });
    await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    const late: CampaignDeps = { ...deps, now: () => new Date("2026-07-01T00:00:00.000Z") };
    const err = await fails(approvePolicy(late, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 }));
    expect(err.status).toBe(400);
    expect(err.details.issues.some((i: { code: string }) => i.code === "EXPIRED")).toBe(true);
  });

  it("revision from REVIEW returns the policy to DRAFT", async () => {
    const { deps } = setup();
    const d = await completeDraft(deps);
    await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    const rev = await reviseDraft(deps, {
      campaignId: d.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
      patch: { refundHoldSeconds: 3600 },
    });
    expect(rev.createdNewVersion).toBe(false);
    expect(rev.version.status).toBe("DRAFT");
    expect(rev.campaign.state).toBe("DRAFT");
  });

  it("emits all five audit actions with policy version IDs in metadata", async () => {
    const { events, deps } = setup();
    const d = await completeDraft(deps);
    await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await reviseDraft(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, patch: { targetOutcomeCount: 6 } });
    // revise the new DRAFT version in place -> draft_revised
    await reviseDraft(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 2, patch: { refundHoldSeconds: 60 } });

    const actions = events.map((e) => e.action);
    expect(actions).toEqual([
      "campaign.created",
      "campaign.review_requested",
      "campaign.policy_approved",
      "campaign.policy_revision_created",
      "campaign.draft_revised",
    ]);
    for (const e of events) {
      expect(e.metadata.campaignId).toBe(d.campaign.id);
      expect(typeof e.metadata.policyVersionId).toBe("string");
      expect(typeof e.metadata.version).toBe("number");
    }
  });

  it("no flow in this slice reaches FUNDING/LIVE or moves money", async () => {
    const { store, deps } = setup();
    const d = await completeDraft(deps);
    await moveToReview(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    const a = await approvePolicy(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    expect(["DRAFT", "REVIEW", "APPROVED"]).toContain(a.campaign.state);
    const versions = store.versions.get(d.campaign.id) ?? [];
    for (const v of versions) {
      expect(["DRAFT", "REVIEW", "APPROVED"]).toContain(v.status);
      expect(v.approvedByUserId === null).toBe(v.status !== "APPROVED");
    }
  });
});
