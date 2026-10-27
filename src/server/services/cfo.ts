import { getDb } from "../db/client";
import { outcomes } from "../db/schema";
import { and, eq } from "drizzle-orm";
import type { AuditSink, MarketStore } from "./campaignStore";
import { recordAuditEvent } from "./audit";
import {
  decideBountyChange,
  forecastLiquidity,
  loadCreatorPerformance,
  loadPace,
  type BountyDecision,
  type Confidence,
  type GrowthPolicy,
  type PaceSnapshot,
} from "./growth";
import { getGrowthPolicy, DEFAULT_GROWTH_POLICY } from "./growth";
import { getOperatorPolicy, DEFAULT_OPERATOR_POLICY, type OperatorPolicy } from "./operator";

/**
 * Campaign CFO + Cross-Campaign Capital Allocator (Slice 5).
 *
 * Deterministic financial operating intelligence for an organization:
 * which campaigns deserve more NEW capital, which get less, at what
 * price, and when to stop. AI PROPOSES → POLICY PERMITS/REFUSES →
 * THESMA EXECUTES ONLY WHERE EXISTING AUTHORITY ALLOWS → LEDGER PROVES.
 *
 * Hard boundaries (no exceptions):
 * - Capital states AVAILABLE / COMMITTED / RESERVED / VERIFIED_UNPAID /
 *   SETTLED are never interchangeable. Only genuinely uncommitted capital
 *   is reallocatable. Frozen terms, active reservations, verified-unpaid
 *   obligations and settled payouts are never touched.
 * - ThesmaMarketVault exposes per-campaign `returnUnspent` but NO
 *   cross-campaign transfer primitive (audited in Slice 5: only
 *   createCampaign / fundCampaign / pause / close / returnUnspent /
 *   payoutVerifiedOutcome exist). So there is NO onchain capital movement
 *   in this slice: every allocation is a RECOMMENDATION / prospective
 *   funding plan, labeled as such, never "executed".
 * - The only autonomous execution permitted is the EXISTING bounded
 *   bounty path (decideBountyChange + evaluateMarket via the growth
 *   evaluate endpoint). The CFO itself executes nothing; it coordinates
 *   bounty + capital so the two agents cannot contradict each other.
 * - No LLM anywhere. No fake performance. No new contract. No migration.
 */

export type CapitalAction =
  | "INCREASE_ALLOCATION"
  | "KEEP_ALLOCATION"
  | "REDUCE_FUTURE_ALLOCATION"
  | "PAUSE_NEW_COMMITMENTS"
  | "ESCALATE"
  | "NO_ACTION";

export type SpendAction = "CONTINUE" | "SLOW" | "PAUSE" | "ESCALATE" | "COMPLETE";

/** Chain movement is categorically unavailable in this slice. */
export const CAPITAL_MOVEMENT = "UNAVAILABLE" as const;
/** Recommendation-only: the CFO never moves money or reprices. */
export const EXECUTION_RECOMMENDED = "RECOMMENDED" as const;

const EXPLORATION_SHARE_BPS = 1_000; // 10% of deployable reserved for low-history explorers
const LOW_CONFIDENCE_SHARE_CAP_BPS = 1_500; // one LOW campaign takes at most 15% of deployable
const EXPLORER_MIN_SCORE = 30;

export interface CfoFinancials {
  fundedMicroUsdc: string;
  spentMicroUsdc: string;
  /** Active reservations + active supply commitments (money held in flight). */
  committedMicroUsdc: string;
  reservedMicroUsdc: string;
  verifiedUnpaidMicroUsdc: string;
  /** funded − spent − committedActive − verifiedUnpaid, floored at 0. Never double-counts. */
  availableMicroUsdc: string;
  /** Priced-at-frozen-terms exposure: spent + reserved + verifiedUnpaid. Informational. */
  frozenTermsExposureMicroUsdc: string;
}

export interface CfoCampaignEvidence {
  verifiedOutcomes: number;
  totalActions: number;
  realizedCostPerVerifiedMicroUsdc: string | null;
  confidence: Confidence;
  topLabel: string | null;
}

export interface CfoCampaignRow {
  campaignId: string;
  objective: string;
  state: string;
  marketStatus: string | null;
  publicBountyMicroUsdc: string;
  targetOutcomeCount: number | null;
  financials: CfoFinancials;
  pace: { status: string; targetProgressPct: number; timeProgressPct: number; projectedOutcomes: number };
  evidence: CfoCampaignEvidence;
  estimatedFundingRequiredMicroUsdc: string;
  budgetHeadroomMicroUsdc: string | null;
  nextDueMicroUsdc: string;
  hardConflict: string | null;
  ambiguous: string | null;
}

export interface CfoSnapshot {
  workspaceId: string;
  generatedAt: string;
  campaigns: CfoCampaignRow[];
  totals: {
    fundedMicroUsdc: string;
    spentMicroUsdc: string;
    committedMicroUsdc: string;
    reservedMicroUsdc: string;
    verifiedUnpaidMicroUsdc: string;
    availableMicroUsdc: string;
  };
}

export interface CfoCampaignDecision {
  campaignId: string;
  capitalScore: number;
  confidence: Confidence;
  reasons: string[];
  warnings: string[];
  spendAction: SpendAction;
  spendReason: string;
  capitalAction: CapitalAction;
  executionStatus: typeof EXECUTION_RECOMMENDED;
  recommendedNewAllocationMicroUsdc: string;
  exploration: boolean;
  currentBountyMicroUsdc: string;
  suggestedBountyMicroUsdc: string | null;
  bountyAction: string;
  bountyReason: string;
  bountyRule: string;
  /** CFO never executes; bounded moves run through the existing growth evaluate path. */
  bountyExecution: typeof EXECUTION_RECOMMENDED;
}

export interface CapitalPlan {
  workspaceId: string;
  generatedAt: string;
  totals: CfoSnapshot["totals"] & {
    reserveMicroUsdc: string;
    deployableMicroUsdc: string;
    est24hObligationsMicroUsdc: string;
    est7dObligationsMicroUsdc: string;
    unallocatedMicroUsdc: string;
  };
  overallConfidence: Confidence;
  /** Always UNAVAILABLE: no cross-campaign transfer primitive exists onchain. */
  chainMovement: typeof CAPITAL_MOVEMENT;
  campaigns: CfoCampaignDecision[];
  escalations: { campaignId: string; reason: string }[];
}

/* ---------------- Pure: capital score ---------------- */

export interface ScoreInput {
  verifiedOutcomes: number;
  totalActions: number;
  evidenceConfidence: Confidence;
  realizedCostPerVerifiedMicroUsdc: bigint | null;
  currentBountyMicroUsdc: bigint;
  bountyCeilingMicroUsdc: bigint | null;
  paceStatus: string;
  targetRemaining: number | null;
  targetTotal: number | null;
  fundedMicroUsdc: bigint;
  availableMicroUsdc: bigint;
  complete: boolean;
  hardConflict: string | null;
  ambiguous: string | null;
}

export function scoreCampaignCapital(input: ScoreInput): {
  capitalScore: number;
  confidence: Confidence;
  reasons: string[];
  warnings: string[];
} {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (input.complete) {
    return { capitalScore: 0, confidence: "HIGH", reasons: ["Target complete — no new capital needed."], warnings };
  }
  if (input.hardConflict) {
    return { capitalScore: 0, confidence: "MEDIUM", reasons: [`Hard conflict: ${input.hardConflict}`], warnings };
  }
  if (input.ambiguous) {
    warnings.push(`Ambiguous truth: ${input.ambiguous}`);
    return { capitalScore: 0, confidence: "LOW", reasons: ["Failing closed on ambiguous campaign truth."], warnings };
  }
  let score = 50;
  // 1. Verified outcome efficiency (realized CAC vs current bounty).
  if (input.verifiedOutcomes > 0 && input.realizedCostPerVerifiedMicroUsdc !== null && input.currentBountyMicroUsdc > 0n) {
    const ratio = Number(input.realizedCostPerVerifiedMicroUsdc) / Number(input.currentBountyMicroUsdc);
    if (ratio <= 1.1) {
      score += 20;
      reasons.push(`Strong verified efficiency: realized ${input.realizedCostPerVerifiedMicroUsdc} vs bounty ${input.currentBountyMicroUsdc} per outcome.`);
    } else if (ratio <= 1.5) {
      score += 10;
      reasons.push(`Acceptable verified efficiency (${Math.round(ratio * 100)}% of bounty per verified outcome).`);
    } else if (ratio <= 2) {
      reasons.push(`Marginal verified efficiency (${Math.round(ratio * 100)}% of bounty per verified outcome).`);
    } else {
      score -= 20;
      warnings.push(`Poor verified economics: realized cost ${Math.round(ratio * 100)}% of bounty per verified outcome.`);
    }
  } else {
    warnings.push("No verified outcomes yet — efficiency unproven.");
  }
  // 2. Pace: behind is opportunity, ahead needs less pressure, at-risk is risk.
  if (input.paceStatus === "BEHIND") {
    score += 10;
    reasons.push("Behind target pace — additional capital can buy the gap.");
  } else if (input.paceStatus === "ON_PACE") {
    score += 5;
    reasons.push("On pace — steady funding justified.");
  } else if (input.paceStatus === "AHEAD") {
    score -= 10;
    reasons.push("Ahead of pace — no urgency for more capital now.");
  } else if (input.paceStatus === "AT_RISK") {
    score -= 10;
    warnings.push("At risk of missing the target — capital alone may not fix it.");
  }
  // 3. Evidence quality: thin samples cannot command capital.
  if (input.evidenceConfidence === "HIGH") {
    score += 10;
    reasons.push(`HIGH-confidence creator evidence (${input.totalActions} actions).`);
  } else if (input.evidenceConfidence === "MEDIUM") {
    score += 5;
    reasons.push(`MEDIUM-confidence creator evidence (${input.totalActions} actions).`);
  } else {
    score -= 10;
    warnings.push(`LOW-confidence evidence (n=${input.totalActions}) — exposure must stay capped.`);
  }
  // 4. Remaining opportunity.
  if (input.targetRemaining !== null && input.targetRemaining <= 0) {
    return { capitalScore: 0, confidence: "HIGH", reasons: ["No remaining target — nothing left to buy."], warnings };
  }
  if (input.targetTotal !== null && input.targetTotal > 0 && input.targetRemaining !== null && input.targetRemaining < input.targetTotal * 0.2) {
    score -= 5;
    reasons.push("Small remaining target — limited room for new capital.");
  }
  // 5. Utilization: funded but idle capital is a flag, not a virtue.
  if (input.fundedMicroUsdc > 0n && input.availableMicroUsdc * 2n > input.fundedMicroUsdc && input.verifiedOutcomes === 0) {
    score -= 5;
    warnings.push("More than half of funded capital sits unused with zero verified outcomes.");
  }
  const capitalScore = Math.max(0, Math.min(100, Math.round(score)));
  const confidence: Confidence =
    input.evidenceConfidence === "LOW" || input.verifiedOutcomes === 0 ? "LOW" : input.evidenceConfidence;
  if (warnings.length === 0) reasons.push("No material warnings.");
  return { capitalScore, confidence, reasons, warnings };
}

/* ---------------- Pure: spend decision ---------------- */

export function decideSpendAction(params: {
  complete: boolean;
  hardConflict: string | null;
  ambiguous: string | null;
  fundedMicroUsdc: bigint;
  availableMicroUsdc: bigint;
  remaining: number | null;
  paceStatus: string;
  cacRatio: number | null;
  ceilingBreached: boolean;
}): { action: SpendAction; reason: string } {
  const p = params;
  if (p.complete || (p.remaining !== null && p.remaining <= 0))
    return { action: "COMPLETE", reason: "Target reached — stop buying; this campaign is done." };
  if (p.ambiguous) return { action: "ESCALATE", reason: `Cannot decide spend on ambiguous truth: ${p.ambiguous}` };
  if (p.hardConflict) return { action: "ESCALATE", reason: `Hard conflict blocks autonomous spend: ${p.hardConflict}` };
  if (p.fundedMicroUsdc <= 0n)
    return { action: "PAUSE", reason: "No confirmed funding — fund the campaign before buying more outcomes." };
  if (p.ceilingBreached)
    return { action: "PAUSE", reason: "Realized cost per verified outcome exceeds the human bounty ceiling." };
  if (p.cacRatio !== null && p.cacRatio > 2)
    return { action: "PAUSE", reason: `Verified outcomes cost ${Math.round(p.cacRatio * 100)}% of bounty — above policy tolerance.` };
  if (p.availableMicroUsdc <= 0n && (p.remaining ?? 1) > 0)
    return { action: "PAUSE", reason: "No free capital left while target remains — obligations and reserve come first." };
  if (p.paceStatus === "AHEAD")
    return { action: "SLOW", reason: "Ahead of pace — additional bounty pressure is unnecessary." };
  if (p.cacRatio !== null && p.cacRatio > 1.2)
    return { action: "SLOW", reason: `Marginal verified economics (${Math.round(p.cacRatio * 100)}% of bounty) — slow spend, watch efficiency.` };
  return { action: "CONTINUE", reason: "Buying outcomes inside policy, liquidity, and evidence bounds." };
}

/* ---------------- Pure: capital action ---------------- */

export function decideCapitalAction(params: {
  spend: SpendAction;
  unfunded: boolean;
  capitalScore: number;
  confidence: Confidence;
  lowSample: boolean;
}): { action: CapitalAction; exploration: boolean; reason: string } {
  const { spend, capitalScore, confidence, lowSample, unfunded } = params;
  if (spend === "COMPLETE") return { action: "NO_ACTION", exploration: false, reason: "Complete — no new capital." };
  if (spend === "ESCALATE") return { action: "ESCALATE", exploration: false, reason: "Escalated — owner decides." };
  if (spend === "PAUSE") {
    if (unfunded) return { action: "NO_ACTION", exploration: false, reason: "Unfunded — pause buying, but there is nothing to reallocate." };
    return { action: "PAUSE_NEW_COMMITMENTS", exploration: false, reason: "Pause new commitments; existing obligations preserved." };
  }
  if (spend === "SLOW")
    return { action: "REDUCE_FUTURE_ALLOCATION", exploration: false, reason: "Slow spend — reduce future allocation, no clawback." };
  // CONTINUE
  if (capitalScore >= 60 && confidence !== "LOW")
    return { action: "INCREASE_ALLOCATION", exploration: false, reason: "Efficient + on-track with solid evidence — eligible for more new capital." };
  if (capitalScore >= 60)
    return { action: "KEEP_ALLOCATION", exploration: false, reason: "Scores well but evidence is LOW — hold steady until confidence improves." };
  if (lowSample && capitalScore >= EXPLORER_MIN_SCORE)
    return { action: "INCREASE_ALLOCATION", exploration: true, reason: "Promising low-history campaign — bounded exploration allocation only." };
  if (capitalScore >= 35)
    return { action: "KEEP_ALLOCATION", exploration: false, reason: "Hold current funding; not earning an increase yet." };
  return { action: "REDUCE_FUTURE_ALLOCATION", exploration: false, reason: "Weak score — reduce future allocation, never claw back frozen terms." };
}

/* ---------------- Pure: cross-campaign allocation ---------------- */

export interface AllocationCandidate {
  campaignId: string;
  capitalScore: number;
  confidence: Confidence;
  exploration: boolean;
  /** Max this campaign can absorb: min(available, remaining need, budget headroom). */
  needMicroUsdc: bigint;
}

export function allocateCapital(candidates: AllocationCandidate[], deployableMicroUsdc: bigint): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (deployableMicroUsdc <= 0n) return out;
  const eligible = candidates
    .filter((c) => c.needMicroUsdc > 0n && c.capitalScore > 0)
    .sort((a, b) => a.campaignId.localeCompare(b.campaignId));
  if (eligible.length === 0) return out;
  let remaining = deployableMicroUsdc;
  // Exploration pool first: promising low-history campaigns get a bounded share.
  const explorers = eligible.filter((c) => c.exploration);
  if (explorers.length > 0) {
    let pool = (deployableMicroUsdc * BigInt(EXPLORATION_SHARE_BPS)) / 10_000n;
    for (const e of explorers) {
      if (pool <= 0n || remaining <= 0n) break;
      const grant = e.needMicroUsdc < pool ? e.needMicroUsdc : pool;
      const capped = grant > remaining ? remaining : grant;
      if (capped > 0n) {
        out.set(e.campaignId, capped);
        pool -= capped;
        remaining -= capped;
      }
    }
  }
  // Proportional remainder by smoothed score; deterministic order.
  const rest = eligible.filter((c) => !out.has(c.campaignId));
  const weights = rest.map((c) => ({ c, w: Math.sqrt(c.capitalScore * 100) }));
  const wSum = weights.reduce((s, x) => s + x.w, 0);
  if (wSum <= 0 || remaining <= 0n) return out;
  const ordered = [...weights].sort((a, b) => b.w - a.w || a.c.campaignId.localeCompare(b.c.campaignId));
  const lowCap = (deployableMicroUsdc * BigInt(LOW_CONFIDENCE_SHARE_CAP_BPS)) / 10_000n;
  // Exact proportional split on the remainder snapshot (single pass, floored; residual stays unallocated).
  const snapshot = remaining;
  const rawShares = ordered.map(({ c, w }) => ({
    c,
    raw: (snapshot * BigInt(Math.max(1, Math.round((w / wSum) * 1_000_000)))) / 1_000_000n,
  }));
  for (const { c, raw } of rawShares) {
    if (remaining <= 0n) break;
    let grant = raw > c.needMicroUsdc ? c.needMicroUsdc : raw;
    if (c.confidence === "LOW" && grant > lowCap) grant = lowCap > c.needMicroUsdc ? c.needMicroUsdc : lowCap;
    if (grant > remaining) grant = remaining;
    if (grant > 0n) {
      out.set(c.campaignId, (out.get(c.campaignId) ?? 0n) + grant);
      remaining -= grant;
    }
  }
  return out;
}

/* ---------------- Loader: org CFO snapshot (reads only, no chain, no writes) ---------------- */

const ACTIVE_RESERVATION = ["RESERVED", "SUBMITTED", "AMBIGUOUS"] as const;

export interface CfoLoadOpts {
  now?: Date;
  evaluationWindowDays?: number;
  growthPolicy?: GrowthPolicy;
  operatorPolicy?: OperatorPolicy;
}

export async function loadCfoSnapshot(
  store: MarketStore,
  workspaceId: string,
  opts: CfoLoadOpts = {},
): Promise<{ snapshot: CfoSnapshot; growthPolicy: GrowthPolicy; operatorPolicy: OperatorPolicy }> {
  const now = opts.now ?? new Date();
  const windowDays = opts.evaluationWindowDays ?? DEFAULT_GROWTH_POLICY.evaluationWindowDays;
  const campaigns = await store.listCampaigns(workspaceId);
  const rows: CfoCampaignRow[] = [];
  for (const campaign of [...campaigns].sort((a, b) => a.id.localeCompare(b.id))) {
    const market = await store.getMarket(campaign.id).catch(() => null);
    const version = market ? await store.getVersion(campaign.id, market.policyVersion).catch(() => null) : null;
    if (!market || !version) {
      rows.push({
        campaignId: campaign.id,
        objective: "",
        state: campaign.state,
        marketStatus: market?.status ?? null,
        publicBountyMicroUsdc: "0",
        targetOutcomeCount: null,
        financials: zeroFinancials(),
        pace: { status: "UNKNOWN", targetProgressPct: 0, timeProgressPct: 0, projectedOutcomes: 0 },
        evidence: { verifiedOutcomes: 0, totalActions: 0, realizedCostPerVerifiedMicroUsdc: null, confidence: "LOW", topLabel: null },
        estimatedFundingRequiredMicroUsdc: "0",
        budgetHeadroomMicroUsdc: null,
        nextDueMicroUsdc: "0",
        hardConflict: null,
        ambiguous: "Campaign is missing market or policy truth.",
      });
      continue;
    }
    const funding = await store.getFunding(campaign.id, market.policyVersion).catch(() => null);
    const funded = funding?.status === "CONFIRMED" ? (funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc) : 0n;
    const reservations = await store.listReservationsByCampaign(campaign.id).catch(() => []);
    const reservedActive = reservations
      .filter((r) => (ACTIVE_RESERVATION as readonly string[]).includes(r.state))
      .reduce((s, r) => s + r.amountMicroUsdc, 0n);
    const commitments = await store.listActiveCommitments(campaign.id).catch(() => []);
    const supplyLocked = commitments.reduce((s, c) => s + c.amountMicroUsdc, 0n);
    const verifiedOutcomes = await store.listOutcomesByStatus("VERIFIED", 10_000).catch(() => []);
    const mine = verifiedOutcomes.filter((o) => o.campaignId === campaign.id);
    let verifiedUnpaid = 0n;
    let spent = 0n;
    const verifiedAtMs: number[] = [];
    for (const o of mine) {
      if (o.verifiedAt) verifiedAtMs.push(o.verifiedAt.getTime());
      const payout = await store.getPayoutByOutcome(o.id).catch(() => null);
      if (payout && payout.state === "SETTLED") {
        spent += payout.amountMicroUsdc;
        continue;
      }
      const res = await store.getReservationByOutcome(o.id).catch(() => null);
      if (res && (ACTIVE_RESERVATION as readonly string[]).includes(res.state)) continue; // counted in reservedActive
      const terms = await store.getTerms(o.campaignId, o.partnerId).catch(() => null);
      verifiedUnpaid += terms?.priceMicroUsdc ?? market.publicBountyMicroUsdc;
    }
    const committedActive = reservedActive + supplyLocked;
    const available = funded - spent - committedActive - verifiedUnpaid;
    let pace: PaceSnapshot | null = null;
    try {
      pace = (await loadPace(store, campaign.id, windowDays, now)).pace;
    } catch {
      pace = null;
    }
    const performances = await loadCreatorPerformance(campaign.id, windowDays, now).catch(() => []);
    const totalActions = performances.reduce((s, p) => s + p.sampleSize, 0);
    const verifiedTotal = performances.reduce((s, p) => s + p.verifiedOutcomes, 0);
    const evidenceConfidence: Confidence =
      totalActions >= 10 ? "HIGH" : totalActions >= 3 ? "MEDIUM" : "LOW";
    const top = [...performances].sort((a, b) => b.verifiedOutcomes - a.verifiedOutcomes)[0] ?? null;
    const hardConflict =
      campaign.state !== "LIVE" ? `Campaign state is ${campaign.state}.` : market.status !== "OPEN" ? `Market is ${market.status}.` : null;
    const target = version.targetOutcomeCount;
    const remaining = target !== null ? Math.max(0, target - mine.length) : null;
    const estRequired = remaining !== null ? BigInt(remaining) * market.publicBountyMicroUsdc : 0n;
    const headroom = version.budgetMicroUsdc !== null ? version.budgetMicroUsdc - funded : null;
    rows.push({
      campaignId: campaign.id,
      objective: version.intentText,
      state: campaign.state,
      marketStatus: market.status,
      publicBountyMicroUsdc: market.publicBountyMicroUsdc.toString(),
      targetOutcomeCount: target,
      financials: {
        fundedMicroUsdc: funded.toString(),
        spentMicroUsdc: spent.toString(),
        committedMicroUsdc: committedActive.toString(),
        reservedMicroUsdc: reservedActive.toString(),
        verifiedUnpaidMicroUsdc: verifiedUnpaid.toString(),
        availableMicroUsdc: (available > 0n ? available : 0n).toString(),
        frozenTermsExposureMicroUsdc: (spent + reservedActive + verifiedUnpaid).toString(),
      },
      pace: pace
        ? { status: pace.paceStatus, targetProgressPct: pace.targetProgressPct, timeProgressPct: pace.timeProgressPct, projectedOutcomes: pace.projectedOutcomesAtCurrentPace }
        : { status: "UNKNOWN", targetProgressPct: 0, timeProgressPct: 0, projectedOutcomes: 0 },
      evidence: {
        verifiedOutcomes: mine.length,
        totalActions,
        realizedCostPerVerifiedMicroUsdc:
          verifiedTotal > 0 ? ((spent + reservedActive) / BigInt(Math.max(1, verifiedTotal))).toString() : null,
        confidence: performances.length === 0 ? "LOW" : evidenceConfidence,
        topLabel: top?.label ?? null,
      },
      estimatedFundingRequiredMicroUsdc: estRequired.toString(),
      budgetHeadroomMicroUsdc: headroom !== null ? (headroom > 0n ? headroom : 0n).toString() : null,
      nextDueMicroUsdc: verifiedUnpaid.toString(),
      hardConflict,
      ambiguous: pace ? null : "Pace truth unavailable.",
    });
  }
  const sum = (pick: (r: CfoCampaignRow) => string) => rows.reduce((s, r) => s + BigInt(pick(r)), 0n).toString();
  const snapshot: CfoSnapshot = {
    workspaceId,
    generatedAt: now.toISOString(),
    campaigns: rows,
    totals: {
      fundedMicroUsdc: sum((r) => r.financials.fundedMicroUsdc),
      spentMicroUsdc: sum((r) => r.financials.spentMicroUsdc),
      committedMicroUsdc: sum((r) => r.financials.committedMicroUsdc),
      reservedMicroUsdc: sum((r) => r.financials.reservedMicroUsdc),
      verifiedUnpaidMicroUsdc: sum((r) => r.financials.verifiedUnpaidMicroUsdc),
      availableMicroUsdc: sum((r) => r.financials.availableMicroUsdc),
    },
  };
  const growthPolicy = opts.growthPolicy ?? ((await getGrowthPolicy(workspaceId).catch(() => null)) ?? { ...DEFAULT_GROWTH_POLICY });
  const operatorPolicy = opts.operatorPolicy ?? ((await getOperatorPolicy(workspaceId).catch(() => null)) ?? { ...DEFAULT_OPERATOR_POLICY });
  return { snapshot, growthPolicy, operatorPolicy };
}

function zeroFinancials(): CfoFinancials {
  const z = "0";
  return {
    fundedMicroUsdc: z, spentMicroUsdc: z, committedMicroUsdc: z, reservedMicroUsdc: z,
    verifiedUnpaidMicroUsdc: z, availableMicroUsdc: z, frozenTermsExposureMicroUsdc: z,
  };
}

/* ---------------- Plan builder (pure given snapshot + policies) ---------------- */

export async function buildCapitalPlan(
  snapshot: CfoSnapshot,
  deps: { store: MarketStore; growthPolicy: GrowthPolicy; operatorPolicy: OperatorPolicy; now?: Date },
): Promise<CapitalPlan> {
  const now = deps.now ?? new Date();
  const decisions: CfoCampaignDecision[] = [];
  // Org-level near-term obligation estimate from verified velocity across campaigns.
  let allVerifiedAt: number[] = [];
  try {
    const db = getDb();
    const rows = await db
      .select({ verifiedAt: outcomes.verifiedAt })
      .from(outcomes)
      .where(eq(outcomes.status, "VERIFIED"))
      .limit(10_000)
      .catch(() => [] as { verifiedAt: Date | null }[]);
    allVerifiedAt = rows.map((r) => r.verifiedAt?.getTime() ?? now.getTime());
  } catch {
    allVerifiedAt = [];
  }
  const avgBounty =
    snapshot.campaigns.length > 0
      ? snapshot.campaigns.reduce((s, r) => s + BigInt(r.publicBountyMicroUsdc), 0n) / BigInt(snapshot.campaigns.length)
      : 0n;
  const orgForecast = forecastLiquidity({
    verifiedAtMs: allVerifiedAt,
    nowMs: now.getTime(),
    averageObligationMicroUsdc: avgBounty,
    currentCommittedMicroUsdc: BigInt(snapshot.totals.committedMicroUsdc),
    currentReserveMicroUsdc: deps.operatorPolicy.minReserveMicroUsdc,
    availableLiquidityMicroUsdc: BigInt(snapshot.totals.availableMicroUsdc),
  });
  const reserve = deps.operatorPolicy.minReserveMicroUsdc;
  const totalAvailable = BigInt(snapshot.totals.availableMicroUsdc);
  const est24h = BigInt(orgForecast.next24hExpectedObligationsMicroUsdc);
  const deployableRaw = totalAvailable - reserve - est24h;
  const deployable = deployableRaw > 0n ? deployableRaw : 0n;

  for (const row of snapshot.campaigns) {
    const funded = BigInt(row.financials.fundedMicroUsdc);
    const available = BigInt(row.financials.availableMicroUsdc);
    const verified = row.evidence.verifiedOutcomes;
    const realized = row.evidence.realizedCostPerVerifiedMicroUsdc !== null ? BigInt(row.evidence.realizedCostPerVerifiedMicroUsdc) : null;
    const bounty = BigInt(row.publicBountyMicroUsdc);
    const complete = row.pace.status === "COMPLETE" || (row.targetOutcomeCount !== null && verified >= row.targetOutcomeCount);
    const score = scoreCampaignCapital({
      verifiedOutcomes: verified,
      totalActions: row.evidence.totalActions,
      evidenceConfidence: row.evidence.confidence,
      realizedCostPerVerifiedMicroUsdc: realized,
      currentBountyMicroUsdc: bounty,
      bountyCeilingMicroUsdc: null,
      paceStatus: row.pace.status,
      targetRemaining: row.targetOutcomeCount !== null ? Math.max(0, row.targetOutcomeCount - verified) : null,
      targetTotal: row.targetOutcomeCount,
      fundedMicroUsdc: funded,
      availableMicroUsdc: available,
      complete,
      hardConflict: row.hardConflict,
      ambiguous: row.ambiguous,
    });
    const cacRatio = realized !== null && bounty > 0n ? Number(realized) / Number(bounty) : null;
    const spend = decideSpendAction({
      complete,
      hardConflict: row.hardConflict,
      ambiguous: row.ambiguous,
      fundedMicroUsdc: funded,
      availableMicroUsdc: available,
      remaining: row.targetOutcomeCount !== null ? Math.max(0, row.targetOutcomeCount - verified) : null,
      paceStatus: row.pace.status,
      cacRatio,
      ceilingBreached: false,
    });
    const capital = decideCapitalAction({
      spend: spend.action,
      unfunded: funded <= 0n,
      capitalScore: score.capitalScore,
      confidence: score.confidence,
      lowSample: row.evidence.totalActions < 10,
    });
    // Bounty coordination: the existing kernel decides, the CFO gates on liquidity.
    const bountyDecision = await decideCfoBounty(deps.store, row, deps.growthPolicy, available, now, spend.action);
    decisions.push({
      campaignId: row.campaignId,
      capitalScore: score.capitalScore,
      confidence: score.confidence,
      reasons: score.reasons,
      warnings: score.warnings,
      spendAction: spend.action,
      spendReason: spend.reason,
      capitalAction: capital.action,
      executionStatus: EXECUTION_RECOMMENDED,
      recommendedNewAllocationMicroUsdc: "0",
      exploration: capital.exploration,
      currentBountyMicroUsdc: row.publicBountyMicroUsdc,
      suggestedBountyMicroUsdc: bountyDecision.recommendedBountyMicroUsdc,
      bountyAction: bountyDecision.action,
      bountyReason: bountyDecision.reason,
      bountyRule: bountyDecision.rule,
      bountyExecution: EXECUTION_RECOMMENDED,
    });
  }

  // Cross-campaign allocation over INCREASE candidates only.
  const candidates: AllocationCandidate[] = [];
  for (const d of decisions) {
    if (d.capitalAction !== "INCREASE_ALLOCATION") continue;
    const row = snapshot.campaigns.find((r) => r.campaignId === d.campaignId)!;
    const available = BigInt(row.financials.availableMicroUsdc);
    const need = BigInt(row.estimatedFundingRequiredMicroUsdc);
    const headroom = row.budgetHeadroomMicroUsdc !== null ? BigInt(row.budgetHeadroomMicroUsdc) : need;
    let cap = need < available ? need : available;
    if (cap > headroom) cap = headroom;
    if (cap <= 0n) continue;
    candidates.push({ campaignId: d.campaignId, capitalScore: d.capitalScore, confidence: d.confidence, exploration: d.exploration, needMicroUsdc: cap });
  }
  const grants = allocateCapital(candidates, deployable);
  let allocated = 0n;
  for (const d of decisions) {
    const g = grants.get(d.campaignId) ?? 0n;
    d.recommendedNewAllocationMicroUsdc = g.toString();
    allocated += g;
  }
  const unallocated = deployable - allocated;
  const escalations = decisions
    .filter((d) => d.spendAction === "ESCALATE" || d.capitalAction === "ESCALATE")
    .map((d) => ({ campaignId: d.campaignId, reason: d.spendAction === "ESCALATE" ? d.spendReason : "Capital decision escalated to the owner." }));
  const overallConfidence: Confidence = decisions.some((d) => d.confidence === "LOW") || orgForecast.confidence === "INSUFFICIENT_DATA"
    ? "LOW"
    : decisions.some((d) => d.confidence === "MEDIUM") || orgForecast.confidence === "MEDIUM"
      ? "MEDIUM"
      : "HIGH";
  return {
    workspaceId: snapshot.workspaceId,
    generatedAt: snapshot.generatedAt,
    totals: {
      ...snapshot.totals,
      reserveMicroUsdc: reserve.toString(),
      deployableMicroUsdc: deployable.toString(),
      est24hObligationsMicroUsdc: est24h.toString(),
      est7dObligationsMicroUsdc: BigInt(orgForecast.next7dExpectedObligationsMicroUsdc).toString(),
      unallocatedMicroUsdc: (unallocated > 0n ? unallocated : 0n).toString(),
    },
    overallConfidence,
    chainMovement: CAPITAL_MOVEMENT,
    campaigns: decisions,
    escalations,
  };
}

/** Existing bounty kernel as CFO input, gated on CFO liquidity truth. Never executes. */
async function decideCfoBounty(
  store: MarketStore,
  row: CfoCampaignRow,
  policy: GrowthPolicy,
  availableMicroUsdc: bigint,
  now: Date,
  spendAction: SpendAction,
): Promise<BountyDecision> {
  const idle = (action: BountyDecision["action"], reason: string, rule: string): BountyDecision => ({
    action,
    currentBountyMicroUsdc: row.publicBountyMicroUsdc,
    recommendedBountyMicroUsdc: null,
    reason,
    rule,
    bounded: true,
  });
  if (row.ambiguous || row.hardConflict || row.pace.status === "UNKNOWN") {
    return {
      action: "ESCALATE_BOUNTY",
      currentBountyMicroUsdc: row.publicBountyMicroUsdc,
      recommendedBountyMicroUsdc: null,
      reason: `CFO cannot price on ${row.ambiguous ? "ambiguous truth" : "a hard conflict"} — owner decides.`,
      rule: "CFO_FAIL_CLOSED",
      bounded: false,
    };
  }
  let loaded: { pace: PaceSnapshot; kernelInputs: Parameters<typeof decideBountyChange>[0]["kernelInputs"]; recentJoins: number; recentVerified: number } | null = null;
  try {
    loaded = await loadPace(store, row.campaignId, policy.evaluationWindowDays, now);
  } catch {
    return idle("NO_ACTION", "Pace truth unavailable — CFO takes no pricing view.", "CFO_FAIL_CLOSED");
  }
  const kernel = decideBountyChange({
    pace: loaded.pace,
    kernelInputs: loaded.kernelInputs,
    recentJoins: loaded.recentJoins,
    recentVerified: loaded.recentVerified,
    availableMicroUsdc,
    bounds: { bountyFloorMicroUsdc: loaded.kernelInputs.bountyFloorMicroUsdc, bountyCeilingMicroUsdc: loaded.kernelInputs.bountyCeilingMicroUsdc },
    policy,
  });
  // CFO liquidity gate: the growth agent must not outspend finance.
  if (kernel.action === "INCREASE_BOUNTY") {
    if (spendAction === "PAUSE" || spendAction === "ESCALATE") {
      return {
        action: "ESCALATE_BOUNTY",
        currentBountyMicroUsdc: kernel.currentBountyMicroUsdc,
        recommendedBountyMicroUsdc: kernel.recommendedBountyMicroUsdc,
        reason: `Growth wants more bounty but CFO spend state is ${spendAction} — owner sign-off required.`,
        rule: "CFO_LIQUIDITY_GATE",
        bounded: false,
      };
    }
    const recommended = kernel.recommendedBountyMicroUsdc ? BigInt(kernel.recommendedBountyMicroUsdc) : null;
    const current = BigInt(kernel.currentBountyMicroUsdc);
    if (recommended !== null && recommended > current) {
      const remaining = loaded.pace.targetOutcomeCount - loaded.pace.verifiedOutcomeCount;
      const delta = (recommended - current) * BigInt(Math.max(0, remaining));
      if (delta > availableMicroUsdc) {
        return {
          action: "ESCALATE_BOUNTY",
          currentBountyMicroUsdc: kernel.currentBountyMicroUsdc,
          recommendedBountyMicroUsdc: kernel.recommendedBountyMicroUsdc,
          reason: "The bounty increase does not fit free capital after obligations and reserve — owner sign-off required.",
          rule: "CFO_LIQUIDITY_GATE",
          bounded: false,
        };
      }
    }
  }
  return kernel;
}

/* ---------------- Audit (existing ledger only, evaluate path only) ---------------- */

export async function recordCfoPlan(audit: AuditSink, plan: CapitalPlan): Promise<void> {
  await audit({
    actorType: "AGENT",
    actorId: null,
    workspaceId: plan.workspaceId,
    partnerId: null,
    action: "cfo.plan.generated",
    targetType: "workspace",
    targetId: plan.workspaceId,
    metadata: {
      generatedAt: plan.generatedAt,
      totals: plan.totals,
      overallConfidence: plan.overallConfidence,
      chainMovement: plan.chainMovement,
      allocations: plan.campaigns.map((c) => ({
        campaignId: c.campaignId,
        capitalAction: c.capitalAction,
        spendAction: c.spendAction,
        capitalScore: c.capitalScore,
        confidence: c.confidence,
        recommendedNewAllocationMicroUsdc: c.recommendedNewAllocationMicroUsdc,
        executionStatus: c.executionStatus,
      })),
      escalations: plan.escalations,
    },
  }).catch(() => {});
  for (const c of plan.campaigns) {
    await audit({
      actorType: "AGENT",
      actorId: null,
      workspaceId: plan.workspaceId,
      partnerId: null,
      action: "cfo.campaign.decision",
      targetType: "campaign",
      targetId: c.campaignId,
      metadata: {
        capitalScore: c.capitalScore,
        confidence: c.confidence,
        spendAction: c.spendAction,
        spendReason: c.spendReason,
        capitalAction: c.capitalAction,
        recommendedNewAllocationMicroUsdc: c.recommendedNewAllocationMicroUsdc,
        executionStatus: c.executionStatus,
        bountyAction: c.bountyAction,
        bountyRule: c.bountyRule,
        reasons: c.reasons.slice(0, 6),
        warnings: c.warnings.slice(0, 6),
      },
    }).catch(() => {});
  }
  if (plan.escalations.length > 0) {
    await audit({
      actorType: "AGENT",
      actorId: null,
      workspaceId: plan.workspaceId,
      partnerId: null,
      action: "cfo.escalated",
      targetType: "workspace",
      targetId: plan.workspaceId,
      metadata: { escalations: plan.escalations, generatedAt: plan.generatedAt },
    }).catch(() => {});
  }
}
