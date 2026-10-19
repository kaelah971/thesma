import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  checkoutIntents,
  growthPolicies,
  outcomes,
  partners,
  payouts,
  referralEvents,
  referrals,
  userPersonas,
  users,
} from "../db/schema";
import {
  derivePace,
  evaluatePricing,
  paceRatioBps,
  type KernelInputs,
  type PaceState,
} from "../domain/pricing";
import { committedForCampaign } from "./payouts";
import { countSettledPayouts } from "./markets";
import type { MarketStore } from "./campaignStore";
import { recordAuditEvent } from "./audit";
import type { Db } from "../db/client";

/**
 * Autonomous Growth Intelligence v1.
 *
 * AI MAY OPTIMIZE. POLICY REMAINS FINAL AUTHORITY.
 *
 * - Pace, performance, allocation, and forecast math below is PURE.
 * - Bounty changes reuse the proven S6 kernel (evaluatePricing) and its
 *   SAFE execution path (evaluateMarket: versioned market bump, frozen
 *   partnerTerms untouched). The growth gate sits IN FRONT: nothing
 *   executes unless human-set policy, evidence, bounds, and liquidity
 *   all permit. The kernel can never be bypassed — recommendations that
 *   fail the gate become NO_ACTION or ESCALATE_BOUNTY.
 * - No follower counts. No fabricated metrics. Tiny samples are damped,
 *   newcomers keep an exploration floor, forecasts are labeled ESTIMATE.
 */

export type PaceStatus = "AHEAD" | "ON_PACE" | "BEHIND" | "AT_RISK" | "COMPLETE";

export interface PaceInput {
  targetOutcomeCount: number;
  verifiedOutcomeCount: number;
  settledOutcomeCount: number;
  openedAtMs: number;
  deadlineMs: number;
  nowMs: number;
  publicBountyMicroUsdc: bigint;
  fundedMicroUsdc: bigint;
  committedMicroUsdc: bigint;
  availableMicroUsdc: bigint;
}

export interface PaceSnapshot extends PaceInput {
  targetProgressPct: number;
  timeProgressPct: number;
  elapsedDays: number;
  remainingDays: number;
  verifiedOutcomesPerDay: number;
  requiredOutcomesPerDay: number;
  projectedOutcomesAtCurrentPace: number;
  estimatedFundingRequiredMicroUsdc: string;
  paceStatus: PaceStatus;
  kernelPace: PaceState;
}

const DAY_MS = 86_400_000;

function pct(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction < 0) return 0;
  return Math.min(100, Math.round(fraction * 10000) / 100);
}

/** Pure pace kernel. Honest about zero/missing/expired inputs. */
export function buildPaceSnapshot(input: PaceInput): PaceSnapshot {
  const elapsedDays = Math.max(0, (input.nowMs - input.openedAtMs) / DAY_MS);
  const remainingDays = Math.max(0, (input.deadlineMs - input.nowMs) / DAY_MS);
  const totalDays = Math.max(elapsedDays + remainingDays, 1 / 24);
  const remaining = Math.max(0, input.targetOutcomeCount - input.verifiedOutcomeCount);
  const verifiedPerDay = elapsedDays > 1 / 24 ? input.verifiedOutcomeCount / elapsedDays : 0;
  const requiredPerDay = remainingDays > 0 ? remaining / remainingDays : remaining > 0 ? Number.POSITIVE_INFINITY : 0;
  const projected = input.verifiedOutcomeCount + verifiedPerDay * remainingDays;
  const stillNeeded = Math.max(0, input.targetOutcomeCount - Math.floor(projected));
  const kernelPace = derivePace(
    {
      publicBountyMicroUsdc: input.publicBountyMicroUsdc,
      bountyFloorMicroUsdc: 0n,
      bountyCeilingMicroUsdc: input.publicBountyMicroUsdc > 0n ? input.publicBountyMicroUsdc * 1000n : 1n,
      fundedMicroUsdc: input.fundedMicroUsdc,
      committedMicroUsdc: input.committedMicroUsdc,
      targetOutcomeCount: Math.max(1, input.targetOutcomeCount),
      verifiedOutcomeCount: input.verifiedOutcomeCount,
      openedAtMs: input.openedAtMs,
      deadlineMs: input.deadlineMs,
      nowMs: input.nowMs,
      recentJoins: 0,
      recentVerified: 0,
      msSinceLastReprice: null,
      marketStatus: "OPEN",
      campaignState: "LIVE",
    } satisfies KernelInputs,
  );
  let paceStatus: PaceStatus;
  if (remaining <= 0) paceStatus = "COMPLETE";
  else if (input.nowMs >= input.deadlineMs) paceStatus = "AT_RISK";
  else if (kernelPace === "EXHAUSTED") paceStatus = "AT_RISK";
  else if (kernelPace === "UNDER_PACED") paceStatus = pct(elapsedDays / totalDays) > 75 ? "AT_RISK" : "BEHIND";
  else if (kernelPace === "OVER_PACED") paceStatus = "AHEAD";
  else paceStatus = "ON_PACE";
  return {
    ...input,
    targetProgressPct: input.targetOutcomeCount > 0 ? pct(input.verifiedOutcomeCount / input.targetOutcomeCount) : 0,
    timeProgressPct: pct(elapsedDays / totalDays),
    elapsedDays: Math.round(elapsedDays * 100) / 100,
    remainingDays: Math.round(remainingDays * 100) / 100,
    verifiedOutcomesPerDay: Math.round(verifiedPerDay * 100) / 100,
    requiredOutcomesPerDay: requiredPerDay === Number.POSITIVE_INFINITY ? -1 : Math.round(requiredPerDay * 100) / 100,
    projectedOutcomesAtCurrentPace: Math.floor(projected),
    estimatedFundingRequiredMicroUsdc: (BigInt(stillNeeded) * input.publicBountyMicroUsdc).toString(),
    paceStatus,
    kernelPace,
  };
}

/* ---------------- Creator performance (pure) ---------------- */

export interface CreatorPerformanceInput {
  partnerId: string;
  label: string;
  clicks: number;
  /** Real checkout intents (actions), any status. */
  actions: number;
  verifiedOutcomeIds: string[];
  settledOutcomeIds: string[];
  settledPayoutMicroUsdc: bigint;
  /** Verified outcomes inside the evidence window. */
  recentVerified: number;
  evidenceWindowDays: number;
}

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface CreatorPerformance extends CreatorPerformanceInput {
  verifiedOutcomes: number;
  settledOutcomes: number;
  verificationRate: number;
  visitToVerifiedRate: number;
  settledUSDC: string;
  recentVerifiedVelocity: number;
  sampleSize: number;
  confidence: Confidence;
}

/** Pure aggregation. Tiny samples are labeled, never hidden, never hype-amplified. */
export function summarizeCreatorPerformance(input: CreatorPerformanceInput): CreatorPerformance {
  const verified = input.verifiedOutcomeIds.length;
  const settled = input.settledOutcomeIds.length;
  const confidence: Confidence = input.actions >= 10 ? "HIGH" : input.actions >= 3 ? "MEDIUM" : "LOW";
  return {
    ...input,
    verifiedOutcomes: verified,
    settledOutcomes: settled,
    verificationRate: input.actions > 0 ? pct(verified / input.actions) : 0,
    visitToVerifiedRate: input.clicks > 0 ? pct(verified / input.clicks) : 0,
    settledUSDC: input.settledPayoutMicroUsdc.toString(),
    recentVerifiedVelocity:
      input.evidenceWindowDays > 0 ? Math.round((input.recentVerified / input.evidenceWindowDays) * 100) / 100 : 0,
    sampleSize: input.actions,
    confidence,
  };
}

/* ---------------- Human-controlled optimization policy ---------------- */

export interface GrowthPolicy {
  optimizationEnabled: boolean;
  /** Max single bounty move, percent (maps to kernel maxStepBps). */
  maxBountyChangePct: number;
  /** Minimum recent joins+verified before any autonomous change. */
  minimumEvidence: number;
  /** Evidence/lookback window, days. */
  evaluationWindowDays: number;
}

export const DEFAULT_GROWTH_POLICY: GrowthPolicy = {
  optimizationEnabled: false,
  maxBountyChangePct: 25,
  minimumEvidence: 5,
  evaluationWindowDays: 7,
};

const MISSING_RELATION = /relation .* does not exist/i;

export async function getGrowthPolicy(workspaceId: string): Promise<GrowthPolicy | null> {
  try {
    const db = getDb();
    const [row] = await db.select().from(growthPolicies).where(eq(growthPolicies.workspaceId, workspaceId)).limit(1);
    if (!row) return null;
    return {
      optimizationEnabled: row.optimizationEnabled,
      maxBountyChangePct: row.maxBountyChangePct,
      minimumEvidence: row.minimumEvidence,
      evaluationWindowDays: row.evaluationWindowDays,
    };
  } catch (err) {
    if (MISSING_RELATION.test(err instanceof Error ? err.message : String(err ?? ""))) return null;
    throw err;
  }
}

export async function setGrowthPolicy(workspaceId: string, policy: GrowthPolicy, updatedByUserId: string): Promise<void> {
  if (policy.maxBountyChangePct <= 0 || policy.maxBountyChangePct > 100) {
    throw Object.assign(new Error("maxBountyChangePct must be 1–100"), { status: 400, code: "BAD_REQUEST" });
  }
  if (policy.minimumEvidence < 0) {
    throw Object.assign(new Error("minimumEvidence must be ≥ 0"), { status: 400, code: "BAD_REQUEST" });
  }
  if (policy.evaluationWindowDays < 1 || policy.evaluationWindowDays > 90) {
    throw Object.assign(new Error("evaluationWindowDays must be 1–90"), { status: 400, code: "BAD_REQUEST" });
  }
  const db = getDb();
  await db
    .insert(growthPolicies)
    .values({
      workspaceId,
      optimizationEnabled: policy.optimizationEnabled,
      maxBountyChangePct: policy.maxBountyChangePct,
      minimumEvidence: policy.minimumEvidence,
      evaluationWindowDays: policy.evaluationWindowDays,
      updatedByUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: growthPolicies.workspaceId,
      set: {
        optimizationEnabled: policy.optimizationEnabled,
        maxBountyChangePct: policy.maxBountyChangePct,
        minimumEvidence: policy.minimumEvidence,
        evaluationWindowDays: policy.evaluationWindowDays,
        updatedByUserId,
        updatedAt: new Date(),
      },
    });
}

/* ---------------- Bounty decision gate (pure) ---------------- */

export type BountyAction = "KEEP_BOUNTY" | "INCREASE_BOUNTY" | "DECREASE_BOUNTY" | "ESCALATE_BOUNTY" | "NO_ACTION";

export interface BountyBounds {
  bountyFloorMicroUsdc: bigint;
  /** Human ceiling from the policy version; contract ceiling, hard max. */
  bountyCeilingMicroUsdc: bigint;
}

export interface BountyDecision {
  action: BountyAction;
  currentBountyMicroUsdc: string;
  recommendedBountyMicroUsdc: string | null;
  reason: string;
  rule: string;
  bounded: boolean;
}

/**
 * The growth gate. Runs the proven S6 kernel for direction, then enforces
 * human authority on top: disabled → NO_ACTION; thin evidence → NO_ACTION;
 * needed move beyond maxPct or outside [floor, ceiling] → ESCALATE_BOUNTY.
 * A planner/LLM can only nominate; this function alone permits.
 */
export function decideBountyChange(params: {
  pace: PaceSnapshot;
  kernelInputs: KernelInputs;
  recentJoins: number;
  recentVerified: number;
  availableMicroUsdc: bigint;
  bounds: BountyBounds;
  policy: GrowthPolicy;
}): BountyDecision {
  const { pace, kernelInputs, recentJoins, recentVerified, availableMicroUsdc, bounds, policy } = params;
  const current = kernelInputs.publicBountyMicroUsdc.toString();
  const idle = (action: BountyAction, reason: string, rule: string): BountyDecision => ({
    action,
    currentBountyMicroUsdc: current,
    recommendedBountyMicroUsdc: null,
    reason,
    rule,
    bounded: true,
  });
  if (!policy.optimizationEnabled) return idle("NO_ACTION", "Autonomous optimization is disabled by the organization.", "OPTIMIZATION_DISABLED");
  const evidence = recentJoins + recentVerified;
  if (evidence < policy.minimumEvidence) {
    return idle("NO_ACTION", `Only ${evidence} recent signals (need ${policy.minimumEvidence}).`, "INSUFFICIENT_EVIDENCE");
  }
  if (bounds.bountyFloorMicroUsdc > bounds.bountyCeilingMicroUsdc || bounds.bountyCeilingMicroUsdc <= 0n) {
    return idle("NO_ACTION", "Policy bounds are incoherent; refusing to price.", "INVALID_BOUNDS");
  }
  const kernel = evaluatePricing(kernelInputs, {
    toleranceBps: 1500,
    minChangeBps: 500,
    maxStepBps: Math.max(1, Math.round(policy.maxBountyChangePct * 100)),
    cooldownMs: 3_600_000,
    demandWindowMs: policy.evaluationWindowDays * 86_400_000,
  });
  if (kernel.decision === "KEEP") {
    if ((kernel.reasons as string[]).includes("AT_CEILING") && (pace.paceStatus === "BEHIND" || pace.paceStatus === "AT_RISK")) {
      return {
        action: "ESCALATE_BOUNTY",
        currentBountyMicroUsdc: current,
        recommendedBountyMicroUsdc: bounds.bountyCeilingMicroUsdc.toString(),
        reason: "Pace is behind but the bounty already sits at the human ceiling — only the owner can raise it.",
        rule: "BOUNDS_EXCEEDED",
        bounded: false,
      };
    }
    return { ...idle("KEEP_BOUNTY", `Pace is ${pace.paceStatus.toLowerCase()} (${kernel.reasons.join(", ")}).`, "PACE_OK"), action: "KEEP_BOUNTY" };
  }
  if (kernel.decision === "PAUSE") {
    return idle("NO_ACTION", `Market needs pause (${kernel.reasons.join(", ")}) — bounty gate takes no pricing action on paused markets.`, "MARKET_PAUSED");
  }
  // REPRICE: clamp into human + contract bounds, escalate what doesn't fit.
  // A pace gap larger than one autonomous step needs owner-sized moves.
  const gapBps = Math.abs((paceRatioBps(kernelInputs) ?? 10_000) - 10_000);
  const stepBps = Math.max(1, Math.round(policy.maxBountyChangePct * 100));
  const raw = kernel.newBountyMicroUsdc as bigint;
  const clamped = raw < bounds.bountyFloorMicroUsdc ? bounds.bountyFloorMicroUsdc : raw > bounds.bountyCeilingMicroUsdc ? bounds.bountyCeilingMicroUsdc : raw;
  const maxStep = (kernelInputs.publicBountyMicroUsdc * BigInt(Math.max(1, Math.round(policy.maxBountyChangePct * 100)))) / 10_000n;
  const move = clamped > kernelInputs.publicBountyMicroUsdc ? clamped - kernelInputs.publicBountyMicroUsdc : kernelInputs.publicBountyMicroUsdc - clamped;
  if (raw !== clamped) {
    return {
      action: "ESCALATE_BOUNTY",
      currentBountyMicroUsdc: current,
      recommendedBountyMicroUsdc: clamped.toString(),
      reason: `Needed ${raw} but human bounds require [${bounds.bountyFloorMicroUsdc}, ${bounds.bountyCeilingMicroUsdc}].`,
      rule: "BOUNDS_EXCEEDED",
      bounded: false,
    };
  }
  if (gapBps > stepBps) {
    return {
      action: "ESCALATE_BOUNTY",
      currentBountyMicroUsdc: current,
      recommendedBountyMicroUsdc: clamped.toString(),
      reason: `Pace gap needs more than the ${policy.maxBountyChangePct}% autonomous step — owner-sized move required.`,
      rule: "STEP_EXCEEDED",
      bounded: false,
    };
  }
  if (move > maxStep) {
    return {
      action: "ESCALATE_BOUNTY",
      currentBountyMicroUsdc: current,
      recommendedBountyMicroUsdc: clamped.toString(),
      reason: `Needed move exceeds the ${policy.maxBountyChangePct}% autonomous step.`,
      rule: "STEP_EXCEEDED",
      bounded: false,
    };
  }
  if (clamped > kernelInputs.publicBountyMicroUsdc && clamped > availableMicroUsdc) {
    return idle("NO_ACTION", "Increase is unaffordable against available liquidity.", "BUDGET_CONSTRAINED");
  }
  return {
    action: clamped > kernelInputs.publicBountyMicroUsdc ? "INCREASE_BOUNTY" : "DECREASE_BOUNTY",
    currentBountyMicroUsdc: current,
    recommendedBountyMicroUsdc: clamped.toString(),
    reason: `Pace is ${pace.paceStatus.toLowerCase()} (${kernel.reasons.join(", ")}); bounded move within human limits.`,
    rule: "BOUNDED_ADJUSTMENT",
    bounded: true,
  };
}

/* ---------------- Creator allocation (pure) ---------------- */

export interface AllocationEntry {
  partnerId: string;
  label: string;
  priority: number;
  sharePct: number;
  reason: string;
  confidence: Confidence;
  sampleSize: number;
  evidence: { verified: number; recentVerified: number; visitToVerifiedRate: number };
}

/**
 * Evidence-weighted shares with Laplace smoothing (+1/+2) so tiny samples
 * cannot dominate, plus a 5% exploration floor per zero-sample creator
 * (total exploration capped at 20%). Never pays — priority only.
 */
export function recommendAllocation(performances: CreatorPerformance[]): AllocationEntry[] {
  if (performances.length === 0) return [];
  const newcomers = performances.filter((p) => p.sampleSize === 0);
  const explorationTotal = Math.min(20, newcomers.length * 5);
  const explorationEach = newcomers.length > 0 ? explorationTotal / newcomers.length : 0;
  const scored = performances
    .filter((p) => p.sampleSize > 0)
    .map((p) => {
      const rate = (p.verifiedOutcomes + 1) / (p.sampleSize + 2);
      const score = rate * (1 + Math.log10(1 + p.sampleSize)) + p.recentVerifiedVelocity * 0.5;
      return { p, score: p.confidence === "LOW" ? Math.min(score, 0.6) : score };
    })
    .sort((a, b) => b.score - a.score);
  const weightSum = scored.reduce((s, x) => s + x.score, 0);
  const distributable = 100 - explorationTotal;
  // LOW-confidence entries are capped so thin evidence can never dominate.
  const LOW_SHARE_CAP = 15;
  const entries: AllocationEntry[] = scored.map(({ p, score }, i) => ({
    partnerId: p.partnerId,
    label: p.label,
    priority: i + 1,
    sharePct: weightSum > 0 ? Math.round(((score / weightSum) * distributable + Number.EPSILON) * 100) / 100 : 0,
    reason:
      p.confidence === "LOW"
        ? `${p.verifiedOutcomes} verified of ${p.sampleSize} actions — small sample, share capped.`
        : `${p.verifiedOutcomes} verified of ${p.sampleSize} actions (${p.verificationRate}% conversion).`,
    confidence: p.confidence,
    sampleSize: p.sampleSize,
    evidence: { verified: p.verifiedOutcomes, recentVerified: p.recentVerified, visitToVerifiedRate: p.visitToVerifiedRate },
  }));
  const lowTotal = entries.filter((e) => e.confidence === "LOW").reduce((s, e) => s + e.sharePct, 0);
  if (lowTotal > LOW_SHARE_CAP) {
    const scale = LOW_SHARE_CAP / lowTotal;
    let freed = 0;
    for (const e of entries) {
      if (e.confidence !== "LOW") continue;
      const capped = Math.round(e.sharePct * scale * 100) / 100;
      freed += e.sharePct - capped;
      e.sharePct = capped;
    }
    const high = entries.filter((e) => e.confidence !== "LOW");
    const highSum = high.reduce((s, e) => s + e.sharePct, 0);
    if (highSum > 0) {
      for (const e of high) e.sharePct = Math.round((e.sharePct + (freed * e.sharePct) / highSum) * 100) / 100;
    }
  }
  newcomers.forEach((p) => {
    entries.push({
      partnerId: p.partnerId,
      label: p.label,
      priority: entries.length + 1,
      sharePct: Math.round(explorationEach * 100) / 100,
      reason: "No actions yet — exploration opportunity, not earned priority.",
      confidence: "LOW",
      sampleSize: 0,
      evidence: { verified: 0, recentVerified: 0, visitToVerifiedRate: 0 },
    });
  });
  return entries.sort((a, b) => a.priority - b.priority);
}

/* ---------------- Liquidity forecast (pure, ESTIMATE) ---------------- */

export interface LiquidityForecast {
  next24hExpectedObligationsMicroUsdc: string;
  next7dExpectedObligationsMicroUsdc: string;
  currentCommittedMicroUsdc: string;
  currentReserveMicroUsdc: string;
  availableLiquidityMicroUsdc: string;
  projectedFreeLiquidity24hMicroUsdc: string;
  projectedFreeLiquidity7dMicroUsdc: string;
  confidence: Confidence | "INSUFFICIENT_DATA";
  basis: string;
}

/** Explicit estimate from verified-outcome velocity. Weak evidence → low confidence, never fake precision. */
export function forecastLiquidity(params: {
  verifiedAtMs: number[];
  nowMs: number;
  averageObligationMicroUsdc: bigint;
  currentCommittedMicroUsdc: bigint;
  currentReserveMicroUsdc: bigint;
  availableLiquidityMicroUsdc: bigint;
}): LiquidityForecast {
  const weekAgo = params.nowMs - 7 * DAY_MS;
  const recent = params.verifiedAtMs.filter((t) => t >= weekAgo && t <= params.nowMs);
  const perDay = recent.length / 7;
  const e24 = perDay * Number(params.averageObligationMicroUsdc);
  const e7d = e24 * 7;
  const confidence =
    recent.length >= 10 ? "HIGH" : recent.length >= 3 ? "MEDIUM" : recent.length >= 1 ? "LOW" : "INSUFFICIENT_DATA";
  const free = (horizon: number) =>
    (params.availableLiquidityMicroUsdc - BigInt(Math.round(horizon))).toString();
  return {
    next24hExpectedObligationsMicroUsdc: Math.round(e24).toString(),
    next7dExpectedObligationsMicroUsdc: Math.round(e7d).toString(),
    currentCommittedMicroUsdc: params.currentCommittedMicroUsdc.toString(),
    currentReserveMicroUsdc: params.currentReserveMicroUsdc.toString(),
    availableLiquidityMicroUsdc: params.availableLiquidityMicroUsdc.toString(),
    projectedFreeLiquidity24hMicroUsdc: free(e24),
    projectedFreeLiquidity7dMicroUsdc: free(e7d),
    confidence,
    basis: `ESTIMATE from ${recent.length} verified outcomes in the last 7 days at current bounty.`,
  };
}

/* ---------------- Growth plan (pure compose) ---------------- */

export interface GrowthPlan {
  situation: string;
  recommendedAction: string;
  why: string;
  expectedEffect: string;
  confidence: Confidence | "INSUFFICIENT_DATA";
  policyStatus: string;
}

export function buildGrowthPlan(params: {
  pace: PaceSnapshot;
  bounty: BountyDecision;
  allocation: AllocationEntry[];
  forecast: LiquidityForecast;
  policy: GrowthPolicy;
}): GrowthPlan {
  const top = params.allocation[0] ?? null;
  const confidence =
    params.forecast.confidence === "INSUFFICIENT_DATA" ? "INSUFFICIENT_DATA" : params.pace.paceStatus === "COMPLETE" ? "HIGH" : params.forecast.confidence;
  return {
    situation: `Campaign is ${params.pace.paceStatus} (${params.pace.verifiedOutcomeCount}/${params.pace.targetOutcomeCount} verified, ${params.pace.timeProgressPct}% of time used, projecting ${params.pace.projectedOutcomesAtCurrentPace}).`,
    recommendedAction:
      params.bounty.action === "INCREASE_BOUNTY" || params.bounty.action === "DECREASE_BOUNTY"
        ? `${params.bounty.action === "INCREASE_BOUNTY" ? "Raise" : "Lower"} bounty ${params.bounty.currentBountyMicroUsdc} → ${params.bounty.recommendedBountyMicroUsdc}`
        : params.bounty.action === "ESCALATE_BOUNTY"
          ? `Escalate bounty change to the owner (needs ${params.bounty.recommendedBountyMicroUsdc})`
          : top
            ? `Hold bounty; prioritize ${top.label} next (${top.sharePct}% evidence share)`
            : "Hold bounty; no allocation signal.",
    why: params.bounty.reason,
    expectedEffect:
      params.bounty.action === "INCREASE_BOUNTY"
        ? `More participation for future joins; frozen terms unchanged; costs bounded by policy.`
        : params.bounty.action === "DECREASE_BOUNTY"
          ? `Lower spend per outcome while pace allows; frozen terms unchanged.`
          : `No price movement; marginal opportunity goes to evidence-backed creators first.`,
    confidence,
    policyStatus: params.policy.optimizationEnabled
      ? `Autonomous optimization ON (cap ±${params.policy.maxBountyChangePct}%, evidence ≥ ${params.policy.minimumEvidence}).`
      : "Autonomous optimization OFF — recommendations only.",
  };
}

/* ---------------- Store-backed loaders (drizzle reads, no new tables) ---------------- */

export interface PaceLoaderResult {
  pace: PaceSnapshot;
  kernelInputs: KernelInputs;
  recentJoins: number;
  recentVerified: number;
}

export async function loadPace(
  store: MarketStore,
  campaignId: string,
  evaluationWindowDays: number,
  now: Date = new Date(),
): Promise<PaceLoaderResult> {
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404, code: "NOT_FOUND" });
  const market = await store.getMarket(campaignId);
  if (!market) throw Object.assign(new Error("No market for this campaign"), { status: 404, code: "MARKET_NOT_OPEN" });
  const version = await store.getVersion(campaignId, market.policyVersion);
  if (!version || version.targetOutcomeCount === null || version.budgetMicroUsdc === null || version.bountyFloorMicroUsdc === null || version.bountyCeilingMicroUsdc === null || !version.deadline) {
    throw Object.assign(new Error("Policy is missing economic fields"), { status: 500, code: "INTERNAL" });
  }
  const funding = await store.getFunding(campaignId, market.policyVersion);
  const funded = funding?.status === "CONFIRMED" ? (funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc) : 0n;
  const committed = await committedForCampaign(store, campaignId).catch(() => 0n);
  const verified = await store.countVerifiedOutcomes(campaignId).catch(() => 0);
  const settled = await countSettledPayouts(store, campaignId).catch(() => 0);
  const since = new Date(now.getTime() - evaluationWindowDays * DAY_MS);
  const recentJoins = await store.countTermsSince(campaignId, since).catch(() => 0);
  const recentVerified = await store.countVerifiedOutcomesSince(campaignId, since).catch(() => 0);
  const lastRepriceAt = await store.getLastExecutedRepriceAt(campaignId).catch(() => null);
  const kernelInputs: KernelInputs = {
    publicBountyMicroUsdc: market.publicBountyMicroUsdc,
    bountyFloorMicroUsdc: version.bountyFloorMicroUsdc,
    bountyCeilingMicroUsdc: version.bountyCeilingMicroUsdc,
    fundedMicroUsdc: funded,
    committedMicroUsdc: committed,
    targetOutcomeCount: version.targetOutcomeCount,
    verifiedOutcomeCount: verified,
    openedAtMs: market.openedAt.getTime(),
    deadlineMs: version.deadline.getTime(),
    nowMs: now.getTime(),
    recentJoins,
    recentVerified,
    msSinceLastReprice: lastRepriceAt ? now.getTime() - lastRepriceAt.getTime() : null,
    marketStatus: market.status,
    campaignState: campaign.state,
  };
  const pace = buildPaceSnapshot({
    targetOutcomeCount: version.targetOutcomeCount,
    verifiedOutcomeCount: verified,
    settledOutcomeCount: settled,
    openedAtMs: market.openedAt.getTime(),
    deadlineMs: version.deadline.getTime(),
    nowMs: now.getTime(),
    publicBountyMicroUsdc: market.publicBountyMicroUsdc,
    fundedMicroUsdc: funded,
    committedMicroUsdc: committed,
    availableMicroUsdc: funded > committed ? funded - committed : 0n,
  });
  return { pace, kernelInputs, recentJoins, recentVerified };
}

export async function loadCreatorPerformance(
  campaignId: string,
  evaluationWindowDays: number,
  now: Date = new Date(),
): Promise<CreatorPerformance[]> {
  const db = getDb();
  const refs = await db.select().from(referrals).where(eq(referrals.campaignId, campaignId));
  if (refs.length === 0) return [];
  const refIds = refs.map((r) => r.id);
  const [events, intents, outcomeRows, payoutRows] = await Promise.all([
    db.select().from(referralEvents).where(inArray(referralEvents.referralId, refIds)).catch(() => []),
    db.select().from(checkoutIntents).where(eq(checkoutIntents.campaignId, campaignId)).catch(() => []),
    db.select().from(outcomes).where(eq(outcomes.campaignId, campaignId)).catch(() => []),
    db.select().from(payouts).where(eq(payouts.campaignId, campaignId)).catch(() => []),
  ]);
  const partnerIds = [...new Set(refs.map((r) => r.partnerId))];
  const [partnerRows, userRows, personaRows] = await Promise.all([
    db.select().from(partners).where(inArray(partners.id, partnerIds)).catch(() => []),
    db.select().from(users).catch(() => []),
    db.select().from(userPersonas).catch(() => []),
  ]);
  const nameByUser = new Map(userRows.map((u) => [u.id, u.name]));
  const handleByUser = new Map(personaRows.map((p) => [p.userId, p.handle]));
  const userByPartner = new Map(partnerRows.map((p) => [p.id, p.userId]));
  const windowStart = now.getTime() - evaluationWindowDays * DAY_MS;
  return partnerIds.map((partnerId) => {
    const myRefs = new Set(refs.filter((r) => r.partnerId === partnerId).map((r) => r.id));
    const clicks = events.filter((e) => myRefs.has(e.referralId)).length;
    const myIntents = intents.filter((i) => i.partnerId === partnerId);
    const myOutcomes = outcomeRows.filter((o) => o.partnerId === partnerId);
    const verifiedIds = myOutcomes.filter((o) => o.status === "VERIFIED").map((o) => o.id);
    const settledIds = payoutRows.filter((p) => p.partnerId === partnerId && p.state === "SETTLED").map((p) => p.outcomeId);
    const settledSum = payoutRows.filter((p) => p.partnerId === partnerId && p.state === "SETTLED").reduce((s, p) => s + p.amountMicroUsdc, 0n);
    const recentVerified = myOutcomes.filter((o) => o.status === "VERIFIED" && o.verifiedAt && o.verifiedAt.getTime() >= windowStart).length;
    const userId = userByPartner.get(partnerId) ?? null;
    const handle = userId ? handleByUser.get(userId) : null;
    const name = userId ? nameByUser.get(userId) : null;
    return summarizeCreatorPerformance({
      partnerId,
      label: handle ? `@${handle}` : name || "Creator",
      clicks,
      actions: myIntents.length,
      verifiedOutcomeIds: verifiedIds,
      settledOutcomeIds: settledIds,
      settledPayoutMicroUsdc: settledSum,
      recentVerified,
      evidenceWindowDays: evaluationWindowDays,
    });
  });
}

/* ---------------- Growth ledger (existing audit table) ---------------- */

export async function recordGrowthEvent(
  db: Db,
  workspaceId: string,
  action: "operator.growth.evaluated" | "operator.bounty.changed" | "operator.bounty.escalated" | "operator.allocation.recommended",
  params: { campaignId: string; metadata: Record<string, unknown> },
): Promise<void> {
  await recordAuditEvent(db, {
    actorType: "AGENT",
    workspaceId,
    action,
    targetType: "campaign",
    targetId: params.campaignId,
    metadata: params.metadata,
  });
}
