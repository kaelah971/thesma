import { describe, expect, it } from "vitest";
import { evaluateGrowthProgramOutcome, type GrowthProgramEvaluationProgram } from "@/server/services/growthProgramOutcome";
import type { ExternalOutcomeEventRow } from "@/server/services/buildWithThesma";

const NOW = new Date("2026-01-15T12:00:00.000Z");

const program: GrowthProgramEvaluationProgram = {
  id: "program-proofpilot",
  campaignId: "campaign-proofpilot",
  policyVersionId: "policy-proofpilot",
  name: "ProofPilot Partner Growth",
  slug: "proofpilot-partner-growth",
  budgetMicroUsdc: 500_000_000n,
  maxVerifiedCacMicroUsdc: 10_000_000n,
  rewardCeilingMicroUsdc: 8_000_000n,
  rewardStructure: "PERFORMANCE_ONLY" as const,
  operatorMode: "SHADOW" as const,
  fundingStatus: "FUNDED" as const,
};

const participant = {
  id: "participant-alpha",
  displayName: "Creator Alpha",
  status: "ACTIVE",
  rewardPolicySnapshotJson: {
    rewardStructure: "PERFORMANCE_ONLY",
    rewardCeilingMicroUsdc: "8000000",
    maxVerifiedCacMicroUsdc: "10000000",
  },
};

function event(overrides: Partial<ExternalOutcomeEventRow> = {}): ExternalOutcomeEventRow {
  return {
    id: "event-1",
    receiptId: "receipt-1",
    workspaceId: "workspace-1",
    integrationId: "integration-1",
    definitionId: "definition-1",
    growthProgramId: program.id,
    attributionIdentityId: "attr-alpha",
    attributionStatus: "DIRECT_ATTRIBUTION",
    externalEventId: "activation_001",
    externalSubjectId: "user_123",
    occurredAt: new Date("2026-01-15T11:00:00.000Z"),
    schemaVersion: 1,
    evidenceJson: { userId: "user_123" },
    normalizedEvidenceJson: { userId: "user_123" },
    evidenceHash: `0x${"a".repeat(64)}`,
    idempotencyKey: "activation_001_v1",
    requestFingerprint: `0x${"b".repeat(64)}`,
    verificationState: "VERIFIED",
    holdState: "RELEASED",
    settlementState: "ELIGIBLE_NOT_REQUESTED",
    executionState: "NOT_REQUESTED",
    decisionReasonsJson: ["EVIDENCE_COMPLETE"],
    policySnapshotJson: {},
    procurementRecommendation: "NOT_NEEDED",
    rejectionCode: null,
    holdUntil: null,
    verifiedAt: new Date("2026-01-15T11:01:00.000Z"),
    settledAt: null,
    createdAt: new Date("2026-01-15T11:01:00.000Z"),
    updatedAt: new Date("2026-01-15T11:01:00.000Z"),
    ...overrides,
  };
}

function evaluate(current: ExternalOutcomeEventRow, options: { program?: GrowthProgramEvaluationProgram; participant?: typeof participant | null; events?: Array<{ event: ExternalOutcomeEventRow; participant: typeof participant | null }>; organizationMode?: "AUTONOMOUS" | "SHADOW" } = {}) {
  const rows = options.events ?? [{ event: current, participant: options.participant === undefined ? participant : options.participant }];
  return evaluateGrowthProgramOutcome({
    program: options.program ?? program,
    events: rows,
    eventId: current.id,
    organizationMode: options.organizationMode ?? "AUTONOMOUS",
    now: NOW,
  });
}

describe("embedded Growth Program outcome pipeline", () => {
  it("reuses verification state, frozen reward terms and Shadow settlement boundaries", () => {
    const result = evaluate(event());
    expect(result.attribution.status).toBe("DIRECT_ATTRIBUTION");
    expect(result.verification.state).toBe("VERIFIED");
    expect(result.reward).toMatchObject({ amountMicroUsdc: "8000000", eligibility: "ELIGIBLE", frozen: true });
    expect(result.economics).toMatchObject({ eligibleExposureMicroUsdc: "8000000", heldExposureMicroUsdc: "0", settledSpendMicroUsdc: "0", remainingAllocatableBudgetMicroUsdc: "492000000" });
    expect(result.settlementEligibility.status).toBe("READY");
    expect(result.operatorDecision.recommendation).toBe("WOULD_SETTLE");
    expect(result.execution).toMatchObject({ status: "BLOCKED_BY_SHADOW", actualPaidMicroUsdc: "0", circleCalls: 0, x402PaidCalls: 0 });
    expect(result.receipt.financialTransaction).toBeNull();
  });

  it("does not treat attribution alone as verification", () => {
    const result = evaluate(event({ verificationState: "SUBMITTED", verifiedAt: null }));
    expect(result.reward.eligibility).toBe("PENDING_VERIFICATION");
    expect(result.settlementEligibility.status).toBe("NOT_READY");
    expect(result.operatorDecision.recommendation).toBe("REVIEW");
  });

  it("routes inconclusive evidence to deterministic review and WOULD_BUY without spend", () => {
    const result = evaluate(event({ verificationState: "REVIEW", procurementRecommendation: "WOULD_BUY", verifiedAt: null }));
    expect(result.verificationProcurement).toMatchObject({ decision: "WOULD_BUY", estimatedCostMicroUsdc: "2000", actualSpendMicroUsdc: "0", execution: "BLOCKED_BY_SHADOW" });
    expect(result.reward.eligibility).toBe("PENDING_VERIFICATION");
    expect(result.operatorDecision.recommendation).toBe("REVIEW");
  });

  it("refuses invalid attribution and never creates reward eligibility", () => {
    const result = evaluate(event({ attributionStatus: "INVALID_ATTRIBUTION", attributionIdentityId: null }));
    expect(result.reward.eligibility).toBe("NOT_ELIGIBLE");
    expect(result.settlementEligibility.status).toBe("NOT_READY");
    expect(result.operatorDecision.recommendation).toBe("HOLD");
  });

  it("refuses rewards above the verified CAC ceiling", () => {
    const result = evaluate(event(), { participant: { ...participant, rewardPolicySnapshotJson: { ...participant.rewardPolicySnapshotJson, rewardCeilingMicroUsdc: "11000000" } } });
    expect(result.reward.eligibility).toBe("NOT_ELIGIBLE");
    expect(result.reward.reasonCodes).toContain("REWARD_EXCEEDS_CAC");
    expect(result.operatorDecision.recommendation).toBe("REFUSE");
  });

  it("blocks an outcome when the exact program budget is exhausted", () => {
    const prior = event({ id: "event-0", externalEventId: "activation_000", createdAt: new Date("2026-01-15T10:00:00.000Z") });
    const current = event({ id: "event-1", createdAt: new Date("2026-01-15T11:00:00.000Z") });
    const result = evaluate(current, {
      program: { ...program, budgetMicroUsdc: 8_000_000n },
      events: [{ event: prior, participant }, { event: current, participant }],
    });
    expect(result.economics.eligibleExposureMicroUsdc).toBe("8000000");
    expect(result.economics.remainingAllocatableBudgetMicroUsdc).toBe("0");
    expect(result.reward.reasonCodes).toContain("PROGRAM_BUDGET_EXHAUSTED");
    expect(result.settlementEligibility.reasonCode).toBe("PROGRAM_BUDGET_EXHAUSTED");
  });

  it("keeps verified reward eligibility separate from an active hold", () => {
    const result = evaluate(event({ holdState: "HELD", settlementState: "HELD", holdUntil: new Date("2026-01-16T12:00:00.000Z") }));
    expect(result.reward.eligibility).toBe("ON_HOLD");
    expect(result.hold.state).toBe("ACTIVE");
    expect(result.economics.heldExposureMicroUsdc).toBe("8000000");
    expect(result.settlementEligibility).toMatchObject({ status: "NOT_READY", reasonCode: "HOLD_ACTIVE" });
    expect(result.operatorDecision.recommendation).toBe("HOLD");
  });

  it("surfaces unsupported hybrid settlement legs instead of faking execution", () => {
    const result = evaluate(event(), { program: { ...program, rewardStructure: "MILESTONE_PLUS_PERFORMANCE" } });
    expect(result.settlementEligibility).toMatchObject({ status: "NOT_READY", reasonCode: "UNSUPPORTED_SETTLEMENT_PATH", path: "UNSUPPORTED_HYBRID" });
    expect(result.execution.actualPaidMicroUsdc).toBe("0");
  });

  it("reports unfunded truth without inventing a balance", () => {
    const result = evaluate(event(), { program: { ...program, fundingStatus: "NOT_FUNDED" } });
    expect(result.program.fundingStatus).toBe("NOT_FUNDED");
    expect(result.settlementEligibility).toMatchObject({ status: "NOT_READY", reasonCode: "PROGRAM_UNFUNDED" });
    expect(result.economics.settledSpendMicroUsdc).toBe("0");
  });

  it("does not double count a settled outcome and reports CAC only from settled production economics", () => {
    const result = evaluate(event({ settlementState: "SETTLED", settledAt: new Date("2026-01-15T11:30:00.000Z") }));
    expect(result.reward.eligibility).toBe("SETTLED");
    expect(result.economics).toMatchObject({ settledSpendMicroUsdc: "8000000", effectiveVerifiedCacMicroUsdc: "8000000", verifiedCacStatus: "WITHIN_POLICY" });
    expect(result.settlementEligibility.status).toBe("SETTLED");
    expect(result.execution.actualPaidMicroUsdc).toBe("0");
  });

  it("excludes verification testnet expense from program accounting", () => {
    const result = evaluate(event({ verificationState: "REVIEW", procurementRecommendation: "WOULD_BUY", verifiedAt: null }));
    expect(result.economics.verificationExpenseMicroUsdc).toBe("0");
    expect(result.economics.testnetVerificationSpendExcluded).toBe(true);
  });
});