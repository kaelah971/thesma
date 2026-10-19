import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
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
import { evaluateTargetSettled, joinCampaign } from "./markets";
import {
  closingBucket,
  createDrizzleNotificationStore,
  dedupeKeyFor,
  isUsefulRefusal,
  isoWeekBucket,
  refusalMessage,
  type NewCreatorNotification,
  type NotificationStore,
  type StoredCreatorNotification,
} from "./creatorNotifications";
import { formatUsdc } from "@/lib/format";
import type { AuditSink, MarketStore } from "./campaignStore";

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

export type ScoutAlertKind = "NEW_MATCH" | "BOUNTY_CHANGED" | "CAMPAIGN_CLOSING_SOON" | "VERIFICATION_DROP" | "PAYOUT_SETTLED" | "AUTO_JOINED" | "AUTO_JOIN_REFUSED" | "NEW_MATCH_REQUIRES_REVIEW";

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

/* ---------------- Bounded auto-join authority ---------------- */

export type AutoJoinVerdict = "AUTO_JOIN" | "RECOMMEND_ONLY" | "REFUSE";

export interface AutoJoinAuthorityInput {
  autoJoinEnabled: boolean;
  scoutDecision: ScoutDecision;
  eligibility: ScoutEligibility;
  confidence: ScoutConfidence;
  confidenceThreshold: ScoutConfidence;
  bountyMicroUsdc: bigint;
  minBountyMicroUsdc: bigint;
  categoryBlocked: boolean;
  categoryAllowed: boolean;
  activeTermsCount: number;
  maxActiveCampaigns: number | null;
  campaignLive: boolean;
  visibilityPublic: boolean;
  deadlineOk: boolean;
  targetSettled: boolean;
  alreadyJoined: boolean;
  joinsToday: number;
  maxJoinsPerDay: number | null;
}

const CONFIDENCE_RANK: Record<ScoutConfidence, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

/** Confidence gate: actual must meet the creator's threshold. Pure. */
export function meetsConfidence(actual: ScoutConfidence, threshold: ScoutConfidence): boolean {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[threshold];
}

/**
 * Deterministic creator-authority validator — the FINAL word on auto-join.
 * Scout scores never reach past it: every requirement must hold, unknown
 * data fails closed to RECOMMEND_ONLY or REFUSE, never AUTO_JOIN.
 */
export function evaluateAutoJoinAuthority(input: AutoJoinAuthorityInput): {
  verdict: AutoJoinVerdict;
  rule: string;
  reason: string;
} {
  const refuse = (rule: string, reason: string) => ({ verdict: "REFUSE" as const, rule, reason });
  const recommend = (rule: string, reason: string) => ({ verdict: "RECOMMEND_ONLY" as const, rule, reason });
  if (input.alreadyJoined) return refuse("ALREADY_JOINED", "Already participating — the existing referral stands.");
  if (input.targetSettled) return refuse("TARGET_SETTLED", "Objective complete and settled; participation closed.");
  if (!input.campaignLive) return refuse("CAMPAIGN_NOT_LIVE", "Campaign is not live.");
  if (!input.visibilityPublic) return refuse("NOT_PUBLIC", "Private campaign — an owner invite is required.");
  if (!input.deadlineOk) return refuse("EXPIRED", "Campaign deadline has passed.");
  if (input.eligibility !== "ELIGIBLE") return refuse("INELIGIBLE", "Join eligibility not proven under current rules.");
  if (input.categoryBlocked) return refuse("CATEGORY_BLOCKED", "Blocked by the creator's category rules — score is irrelevant.");
  if (!input.categoryAllowed) return refuse("CATEGORY_NOT_ALLOWED", "Outside the creator's allowed categories.");
  if (input.bountyMicroUsdc < input.minBountyMicroUsdc) {
    return refuse("MIN_BOUNTY", "Bounty is below the creator's minimum — no bounty outranks policy.");
  }
  if (input.maxActiveCampaigns !== null && input.activeTermsCount >= input.maxActiveCampaigns) {
    return refuse("MAX_ACTIVE", "Creator active-campaign limit reached.");
  }
  if (input.maxJoinsPerDay !== null && input.joinsToday >= input.maxJoinsPerDay) {
    return refuse("RATE_LIMITED", "Creator daily join limit reached.");
  }
  if (!input.autoJoinEnabled) {
    return recommend("AUTOJOIN_DISABLED", "Recommended, but auto-join is disabled — join manually.");
  }
  if (input.scoutDecision !== "RECOMMEND") {
    return recommend("NOT_RECOMMENDED", "Scout did not recommend — human review first.");
  }
  if (!meetsConfidence(input.confidence, input.confidenceThreshold)) {
    return recommend("CONFIDENCE_BELOW_THRESHOLD", `Confidence ${input.confidence} is below the ${input.confidenceThreshold} threshold.`);
  }
  return {
    verdict: "AUTO_JOIN",
    rule: "WITHIN_CREATOR_AUTHORITY",
    reason: "Eligible, recommended, and inside every creator rule.",
  };
}

/* ---------------- Manual Run Scout (no scheduler in v1) ---------------- */

export interface ScoutRunSummary {
  evaluated: number;
  joined: { campaignId: string; referralCode: string; alreadyJoined: boolean }[];
  refused: { campaignId: string; rule: string; reason: string }[];
  recommendedOnly: { campaignId: string; rule: string; reason: string }[];
}

/**
 * Creator-triggered Scout run: evaluates live candidates through Scout +
 * creator authority, joining ONLY permitted ones via the existing
 * idempotent joinCampaign path (same referral reused on repeats).
 */
export async function runScoutAutoJoin(
  deps: { store: MarketStore; audit: AuditSink; now?: () => Date },
  userId: string,
  opts?: {
    joinsTodayByPartner?: (partnerId: string) => Promise<number>;
    /** Test seam: skip live loading and dispose this snapshot instead. */
    snapshot?: ScoutSnapshot;
    /** Recorded in the evaluated audit event; background runs tag themselves. */
    trigger?: "manual" | "background";
  },
): Promise<ScoutRunSummary> {
  const now = deps.now?.() ?? new Date();
  const profile = await deps.store.getPartnerByUserId(userId);
  if (!profile) {
    throw Object.assign(new Error("Create a Partner profile first"), { status: 404, code: "PARTNER_PROFILE_REQUIRED" });
  }
  const parsed = parsePartnerRules(profile.rulesJson);
  if (!parsed.ok) {
    throw Object.assign(new Error("Stored Partner rules are invalid"), { status: 500, code: "INTERNAL" });
  }
  const rules = (parsed as { ok: true; rules: import("../domain/market").PartnerRules }).rules;
  const snapshot = opts?.snapshot ?? (await loadScoutSnapshot(deps.store, userId, now));
  const terms = await deps.store.listPartnerTerms(profile.id).catch(() => []);
  const activeTermsCount = terms.filter((t) => t.status === "ACTIVE").length;
  let joinsToday = 0;
  if (rules.maxAutoJoinsPerDay !== null) {
    if (opts?.joinsTodayByPartner) {
      joinsToday = await opts.joinsTodayByPartner(profile.id);
    } else {
      try {
        const db = getDb();
        const dayStart = new Date(now);
        dayStart.setUTCHours(0, 0, 0, 0);
        const rows = await db.select().from(referrals).where(eq(referrals.partnerId, profile.id));
        joinsToday = rows.filter((r) => r.createdAt >= dayStart).length;
      } catch {
        joinsToday = Number.MAX_SAFE_INTEGER;
      }
    }
  }
  const summary: ScoutRunSummary = { evaluated: 0, joined: [], refused: [], recommendedOnly: [] };
  const categoryOf = (category: string | null) => (category ?? "").trim().toLowerCase();
  for (const c of snapshot.candidates) {
    if (c.eligibility === "ALREADY_JOINED") continue;
    if (c.eligibility !== "ELIGIBLE") {
      summary.refused.push({ campaignId: c.facts.campaignId, rule: "INELIGIBLE", reason: c.eligibilityReason });
      continue;
    }
    summary.evaluated += 1;
    const allowed = rules.allowedCategories.map((x) => x.toLowerCase());
    const authority = evaluateAutoJoinAuthority({
      autoJoinEnabled: rules.autoJoin,
      scoutDecision: c.decision,
      eligibility: c.eligibility,
      confidence: c.confidence,
      confidenceThreshold: rules.minScoutConfidence,
      bountyMicroUsdc: BigInt(c.facts.bountyMicroUsdc),
      minBountyMicroUsdc: rules.minimumBountyMicroUsdc,
      categoryBlocked: categoryOf(c.facts.category) !== "" && rules.blockedCategories.map((x) => x.toLowerCase()).includes(categoryOf(c.facts.category)),
      categoryAllowed: allowed.length === 0 || (categoryOf(c.facts.category) !== "" && allowed.includes(categoryOf(c.facts.category))),
      activeTermsCount: activeTermsCount + summary.joined.length,
      maxActiveCampaigns: rules.maxActiveCampaigns,
      campaignLive: c.facts.campaignState === "LIVE",
      visibilityPublic: true,
      deadlineOk: c.facts.deadline ? new Date(c.facts.deadline) > now : true,
      targetSettled: false,
      alreadyJoined: false,
      joinsToday,
      maxJoinsPerDay: rules.maxAutoJoinsPerDay,
    });
    if (authority.verdict === "AUTO_JOIN") {
      try {
        const res = await joinCampaign(
          { store: deps.store, audit: deps.audit, now: () => now } as never,
          { campaignId: c.facts.campaignId, userId },
        );
        summary.joined.push({ campaignId: c.facts.campaignId, referralCode: res.referral.code, alreadyJoined: res.alreadyJoined });
        joinsToday += res.alreadyJoined ? 0 : 1;
        await deps.audit({
          actorType: "USER",
          actorId: userId,
          partnerId: profile.id,
          action: "creator.autojoin.executed",
          targetType: "campaign",
          targetId: c.facts.campaignId,
          metadata: { campaignId: c.facts.campaignId, referralCode: res.referral.code, rule: authority.rule, score: c.score, confidence: c.confidence },
        });
      } catch (e) {
        summary.refused.push({ campaignId: c.facts.campaignId, rule: (e as { code?: string }).code ?? "JOIN_FAILED", reason: (e as Error).message });
      }
    } else if (authority.verdict === "RECOMMEND_ONLY") {
      summary.recommendedOnly.push({ campaignId: c.facts.campaignId, rule: authority.rule, reason: authority.reason });
    } else {
      summary.refused.push({ campaignId: c.facts.campaignId, rule: authority.rule, reason: authority.reason });
    }
  }
  await deps.audit({
    actorType: "USER",
    actorId: userId,
    partnerId: profile.id,
    action: "creator.autojoin.evaluated",
    targetType: "partner",
    targetId: profile.id,
    metadata: {
      trigger: opts?.trigger ?? "manual",
      evaluated: summary.evaluated,
      joined: summary.joined.map((j) => j.campaignId),
      refused: summary.refused,
      recommendedOnly: summary.recommendedOnly,
    },
  });
  return summary;
}

/** Alert candidates for one manual Run Scout pass. Pure — no delivery. */
export function alertsForAutoJoinRun(summary: ScoutRunSummary): ScoutAlert[] {
  const alerts: ScoutAlert[] = [];
  for (const j of summary.joined) {
    alerts.push({ kind: "AUTO_JOINED", campaignId: j.campaignId, reason: `Auto-joined inside creator rules (referral ${j.referralCode}).` });
  }
  for (const r of summary.refused) {
    alerts.push({ kind: "AUTO_JOIN_REFUSED", campaignId: r.campaignId, reason: `${r.rule}: ${r.reason}` });
  }
  for (const r of summary.recommendedOnly) {
    alerts.push({ kind: "NEW_MATCH_REQUIRES_REVIEW", campaignId: r.campaignId, reason: `${r.rule}: ${r.reason}` });
  }
  return alerts;
}

export interface AuthorityMap {
  rules: {
    autoJoin: boolean;
    minBountyMicroUsdc: string;
    allowedCategories: string[];
    blockedCategories: string[];
    minScoutConfidence: string;
    maxActiveCampaigns: number | null;
    maxAutoJoinsPerDay: number | null;
  } | null;
  byCampaign: Record<string, { verdict: AutoJoinVerdict; rule: string; reason: string }>;
}

/**
 * Authority state for rendered Scout cards (page + API share this).
 * Rules come from the creator's stored profile; unknown data fails
 * closed — never AUTO_JOIN.
 */
export async function loadScoutAuthority(
  store: MarketStore,
  userId: string,
  candidates: ScoredCandidate[],
  now: Date = new Date(),
): Promise<AuthorityMap> {
  const profile = await store.getPartnerByUserId(userId).catch(() => null);
  if (!profile) return { rules: null, byCampaign: {} };
  const parsed = parsePartnerRules(profile.rulesJson);
  if (!parsed.ok) return { rules: null, byCampaign: {} };
  const rules = (parsed as { ok: true; rules: import("../domain/market").PartnerRules }).rules;
  const terms = await store.listPartnerTerms(profile.id).catch(() => []);
  const activeTermsCount = terms.filter((t) => t.status === "ACTIVE").length;
  let joinsToday = 0;
  if (rules.maxAutoJoinsPerDay !== null) {
    try {
      const db = getDb();
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const rows = await db.select().from(referrals).where(eq(referrals.partnerId, profile.id));
      joinsToday = rows.filter((r) => r.createdAt >= dayStart).length;
    } catch {
      joinsToday = Number.MAX_SAFE_INTEGER;
    }
  }
  const byCampaign: AuthorityMap["byCampaign"] = {};
  const norm = (v: string | null) => (v ?? "").trim().toLowerCase();
  const allowed = rules.allowedCategories.map((x) => x.toLowerCase());
  for (const c of candidates) {
    const authority = evaluateAutoJoinAuthority({
      autoJoinEnabled: rules.autoJoin,
      scoutDecision: c.decision,
      eligibility: c.eligibility,
      confidence: c.confidence,
      confidenceThreshold: rules.minScoutConfidence,
      bountyMicroUsdc: BigInt(c.facts.bountyMicroUsdc),
      minBountyMicroUsdc: rules.minimumBountyMicroUsdc,
      categoryBlocked: norm(c.facts.category) !== "" && rules.blockedCategories.map((x) => x.toLowerCase()).includes(norm(c.facts.category)),
      categoryAllowed: allowed.length === 0 || (norm(c.facts.category) !== "" && allowed.includes(norm(c.facts.category))),
      activeTermsCount,
      maxActiveCampaigns: rules.maxActiveCampaigns,
      campaignLive: c.facts.campaignState === "LIVE",
      visibilityPublic: true,
      deadlineOk: c.facts.deadline ? new Date(c.facts.deadline) > now : true,
      targetSettled: false,
      alreadyJoined: c.facts.alreadyJoined,
      joinsToday,
      maxJoinsPerDay: rules.maxAutoJoinsPerDay,
    });
    byCampaign[c.facts.campaignId] = authority;
  }
  return {
    rules: {
      autoJoin: rules.autoJoin,
      minBountyMicroUsdc: rules.minimumBountyMicroUsdc.toString(),
      allowedCategories: rules.allowedCategories,
      blockedCategories: rules.blockedCategories,
      minScoutConfidence: rules.minScoutConfidence,
      maxActiveCampaigns: rules.maxActiveCampaigns,
      maxAutoJoinsPerDay: rules.maxAutoJoinsPerDay,
    },
    byCampaign,
  };
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

/* ---------------- Background Scout runner (scheduled, no clicks) ---------------- */

export interface SettledPayoutInfo {
  payoutId: string;
  campaignId: string;
  amountMicroUsdc: string;
  workspaceName: string | null;
}

export interface BackgroundScoutDeps {
  store: MarketStore;
  audit: AuditSink;
  now?: () => Date;
  notifications?: NotificationStore;
  /** Test seam: replace live snapshot loading (evidence lives in the DB in production). */
  loadSnapshot?: (store: MarketStore, userId: string, now: Date) => Promise<ScoutSnapshot>;
  onboardingCompleted?: (userId: string) => Promise<boolean>;
  joinsTodayByPartner?: (partnerId: string) => Promise<number>;
  settledPayoutsByPartner?: (partnerId: string) => Promise<SettledPayoutInfo[]>;
  funnelRatesByPartner?: (partnerId: string) => Promise<{ recent: number; historical: number } | null>;
  maxCreatorsPerRun?: number;
}

export interface BackgroundScoutSummary {
  startedAt: string;
  creatorsEvaluated: number;
  creatorsSkipped: number;
  campaignsEvaluated: number;
  autoJoins: number;
  refusals: number;
  recommendedOnly: number;
  alertsCreated: number;
  truncated: boolean;
  errors: Array<{ partnerId: string; error: string }>;
}

/** Onboarding gate: unknown (no DB) fails closed — the creator is skipped. */
async function defaultOnboardingCompleted(userId: string): Promise<boolean> {
  try {
    const db = getDb();
    const [row] = await db.select().from(userPersonas).where(eq(userPersonas.userId, userId)).limit(1);
    return Boolean(row?.onboardingCompletedAt);
  } catch {
    return false;
  }
}

/** Settlement truth only: state SETTLED. SUBMITTED rows never surface. */
async function defaultSettledPayouts(store: MarketStore, partnerId: string): Promise<SettledPayoutInfo[]> {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(payouts)
      .where(and(eq(payouts.partnerId, partnerId), eq(payouts.state, "SETTLED")))
      .orderBy(desc(payouts.settledAt))
      .limit(50);
    const out: SettledPayoutInfo[] = [];
    for (const r of rows) {
      let workspaceName: string | null = null;
      try {
        const campaign = await store.getCampaign(r.campaignId);
        const ws = campaign ? await store.getWorkspace(campaign.workspaceId) : null;
        workspaceName = ws?.name ?? null;
      } catch {
        workspaceName = null;
      }
      out.push({
        payoutId: r.id,
        campaignId: r.campaignId,
        amountMicroUsdc: r.amountMicroUsdc.toString(),
        workspaceName,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Observable funnel change with sufficient evidence: verified-per-action
 * rates for the recent 7d window vs the prior 7d. Null when evidence is
 * thin (prior-window actions < 10) or the database is unavailable.
 */
async function defaultFunnelRates(partnerId: string): Promise<{ recent: number; historical: number } | null> {
  try {
    const db = getDb();
    const nowMs = Date.now();
    const weekMs = 7 * 86_400_000;
    const recentStart = new Date(nowMs - weekMs);
    const histStart = new Date(nowMs - 2 * weekMs);
    const [recentVerified, histVerified, recentActions, histActions] = await Promise.all([
      db
        .select({ id: outcomes.id })
        .from(outcomes)
        .where(
          and(
            eq(outcomes.partnerId, partnerId),
            eq(outcomes.status, "VERIFIED"),
            gte(outcomes.verifiedAt, recentStart),
          ),
        ),
      db
        .select({ id: outcomes.id })
        .from(outcomes)
        .where(
          and(
            eq(outcomes.partnerId, partnerId),
            eq(outcomes.status, "VERIFIED"),
            gte(outcomes.verifiedAt, histStart),
            lt(outcomes.verifiedAt, recentStart),
          ),
        ),
      db
        .select({ id: checkoutIntents.id })
        .from(checkoutIntents)
        .where(and(eq(checkoutIntents.partnerId, partnerId), gte(checkoutIntents.createdAt, recentStart))),
      db
        .select({ id: checkoutIntents.id })
        .from(checkoutIntents)
        .where(
          and(
            eq(checkoutIntents.partnerId, partnerId),
            gte(checkoutIntents.createdAt, histStart),
            lt(checkoutIntents.createdAt, recentStart),
          ),
        ),
    ]);
    if (histActions.length < 10 || recentActions.length === 0) return null;
    return {
      recent: recentVerified.length / recentActions.length,
      historical: histVerified.length / histActions.length,
    };
  } catch {
    return null;
  }
}

/**
 * Pure alert builder: Scout summary + market truth + settlement truth →
 * deduped inbox rows. Repeat runs with no change produce nothing.
 */
export function buildBackgroundAlerts(params: {
  candidates: ScoredCandidate[];
  runSummary: ScoutRunSummary;
  existing: StoredCreatorNotification[];
  settled: SettledPayoutInfo[];
  funnel: { recent: number; historical: number } | null;
  rules: { minBountyMicroUsdc: string; maxActiveCampaigns: number | null; maxJoinsPerDay: number | null } | null;
  now: Date;
}): NewCreatorNotification[] {
  const { candidates, runSummary, settled, funnel, rules, now } = params;
  const existingKeys = new Set(params.existing.map((e) => e.dedupeKey));
  const seen = new Set(
    params.existing.map((e) => e.campaignId).filter((c): c is string => Boolean(c)),
  );
  const previousBounty: Record<string, string> = {};
  const ordered = [...params.existing].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const e of ordered) {
    const b = (e.metadataJson as Record<string, unknown> | null)?.bountyMicroUsdc;
    if (e.campaignId && typeof b === "string") previousBounty[e.campaignId] = b;
  }
  const out: NewCreatorNotification[] = [];
  const push = (n: NewCreatorNotification) => {
    if (existingKeys.has(n.dedupeKey)) return;
    existingKeys.add(n.dedupeKey);
    out.push(n);
  };
  const byCampaign = new Map(candidates.map((c) => [c.facts.campaignId, c]));

  for (const j of runSummary.joined) {
    const c = byCampaign.get(j.campaignId);
    const ws = c?.facts.workspaceName ?? "a campaign";
    push({
      type: "AUTO_JOINED",
      campaignId: j.campaignId,
      title: `Auto-joined ${ws}`,
      message:
        `Scout auto-joined ${ws} (${c ? `score ${c.score}, ${c.confidence} confidence` : "inside creator rules"}). ` +
        `Referral /r/${j.referralCode}${j.alreadyJoined ? " (existing link reused — no duplicate)" : ""}.`,
      dedupeKey: dedupeKeyFor.autoJoined(j.campaignId, j.referralCode),
      metadataJson: {
        campaignId: j.campaignId,
        referralCode: j.referralCode,
        referralPath: `/r/${j.referralCode}`,
        alreadyJoined: j.alreadyJoined,
        rule: "WITHIN_CREATOR_AUTHORITY",
        score: c?.score ?? null,
        confidence: c?.confidence ?? null,
        bountyMicroUsdc: c?.facts.bountyMicroUsdc ?? null,
        reason: c?.reason ?? null,
      },
    });
  }
  for (const r of runSummary.refused) {
    const c = byCampaign.get(r.campaignId);
    if (!c || !isUsefulRefusal(c.decision, r.rule)) continue;
    push({
      type: "AUTO_JOIN_REFUSED",
      campaignId: r.campaignId,
      title: `Needs a rule change: ${c.facts.workspaceName}`,
      message: refusalMessage({
        workspaceName: c.facts.workspaceName,
        bountyMicroUsdc: c.facts.bountyMicroUsdc,
        rule: r.rule,
        minBountyMicroUsdc: rules?.minBountyMicroUsdc ?? "0",
        maxActiveCampaigns: rules?.maxActiveCampaigns ?? null,
        maxJoinsPerDay: rules?.maxJoinsPerDay ?? null,
        formatUsdc: (micro) => formatUsdc(micro),
      }),
      dedupeKey: dedupeKeyFor.autoJoinRefused(r.campaignId, r.rule),
      metadataJson: {
        campaignId: r.campaignId,
        rule: r.rule,
        reason: r.reason,
        score: c.score,
        confidence: c.confidence,
        bountyMicroUsdc: c.facts.bountyMicroUsdc,
      },
    });
  }
  for (const r of runSummary.recommendedOnly) {
    const c = byCampaign.get(r.campaignId);
    const ws = c?.facts.workspaceName ?? r.campaignId;
    push({
      type: "NEW_MATCH_REQUIRES_REVIEW",
      campaignId: r.campaignId,
      title: `Review: ${ws}`,
      message:
        `Scout flagged ${ws}` +
        `${c ? ` (score ${c.score}, ${c.confidence} confidence)` : ""} — ${r.reason}`,
      dedupeKey: dedupeKeyFor.review(r.campaignId, r.rule),
      metadataJson: {
        campaignId: r.campaignId,
        rule: r.rule,
        reason: r.reason,
        score: c?.score ?? null,
        confidence: c?.confidence ?? null,
        bountyMicroUsdc: c?.facts.bountyMicroUsdc ?? null,
      },
    });
  }

  const marketAlerts = detectScoutAlerts({
    candidates: candidates.map((c) => ({
      campaignId: c.facts.campaignId,
      decision: c.decision,
      bountyMicroUsdc: c.facts.bountyMicroUsdc,
      msUntilDeadline: c.facts.deadline ? c.facts.deadline.getTime() - now.getTime() : null,
    })),
    seenCampaignIds: [...seen],
    previousBountyByCampaign: previousBounty,
    recentVerificationRate: funnel?.recent ?? null,
    historicalVerificationRate: funnel?.historical ?? null,
    newSettledPayouts: [],
  });
  for (const a of marketAlerts) {
    // Match/join/review surfacing is handled above from the run summary.
    if (a.kind === "NEW_MATCH") continue;
    const c = byCampaign.get(a.campaignId);
    if (a.kind === "BOUNTY_CHANGED" && c) {
      const prev = previousBounty[a.campaignId] ?? "?";
      push({
        type: "BOUNTY_CHANGED",
        campaignId: a.campaignId,
        title: `Bounty changed: ${c.facts.workspaceName}`,
        message:
          `Prospective bounty moved ${formatUsdc(prev === "?" ? null : prev)} → ` +
          `${formatUsdc(c.facts.bountyMicroUsdc)} USDC for ${c.facts.workspaceName}. ` +
          `Scout re-evaluated the economics against your rules on this run; past outcomes keep their old terms.`,
        dedupeKey: dedupeKeyFor.bountyChanged(a.campaignId, c.facts.bountyMicroUsdc),
        metadataJson: {
          campaignId: a.campaignId,
          previousBountyMicroUsdc: prev === "?" ? null : prev,
          bountyMicroUsdc: c.facts.bountyMicroUsdc,
        },
      });
    } else if (a.kind === "CAMPAIGN_CLOSING_SOON" && c) {
      const msLeft = c.facts.deadline ? c.facts.deadline.getTime() - now.getTime() : null;
      const bucket = closingBucket(msLeft);
      if (!bucket) continue;
      push({
        type: "CAMPAIGN_CLOSING_SOON",
        campaignId: a.campaignId,
        title: `Closing soon: ${c.facts.workspaceName}`,
        message:
          `${c.facts.workspaceName} closes within ${bucket} ` +
          `(${c.facts.deadline ? c.facts.deadline.toISOString() : "soon"}) — eligible now at ` +
          `${formatUsdc(c.facts.bountyMicroUsdc)} USDC per verified outcome.`,
        dedupeKey: dedupeKeyFor.closingSoon(a.campaignId, bucket),
        metadataJson: { campaignId: a.campaignId, bucket, bountyMicroUsdc: c.facts.bountyMicroUsdc },
      });
    } else if (a.kind === "VERIFICATION_DROP" && a.campaignId) {
      push({
        type: "VERIFICATION_DROP",
        campaignId: a.campaignId,
        title: "Verification dip detected",
        message:
          `Recent verification fell below half the historical rate ` +
          `(${(funnel?.recent ?? 0).toFixed(2)} vs ${(funnel?.historical ?? 0).toFixed(2)}). ` +
          `Check which step of the funnel is losing visits before scaling spend.`,
        dedupeKey: dedupeKeyFor.verificationDrop(isoWeekBucket(now)),
        metadataJson: { recentRate: funnel?.recent ?? null, historicalRate: funnel?.historical ?? null },
      });
    }
  }
  for (const s of settled) {
    push({
      type: "PAYOUT_SETTLED",
      campaignId: s.campaignId,
      title: `Payout settled: ${formatUsdc(s.amountMicroUsdc)} USDC`,
      message:
        `${formatUsdc(s.amountMicroUsdc)} USDC settled for ${s.workspaceName ?? "a campaign"} ` +
        `(payout ${s.payoutId.slice(0, 8)}…). Verified and paid — not just submitted.`,
      dedupeKey: dedupeKeyFor.payoutSettled(s.payoutId),
      metadataJson: {
        payoutId: s.payoutId,
        campaignId: s.campaignId,
        amountMicroUsdc: s.amountMicroUsdc,
      },
    });
  }
  return out;
}

/**
 * Background Creator Scout runner. For every autoJoin creator with finished
 * onboarding: load the live Scout snapshot, dispose it through the SAME
 * runScoutAutoJoin path as manual runs (same eligibility, same Scout
 * decision, same evaluateAutoJoinAuthority, same idempotent joinCampaign),
 * then persist deduped alerts. One creator failure never aborts the batch.
 * Read-only except permitted joins + inbox rows: no economics mutation,
 * no payout execution.
 */
export async function runBackgroundScout(deps: BackgroundScoutDeps): Promise<BackgroundScoutSummary> {
  const now = deps.now?.() ?? new Date();
  const notifications = deps.notifications ?? createDrizzleNotificationStore();
  const summary: BackgroundScoutSummary = {
    startedAt: now.toISOString(),
    creatorsEvaluated: 0,
    creatorsSkipped: 0,
    campaignsEvaluated: 0,
    autoJoins: 0,
    refusals: 0,
    recommendedOnly: 0,
    alertsCreated: 0,
    truncated: false,
    errors: [],
  };
  const partners = await deps.store.listAutoJoinPartners();
  const cap = deps.maxCreatorsPerRun ?? 500;
  for (const profile of partners.slice(0, cap)) {
    try {
      const onboarded = deps.onboardingCompleted
        ? await deps.onboardingCompleted(profile.userId)
        : await defaultOnboardingCompleted(profile.userId);
      if (!onboarded) {
        summary.creatorsSkipped += 1;
        continue;
      }
      const loadSnapshot = deps.loadSnapshot ?? loadScoutSnapshot;
      const snapshot = await loadSnapshot(deps.store, profile.userId, now);
      const run = await runScoutAutoJoin(
        { store: deps.store, audit: deps.audit, now: () => now },
        profile.userId,
        {
          snapshot,
          joinsTodayByPartner: deps.joinsTodayByPartner,
          trigger: "background",
        },
      );
      summary.creatorsEvaluated += 1;
      summary.campaignsEvaluated += run.evaluated;
      summary.autoJoins += run.joined.length;
      summary.refusals += run.refused.length;
      summary.recommendedOnly += run.recommendedOnly.length;
      const existing = await notifications.listForCreator(profile.userId, 500).catch(() => []);
      const settled = deps.settledPayoutsByPartner
        ? await deps.settledPayoutsByPartner(profile.id).catch(() => [])
        : await defaultSettledPayouts(deps.store, profile.id);
      const funnel = deps.funnelRatesByPartner
        ? await deps.funnelRatesByPartner(profile.id).catch(() => null)
        : await defaultFunnelRates(profile.id);
      const parsed = parsePartnerRules(profile.rulesJson);
      const rules = parsed.ok
        ? {
            minBountyMicroUsdc: (parsed as { ok: true; rules: PartnerRules }).rules.minimumBountyMicroUsdc.toString(),
            maxActiveCampaigns: (parsed as { ok: true; rules: PartnerRules }).rules.maxActiveCampaigns,
            maxJoinsPerDay: (parsed as { ok: true; rules: PartnerRules }).rules.maxAutoJoinsPerDay,
          }
        : null;
      const alerts = buildBackgroundAlerts({
        candidates: snapshot.candidates,
        runSummary: run,
        existing,
        settled,
        funnel,
        rules,
        now,
      });
      for (const a of alerts) {
        try {
          if ((await notifications.insertIfAbsent(profile.userId, a)).inserted) summary.alertsCreated += 1;
        } catch (e) {
          summary.errors.push({ partnerId: profile.id, error: `ALERT_FAILED: ${(e as Error).message}` });
        }
      }
    } catch (e) {
      summary.errors.push({ partnerId: profile.id, error: (e as Error).message });
    }
  }
  summary.truncated = partners.length > cap;
  await deps
    .audit({
      actorType: "SYSTEM",
      actorId: null,
      workspaceId: null,
      partnerId: null,
      action: "creator.scout.background.completed",
      targetType: "job",
      targetId: "creator-scout-background",
      metadata: {
        startedAt: summary.startedAt,
        creatorsEvaluated: summary.creatorsEvaluated,
        creatorsSkipped: summary.creatorsSkipped,
        campaignsEvaluated: summary.campaignsEvaluated,
        autoJoins: summary.autoJoins,
        refusals: summary.refusals,
        recommendedOnly: summary.recommendedOnly,
        alertsCreated: summary.alertsCreated,
        truncated: summary.truncated,
        errors: summary.errors.slice(0, 10),
      },
    })
    .catch(() => {});
  return summary;
}
