import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import { findCreatorMatches } from "@/server/services/matching";
import {
  acceptInvitation,
  createInvitation,
  listCreatorInvitations,
} from "@/server/services/invitations";
import { invitationDeal } from "@/server/services/deals";
import { loadCreatorReliability } from "@/server/services/reliability";
import { loadCfoSnapshot, buildCapitalPlan } from "@/server/services/cfo";
import { evaluateVerificationCheck } from "@/server/services/verificationProcurement";
import { queryLedger, summarizeAutonomy, deriveEscalations, type LedgerAuditRow } from "@/server/services/autonomy";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;
const M = 1_000_000n;
const WALLET = "0xeBB551653815900D6886d2eeEea2325d86275173";

const RULES_MANUAL = {
  autoJoin: false, minimumBountyMicroUsdc: "1000000", allowedCategories: [],
  blockedCategories: [], maxActiveCampaigns: 3, minScoutConfidence: "LOW", maxAutoJoinsPerDay: null,
};
const RULES_AUTO = { ...RULES_MANUAL, autoJoin: true };

async function workshop() {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "owner-9", workspaceId: "ws-B", role: "ORGANIZATION_OWNER" },
    ],
    workspaces: [
      { id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Acme" },
      { id: "ws-B", ownerUserId: "owner-9", companyWallet: null, category: "ai", name: "Other" },
    ],
    partners: [
      { id: "p-manual", userId: "creator-manual", payoutWallet: WALLET, rulesJson: RULES_MANUAL },
      { id: "p-auto", userId: "creator-auto", payoutWallet: WALLET, rulesJson: RULES_AUTO },
      { id: "p-legacy", userId: "creator-legacy", payoutWallet: WALLET, rulesJson: RULES_MANUAL },
    ],
  });
  for (const [cid, ws] of [["c-1", "ws-A"], ["c-2", "ws-A"]] as const) {
    await store.insertCampaign({ id: cid, workspaceId: ws, state: "LIVE", createdByUserId: "owner-1" });
    await store.insertMarket({
      campaignId: cid, publicBountyMicroUsdc: 4n * M, status: "OPEN",
      destinationUrl: "https://acme.example/offer", version: 1, policyVersion: 1,
    });
    await store.insertVersion({
      id: `v-${cid}`, campaignId: cid, version: 1, intentText: "Get paying customers",
      status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 200n * M,
      bountyFloorMicroUsdc: 1n * M, bountyCeilingMicroUsdc: 8n * M,
      minQualifyingPurchaseMicroUsdc: 1n * M, deadline: new Date(NOW.getTime() + 30 * DAY),
      marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
    });
    await store.insertFunding({
      id: `f-${cid}`, campaignId: cid, policyVersionId: `v-${cid}`, policyVersion: 1,
      campaignKey: `0xk-${cid}`, policyHash: "0xh", chainId: 1, vaultAddress: "0xv",
      usdcAddress: "0xu", ownerAddress: "0xo", expectedAmountMicroUsdc: 100n * M,
    });
    await store.updateFunding(cid, 1, { status: "CONFIRMED", observedAmountMicroUsdc: 100n * M });
  }
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

function seed(userId: string) {
  return {
    userId, handle: userId, creatorType: "CREATOR" as const, interests: ["ai"],
    preferences: ["referral"], profileCategory: "ai", onboardingCompleted: true,
  };
}
const HIST = { verifiedTotal: 2, settledCollaborations: 0, activeTermsCount: 0, campaignsWithVerified: 1, retainedOutcomes: 0 };

function snap() {
  return {
    candidates: [{
      facts: {
        campaignId: "c-1", workspaceName: "Acme", objective: "Get customers", category: "ai",
        bountyMicroUsdc: (4n * M).toString(), targetOutcomeCount: 10, verifiedOutcomes: 0,
        deadline: new Date(NOW.getTime() + 10 * DAY),
        campaignState: "LIVE", marketStatus: "OPEN", minQualifyingMicroUsdc: (1n * M).toString(), holdSeconds: 3600,
        alreadyJoined: false, referralPath: null, creatorVerifiedTotal: 0, creatorVerifiedRecent: 0,
        creatorActions: 0, creatorSettledTotalMicroUsdc: "0", paceStatus: null,
      },
      eligibility: "ELIGIBLE", eligibilityReason: "ok", score: 80, rank: 1,
      decision: "RECOMMEND", reason: "Strong match", confidence: "HIGH", evidenceUsed: [],
      earningsEstimateMicroUsdc: null, earningsNote: "",
    }],
    plan: { topOpportunities: [], watchlist: [], joined: [], notEligible: [], summary: "" },
  } as never;
}

describe("10A integrated marketplace rehearsal (Slices 1–9, memory store)", () => {
  it("org match → frozen invite → inbox → manual accept → participation + referral, no money moved", async () => {
    const { store, sink } = await workshop();
    const deps = { store, audit: sink, now: () => NOW };
    const report = await findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-1" }, {
      candidates: [seed("creator-manual"), seed("creator-auto")],
      histories: { "creator-manual": HIST, "creator-auto": HIST },
    });
    expect(report.evaluated).toBe(2);
    expect(report.invite.length + report.review.length).toBeGreaterThan(0);
    const why = [...report.invite, ...report.review][0];
    expect(why.reasons.length).toBeGreaterThan(0);
    expect(why.reliability).toBeDefined();

    const inv = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST });
    expect(inv.invitation.status).toBe("INVITED");
    const inbox = await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "creator-manual" });
    expect(inbox.some((i) => i.id === inv.invitation.id)).toBe(true);

    const acc = await acceptInvitation(deps, { creatorUserId: "creator-manual", invitationId: inv.invitation.id });
    expect(acc.invitation.status).toBe("ACCEPTED");
    expect(acc.participation.priceMicroUsdc).toBe((4n * M).toString());
    expect(acc.referral.code.length).toBeGreaterThan(0);
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
    expect(await store.getPayoutByOutcome("nope")).toBeNull();
  });

  it("auto-join agent accepts once: one participation, one referral, deduped notification", async () => {
    const { store, sink } = await workshop();
    const { createMemoryNotificationStore } = await import("@/server/services/creatorNotifications");
    const deps = { store, audit: sink, now: () => NOW, notifications: createMemoryNotificationStore() };
    const inv = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-auto" }, { candidate: seed("creator-auto"), history: HIST, snapshot: snap(), joinsToday: 0 });
    expect(inv.invitation.status).toBe("ACCEPTED");
    expect(inv.invitation.acceptedBy).toBe("AGENT");
    expect(await store.listPartnerTerms("p-auto")).toHaveLength(1);
    expect(await store.getReferralByTerms((await store.listPartnerTerms("p-auto"))[0].id)).not.toBeNull();
  });

  it("hybrid offer freezes exposure, accepts without paying, stays unsupported onchain", async () => {
    const { store, sink } = await workshop();
    const deps = { store, audit: sink, now: () => NOW };
    const deal = {
      structure: "BASE_PLUS_PERFORMANCE" as const,
      baseAmountMicroUsdc: (25n * M).toString(),
      deliverable: { kind: "content", title: "Launch video" },
      performanceBountyMicroUsdc: (4n * M).toString(),
      allocationCount: 5,
    };
    const inv = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST, deal });
    const frozen = invitationDeal(inv.invitation.offered.bonus)!;
    expect(frozen.structure).toBe("BASE_PLUS_PERFORMANCE");
    const acc = await acceptInvitation(deps, { creatorUserId: "creator-manual", invitationId: inv.invitation.id });
    const stored = await store.getHybridDealByTerms(acc.participation.termsId);
    expect(stored?.baseStatus).toBe("PENDING");
    expect(await store.listReservationsByCampaign("c-1")).toHaveLength(0);
  });

  it("reliability + retention + CFO reconcile on the same history", async () => {
    const { store, sink } = await workshop();
    // Two VERIFIED outcomes, same subject 10 days apart → D7 qualified.
    for (const [id, days] of [["o-r1", 30], ["o-r2", 20]] as const) {
      await store.insertOutcome({
        id, campaignId: "c-1", partnerId: "p-manual", partnerTermsId: "t-1",
        checkoutIntentId: `ci-${id}`, customerKeyHash: "ck-same", purchaseTx: `0x${id}`,
        purchaseAmountMicroUsdc: 10n * M,
      });
      await store.updateOutcome(id, { status: "VERIFIED", verifiedAt: new Date(NOW.getTime() - days * DAY) });
    }
    const rel = await loadCreatorReliability(store, "creator-manual", NOW);
    expect(rel.verifiedOutcomes).toBe(2);
    expect(rel.retainedOutcomes).toBe(1);
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW });
    expect(snapshot.campaigns).toHaveLength(2);
    const plan = await buildCapitalPlan(snapshot, {
      store,
      growthPolicy: { optimizationEnabled: false, maxBountyChangePct: 25, minimumEvidence: 5, evaluationWindowDays: 7 },
      operatorPolicy: { minReserveMicroUsdc: 0n, maxAutonomousPaymentMicroUsdc: 10n * M, maxAutonomousSpendPerPeriodMicroUsdc: null },
      now: NOW,
    });
    const allocated = plan.campaigns.reduce((s, c) => s + BigInt(c.recommendedNewAllocationMicroUsdc), 0n);
    expect(allocated + BigInt(plan.totals.unallocatedMicroUsdc)).toBe(BigInt(plan.totals.deployableMicroUsdc));
    expect(plan.chainMovement).toBe("UNAVAILABLE");
  });

  it("verification procurement runs the full local x402 loop without touching payouts", async () => {
    const { store, sink, events } = await workshop();
    await store.insertOutcome({
      id: "o-v1", campaignId: "c-1", partnerId: "p-manual", partnerTermsId: "t-1",
      checkoutIntentId: "ci-v1", customerKeyHash: "ck-v1", purchaseTx: "0xv1",
      purchaseAmountMicroUsdc: 10n * M,
    });
    await store.updateOutcome("o-v1", { status: "VERIFIED", verifiedAt: new Date(NOW.getTime() - 20 * DAY) });
    await store.insertOutcome({
      id: "o-v2", campaignId: "c-1", partnerId: "p-manual", partnerTermsId: "t-1",
      checkoutIntentId: "ci-v2", customerKeyHash: "ck-v2", purchaseTx: "0xv2",
      purchaseAmountMicroUsdc: 10n * M,
    });
    await store.updateOutcome("o-v2", { status: "REJECTED", rejectionCode: "DUPLICATE_TX" });
    await store.insertReservation({ id: "r-v1", campaignId: "c-1", outcomeId: "o-v1", partnerId: "p-manual", partnerTermsId: "t-1", amountMicroUsdc: 4n * M, policyVersionId: "v-1" });
    await store.setProcurementPolicy({
      workspaceId: "ws-A", enabled: true, maxCostPerCheckMicroUsdc: 2n * M,
      maxSpendPerPeriodMicroUsdc: 10n * M, periodDays: 365, maxCostBpsOfExposure: 200,
      allowedProvidersJson: ["local-test"], allowedCheckTypesJson: ["DUPLICATE_PAYMENT_REFERENCE", "PAYMENT_REFERENCE_CHECK", "ATTRIBUTION_INTEGRITY"],
      humanApprovalThresholdMicroUsdc: null, updatedByUserId: null,
    });
    const key = generatePrivateKey();
    const env = { ...process.env, THESMA_PROCUREMENT_PRIVATE_KEY: key, THESMA_PROCUREMENT_ADDRESS: privateKeyToAccount(key).address, NODE_ENV: "test" } as NodeJS.ProcessEnv;
    const out = await evaluateVerificationCheck({ store, audit: sink, now: () => NOW, env }, { workspaceId: "ws-A", campaignId: "c-1" });
    expect(["BUY_CHECK", "ESCALATE", "REFUSE", "NO_CHECK"]).toContain(out.decision.decision);
    if (out.decision.decision === "BUY_CHECK") {
      expect(out.execution.purchased).toBe(true);
      expect(["CHECK_CLEAR", "RISK_SIGNAL", "INCONCLUSIVE"]).toContain(out.execution.result?.result);
    }
    // No payout or reservation created or mutated by procurement evaluation.
    expect(await store.getPayoutByOutcome("o-v1")).toBeNull();
    expect(events.filter((e) => (e as { action?: string }).action === "verification.procurement.purchased")).toHaveLength(out.execution.purchased ? 1 : 0);
  });

  it("autonomy ledger normalizes the rehearsal trail deterministically", () => {
    const rows: LedgerAuditRow[] = [
      { id: "a1", actorType: "USER", actorId: "owner-1", workspaceId: "ws-A", partnerId: null, action: "match_engine.run", targetType: "campaign", targetId: "c-1", metadata: { campaignId: "c-1", evaluated: 2 }, createdAt: "2026-06-01T12:00:00.000Z" },
      { id: "a2", actorType: "SYSTEM", actorId: null, workspaceId: "ws-A", partnerId: null, action: "creator.invitation.agent_evaluated", targetType: "invitation", targetId: "i-1", metadata: { campaignId: "c-1", creatorUserId: "creator-auto", invitationId: "i-1", result: "AUTO_ACCEPT", rule: "AUTO_JOIN", frozenBountyMicroUsdc: "4000000", reasons: ["ok"] }, createdAt: "2026-06-01T12:01:00.000Z" },
      { id: "a3", actorType: "SYSTEM", actorId: null, workspaceId: "ws-A", partnerId: "p-auto", action: "creator.invitation.accepted", targetType: "invitation", targetId: "i-1", metadata: { mode: "AGENT", campaignId: "c-1", creatorUserId: "creator-auto", invitationId: "i-1", offeredBountyMicroUsdc: "4000000", termsId: "t-9" }, createdAt: "2026-06-01T12:02:00.000Z" },
      { id: "a4", actorType: "AGENT", actorId: null, workspaceId: "ws-A", partnerId: null, action: "cfo.plan.generated", targetType: "workspace", targetId: "ws-A", metadata: { campaignId: "c-1" }, createdAt: "2026-06-01T12:03:00.000Z" },
      { id: "a5", actorType: "AGENT", actorId: null, workspaceId: "ws-A", partnerId: null, action: "verification.procurement.evaluated", targetType: "outcome", targetId: "o-1", metadata: { campaignId: "c-1", outcomeId: "o-1", decision: "NO_CHECK", reasons: ["low exposure"] }, createdAt: "2026-06-01T12:04:00.000Z" },
    ];
    const { decisions, total } = queryLedger(rows, { workspaceId: "ws-A" });
    expect(total).toBe(5);
    const byAction = Object.fromEntries(decisions.map((d) => [d.provenance.action, d]));
    expect(byAction["creator.invitation.accepted"].executionState).toBe("EXECUTED");
    expect(byAction["creator.invitation.accepted"].authorityState).toBe("AUTONOMOUS_ALLOWED");
    expect(byAction["cfo.plan.generated"].executionState).toBe("PROPOSED");
    expect(byAction["verification.procurement.evaluated"].authorityState).toBe("ADVISORY");
    expect(queryLedger([...rows].reverse(), { workspaceId: "ws-A" }).decisions).toEqual(decisions);
    const m = summarizeAutonomy(decisions);
    expect(m.creatorAutoAccepts).toBe(1);
    expect(m.autonomousExecutions).toBeGreaterThanOrEqual(1);
    const esc = deriveEscalations(decisions, Date.parse("2026-06-02T00:00:00Z"));
    expect(Array.isArray(esc)).toBe(true);
  });

  it("legacy shapes stay valid: capability-less persona, minimal rules, performance-only terms", async () => {
    const { store, sink } = await workshop();
    // Legacy creator: no capability fields anywhere in this seed.
    const legacySeed = { userId: "creator-legacy", handle: "legacy", creatorType: "CREATOR" as const, interests: [], preferences: [], profileCategory: null, onboardingCompleted: true };
    const report = await findCreatorMatches({ store, audit: sink, now: () => NOW }, { callerUserId: "owner-1", campaignId: "c-1" }, {
      candidates: [legacySeed],
      histories: { "creator-legacy": { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 } },
    });
    expect(report.evaluated).toBe(1);
    // Minimal legacy rules JSON parses and governs.
    const { parsePartnerRules } = await import("@/server/domain/market");
    const parsed = parsePartnerRules({ autoJoin: false });
    expect(parsed.ok).toBe(true);
    // Performance-only invite carries no deal and creates no hybrid row.
    const inv = await createInvitation({ store, audit: sink, now: () => NOW }, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-legacy" }, {
      candidate: { ...legacySeed, profileCategory: "ai", interests: ["ai"] },
      history: { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 },
    });
    expect(invitationDeal(inv.invitation.offered.bonus)).toBeNull();
  });

  it("Aster/Beaconfield-style legacy public rendering needs no new columns", async () => {
    const { store } = await workshop();
    // Legacy VERIFIED outcome on a public campaign, zero Slice 6–9 rows anywhere.
    await store.insertOutcome({
      id: "o-proof", campaignId: "c-1", partnerId: "p-manual", partnerTermsId: "t-1",
      checkoutIntentId: "ci-proof", customerKeyHash: "ck-proof", purchaseTx: "0xproof",
      purchaseAmountMicroUsdc: 900000n,
    });
    await store.updateOutcome("o-proof", { status: "VERIFIED", verifiedAt: new Date(NOW.getTime() - 5 * DAY) });
    const campaign = await store.getCampaign("c-1");
    const market = await store.getMarket("c-1");
    const version = await store.getVersion("c-1", 1);
    // Public market card fields resolve from legacy-shaped rows alone.
    expect(campaign?.state).toBe("LIVE");
    expect(market?.publicBountyMicroUsdc).toBe(4n * M);
    expect(version?.marketVisibility).toBe("PUBLIC");
    const verified = (await store.listOutcomesByStatus("VERIFIED", 10)).filter((o) => o.campaignId === "c-1");
    expect(verified.length).toBeGreaterThan(0);
    // No hybrid/retention/verification rows exist, yet nothing crashes.
    expect(await store.listHybridDealsByCampaign("c-1")).toHaveLength(0);
    expect(await store.listProcurementsByCampaign("c-1")).toHaveLength(0);
  });
});

describe("10A authorization matrix (service-level, memory store)", () => {
  it("cross-workspace and cross-creator access is denied or scoped", async () => {
    const { store, sink } = await workshop();
    const deps = { store, audit: sink, now: () => NOW };
    // ORG A cannot invite from ORG B campaign (no membership).
    await store.insertCampaign({ id: "c-b", workspaceId: "ws-B", state: "LIVE", createdByUserId: "owner-9" });
    await store.insertMarket({
      campaignId: "c-b", publicBountyMicroUsdc: 4n * M, status: "OPEN",
      destinationUrl: "https://other.example/offer", version: 1, policyVersion: 1,
    });
    await store.insertVersion({
      id: "v-b", campaignId: "c-b", version: 1, intentText: "Other campaign",
      status: "APPROVED", targetOutcomeCount: 5, budgetMicroUsdc: 50n * M,
      bountyFloorMicroUsdc: 1n * M, bountyCeilingMicroUsdc: 8n * M,
      minQualifyingPurchaseMicroUsdc: 1n * M, deadline: new Date(NOW.getTime() + 30 * DAY),
      marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
    });
    await expect(findCreatorMatches(deps, { callerUserId: "owner-1", campaignId: "c-b" }, { candidates: [], histories: {} })).rejects.toMatchObject({ status: 403 });
    // Outsider cannot invite at all.
    await expect(createInvitation(deps, { callerUserId: "stranger", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST })).rejects.toMatchObject({ status: 403 });
    // CREATOR A cannot accept CREATOR B invitation.
    const inv = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST });
    await expect(acceptInvitation(deps, { creatorUserId: "creator-auto", invitationId: inv.invitation.id })).rejects.toMatchObject({ status: 403 });
    // CREATOR B inbox is empty of A's invitation.
    const inboxB = await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "creator-auto" });
    expect(inboxB.some((i) => i.id === inv.invitation.id)).toBe(false);
    // ORG B ledger/campaign reads return nothing for ws-A objects.
    const { listCampaignProcurements } = await import("@/server/services/verificationProcurement");
    expect(await listCampaignProcurements(store, { workspaceId: "ws-B", campaignId: "c-1" })).toHaveLength(0);
    // Verification for another org's campaign is rejected.
    await expect(evaluateVerificationCheck(deps, { workspaceId: "ws-B", campaignId: "c-1" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("10A privacy scan (DTOs never leak secrets)", () => {
  it("invitation, autonomy and public DTOs carry no private material", async () => {
    const { store, sink } = await workshop();
    const deps = { store, audit: sink, now: () => NOW };
    const inv = await createInvitation(deps, { callerUserId: "owner-1", campaignId: "c-1", creatorUserId: "creator-manual" }, { candidate: seed("creator-manual"), history: HIST });
    const inbox = await listCreatorInvitations({ store, audit: sink }, { creatorUserId: "creator-manual" });
    const { listCampaignProcurements } = await import("@/server/services/verificationProcurement");
    const procs = await listCampaignProcurements(store, { workspaceId: "ws-A", campaignId: "c-1" });
    const blob = JSON.stringify({ inv: inv.invitation, inbox, procs });
    expect(blob).not.toMatch(/wallet|email|secret|privateKey|mnemonic|session|token|rulesJson/i);
    expect(blob).not.toContain(WALLET.toLowerCase());
  });
});
