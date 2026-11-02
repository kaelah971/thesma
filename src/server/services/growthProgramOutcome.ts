import { and, asc, eq } from "drizzle-orm";
import { getDb, isDbConfigured, type Db } from "../db/client";
import {
  campaignFundings,
  campaignPolicyVersions,
  developerGrowthPrograms,
  externalOutcomeEvents,
  growthAttributionIdentities,
  growthProgramParticipants,
} from "../db/schema";
import { getOrganizationOperatorMode, type OrganizationOperatorMode } from "./operatorMode";
import { buildShadowDecision, recordShadowDecision } from "./shadowOperator";
import { createDrizzleCampaignStore } from "./campaignStore.drizzle";
import { loadCfoSnapshot } from "./cfo";
import type { AuditSink } from "./campaignStore";
import type { ExternalOutcomeEventRow } from "./buildWithThesma";

export type GrowthProgramFundingStatus = "FUNDED" | "NOT_FUNDED";
export type GrowthProgramRewardEligibility =
  | "NOT_ELIGIBLE"
  | "PENDING_VERIFICATION"
  | "ELIGIBLE"
  | "ON_HOLD"
  | "SETTLEMENT_READY"
  | "SETTLED"
  | "REFUSED";
export type GrowthProgramSettlementEligibility = "NOT_READY" | "READY" | "SETTLED";
export type GrowthProgramOperatorRecommendation = "ACCEPT" | "HOLD" | "REVIEW" | "REFUSE" | "WOULD_SETTLE";

export interface GrowthProgramEvaluationProgram {
  id: string;
  campaignId: string;
  policyVersionId: string;
  name: string;
  slug: string;
  budgetMicroUsdc: bigint;
  maxVerifiedCacMicroUsdc: bigint;
  rewardCeilingMicroUsdc: bigint;
  rewardStructure: "PERFORMANCE_ONLY" | "BASE_PLUS_PERFORMANCE" | "MILESTONE_PLUS_PERFORMANCE" | "HYBRID_FULL";
  operatorMode: "SHADOW" | "REVIEW" | "AUTONOMOUS";
  fundingStatus: GrowthProgramFundingStatus;
}

export interface GrowthProgramParticipantSnapshot {
  id: string;
  displayName: string;
  status: string;
  rewardPolicySnapshotJson: Record<string, unknown>;
}

export interface GrowthProgramEventSnapshot {
  event: ExternalOutcomeEventRow;
  participant: GrowthProgramParticipantSnapshot | null;
}

export interface GrowthProgramOutcomeEvaluation {
  version: 1;
  eventId: string;
  program: {
    id: string;
    name: string;
    slug: string;
    campaignId: string;
    policyVersionId: string;
    rewardStructure: GrowthProgramEvaluationProgram["rewardStructure"];
    fundingStatus: GrowthProgramFundingStatus;
  };
  attribution: {
    status: string;
    identityId: string | null;
    participantId: string | null;
    participantName: string | null;
  };
  verification: {
    state: ExternalOutcomeEventRow["verificationState"];
    evidenceHash: string;
    reasons: string[];
  };
  verificationProcurement: {
    decision: "NO_CHECK" | "WOULD_BUY" | "BUY" | "BOUGHT" | "REFUSED";
    estimatedCostMicroUsdc: string;
    actualSpendMicroUsdc: string;
    execution: "NOT_NEEDED" | "BLOCKED_BY_SHADOW" | "NOT_EXECUTED";
  };
  reward: {
    amountMicroUsdc: string;
    model: string;
    frozen: boolean;
    eligibility: GrowthProgramRewardEligibility;
    reasonCodes: string[];
    participantId: string | null;
  };
  economics: {
    budgetCapMicroUsdc: string;
    eligibleExposureMicroUsdc: string;
    heldExposureMicroUsdc: string;
    settledSpendMicroUsdc: string;
    verificationExpenseMicroUsdc: string;
    remainingAllocatableBudgetMicroUsdc: string;
    verifiedOutcomeCount: number;
    effectiveVerifiedCacMicroUsdc: string | null;
    verifiedCacStatus: "INSUFFICIENT_DATA" | "WITHIN_POLICY" | "ABOVE_POLICY";
    targetCacMicroUsdc: string;
    budgetState: "AVAILABLE" | "EXHAUSTED";
    testnetVerificationSpendExcluded: true;
  };
  hold: {
    state: "NONE" | "ACTIVE" | "RELEASED";
    until: string | null;
    reasonCode: string | null;
  };
  settlementEligibility: {
    status: GrowthProgramSettlementEligibility;
    reasonCode: string | null;
    reason: string;
    path: "EXISTING_CAMPAIGN_PERFORMANCE" | "UNSUPPORTED_HYBRID";
    campaignId: string;
  };
  operatorDecision: {
    recommendation: GrowthProgramOperatorRecommendation;
    reasonCodes: string[];
    reasons: string[];
    mode: OrganizationOperatorMode;
    execution: "WOULD_SETTLE" | "BLOCKED_BY_SHADOW" | "NOT_READY" | "NOT_EXECUTED";
  };
  execution: {
    status: "BLOCKED_BY_SHADOW" | "NOT_EXECUTED" | "NOT_REQUESTED";
    actualPaidMicroUsdc: "0";
    financialTransaction: null;
    ledgerReference: null;
    circleCalls: 0;
    x402PaidCalls: 0;
  };
  receipt: {
    programName: string;
    programId: string;
    campaignId: string;
    externalEventId: string;
    externalSubjectId: string;
    participant: string | null;
    attributionStatus: string;
    attributionIdentityId: string | null;
    evidenceHash: string;
    verification: ExternalOutcomeEventRow["verificationState"];
    rewardEligibility: GrowthProgramRewardEligibility;
    rewardMicroUsdc: string;
    hold: "ACTIVE" | "NONE" | "RELEASED";
    settlement: GrowthProgramSettlementEligibility;
    operatorMode: OrganizationOperatorMode;
    executionStatus: "BLOCKED_BY_SHADOW" | "NOT_EXECUTED" | "NOT_REQUESTED";
    financialTransaction: null;
  };
}

export interface GrowthProgramOutcomeSummary {
  program: GrowthProgramOutcomeEvaluation["program"];
  economics: GrowthProgramOutcomeEvaluation["economics"];
  verification: { submitted: number; verified: number; review: number; refused: number };
  settlement: { ready: number; notReady: number; settled: number; actualPaidMicroUsdc: "0" };
  operator: {
    mode: OrganizationOperatorMode;
    latestRecommendation: GrowthProgramOperatorRecommendation | null;
    latestReasonCodes: string[];
    latestEventId: string | null;
  };
  finance: {
    campaignCfo: "AVAILABLE" | "UNAVAILABLE";
    campaignId: string;
    availableMicroUsdc: string | null;
    budgetHeadroomMicroUsdc: string | null;
  };
  portfolio: {
    recommendation: "NOT_INCLUDED";
    chainMovement: "UNAVAILABLE";
    reason: string;
  };
}

function bigintValue(value: unknown, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return fallback;
}

function maxZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function rewardFor(program: GrowthProgramEvaluationProgram, participant: GrowthProgramParticipantSnapshot | null): {
  amount: bigint;
  model: string;
  frozen: boolean;
} {
  const snapshot = participant?.rewardPolicySnapshotJson ?? {};
  const amount = bigintValue(snapshot.rewardCeilingMicroUsdc, program.rewardCeilingMicroUsdc);
  const model = typeof snapshot.rewardStructure === "string" ? snapshot.rewardStructure : program.rewardStructure;
  return { amount, model, frozen: participant !== null && snapshot.rewardCeilingMicroUsdc !== undefined };
}

function isHoldActive(event: ExternalOutcomeEventRow, now: Date): boolean {
  return event.holdState === "HELD" && (!event.holdUntil || event.holdUntil.getTime() > now.getTime());
}

function procurementDecision(event: ExternalOutcomeEventRow): GrowthProgramOutcomeEvaluation["verificationProcurement"]["decision"] {
  if (event.verificationState !== "REVIEW") return "NO_CHECK";
  if (event.procurementRecommendation === "WOULD_BUY") return "WOULD_BUY";
  if (event.procurementRecommendation === "BUY") return "BUY";
  if (event.procurementRecommendation === "BOUGHT") return "BOUGHT";
  if (event.procurementRecommendation === "REFUSE") return "REFUSED";
  return "NO_CHECK";
}

function modeFor(program: GrowthProgramEvaluationProgram, organizationMode: OrganizationOperatorMode): OrganizationOperatorMode {
  return program.operatorMode === "AUTONOMOUS" && organizationMode === "AUTONOMOUS" ? "AUTONOMOUS" : "SHADOW";
}

function orderedEvents(events: readonly GrowthProgramEventSnapshot[], eventId: string): GrowthProgramEventSnapshot[] {
  const rows = new Map(events.map((row) => [row.event.id, row]));
  return [...rows.values()].sort((a, b) => {
    const created = a.event.createdAt.getTime() - b.event.createdAt.getTime();
    return created || a.event.id.localeCompare(b.event.id);
  }).filter((row) => row.event.growthProgramId !== null || row.event.id === eventId);
}

export function evaluateGrowthProgramOutcome(input: {
  program: GrowthProgramEvaluationProgram;
  events: readonly GrowthProgramEventSnapshot[];
  eventId: string;
  organizationMode?: OrganizationOperatorMode;
  now?: Date;
}): GrowthProgramOutcomeEvaluation {
  const now = input.now ?? new Date();
  const organizationMode = input.organizationMode ?? "SHADOW";
  const mode = modeFor(input.program, organizationMode);
  const events = orderedEvents(input.events, input.eventId);
  const current = events.find((row) => row.event.id === input.eventId);
  if (!current) throw new Error("Growth Program outcome event not found.");

  let allocated = 0n;
  let held = 0n;
  let settled = 0n;
  let verifiedCount = 0;
  let settledVerifiedCount = 0;
  const currentDecision = {
    eligible: false,
    reasonCodes: [] as string[],
    reward: rewardFor(input.program, current.participant),
    holdActive: isHoldActive(current.event, now),
    settled: current.event.settlementState === "SETTLED" || current.event.settledAt !== null,
  };

  for (const row of events) {
    const event = row.event;
    const reward = rewardFor(input.program, row.participant);
    const direct = event.attributionStatus === "DIRECT_ATTRIBUTION" && row.participant?.status === "ACTIVE";
    const reasons: string[] = [];
    let eligible = false;

    if (event.verificationState === "VERIFIED" && direct && reward.amount <= input.program.maxVerifiedCacMicroUsdc && allocated + reward.amount <= input.program.budgetMicroUsdc) {
      eligible = true;
      allocated += reward.amount;
      verifiedCount += 1;
      if (isHoldActive(event, now)) held += reward.amount;
      if (event.settlementState === "SETTLED" || event.settledAt !== null) {
        settled += reward.amount;
        settledVerifiedCount += 1;
      }
      reasons.push("VERIFICATION_CONFIRMED", "WITHIN_REWARD_POLICY", "WITHIN_CAC_CEILING", "PROGRAM_BUDGET_AVAILABLE");
    } else if (event.verificationState !== "VERIFIED") {
      reasons.push(event.verificationState === "REFUSED" ? "VERIFICATION_REFUSED" : "VERIFICATION_REQUIRED");
    } else if (!direct) {
      reasons.push("DIRECT_ATTRIBUTION_REQUIRED");
    } else if (reward.amount > input.program.maxVerifiedCacMicroUsdc) {
      reasons.push("REWARD_EXCEEDS_CAC");
    } else {
      reasons.push("PROGRAM_BUDGET_EXHAUSTED");
    }

    if (event.id === input.eventId) {
      currentDecision.eligible = eligible;
      currentDecision.reasonCodes = reasons;
      currentDecision.reward = reward;
    }
  }

  const currentEvent = current.event;
  const attributionStatus = currentEvent.attributionStatus;
  const direct = attributionStatus === "DIRECT_ATTRIBUTION" && current.participant?.status === "ACTIVE";
  const procurement = procurementDecision(currentEvent);
  const verificationReasons = [...currentEvent.decisionReasonsJson];
  const rewardReasonCodes = [...currentDecision.reasonCodes];
  const rewardEligibility: GrowthProgramRewardEligibility = currentEvent.verificationState === "REFUSED"
    ? "REFUSED"
    : currentEvent.verificationState !== "VERIFIED"
      ? "PENDING_VERIFICATION"
      : !direct || !currentDecision.eligible
        ? "NOT_ELIGIBLE"
        : currentDecision.settled
          ? "SETTLED"
          : currentDecision.holdActive
            ? "ON_HOLD"
            : "ELIGIBLE";

  const holdState: GrowthProgramOutcomeEvaluation["hold"]["state"] = currentDecision.holdActive
    ? "ACTIVE"
    : currentEvent.holdState === "RELEASED"
      ? "RELEASED"
      : "NONE";
  if (currentDecision.holdActive) rewardReasonCodes.push("HOLD_REQUIRED");

  const settlementPath = input.program.rewardStructure === "PERFORMANCE_ONLY"
    ? "EXISTING_CAMPAIGN_PERFORMANCE"
    : "UNSUPPORTED_HYBRID";
  let settlementStatus: GrowthProgramSettlementEligibility = "NOT_READY";
  let settlementReasonCode: string | null = null;
  let settlementReason = "Reward is not eligible for settlement.";
  if (rewardEligibility === "SETTLED") {
    settlementStatus = "SETTLED";
    settlementReason = "Settlement is already recorded; duplicate settlement is refused.";
  } else if (currentDecision.eligible && !currentDecision.holdActive && settlementPath === "EXISTING_CAMPAIGN_PERFORMANCE" && input.program.fundingStatus === "FUNDED") {
    settlementStatus = "READY";
    settlementReason = "Verified reward satisfies attribution, policy, budget, hold and funding rules.";
  } else if (currentDecision.holdActive) {
    settlementReasonCode = "HOLD_ACTIVE";
    settlementReason = "Settlement waits for the existing hold to release.";
  } else if (settlementPath === "UNSUPPORTED_HYBRID") {
    settlementReasonCode = "UNSUPPORTED_SETTLEMENT_PATH";
    settlementReason = "Hybrid base or milestone settlement legs are not supported onchain.";
  } else if (input.program.fundingStatus !== "FUNDED") {
    settlementReasonCode = "PROGRAM_UNFUNDED";
    settlementReason = "The Growth Program is configured but not funded.";
  } else if (rewardReasonCodes.includes("PROGRAM_BUDGET_EXHAUSTED")) {
    settlementReasonCode = "PROGRAM_BUDGET_EXHAUSTED";
    settlementReason = "The configured Growth Program budget has no allocatable headroom.";
  } else if (rewardReasonCodes.includes("REWARD_EXCEEDS_CAC")) {
    settlementReasonCode = "REWARD_EXCEEDS_CAC";
    settlementReason = "The frozen participant reward exceeds the verified CAC ceiling.";
  } else if (currentEvent.verificationState === "REVIEW") {
    settlementReasonCode = "REVIEW_REQUIRED";
    settlementReason = "Verification remains in review and cannot create reward eligibility.";
  } else if (!direct) {
    settlementReasonCode = "ATTRIBUTION_REQUIRED";
    settlementReason = "A direct active participant attribution is required.";
  }

  const reasonCodes = [...new Set([
    ...rewardReasonCodes,
    ...(currentEvent.verificationState === "VERIFIED" ? ["VERIFICATION_CONFIRMED"] : []),
    ...(holdState === "ACTIVE" ? ["HOLD_REQUIRED"] : []),
    ...(settlementReasonCode ? [settlementReasonCode] : []),
    ...(mode === "SHADOW" ? ["SHADOW_MODE"] : []),
  ])];
  const reasons = [...new Set([
    ...verificationReasons,
    settlementReason,
    ...(mode === "SHADOW" ? ["Thesma evaluated this recommendation in Shadow Mode; no financial execution is authorized."] : []),
  ])];

  const effectiveCac = settledVerifiedCount > 0 ? settled / BigInt(settledVerifiedCount) : null;
  const economics = {
    budgetCapMicroUsdc: input.program.budgetMicroUsdc.toString(),
    eligibleExposureMicroUsdc: allocated.toString(),
    heldExposureMicroUsdc: held.toString(),
    settledSpendMicroUsdc: settled.toString(),
    verificationExpenseMicroUsdc: "0",
    remainingAllocatableBudgetMicroUsdc: maxZero(input.program.budgetMicroUsdc - allocated).toString(),
    verifiedOutcomeCount: verifiedCount,
    effectiveVerifiedCacMicroUsdc: effectiveCac?.toString() ?? null,
    verifiedCacStatus: effectiveCac === null ? "INSUFFICIENT_DATA" as const : effectiveCac <= input.program.maxVerifiedCacMicroUsdc ? "WITHIN_POLICY" as const : "ABOVE_POLICY" as const,
    targetCacMicroUsdc: input.program.maxVerifiedCacMicroUsdc.toString(),
    budgetState: input.program.budgetMicroUsdc > allocated ? "AVAILABLE" as const : "EXHAUSTED" as const,
    testnetVerificationSpendExcluded: true as const,
  };

  let recommendation: GrowthProgramOperatorRecommendation;
  if (currentEvent.verificationState === "REFUSED" || (currentEvent.verificationState === "VERIFIED" && rewardReasonCodes.includes("REWARD_EXCEEDS_CAC"))) recommendation = "REFUSE";
  else if (currentEvent.verificationState !== "VERIFIED" || attributionStatus === "AMBIGUOUS") recommendation = "REVIEW";
  else if (!currentDecision.eligible || currentDecision.holdActive || settlementStatus === "NOT_READY") recommendation = "HOLD";
  else recommendation = mode === "SHADOW" ? "WOULD_SETTLE" : "ACCEPT";

  const executionStatus: GrowthProgramOutcomeEvaluation["execution"]["status"] = mode === "SHADOW"
    ? "BLOCKED_BY_SHADOW"
    : settlementStatus === "READY"
      ? "NOT_REQUESTED"
      : "NOT_EXECUTED";
  const operatorExecution: GrowthProgramOutcomeEvaluation["operatorDecision"]["execution"] = settlementStatus === "READY"
    ? mode === "SHADOW" ? "BLOCKED_BY_SHADOW" : "WOULD_SETTLE"
    : "NOT_READY";

  return {
    version: 1,
    eventId: currentEvent.id,
    program: {
      id: input.program.id,
      name: input.program.name,
      slug: input.program.slug,
      campaignId: input.program.campaignId,
      policyVersionId: input.program.policyVersionId,
      rewardStructure: input.program.rewardStructure,
      fundingStatus: input.program.fundingStatus,
    },
    attribution: {
      status: attributionStatus,
      identityId: currentEvent.attributionIdentityId,
      participantId: current.participant?.id ?? null,
      participantName: current.participant?.displayName ?? null,
    },
    verification: {
      state: currentEvent.verificationState,
      evidenceHash: currentEvent.evidenceHash,
      reasons: verificationReasons,
    },
    verificationProcurement: {
      decision: procurement,
      estimatedCostMicroUsdc: procurement === "WOULD_BUY" || procurement === "BUY" || procurement === "BOUGHT" ? "2000" : "0",
      actualSpendMicroUsdc: "0",
      execution: procurement === "WOULD_BUY" || procurement === "BUY" ? mode === "SHADOW" ? "BLOCKED_BY_SHADOW" : "NOT_EXECUTED" : "NOT_NEEDED",
    },
    reward: {
      amountMicroUsdc: currentDecision.reward.amount.toString(),
      model: currentDecision.reward.model,
      frozen: currentDecision.reward.frozen,
      eligibility: rewardEligibility,
      reasonCodes: rewardReasonCodes,
      participantId: current.participant?.id ?? null,
    },
    economics,
    hold: {
      state: holdState,
      until: currentEvent.holdUntil?.toISOString() ?? null,
      reasonCode: holdState === "ACTIVE" ? "HOLD_ACTIVE" : null,
    },
    settlementEligibility: {
      status: settlementStatus,
      reasonCode: settlementReasonCode,
      reason: settlementReason,
      path: settlementPath,
      campaignId: input.program.campaignId,
    },
    operatorDecision: {
      recommendation,
      reasonCodes,
      reasons,
      mode,
      execution: operatorExecution,
    },
    execution: {
      status: executionStatus,
      actualPaidMicroUsdc: "0",
      financialTransaction: null,
      ledgerReference: null,
      circleCalls: 0,
      x402PaidCalls: 0,
    },
    receipt: {
      programName: input.program.name,
      programId: input.program.id,
      campaignId: input.program.campaignId,
      externalEventId: currentEvent.externalEventId,
      externalSubjectId: currentEvent.externalSubjectId,
      participant: current.participant?.displayName ?? null,
      attributionStatus,
      attributionIdentityId: currentEvent.attributionIdentityId,
      evidenceHash: currentEvent.evidenceHash,
      verification: currentEvent.verificationState,
      rewardEligibility,
      rewardMicroUsdc: currentDecision.reward.amount.toString(),
      hold: holdState,
      settlement: settlementStatus,
      operatorMode: mode,
      executionStatus,
      financialTransaction: null,
    },
  };
}

export async function recordGrowthProgramShadowDecision(
  audit: AuditSink,
  workspaceId: string,
  evaluation: GrowthProgramOutcomeEvaluation,
): Promise<void> {
  if (evaluation.operatorDecision.mode !== "SHADOW") return;
  const decision = buildShadowDecision({
    runId: `growth-program:${evaluation.eventId}`,
    workspaceId,
    family: "FINANCIAL_SETTLEMENT",
    targetId: evaluation.eventId,
    recommendation: evaluation.operatorDecision.recommendation,
    amountMicroUsdc: evaluation.reward.amountMicroUsdc,
    confidence: evaluation.verification.state,
    reasons: evaluation.operatorDecision.reasons,
    inputSnapshot: evaluation.receipt,
    policySnapshot: {
      program: evaluation.program,
      economics: evaluation.economics,
      settlementEligibility: evaluation.settlementEligibility,
    },
    generatedAt: new Date().toISOString(),
  });
  await recordShadowDecision(audit, decision);
}

function toEvaluationProgram(row: {
  id: string;
  campaignId: string;
  policyVersionId: string;
  name: string;
  slug: string;
  budgetMicroUsdc: bigint | null;
  maxVerifiedCacMicroUsdc: bigint;
  rewardCeilingMicroUsdc: bigint | null;
  rewardStructure: string;
  operatorMode: string;
  fundingStatus: GrowthProgramFundingStatus;
}): GrowthProgramEvaluationProgram {
  return {
    id: row.id,
    campaignId: row.campaignId,
    policyVersionId: row.policyVersionId,
    name: row.name,
    slug: row.slug,
    budgetMicroUsdc: row.budgetMicroUsdc ?? 0n,
    maxVerifiedCacMicroUsdc: row.maxVerifiedCacMicroUsdc,
    rewardCeilingMicroUsdc: row.rewardCeilingMicroUsdc ?? 0n,
    rewardStructure: row.rewardStructure as GrowthProgramEvaluationProgram["rewardStructure"],
    operatorMode: row.operatorMode as GrowthProgramEvaluationProgram["operatorMode"],
    fundingStatus: row.fundingStatus,
  };
}

export function createProductionGrowthProgramOutcomeService(db: Db = getDb()) {
  if (!isDbConfigured()) throw Object.assign(new Error("Database is not configured."), { status: 503, code: "UNCONFIGURED" });

  async function load(workspaceId: string, eventId: string) {
    const [target] = await db.select().from(externalOutcomeEvents).where(and(eq(externalOutcomeEvents.workspaceId, workspaceId), eq(externalOutcomeEvents.id, eventId))).limit(1);
    if (!target?.growthProgramId) return null;
    const [programRow] = await db.select({
      id: developerGrowthPrograms.id,
      campaignId: developerGrowthPrograms.campaignId,
      policyVersionId: developerGrowthPrograms.policyVersionId,
      name: developerGrowthPrograms.name,
      slug: developerGrowthPrograms.slug,
      maxVerifiedCacMicroUsdc: developerGrowthPrograms.maxVerifiedCacMicroUsdc,
      rewardStructure: developerGrowthPrograms.rewardStructure,
      operatorMode: developerGrowthPrograms.operatorMode,
      budgetMicroUsdc: campaignPolicyVersions.budgetMicroUsdc,
      rewardCeilingMicroUsdc: campaignPolicyVersions.bountyCeilingMicroUsdc,
    }).from(developerGrowthPrograms).innerJoin(campaignPolicyVersions, eq(campaignPolicyVersions.id, developerGrowthPrograms.policyVersionId)).where(and(eq(developerGrowthPrograms.workspaceId, workspaceId), eq(developerGrowthPrograms.id, target.growthProgramId))).limit(1);
    if (!programRow) return null;
    const [funding] = await db.select({ status: campaignFundings.status }).from(campaignFundings).where(and(eq(campaignFundings.campaignId, programRow.campaignId), eq(campaignFundings.policyVersionId, programRow.policyVersionId))).limit(1);
    const program = toEvaluationProgram({ ...programRow, fundingStatus: funding?.status === "CONFIRMED" ? "FUNDED" : "NOT_FUNDED" });
    const [events, participants, identities, organizationMode] = await Promise.all([
      db.select().from(externalOutcomeEvents).where(and(eq(externalOutcomeEvents.workspaceId, workspaceId), eq(externalOutcomeEvents.growthProgramId, program.id))).orderBy(asc(externalOutcomeEvents.createdAt)),
      db.select().from(growthProgramParticipants).where(eq(growthProgramParticipants.growthProgramId, program.id)),
      db.select().from(growthAttributionIdentities).where(eq(growthAttributionIdentities.growthProgramId, program.id)),
      getOrganizationOperatorMode(workspaceId),
    ]);
    const participantsById = new Map(participants.map((row) => [row.id, row]));
    const participantByIdentity = new Map(identities.map((identity) => [identity.id, participantsById.get(identity.participantId) ?? null]));
    const snapshots: GrowthProgramEventSnapshot[] = events.map((event) => {
      const participant = event.attributionIdentityId ? participantByIdentity.get(event.attributionIdentityId) ?? null : null;
      return {
        event: event as ExternalOutcomeEventRow,
        participant: participant ? {
          id: participant.id,
          displayName: participant.displayName,
          status: participant.status,
          rewardPolicySnapshotJson: participant.rewardPolicySnapshotJson as Record<string, unknown>,
        } : null,
      };
    });
    return { program, snapshots, organizationMode };
  }

  return {
    async evaluate(params: { workspaceId: string; eventId: string }): Promise<GrowthProgramOutcomeEvaluation | null> {
      const context = await load(params.workspaceId, params.eventId);
      return context ? evaluateGrowthProgramOutcome({ program: context.program, events: context.snapshots, organizationMode: context.organizationMode, eventId: params.eventId }) : null;
    },
    async getSummary(params: { workspaceId: string; growthProgramId: string }): Promise<GrowthProgramOutcomeSummary | null> {
      const [firstEvent] = await db.select({ id: externalOutcomeEvents.id }).from(externalOutcomeEvents).where(and(eq(externalOutcomeEvents.workspaceId, params.workspaceId), eq(externalOutcomeEvents.growthProgramId, params.growthProgramId))).orderBy(asc(externalOutcomeEvents.createdAt)).limit(1);
      if (!firstEvent) return null;
      const context = await load(params.workspaceId, firstEvent.id);
      if (!context) return null;
      const evaluations = context.snapshots.map((row) => evaluateGrowthProgramOutcome({ program: context.program, events: context.snapshots, organizationMode: context.organizationMode, eventId: row.event.id }));
      const latest = evaluations[evaluations.length - 1] ?? null;
      const cfo = await loadCfoSnapshot(createDrizzleCampaignStore(db), params.workspaceId).catch(() => null);
      const cfoCampaign = cfo?.snapshot.campaigns.find((row) => row.campaignId === context.program.campaignId) ?? null;
      const verification = {
        submitted: evaluations.length,
        verified: evaluations.filter((row) => row.verification.state === "VERIFIED").length,
        review: evaluations.filter((row) => row.verification.state === "REVIEW").length,
        refused: evaluations.filter((row) => row.verification.state === "REFUSED").length,
      };
      return {
        program: latest?.program ?? {
          id: context.program.id,
          name: context.program.name,
          slug: context.program.slug,
          campaignId: context.program.campaignId,
          policyVersionId: context.program.policyVersionId,
          rewardStructure: context.program.rewardStructure,
          fundingStatus: context.program.fundingStatus,
        },
        economics: latest?.economics ?? {
          budgetCapMicroUsdc: context.program.budgetMicroUsdc.toString(),
          eligibleExposureMicroUsdc: "0",
          heldExposureMicroUsdc: "0",
          settledSpendMicroUsdc: "0",
          verificationExpenseMicroUsdc: "0",
          remainingAllocatableBudgetMicroUsdc: context.program.budgetMicroUsdc.toString(),
          verifiedOutcomeCount: 0,
          effectiveVerifiedCacMicroUsdc: null,
          verifiedCacStatus: "INSUFFICIENT_DATA" as const,
          targetCacMicroUsdc: context.program.maxVerifiedCacMicroUsdc.toString(),
          budgetState: context.program.budgetMicroUsdc > 0n ? "AVAILABLE" as const : "EXHAUSTED" as const,
          testnetVerificationSpendExcluded: true as const,
        },
        verification,
        settlement: {
          ready: evaluations.filter((row) => row.settlementEligibility.status === "READY").length,
          notReady: evaluations.filter((row) => row.settlementEligibility.status === "NOT_READY").length,
          settled: evaluations.filter((row) => row.settlementEligibility.status === "SETTLED").length,
          actualPaidMicroUsdc: "0",
        },
        operator: {
          mode: latest?.operatorDecision.mode ?? context.organizationMode,
          latestRecommendation: latest?.operatorDecision.recommendation ?? null,
          latestReasonCodes: latest?.operatorDecision.reasonCodes ?? [],
          latestEventId: latest?.eventId ?? null,
        },
        finance: {
          campaignCfo: cfoCampaign ? "AVAILABLE" : "UNAVAILABLE",
          campaignId: context.program.campaignId,
          availableMicroUsdc: cfoCampaign?.financials.availableMicroUsdc ?? null,
          budgetHeadroomMicroUsdc: cfoCampaign?.budgetHeadroomMicroUsdc ?? null,
        },
        portfolio: {
          recommendation: "NOT_INCLUDED",
          chainMovement: "UNAVAILABLE",
          reason: "Outcome Portfolio V1 remains campaign-only; no cross-campaign or program capital movement is fabricated.",
        },
      };
    },
  };
}

export function createProductionGrowthProgramOutcomeEvaluator() {
  const service = createProductionGrowthProgramOutcomeService();
  return (params: { workspaceId: string; eventId: string }) => service.evaluate(params);
}