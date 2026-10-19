import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  checkoutIntents,
  outcomes,
  partners,
  payouts,
  referralEvents,
  referrals,
  userPersonas,
} from "../db/schema";
import { checkJoinEligibility, parsePartnerRules, type PartnerRules } from "../domain/market";
import { buildPaceSnapshot, type PaceStatus } from "./growth";
import { committedForCampaign } from "./payouts";
import { evaluateTargetSettled } from "./markets";
import type { MarketStore } from "./campaignStore";

/**
 * Creator Campaign Scout v1 (creator-side intelligence).
 *
 * Deterministic throughout: interpretable scores, explicit reasons,
 * evidence-graded confidence. No follower counts, no fabricated metrics,
 * no model calls. Join/referral/attribution paths are reused untouched —
 * this module only READS and recommends.
 */

export type ScoutEligibility = "ELIGIBLE" | "NOT_ELIGIBLE" | "ALREADY_JOINED" | "UNKNOWN";
export type ScoutDecision = "RECOMMEND" | "WATCH" | "ALREADY_JOINED" | "SKIP" | "NOT_ELIGIBLE";
export type ScoutConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface ScoutCandidateFacts {
  campaignId: string;
  workspaceName: string;
  objective: string;
  category: string | null;
  bountyMicroUsdc: bigint;
  targetOutcomeCount: number | null;
  verifiedOutcomes: number;
  deadline: Date | null;
  campaignState: string;
  marketStatus: string;
  minQualifyingMicroUsdc: bigint | null;
  holdSeconds: number;
  alreadyJoined: boolean;
  referralPath: string | null;
  creatorVerifiedTotal: number;
  creatorVerifiedRecent: number;
  creatorActions: number;
  creatorSettledTotalMicroUsdc: bigint;
  paceStatus: PaceStatus | null;
}

export interface ScoredCandidate {
  facts: Omit<ScoutCandidateFacts, "bountyMicroUsdc" | "minQualifyingMicroUsdc" | "creatorSettledTotalMicroUsdc"> & {
    bountyMicroUsdc: string;
    minQualifyingMicroUsdc: string | null;
    creatorSettledTotalMicroUsdc: string;
  };
  eligibility: ScoutEligibility;
  eligibilityReason: string;
  score: number;
  rank: number;
  decision: ScoutDecision;
  reason: string;
  confidence: ScoutConfidence;
  evidenceUsed: string[];
  earningsEstimateMicroUsdc: { low: string; high: string } | null;
  earningsNote: string;
}

function normCategory(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/** Eligibility first: an unjoinable campaign can never be an opportunity. */
export function checkScoutEligibility(params: {
  alreadyJoined: boolean;
  marketStatus: string;
  campaignLive: boolean;
  deadline: Date | null;
  visibility: string;
  targetSettled: boolean;
  rules: PartnerRules | null;
  campaignCategory: string | null;
  activeTermsCount: number;
  payoutWallet: string | null;
  bountyMicroUsdc: bigint;
  now: Date;
}): { eligibility: ScoutEligibility; reason: string } {
  const p = params;
  if (p.alreadyJoined) return { eligibility: "ALREADY_JOINED", reason: "Already participating — referral link active." };
  if (p.targetSettled) return { eligibility: "NOT_ELIGIBLE", reason: "Objective complete and settled; participation closed." };
  if (p.visibility !== "PUBLIC") {
    return { eligibility: "NOT_ELIGIBLE", reason: "Private campaign — an owner invite is required." };
  }
  if (!p.rules) return { eligibility: "UNKNOWN", reason: "Creator profile incomplete — cannot prove eligibility yet." };
  const check = checkJoinEligibility({
    marketStatus: p.marketStatus as "OPEN",
    campaignLive: p.campaignLive,
    deadline: p.deadline,
    publicBountyMicroUsdc: p.bountyMicroUsdc,
    rules: p.rules,
    campaignCategory: p.campaignCategory,
    activeTermsCount: p.activeTermsCount,
    requestedAllocation: 1,
    payoutWallet: p.payoutWallet,
    now: p.now,
  });
  if (!check.ok) return { eligibility: "NOT_ELIGIBLE", reason: check.message };
  return { eligibility: "ELIGIBLE", reason: "Eligible under current campaign and creator rules." };
}

interface ScoreBreakdown {
  fit: number;
  evidence: number;
  economics: number;
  urgency: number;
}

/**
 * Interpretable 0–100 scoring. Weights: fit 30 / evidence 30 / economics 25 /
 * urgency 15. Evidence is damped (log scale) so tiny samples cannot dominate;
 * cold-start creators score on fit + economics with LOW confidence.
 */
export function scoreCandidate(params: {
  nicheFit: boolean;
  categoryBlocked: boolean;
  verifiedTotal: number;
  verifiedRecent: number;
  actions: number;
  verificationRate: number;
  bountyMicroUsdc: bigint;
  minBountyMicroUsdc: bigint | null;
  remainingTarget: number | null;
  msUntilDeadline: number | null;
  paceStatus: PaceStatus | null;
}): { score: number; breakdown: ScoreBreakdown; confidence: ScoutConfidence; evidenceUsed: string[] } {
  const evidenceUsed: string[] = [];
  let fit = 0;
  if (params.categoryBlocked) {
    fit = 0;
    evidenceUsed.push("category-blocked");
  } else if (params.nicheFit) {
    fit = 30;
    evidenceUsed.push("niche-match");
  } else {
    fit = 12;
    evidenceUsed.push("open-category");
  }
  const evidenceRaw = Math.log10(1 + params.verifiedTotal) * 8 + Math.min(10, params.verifiedRecent * 2) + params.verificationRate * 10;
  const evidence = Math.min(30, Math.round(evidenceRaw * 10) / 10);
  if (params.verifiedTotal > 0 || params.actions > 0) evidenceUsed.push(`${params.verifiedTotal}-verified/${params.actions}-actions`);
  else evidenceUsed.push("no-history");
  let economics = 10;
  if (params.minBountyMicroUsdc !== null && params.bountyMicroUsdc >= params.minBountyMicroUsdc) {
    economics = 18;
    evidenceUsed.push("meets-min-bounty");
  } else if (params.minBountyMicroUsdc !== null) {
    economics = 4;
    evidenceUsed.push("below-min-bounty");
  }
  if (params.remainingTarget !== null && params.remainingTarget > 0) {
    economics += 7;
    evidenceUsed.push(`${params.remainingTarget}-remaining`);
  }
  let urgency = 5;
  if (params.msUntilDeadline !== null) {
    const days = params.msUntilDeadline / 86_400_000;
    if (days < 0) urgency = 0;
    else if (days <= 3) urgency = 15;
    else if (days <= 14) urgency = 10;
    evidenceUsed.push(days <= 3 ? "closing-soon" : "time-remaining");
  }
  if (params.paceStatus === "BEHIND" || params.paceStatus === "AT_RISK") {
    urgency = Math.min(15, urgency + 3);
    evidenceUsed.push(`pace-${params.paceStatus.toLowerCase()}`);
  }
  const score = Math.round((fit + Math.min(30, evidence) + Math.min(25, economics) + urgency) * 10) / 10;
  const confidence: ScoutConfidence = params.actions >= 10 ? "HIGH" : params.actions >= 3 || params.verifiedTotal > 0 ? "MEDIUM" : "LOW";
  return { score, breakdown: { fit, evidence, economics, urgency }, confidence, evidenceUsed };
}

/** Earnings range only with real history (≥5 actions); otherwise honest absence. */
export function estimateEarnings(params: {
  bountyMicroUsdc: bigint;
  actions: number;
  verifiedTotal: number;
}): { estimate: { low: string; high: string } | null; note: string } {
  if (params.actions < 5 || params.verifiedTotal === 0) {
    return { estimate: null, note: "Not enough history to estimate earnings yet." };
  }
  const rate = params.verifiedTotal / params.actions;
  const low = BigInt(Math.floor(Number(params.bountyMicroUsdc) * rate * 0.5));
  const high = BigInt(Math.ceil(Number(params.bountyMicroUsdc) * Math.min(1, rate * 1.5)));
  return {
    estimate: { low: low.toString(), high: high.toString() },
    note: `ESTIMATE from ${params.verifiedTotal}/${params.actions} verified history — never guaranteed.`,
  };
}

const RECOMMEND_SCORE = 55;

/** Disposes one scored candidate. Relative SKIP needs rank context from the plan builder. */
export function decideScoutCandidate(params: {
  eligibility: ScoutEligibility;
  score: number;
  rank: number;
  total: number;
  confidence: ScoutConfidence;
  hasEvidence: boolean;
}): { decision: ScoutDecision; reason: string } {
  switch (params.eligibility) {
    case "ALREADY_JOINED":
      return { decision: "ALREADY_JOINED", reason: "Already participating — share the referral link." };
    case "NOT_ELIGIBLE":
      return { decision: "NOT_ELIGIBLE", reason: "Cannot join under current rules." };
    case "UNKNOWN":
      return { decision: "WATCH", reason: "Eligibility unproven — complete the creator profile first." };
    default:
      break;
  }
  if (!params.hasEvidence) {
    return params.score >= 40
      ? { decision: "WATCH", reason: "Cold-start opportunity — profile fits but no performance history yet." }
      : { decision: "SKIP", reason: "Weak fit and no evidence; better options available." };
  }
  if (params.score >= RECOMMEND_SCORE) {
    return { decision: "RECOMMEND", reason: "Strong match — eligible with verified performance evidence." };
  }
  if (params.rank <= 3) {
    return { decision: "WATCH", reason: "Eligible but evidence is thin; watch while stronger options lead." };
  }
  return { decision: "SKIP", reason: "Weak fit — stronger evidence-backed options available." };
}

export interface ScoutPlan {
  topOpportunities: ScoredCandidate[];
  watchlist: ScoredCandidate[];
  joined: ScoredCandidate[];
  notEligible: ScoredCandidate[];
  summary: string;
}

export function buildScoutPlan(candidates: ScoredCandidate[]): ScoutPlan {
  const ranked = [...candidates]
    .filter((c) => c.eligibility === "ELIGIBLE")
    .sort((a, b) => b.score - a.score)
    .map((c, i) => ({ ...c, rank: i + 1 }));
  // Re-dispose SKIP/WATCH with rank context (top-3 watch rule).
  for (const c of ranked) {
    if (c.decision === "SKIP" || c.decision === "WATCH") {
      const re = decideScoutCandidate({
        eligibility: c.eligibility,
        score: c.score,
        rank: c.rank,
        total: ranked.length,
        confidence: c.confidence,
        hasEvidence: c.evidenceUsed.some((e) => e.includes("verified")),
      });
      c.decision = re.decision;
      c.reason = re.reason;
    }
  }
  const topOpportunities = ranked.filter((c) => c.decision === "RECOMMEND");
  const watchlist = ranked.filter((c) => c.decision === "WATCH");
  const joined = candidates.filter((c) => c.decision === "ALREADY_JOINED");
  const notEligible = candidates.filter((c) => c.decision === "NOT_ELIGIBLE");
  const best = topOpportunities[0] ?? null;
  return {
    topOpportunities,
    watchlist,
    joined,
    notEligible,
    summary: best
      ? `${topOpportunities.length} recommended, ${watchlist.length} to watch — best: ${best.facts.workspaceName} (${best.score}, ${best.confidence} confidence).`
      : joined.length > 0 && ranked.length === 0
        ? `Already joined ${joined.length} campaign${joined.length === 1 ? "" : "s"} — no new eligible opportunities right now.`
        : "No recommended opportunities right now — complete the creator profile or check back as markets open.",
  };
}

/* ---------------- Funnel diagnosis (observable truth only) ---------------- */

export interface FunnelDiagnosis {
  stage: "visit-to-action" | "action-to-verified" | "verified-to-hold" | "hold-to-settled" | "healthy" | "empty";
  sentence: string;
}

export function diagnoseFunnel(params: {
  clicks: number;
  actions: number;
  verified: number;
  inHold: number;
  settled: number;
}): FunnelDiagnosis {
  const p = params;
  if (p.clicks === 0 && p.actions === 0 && p.verified === 0) {
    return { stage: "empty", sentence: "No funnel activity yet — share the referral link to start." };
  }
  const visitLoss = p.clicks - p.actions;
  const verifyLoss = p.actions - p.verified;
  if (p.clicks > 0 && visitLoss >= Math.max(verifyLoss, 1) && visitLoss > 0) {
    return { stage: "visit-to-action", sentence: `Most loss is between visit and action (${visitLoss} drop-off observed).` };
  }
  if (verifyLoss > 0 && verifyLoss >= p.inHold && verifyLoss >= p.settled) {
    return { stage: "action-to-verified", sentence: "Actions are happening, but verification is the bottleneck (drop-off observed)." };
  }
  if (p.inHold > 0 && p.inHold >= p.settled) {
    return { stage: "verified-to-hold", sentence: "Verified outcomes are healthy; current earnings are waiting in hold." };
  }
  if (p.settled > 0) {
    return { stage: "healthy", sentence: `Funnel is settling — ${p.settled} settled payout${p.settled === 1 ? "" : "s"} recorded.` };
  }
  return { stage: "hold-to-settled", sentence: "Verified outcomes recorded; settlement pending hold clearance." };
}

/* ---------------- Alert candidates (pure, no delivery) ---------------- */

export type ScoutAlertKind = "NEW_MATCH" | "BOUNTY_CHANGED" | "CAMPAIGN_CLOSING_SOON" | "VERIFICATION_DROP" | "PAYOUT_SETTLED";

export interface ScoutAlert {
  kind: ScoutAlertKind;
  campaignId: string;
  reason: string;
}

export function detectScoutAlerts(params: {
  candidates: { campaignId: string; decision: ScoutDecision; bountyMicroUsdc: string; msUntilDeadline: number | null }[];
  seenCampaignIds: string[];
  previousBountyByCampaign: Record<string, string>;
  recentVerificationRate: number | null;
  historicalVerificationRate: number | null;
  newSettledPayouts: { campaignId: string; payoutId: string }[];
}): ScoutAlert[] {
  const alerts: ScoutAlert[] = [];
  for (const c of params.candidates) {
    if (!params.seenCampaignIds.includes(c.campaignId) && (c.decision === "RECOMMEND" || c.decision === "WATCH")) {
      alerts.push({ kind: "NEW_MATCH", campaignId: c.campaignId, reason: "New matching opportunity appeared." });
    }
    const prev = params.previousBountyByCampaign[c.campaignId];
    if (prev !== undefined && prev !== c.bountyMicroUsdc) {
      alerts.push({ kind: "BOUNTY_CHANGED", campaignId: c.campaignId, reason: `Bounty moved ${prev} → ${c.bountyMicroUsdc}.` });
    }
    if (c.msUntilDeadline !== null && c.msUntilDeadline > 0 && c.msUntilDeadline <= 72 * 3_600_000) {
      alerts.push({ kind: "CAMPAIGN_CLOSING_SOON", campaignId: c.campaignId, reason: "Eligible campaign closes within 72 hours." });
    }
  }
  if (
    params.recentVerificationRate !== null &&
    params.historicalVerificationRate !== null &&
    params.historicalVerificationRate > 0 &&
    params.recentVerificationRate < params.historicalVerificationRate * 0.5
  ) {
    alerts.push({ kind: "VERIFICATION_DROP", campaignId: params.candidates[0]?.campaignId ?? "", reason: "Recent verification rate fell below half the historical rate." });
  }
  for (const s of params.newSettledPayouts) {
    alerts.push({ kind: "PAYOUT_SETTLED", campaignId: s.campaignId, reason: `Payout ${s.payoutId.slice(0, 8)} settled.` });
  }
  return alerts;
}

/* ---------------- Loader (reads existing truth; no new tables) ---------------- */

export interface ScoutSnapshot {
  candidates: ScoredCandidate[];
  plan: ScoutPlan;
}

export async function loadScoutSnapshot(
  store: MarketStore,
  userId: string,
  now: Date = new Date(),
): Promise<ScoutSnapshot> {
  // DB-backed reads (persona, cross-campaign evidence) are best-effort:
  // without a database the loader still scores live markets as a cold
  // start instead of failing.
  let db: ReturnType<typeof getDb> | null = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }
  const [personaRow] = db
    ? await db.select().from(userPersonas).where(eq(userPersonas.userId, userId)).limit(1).catch(() => [])
    : [];
  const profile = await store.getPartnerByUserId(userId).catch(() => null);
  const rules = profile ? parsePartnerRules(profile.rulesJson) : null;
  const parsedRules = rules && rules.ok ? rules.rules : null;
  const niche = normCategory(personaRow?.category ?? profile?.categories?.[0] ?? null);

  const markets = await store.listMarkets().catch(() => []);
  const activeTerms = profile ? await store.listPartnerTerms(profile.id).catch(() => []) : [];
  const activeTermsCount = activeTerms.filter((t) => t.status === "ACTIVE").length;

  // Creator-wide evidence (across campaigns — history, not just this card).
  // Empty when there is no database (cold start) or no profile.
  const [allRefs, allOutcomes, allPayouts, allIntents]: [typeof referrals.$inferSelect[], typeof outcomes.$inferSelect[], typeof payouts.$inferSelect[], typeof checkoutIntents.$inferSelect[]] =
    profile && db
      ? await Promise.all([
          db.select().from(referrals).where(eq(referrals.partnerId, profile.id)).catch(() => []),
          db.select().from(outcomes).where(eq(outcomes.partnerId, profile.id)).catch(() => []),
          db.select().from(payouts).where(eq(payouts.partnerId, profile.id)).catch(() => []),
          db.select().from(checkoutIntents).where(eq(checkoutIntents.partnerId, profile.id)).catch(() => []),
        ])
      : [[], [], [], []];
  const verifiedIds = new Set(allOutcomes.filter((o) => o.status === "VERIFIED").map((o) => o.id));
  const settledIds = new Set(allPayouts.filter((p) => p.state === "SETTLED").map((p) => p.outcomeId));
  const settledSum = allPayouts.filter((p) => p.state === "SETTLED").reduce((s, p) => s + p.amountMicroUsdc, 0n);
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const recentVerified = allOutcomes.filter((o) => o.status === "VERIFIED" && o.verifiedAt && o.verifiedAt.getTime() >= weekAgo).length;

  const scored: ScoredCandidate[] = [];
  for (const m of markets) {
    const campaign = await store.getCampaign(m.campaignId).catch(() => null);
    if (!campaign) continue;
    const version = await store.getVersion(m.campaignId, m.policyVersion).catch(() => null);
    if (!version) continue;
    // Exclude anything that is not a live public opportunity.
    if (m.status !== "OPEN" || campaign.state !== "LIVE") continue;
    if (version.marketVisibility !== "PUBLIC") continue;
    if (!version.deadline || version.deadline <= now) continue;
    const settled = await evaluateTargetSettled(store, m.campaignId, m.policyVersion).catch(() => ({ complete: false }));
    if (settled.complete) continue;

    const terms = profile ? await store.getTerms(m.campaignId, profile.id).catch(() => null) : null;
    const joined = Boolean(terms && terms.status === "ACTIVE");
    let referralPath: string | null = null;
    if (joined && terms) {
      const referral = await store.getReferralByTerms(terms.id).catch(() => null);
      if (referral && referral.status === "ACTIVE") referralPath = `/r/${referral.code}`;
    }
    const workspace = await store.getWorkspace(campaign.workspaceId).catch(() => null);
    const category = workspace?.category ?? null;
    let paceStatus: PaceStatus | null = null;
    try {
      const funding = await store.getFunding(m.campaignId, m.policyVersion).catch(() => null);
      const funded = funding?.status === "CONFIRMED" ? (funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc) : 0n;
      const committed = await committedForCampaign(store, m.campaignId).catch(() => 0n);
      paceStatus = buildPaceSnapshot({
        targetOutcomeCount: version.targetOutcomeCount ?? 0,
        verifiedOutcomeCount: await store.countVerifiedOutcomes(m.campaignId).catch(() => 0),
        settledOutcomeCount: 0,
        openedAtMs: m.openedAt.getTime(),
        deadlineMs: version.deadline ? version.deadline.getTime() : now.getTime(),
        nowMs: now.getTime(),
        publicBountyMicroUsdc: m.publicBountyMicroUsdc,
        fundedMicroUsdc: funded,
        committedMicroUsdc: committed,
        availableMicroUsdc: funded > committed ? funded - committed : 0n,
      }).paceStatus;
    } catch {
      paceStatus = null;
    }
    const eligibility = checkScoutEligibility({
      alreadyJoined: joined,
      marketStatus: m.status,
      campaignLive: campaign.state === "LIVE",
      deadline: version.deadline,
      visibility: version.marketVisibility,
      targetSettled: false,
      rules: parsedRules,
      campaignCategory: category,
      activeTermsCount,
      payoutWallet: profile?.payoutWallet ?? null,
      bountyMicroUsdc: m.publicBountyMicroUsdc,
      now,
    });

    const nicheFit = niche !== "" && normCategory(category) === niche;
    const categoryBlocked =
      (parsedRules?.blockedCategories ?? []).map((c) => c.toLowerCase()).includes(normCategory(category)) && normCategory(category) !== "";
    const actions = allIntents.length;
    const verificationRate = actions > 0 ? verifiedIds.size / actions : 0;
    const { score, confidence, evidenceUsed } = scoreCandidate({
      nicheFit,
      categoryBlocked,
      verifiedTotal: verifiedIds.size,
      verifiedRecent: recentVerified,
      actions,
      verificationRate,
      bountyMicroUsdc: m.publicBountyMicroUsdc,
      minBountyMicroUsdc: profile ? (parsedRules?.minimumBountyMicroUsdc ?? null) : null,
      remainingTarget: version.targetOutcomeCount,
      msUntilDeadline: version.deadline ? version.deadline.getTime() - now.getTime() : null,
      paceStatus,
    });
    const earnings = estimateEarnings({ bountyMicroUsdc: m.publicBountyMicroUsdc, actions, verifiedTotal: verifiedIds.size });
    const hasEvidence = verifiedIds.size > 0 || actions > 0;
    const { decision, reason } = decideScoutCandidate({
      eligibility: eligibility.eligibility,
      score,
      rank: 0,
      total: 0,
      confidence,
      hasEvidence,
    });
    scored.push({
      facts: {
        campaignId: campaign.id,
        workspaceName: workspace?.name ?? "Workspace",
        objective: version.intentText,
        category,
        bountyMicroUsdc: m.publicBountyMicroUsdc.toString(),
        targetOutcomeCount: version.targetOutcomeCount,
        verifiedOutcomes: await store.countVerifiedOutcomes(m.campaignId).catch(() => 0),
        deadline: version.deadline,
        campaignState: campaign.state,
        marketStatus: m.status,
        minQualifyingMicroUsdc: version.minQualifyingPurchaseMicroUsdc?.toString() ?? null,
        holdSeconds: version.refundHoldSeconds ?? 0,
        alreadyJoined: joined,
        referralPath,
        creatorVerifiedTotal: verifiedIds.size,
        creatorVerifiedRecent: recentVerified,
        creatorActions: actions,
        creatorSettledTotalMicroUsdc: settledSum.toString(),
        paceStatus,
      },
      eligibility: eligibility.eligibility,
      eligibilityReason: eligibility.reason,
      score,
      rank: 0,
      decision,
      reason: eligibility.eligibility === "ELIGIBLE" ? reason : eligibility.reason,
      confidence,
      evidenceUsed,
      earningsEstimateMicroUsdc: earnings.estimate,
      earningsNote: earnings.note,
    });
  }
  return { candidates: scored, plan: buildScoutPlan(scored) };
}
