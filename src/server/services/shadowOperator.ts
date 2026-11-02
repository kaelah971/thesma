import { desc, eq } from "drizzle-orm";
import { newId } from "../auth/session";
import { getDb, isDbConfigured } from "../db/client";
import { auditEvents } from "../db/schema";
import type { AuditSink, MarketStore } from "./campaignStore";
import { loadCfoSnapshot } from "./cfo";
import {
  decideObligation,
  HeuristicOperatorPlanner,
  loadOperatorInput,
  type OperatorPolicy,
  type OperatorDecision,
} from "./operator";
import { evaluateVerificationCheck, type EvaluateResult, type ProcurementDeps } from "./verificationProcurement";
import type { CheckType } from "./verification";
import { loadOutcomePortfolioPlan, type OutcomePortfolioPlan } from "./outcomePortfolio";
import type { OrganizationOperatorMode } from "./operatorMode";

export type ShadowDecisionFamily = "OUTCOME_PORTFOLIO" | "VERIFICATION_PROCUREMENT" | "FINANCIAL_SETTLEMENT";
export type ShadowHumanResponse = "AGREE" | "OVERRIDE" | "IGNORE";
export type ShadowExecutionStatus = "NOT_EXECUTED";

export const SHADOW_DECISION_GENERATED_ACTION = "shadow.decision.generated";
export const SHADOW_DECISION_RESPONDED_ACTION = "shadow.decision.responded";

export interface ShadowDecisionResponse {
  response: ShadowHumanResponse;
  reason: string | null;
  respondedAt: string;
  respondedByUserId: string | null;
}

export interface ShadowDecisionRecord {
  id: string;
  runId: string;
  workspaceId: string;
  family: ShadowDecisionFamily;
  targetId: string;
  recommendation: string;
  amountMicroUsdc: string | null;
  confidence: string | null;
  reasons: string[];
  inputSnapshot: unknown;
  policySnapshot: unknown;
  generatedAt: string;
  executionStatus: ShadowExecutionStatus;
  response: ShadowDecisionResponse | null;
}

export interface ShadowTelemetryBucket {
  generated: number;
  reviewed: number;
  agreements: number;
  overrides: number;
  ignored: number;
  agreementRateBps: number | null;
}

export interface ShadowTelemetry extends ShadowTelemetryBucket {
  byFamily: Record<string, ShadowTelemetryBucket>;
  byConfidence: Record<string, ShadowTelemetryBucket>;
}

export interface ShadowVerificationRequest {
  campaignId: string;
  outcomeId?: string;
  providerId?: string;
  checkType?: CheckType;
  currentConfidenceBps?: number;
  requiredConfidenceBps?: number;
}

export interface ShadowRunParams {
  store: MarketStore;
  audit: AuditSink;
  workspaceId: string;
  now?: Date;
  verificationChecks?: ShadowVerificationRequest[];
  includeSettlement?: boolean;
  /** Test seam and a way to reuse one already-wired procurement evaluator. */
  evaluateVerification?: (request: ShadowVerificationRequest) => Promise<EvaluateResult>;
  verificationDeps?: Omit<ProcurementDeps, "store" | "audit" | "now">;
}

export interface ShadowRunResult {
  runId: string;
  generatedAt: string;
  mode: Extract<OrganizationOperatorMode, "SHADOW">;
  decisions: ShadowDecisionRecord[];
  telemetry: ShadowTelemetry;
  boundary: {
    executionStatus: ShadowExecutionStatus;
    payments: "BLOCKED";
    x402: "BLOCKED";
    capitalMovement: "BLOCKED";
    creatorInvites: "BLOCKED";
    settlements: "BLOCKED";
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** JSON-safe snapshots retain bigint exactness without letting JSON stringify become financial logic. */
export function toShadowJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toShadowJson(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = toShadowJson(item);
    }
    return out;
  }
  return value;
}

function rateBps(reviewed: number, agreements: number): number | null {
  if (reviewed <= 0) return null;
  // Nearest basis point: the fixture 2/3 is truthfully 6,667 bps, not 6,666.
  return Math.floor((agreements * 10_000 + Math.floor(reviewed / 2)) / reviewed);
}

function emptyBucket(): ShadowTelemetryBucket {
  return { generated: 0, reviewed: 0, agreements: 0, overrides: 0, ignored: 0, agreementRateBps: null };
}

function finishBucket(bucket: ShadowTelemetryBucket): ShadowTelemetryBucket {
  return { ...bucket, agreementRateBps: rateBps(bucket.reviewed, bucket.agreements) };
}

/** Pure organization/family/confidence telemetry reducer. */
export function summarizeShadowTelemetry(decisions: readonly ShadowDecisionRecord[]): ShadowTelemetry {
  const overall = emptyBucket();
  const byFamily: Record<string, ShadowTelemetryBucket> = {};
  const byConfidence: Record<string, ShadowTelemetryBucket> = {};
  const buckets = (record: Record<string, ShadowTelemetryBucket>, key: string) => (record[key] ??= emptyBucket());

  for (const decision of decisions) {
    const family = buckets(byFamily, decision.family);
    const confidence = buckets(byConfidence, decision.confidence ?? "UNKNOWN");
    for (const bucket of [overall, family, confidence]) {
      bucket.generated += 1;
      const response = decision.response?.response;
      if (!response) continue;
      bucket.reviewed += 1;
      if (response === "AGREE") bucket.agreements += 1;
      if (response === "OVERRIDE") bucket.overrides += 1;
      if (response === "IGNORE") bucket.ignored += 1;
    }
  }

  return {
    ...finishBucket(overall),
    byFamily: Object.fromEntries(Object.entries(byFamily).map(([key, bucket]) => [key, finishBucket(bucket)])),
    byConfidence: Object.fromEntries(Object.entries(byConfidence).map(([key, bucket]) => [key, finishBucket(bucket)])),
  };
}

export function normalizeSettlementRecommendation(decision: OperatorDecision): string {
  if (decision.decision === "WAIT_FOR_HOLD" || decision.decision === "HOLD_FOR_LIQUIDITY") return "HOLD";
  return decision.decision;
}

export function normalizeVerificationRecommendation(decision: string): string {
  if (decision === "BUY_CHECK") return "WOULD_BUY";
  if (decision === "NO_CHECK") return "WOULD_SKIP";
  return decision;
}

export function buildShadowDecision(
  input: Omit<ShadowDecisionRecord, "id" | "response" | "executionStatus"> & { id?: string },
): ShadowDecisionRecord {
  return {
    id: input.id ?? newId(),
    runId: input.runId,
    workspaceId: input.workspaceId,
    family: input.family,
    targetId: input.targetId,
    recommendation: input.recommendation,
    amountMicroUsdc: input.amountMicroUsdc,
    confidence: input.confidence,
    reasons: [...input.reasons],
    inputSnapshot: toShadowJson(input.inputSnapshot),
    policySnapshot: toShadowJson(input.policySnapshot),
    generatedAt: input.generatedAt,
    executionStatus: "NOT_EXECUTED",
    response: null,
  };
}

/** Append one immutable generated recommendation plus its exact inputs and policy. */
export async function recordShadowDecision(audit: AuditSink, decision: ShadowDecisionRecord): Promise<void> {
  await audit({
    actorType: "AGENT",
    actorId: null,
    workspaceId: decision.workspaceId,
    action: SHADOW_DECISION_GENERATED_ACTION,
    targetType: "shadow_decision",
    targetId: decision.id,
    metadata: {
      decisionId: decision.id,
      runId: decision.runId,
      workspaceId: decision.workspaceId,
      family: decision.family,
      targetId: decision.targetId,
      recommendation: decision.recommendation,
      amountMicroUsdc: decision.amountMicroUsdc,
      confidence: decision.confidence,
      reasons: [...decision.reasons],
      inputSnapshot: toShadowJson(decision.inputSnapshot),
      policySnapshot: toShadowJson(decision.policySnapshot),
      generatedAt: decision.generatedAt,
      executionStatus: decision.executionStatus,
    },
  });
}

function rowToDecision(row: { id: string; targetId: string | null; metadata: unknown; createdAt: Date | string | null }): ShadowDecisionRecord | null {
  const metadata = asRecord(row.metadata);
  const id = asString(metadata.decisionId) ?? row.targetId;
  const family = asString(metadata.family);
  const workspaceId = asString(metadata.workspaceId);
  if (!id || !workspaceId || (family !== "OUTCOME_PORTFOLIO" && family !== "VERIFICATION_PROCUREMENT" && family !== "FINANCIAL_SETTLEMENT")) return null;
  const generatedAt = asString(metadata.generatedAt) ?? (row.createdAt ? new Date(row.createdAt).toISOString() : new Date(0).toISOString());
  return {
    id,
    runId: asString(metadata.runId) ?? "unknown",
    workspaceId,
    family,
    targetId: asString(metadata.targetId) ?? "unknown",
    recommendation: asString(metadata.recommendation) ?? "REVIEW",
    amountMicroUsdc: asString(metadata.amountMicroUsdc),
    confidence: asString(metadata.confidence),
    reasons: Array.isArray(metadata.reasons) ? metadata.reasons.filter((value): value is string => typeof value === "string") : [],
    inputSnapshot: metadata.inputSnapshot ?? null,
    policySnapshot: metadata.policySnapshot ?? null,
    generatedAt,
    executionStatus: "NOT_EXECUTED",
    response: null,
  };
}

/** Read generated decisions and response events from the append-only decision ledger. */
export async function listShadowDecisions(workspaceId: string, limit = 200): Promise<ShadowDecisionRecord[]> {
  if (!isDbConfigured()) return [];
  const rows = await getDb()
    .select({ id: auditEvents.id, targetId: auditEvents.targetId, action: auditEvents.action, metadata: auditEvents.metadata, createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  const decisions = rows.filter((row) => row.action === SHADOW_DECISION_GENERATED_ACTION).map(rowToDecision).filter((row): row is ShadowDecisionRecord => row !== null);
  const responses = rows.filter((row) => row.action === SHADOW_DECISION_RESPONDED_ACTION);
  const responseByDecision = new Map<string, ShadowDecisionResponse>();
  for (const row of responses) {
    const metadata = asRecord(row.metadata);
    const decisionId = asString(metadata.decisionId) ?? row.targetId;
    const response = asString(metadata.response);
    if (!decisionId || (response !== "AGREE" && response !== "OVERRIDE" && response !== "IGNORE") || responseByDecision.has(decisionId)) continue;
    responseByDecision.set(decisionId, {
      response,
      reason: asString(metadata.reason),
      respondedAt: asString(metadata.respondedAt) ?? (row.createdAt ? new Date(row.createdAt).toISOString() : new Date(0).toISOString()),
      respondedByUserId: asString(metadata.respondedByUserId),
    });
  }
  return decisions.map((decision) => ({ ...decision, response: responseByDecision.get(decision.id) ?? null }));
}

/** Append a human response; generated rows are never updated in place. */
export async function recordShadowResponse(
  audit: AuditSink,
  decision: ShadowDecisionRecord,
  params: { response: ShadowHumanResponse; reason?: string | null; userId: string; respondedAt?: Date },
): Promise<ShadowDecisionResponse> {
  if (params.response === "OVERRIDE" && !params.reason?.trim()) {
    throw Object.assign(new Error("Override reason is required."), { status: 400, code: "OVERRIDE_REASON_REQUIRED" });
  }
  const respondedAt = (params.respondedAt ?? new Date()).toISOString();
  const response: ShadowDecisionResponse = {
    response: params.response,
    reason: params.reason?.trim() || null,
    respondedAt,
    respondedByUserId: params.userId,
  };
  await audit({
    actorType: "USER",
    actorId: params.userId,
    workspaceId: decision.workspaceId,
    action: SHADOW_DECISION_RESPONDED_ACTION,
    targetType: "shadow_decision",
    targetId: decision.id,
    metadata: {
      decisionId: decision.id,
      family: decision.family,
      recommendation: decision.recommendation,
      confidence: decision.confidence,
      response: response.response,
      reason: response.reason,
      respondedAt,
      respondedByUserId: params.userId,
    },
  });
  return response;
}

function policySnapshot(policy: OperatorPolicy): Record<string, unknown> {
  return toShadowJson({
    minReserveMicroUsdc: policy.minReserveMicroUsdc,
    maxAutonomousPaymentMicroUsdc: policy.maxAutonomousPaymentMicroUsdc,
    maxAutonomousSpendPerPeriodMicroUsdc: policy.maxAutonomousSpendPerPeriodMicroUsdc,
  }) as Record<string, unknown>;
}

function portfolioPolicySnapshot(plan: OutcomePortfolioPlan, operatorPolicy: OperatorPolicy): Record<string, unknown> {
  return toShadowJson({ outcomePortfolio: plan.policyConstraints, operator: policySnapshot(operatorPolicy) }) as Record<string, unknown>;
}

async function defaultVerificationEvaluator(
  params: ShadowRunParams,
  request: ShadowVerificationRequest,
  now: Date,
): Promise<EvaluateResult> {
  const deps: ProcurementDeps = {
    ...(params.verificationDeps ?? {}),
    store: params.store,
    audit: params.audit,
    now: () => now,
  };
  return evaluateVerificationCheck(deps, {
    workspaceId: params.workspaceId,
    campaignId: request.campaignId,
    ...(request.outcomeId ? { outcomeId: request.outcomeId } : {}),
    ...(request.providerId ? { providerId: request.providerId } : {}),
    ...(request.checkType ? { checkType: request.checkType } : {}),
    ...(request.currentConfidenceBps !== undefined && request.requiredConfidenceBps !== undefined
      ? { confidenceBps: { current: request.currentConfidenceBps, required: request.requiredConfidenceBps } }
      : {}),
    executionMode: "SHADOW",
  });
}

/**
 * Run the existing deterministic kernels as recommendations only. This function
 * never calls payout, invite, funding, x402 purchase, or settlement primitives.
 */
export async function runShadowOperator(params: ShadowRunParams): Promise<ShadowRunResult> {
  const now = params.now ?? new Date();
  const generatedAt = now.toISOString();
  const runId = newId();
  const { snapshot, operatorPolicy } = await loadCfoSnapshot(params.store, params.workspaceId, { now });
  const portfolio = await loadOutcomePortfolioPlan(snapshot, { store: params.store, operatorPolicy, now });
  const decisions: ShadowDecisionRecord[] = [];

  for (const member of portfolio.members) {
    const decision = buildShadowDecision({
      runId,
      workspaceId: params.workspaceId,
      family: "OUTCOME_PORTFOLIO",
      targetId: member.memberId,
      recommendation: member.recommendation,
      amountMicroUsdc: member.recommendedNextAllocationMicro,
      confidence: member.confidence,
      reasons: member.humanReadableReasons.length ? member.humanReadableReasons : member.reasonCodes,
      inputSnapshot: {
        cfoSnapshot: snapshot,
        portfolioPlan: portfolio,
        member,
      },
      policySnapshot: portfolioPolicySnapshot(portfolio, operatorPolicy),
      generatedAt,
    });
    await recordShadowDecision(params.audit, decision);
    decisions.push(decision);
  }

  const liveCampaigns = snapshot.campaigns.filter((campaign) => campaign.state === "LIVE" && campaign.marketStatus === "OPEN");
  const verificationRequests: ShadowVerificationRequest[] = params.verificationChecks ?? liveCampaigns.map((campaign) => ({ campaignId: campaign.campaignId }));
  const evaluateVerification = params.evaluateVerification ?? ((request: ShadowVerificationRequest) => defaultVerificationEvaluator(params, request, now));
  const procurementPolicyRows = await params.store.getProcurementPolicy(params.workspaceId).catch(() => null);
  for (const request of verificationRequests.slice(0, 20)) {
    const result = await evaluateVerification(request);
    const decision = buildShadowDecision({
      runId,
      workspaceId: params.workspaceId,
      family: "VERIFICATION_PROCUREMENT",
      targetId: request.outcomeId ?? request.campaignId,
      recommendation: normalizeVerificationRecommendation(result.decision.decision),
      amountMicroUsdc: result.decision.costMicroUsdc,
      confidence: null,
      reasons: result.decision.reasons,
      inputSnapshot: { request, result },
      policySnapshot: {
        procurement: procurementPolicyRows,
        operator: policySnapshot(operatorPolicy),
      },
      generatedAt,
    });
    await recordShadowDecision(params.audit, decision);
    decisions.push(decision);
  }

  if (params.includeSettlement !== false) {
    const operatorInput = await loadOperatorInput(params.store, params.workspaceId, operatorPolicy, now);
    const planner = new HeuristicOperatorPlanner();
    const plannerRecommendation = await planner.plan(operatorInput.snapshot, operatorPolicy);
    for (const obligation of operatorInput.snapshot.obligations) {
      const kernelDecision = decideObligation(
        operatorInput.snapshot,
        obligation,
        operatorPolicy,
        operatorInput.spentThisPeriodMicroUsdc,
      );
      const decision = buildShadowDecision({
        runId,
        workspaceId: params.workspaceId,
        family: "FINANCIAL_SETTLEMENT",
        targetId: obligation.outcomeId,
        recommendation: normalizeSettlementRecommendation(kernelDecision),
        amountMicroUsdc: kernelDecision.amountMicroUsdc,
        confidence: null,
        reasons: [kernelDecision.reason, `Rule: ${kernelDecision.rule}.`],
        inputSnapshot: {
          operatorSnapshot: operatorInput.snapshot,
          obligation,
          plannerRecommendation,
          kernelDecision,
        },
        policySnapshot: policySnapshot(operatorPolicy),
        generatedAt,
      });
      await recordShadowDecision(params.audit, decision);
      decisions.push(decision);
    }
  }

  return {
    runId,
    generatedAt,
    mode: "SHADOW",
    decisions,
    telemetry: summarizeShadowTelemetry(decisions),
    boundary: {
      executionStatus: "NOT_EXECUTED",
      payments: "BLOCKED",
      x402: "BLOCKED",
      capitalMovement: "BLOCKED",
      creatorInvites: "BLOCKED",
      settlements: "BLOCKED",
    },
  };
}
