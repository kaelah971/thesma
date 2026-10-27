import { describe, expect, it } from "vitest";
import {
  buildCreatorAutonomy,
  buildOrganizationLadder,
  deriveEscalations,
  normalizeAuditRow,
  queryLedger,
  summarizeAutonomy,
  type LedgerAuditRow,
} from "@/server/services/autonomy";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let n = 0;
function row(action: string, metadata: Record<string, unknown> = {}, over: Partial<LedgerAuditRow> = {}): LedgerAuditRow {
  n += 1;
  return {
    id: `evt-${n}`,
    actorType: "SYSTEM",
    actorId: null,
    workspaceId: "ws-A",
    partnerId: null,
    action,
    targetType: "outcome",
    targetId: `t-${n}`,
    metadata,
    createdAt: new Date(Date.UTC(2026, 5, 1, 12, 0, n)).toISOString(),
    ...over,
  };
}

describe("authority views derive from existing policy", () => {
  it("creator view derives strictly from Scout rules", () => {
    const on = buildCreatorAutonomy({
      autoJoin: true, minimumBountyMicroUsdc: 4000000n, minScoutConfidence: "HIGH",
      maxActiveCampaigns: 3, maxAutoJoinsPerDay: 2, blockedCategories: ["crypto"], allowedCategories: [],
    });
    expect(on.directInvitations).toBe("AUTO");
    expect(on.minimumBountyMicroUsdc).toBe("4000000");
    expect(on.hybridOffers).toBe("REVIEW_REQUIRED");
    const off = buildCreatorAutonomy({ autoJoin: false, minimumBountyMicroUsdc: 0n, minScoutConfidence: "LOW", maxActiveCampaigns: null, maxAutoJoinsPerDay: null, blockedCategories: [], allowedCategories: [] });
    expect(off.directInvitations).toBe("MANUAL");
    const none = buildCreatorAutonomy(null);
    expect(none.autoJoin).toBe(false);
    expect(none.directInvitations).toBe("MANUAL");
    expect(JSON.stringify(on)).not.toMatch(/"payoutWallet"|"privateKey"|"mnemonic"|"secret"|"email"|"rulesJson"|"reserve"/i);
  });

  it("organization ladder derives from actual policies without widening", () => {
    const off = buildOrganizationLadder({
      growthEnabled: false, maxBountyChangePct: 20, minimumEvidence: 5,
      operatorMaxPaymentMicroUsdc: 10_000_000n, procurementEnabled: false,
      procurementAllowlisted: false, procurementSignerConfigured: false,
      procurementMaxPerCheckMicroUsdc: null,
    });
    const bounty = off.find((r) => r.capability === "ADJUST BOUNTY")!;
    expect(bounty.authority).toBe("ADVISORY");
    const verify = off.find((r) => r.capability === "PURCHASE VERIFICATION")!;
    expect(["REFUSED_BY_POLICY", "NOT_CONFIGURED"]).toContain(verify.authority);
    const settle = off.find((r) => r.capability === "SETTLE UNSUPPORTED HYBRID OBLIGATIONS")!;
    expect(settle.authority).toBe("UNSUPPORTED");
    const on = buildOrganizationLadder({
      growthEnabled: true, maxBountyChangePct: 20, minimumEvidence: 5,
      operatorMaxPaymentMicroUsdc: 10_000_000n, procurementEnabled: true,
      procurementAllowlisted: false, procurementSignerConfigured: false,
      procurementMaxPerCheckMicroUsdc: 2_000_000n,
    });
    expect(on.find((r) => r.capability === "ADJUST BOUNTY")!.authority).toBe("AUTONOMOUS_ALLOWED");
    expect(on.find((r) => r.capability === "PURCHASE VERIFICATION")!.authority).toBe("NOT_CONFIGURED");
    expect(on.find((r) => r.capability === "ALLOCATE NEW CAMPAIGN CAPITAL")!.authority).toBe("ADVISORY");
  });
});

describe("envelope mapping preserves domain truth", () => {
  it("recommendation-only rows are ADVISORY and never execute", () => {
    const ranked = normalizeAuditRow(row("match_engine.run", { evaluated: 5 }))!;
    expect(ranked.authorityState).toBe("ADVISORY");
    expect(ranked.executionState).toBe("NO_ACTION");
    const plan = normalizeAuditRow(row("cfo.plan.generated", { campaignId: "c-1" }))!;
    expect(plan.authorityState).toBe("ADVISORY");
    expect(plan.executionState).toBe("PROPOSED");
    const alloc = normalizeAuditRow(row("operator.allocation.recommended", { campaignId: "c-1" }))!;
    expect(alloc.executionState).toBe("PROPOSED");
  });

  it("executed bounty maps AUTONOMOUS_ALLOWED; escalations require approval", () => {
    const done = normalizeAuditRow(row("operator.bounty.changed", { execution: { executed: true, decision: "INCREASE_BOUNTY" } }))!;
    expect(done.authorityState).toBe("AUTONOMOUS_ALLOWED");
    expect(done.executionState).toBe("EXECUTED");
    const esc = normalizeAuditRow(row("operator.bounty.escalated", { campaignId: "c-1" }))!;
    expect(esc.authorityState).toBe("REQUIRES_APPROVAL");
    expect(esc.executionState).toBe("ESCALATED");
  });

  it("CFO plan maps ADVISORY even with capital scores", () => {
    const d = normalizeAuditRow(row("cfo.campaign.decision", { campaignId: "c-1", spendAction: "PAUSE", capitalAction: "PAUSE_NEW_COMMITMENTS" }))!;
    expect(d.authorityState).toBe("ADVISORY");
    expect(d.executionState).toBe("PROPOSED");
    expect(d.decision).toBe("PAUSE");
  });

  it("operator payouts map by decision; above-limit requires approval", () => {
    const pay = normalizeAuditRow(row("operator.decision", { decision: "PAY_NOW", amountMicroUsdc: "5000000", campaignId: "c-1" }))!;
    expect(pay.authorityState).toBe("AUTONOMOUS_ALLOWED");
    expect(pay.executionState).toBe("EXECUTED");
    expect(pay.enforcement).toBe("ONCHAIN_ENFORCED");
    const esc = normalizeAuditRow(row("operator.decision", { decision: "ESCALATE_APPROVAL", amountMicroUsdc: "50000000", campaignId: "c-1" }))!;
    expect(esc.authorityState).toBe("REQUIRES_APPROVAL");
    expect(esc.executionState).toBe("ESCALATED");
    const hold = normalizeAuditRow(row("operator.decision", { decision: "HOLD_FOR_LIQUIDITY", campaignId: "c-1" }))!;
    expect(hold.executionState).toBe("WAITING");
  });

  it("agent vs manual acceptance map distinct actors, same execution", () => {
    const agent = normalizeAuditRow(row("creator.invitation.accepted", { mode: "AGENT", campaignId: "c-1", creatorUserId: "u-1", invitationId: "i-1", termsId: "t-1" }, { actorType: "SYSTEM" }))!;
    expect(agent.authorityState).toBe("AUTONOMOUS_ALLOWED");
    expect(agent.executionState).toBe("EXECUTED");
    expect(agent.actor).toBe("AGENT");
    expect(agent.executionMode).toBe("AUTONOMOUS");
    const manual = normalizeAuditRow(
      row("creator.invitation.accepted", { mode: "MANUAL", campaignId: "c-1", creatorUserId: "u-1", invitationId: "i-1", termsId: "t-1" }, { actorType: "USER", actorId: "u-1" }),
    )!;
    expect(manual.executionState).toBe("EXECUTED");
    expect(manual.executionMode).toBe("HUMAN");
    expect(manual.actor).toBe("USER");
    expect(manual.amountMicroUsdc).toBeNull();
  });

  it("SUBMITTED never normalizes as SETTLED; PURCHASED stays distinct from RESULT_RECEIVED", () => {
    const sub = normalizeAuditRow(row("payout.submitted", { amountMicroUsdc: "4000000", outcomeId: "o-1", txHash: "0xabc" }))!;
    expect(sub.executionState).toBe("EXECUTED");
    expect(sub.decision).toBe("SUBMITTED");
    const settled = normalizeAuditRow(row("payout.settled", { amountMicroUsdc: "4000000", outcomeId: "o-1", txHash: "0xabc" }))!;
    expect(settled.executionState).toBe("SETTLED");
    const bought = normalizeAuditRow(row("verification.procurement.purchased", { campaignId: "c-1", outcomeId: "o-1", costMicroUsdc: "80000", paymentReference: "ref-1" }))!;
    const done = normalizeAuditRow(row("verification.procurement.result_received", { campaignId: "c-1", outcomeId: "o-1", costMicroUsdc: "80000", result: "RISK_SIGNAL", paymentReference: "ref-1" }))!;
    expect(bought.executionState).toBe("EXECUTED");
    expect(done.executionState).toBe("EXECUTED");
    expect(done).not.toEqual(bought);
    expect(done.decision).toBe("RISK_SIGNAL");
  });

  it("AMBIGUOUS, FAILED and REFUSED stay visible", () => {
    expect(normalizeAuditRow(row("payout.ambiguous", { outcomeId: "o-1" }))!.executionState).toBe("AMBIGUOUS");
    expect(normalizeAuditRow(row("payout.failed", { outcomeId: "o-1", failureCode: "X" }))!.executionState).toBe("FAILED");
    expect(normalizeAuditRow(row("verification.procurement.refused", { campaignId: "c-1", outcomeId: "o-1" }))!.executionState).toBe("REFUSED");
  });

  it("policy refs and enforcement labels are accurate", () => {
    const accepted = normalizeAuditRow(row("creator.invitation.accepted", { mode: "AGENT", campaignId: "c-1", offeredPolicyVersion: 3 }))!;
    expect(accepted.policyRefs).toContain("Campaign policy v3");
    expect(accepted.policyRefs).toContain("Creator Scout rules");
    const settled = normalizeAuditRow(row("payout.settled", { amountMicroUsdc: "1", outcomeId: "o-1" }))!;
    expect(settled.enforcement).toBe("ONCHAIN_ENFORCED");
    const plan = normalizeAuditRow(row("cfo.plan.generated", { campaignId: "c-1" }))!;
    expect(plan.enforcement).toBe("APPLICATION_POLICY");
  });

  it("unmapped noise is skipped, never invented", () => {
    expect(normalizeAuditRow(row("workspace.created", {}))).toBeNull();
    expect(normalizeAuditRow(row("partner.created", {}))).toBeNull();
  });
});

describe("ledger query, escalations, metrics", () => {
  function wsRows(): ReturnType<typeof row>[] {
    return [
      row("match_engine.run", { evaluated: 2, campaignId: "c-1" }),
      row("creator.invitation.accepted", { mode: "AGENT", campaignId: "c-1", creatorUserId: "u-1", invitationId: "i-1", termsId: "t-1" }, { actorType: "SYSTEM" }),
      row("payout.submitted", { amountMicroUsdc: "4000000", outcomeId: "o-1", txHash: "0xabc" }),
      row("payout.settled", { amountMicroUsdc: "4000000", outcomeId: "o-1", txHash: "0xabc" }),
      row("operator.decision", { decision: "ESCALATE_APPROVAL", amountMicroUsdc: "99999999", campaignId: "c-1" }),
      row("verification.procurement.purchased", { campaignId: "c-1", outcomeId: "o-2", costMicroUsdc: "80000" }),
    ];
  }

  it("org isolation: workspace filter is exact", () => {
    const rows = [...wsRows(), row("payout.settled", { amountMicroUsdc: "1", outcomeId: "ox" }, { workspaceId: "ws-B" })];
    const { decisions, total } = queryLedger(rows, { workspaceId: "ws-A" });
    expect(total).toBe(6);
    expect(decisions.every((d) => d.organizationId === "ws-A")).toBe(true);
  });

  it("filtering and pagination are stable and deterministic", () => {
    const rows = wsRows();
    const a = queryLedger(rows, { workspaceId: "ws-A", executionState: "EXECUTED" });
    expect(a.decisions.every((d) => d.executionState === "EXECUTED")).toBe(true);
    const b = queryLedger([...rows].reverse(), { workspaceId: "ws-A", executionState: "EXECUTED" });
    expect(a).toEqual(b);
    const p1 = queryLedger(rows, { workspaceId: "ws-A", limit: 2, offset: 0 });
    const p2 = queryLedger(rows, { workspaceId: "ws-A", limit: 2, offset: 2 });
    expect(p1.decisions.map((d) => d.id)).not.toEqual(p2.decisions.map((d) => d.id));
    expect(p1.total).toBe(6);
  });

  it("metrics count real events only; recommendations never execute", () => {
    const rows = [...wsRows(), row("cfo.plan.generated", { campaignId: "c-1" }), row("operator.allocation.recommended", { campaignId: "c-1" })];
    const { decisions } = queryLedger(rows, { workspaceId: "ws-A" });
    const m = summarizeAutonomy(decisions);
    expect(m.creatorAutoAccepts).toBe(1);
    expect(m.obligationsSettledAutonomously).toBe(1);
    expect(m.usdcSettledAutonomouslyMicroUsdc).toBe("4000000");
    expect(m.verificationPurchases).toBe(1);
    expect(m.humanEscalations).toBe(1);
    // 8 envelopes, of which PROPOSED/NO_ACTION/WAITING recommendations add zero executions.
    const expectedExecutions = decisions.filter((d) => d.executionState === "EXECUTED" || d.executionState === "SETTLED").length;
    expect(m.autonomousExecutions).toBe(expectedExecutions);
  });

  it("escalations derive OPEN/RESOLVED/EXPIRED truthfully", () => {
    const open = normalizeAuditRow(row("operator.decision", { decision: "ESCALATE_APPROVAL", campaignId: "c-9" }))!;
    expect(deriveEscalations([open], Date.parse("2026-06-02T00:00:00Z"))[0].status).toBe("OPEN");
    const old = normalizeAuditRow({ ...row("operator.decision", { decision: "ESCALATE_APPROVAL", campaignId: "c-9" }), createdAt: "2026-01-01T00:00:00.000Z" })!;
    expect(deriveEscalations([old], Date.parse("2026-06-02T00:00:00Z"))[0].status).toBe("EXPIRED");
  });

  it("pure readers mutate nothing and leak no secrets", () => {
    const rows = wsRows();
    const frozen = JSON.parse(JSON.stringify(rows)) as unknown[];
    const { decisions } = queryLedger(rows, { workspaceId: "ws-A" });
    deriveEscalations(decisions, Date.parse("2026-06-02T00:00:00Z"));
    summarizeAutonomy(decisions);
    expect(rows).toEqual(frozen);
    expect(JSON.stringify(decisions)).not.toMatch(/privateKey|secret|mnemonic|wallet|email/i);
  });
});

describe("integration readiness doc", () => {
  it("lists every pending migration, env requirement and known blocker", () => {
    const doc = readFileSync(join(process.cwd(), "docs", "integration-readiness.md"), "utf8");
    for (const token of ["0014", "0015", "0016", "0017", "__drizzle_migrations", "THESMA_PROCUREMENT_PRIVATE_KEY", "THESMA_PROCUREMENT_ADDRESS", "NOT_CONFIGURED", "UNSUPPORTED", "CONFIGURATION_REQUIRED"]) {
      expect(doc).toContain(token);
    }
  });
});
