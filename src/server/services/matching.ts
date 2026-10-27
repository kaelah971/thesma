import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { outcomes, payouts, userPersonas } from "../db/schema";
import { checkJoinEligibility, parsePartnerRules, type PartnerRules } from "../domain/market";
import type { AuditSink, MarketStore } from "./campaignStore";
import type { CreatorType } from "./personas";
import { evaluateRetention, scoreReliability } from "./reliability";

/**
 * Organization-side Creator Match Engine (deterministic intelligence).
 *
 * Answers: "which registered creators fit this campaign, and why?"
 * Weights mirror Scout (fit 30 / evidence 30 / economics 25 /
 * availability 15) so both agents speak the same language — but this is
 * the organization's perspective: invite/review/skip triage, not the
 * creator's join authority. Scout semantics are reused, never duplicated:
 * eligibility goes through checkJoinEligibility, evidence is damped like
 * Scout, and follower counts are never read.
 *
 * No LLM is involved. Naming says "Match Engine / agent recommendation"
 * and the code stays pure math over recorded rows.
 */

export type MatchEligibility = "ELIGIBLE" | "NOT_ELIGIBLE" | "UNKNOWN";
export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";
export type RecommendedAction = "INVITE" | "REVIEW" | "SKIP" | "NOT_ELIGIBLE";

export interface MatchCandidateFacts {
  creatorUserId: string;
  handle: string | null;
  creatorType: CreatorType | null;
  interests: string[];
  preferences: string[];
  profileCategory: string | null;
  campaignCategory: string | null;
  campaignKinds: string[];
  bountyMicroUsdc: bigint;
  minBountyMicroUsdc: bigint | null;
  verifiedTotal: number;
  settledCollaborations: number;
  /** Slice 7: multi-campaign consistency + retained outcomes feed evidence (default 0 = legacy behavior). */
  campaignsWithVerified?: number;
  retainedOutcomes?: number;
  activeTermsCount: number;
  maxActiveCampaigns: number | null;
  eligibility: MatchEligibility;
  eligibilityReason: string;
}

export interface CreatorMatch {
  creatorUserId: string;
  handle: string | null;
  creatorType: CreatorType | null;
  matchScore: number;
  fitScore: number;
  evidenceScore: number;
  economicsScore: number;
  availabilityScore: number;
  confidence: MatchConfidence;
  eligibility: MatchEligibility;
  eligibilityReason: string;
  reasons: string[];
  warnings: string[];
  recommendedAction: RecommendedAction;
  /** Slice 7: compact reliability derived from the same match facts. */
  reliability: {
    score: number;
    confidence: MatchConfidence;
    level: string;
    verifiedOutcomes: number;
    campaignsWithVerified: number;
    retainedOutcomes: number;
    settledCollaborations: number;
  };
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const clampSub = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v * 10) / 10));

/** Compact reliability from the same match facts (full snapshot via loadCreatorReliability). */
function toMatchReliability(f: MatchCandidateFacts): CreatorMatch["reliability"] {
  const campaignsWithVerified = f.campaignsWithVerified ?? 0;
  const retainedOutcomes = f.retainedOutcomes ?? 0;
  const snap = scoreReliability({
    attributedActions: f.verifiedTotal,
    verifiedOutcomes: f.verifiedTotal,
    rejectedOutcomes: 0,
    settledCollaborations: f.settledCollaborations,
    campaignsWithVerified,
    retentionQualified: retainedOutcomes,
    retentionMatured: retainedOutcomes > 0 ? retainedOutcomes : null,
    recentVerified: 0,
  });
  return {
    score: snap.reliabilityScore,
    confidence: snap.confidence,
    level: snap.level,
    verifiedOutcomes: f.verifiedTotal,
    campaignsWithVerified,
    retainedOutcomes,
    settledCollaborations: f.settledCollaborations,
  };
}

function overlapCount(a: string[], b: string[]): number {
  const set = new Set(a.map(norm).filter(Boolean));
  return b.map(norm).filter((x) => x && set.has(x)).length;
}

/**
 * Pure kernel: facts in, ranked match out. Deterministic — same input,
 * same output, every time. Ties are NOT broken here; the service sorts
 * by (score desc, handle asc, userId asc).
 */
export function scoreCreatorMatch(f: MatchCandidateFacts): CreatorMatch {
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Fit 30: category overlap (18) + campaign-kind preference overlap (12).
  const interests = [...f.interests, ...(f.profileCategory ? [f.profileCategory] : [])];
  const categoryHit = f.campaignCategory ? overlapCount(interests, [f.campaignCategory]) > 0 : false;
  let fit = categoryHit ? 18 : 6;
  if (categoryHit) reasons.push(`${f.campaignCategory} category overlap`);
  else if (f.campaignCategory) warnings.push("no stated category overlap");
  else warnings.push("campaign has no category");
  const kindHit = overlapCount(f.preferences, f.campaignKinds);
  fit += kindHit > 0 ? 12 : 4;
  if (kindHit > 0) reasons.push(`accepts ${f.campaignKinds.filter((k) => f.preferences.map(norm).includes(norm(k))).join(", ")} campaigns`);
  else warnings.push("no stated campaign-type preference match");
  const fitScore = clampSub(fit, 30);

  // Evidence 30: log-damped verified history + settled collaboration bonus.
  // Slice 7: verified history across MULTIPLE campaigns and retained
  // outcomes strengthen evidence (capped). Thin samples stay capped by
  // confidence below; cold-start zeros reproduce legacy scores exactly.
  const campaignsWithVerified = f.campaignsWithVerified ?? 0;
  const retainedOutcomes = f.retainedOutcomes ?? 0;
  const evidenceRaw = Math.log10(1 + f.verifiedTotal) * 8 + Math.min(10, f.settledCollaborations * 2) +
    Math.min(4, Math.max(0, campaignsWithVerified - 1) * 2) +
    (retainedOutcomes > 0 ? 2 : 0);
  const evidenceScore = clampSub(evidenceRaw, 30);
  if (f.verifiedTotal > 0) reasons.push(`${f.verifiedTotal} historical verified outcome${f.verifiedTotal === 1 ? "" : "s"}`);
  else warnings.push("no verified history yet");
  if (f.settledCollaborations > 0) reasons.push(`${f.settledCollaborations} settled collaboration${f.settledCollaborations === 1 ? "" : "s"}`);
  if (campaignsWithVerified > 1) reasons.push(`verified results across ${campaignsWithVerified} campaigns`);
  if (retainedOutcomes > 0) reasons.push(`${retainedOutcomes} retained outcomes`);

  // Economics 25: creator minimum respected; unspecified minimum is neutral.
  let economicsScore: number;
  if (f.minBountyMicroUsdc === null) {
    economicsScore = 12;
    warnings.push("no minimum bounty set");
  } else if (f.bountyMicroUsdc >= f.minBountyMicroUsdc) {
    economicsScore = 25;
    reasons.push("bounty satisfies creator minimum");
  } else {
    economicsScore = 0;
    warnings.push("bounty below creator minimum");
  }

  // Availability 15: room in the creator's active-campaign cap.
  let availabilityScore: number;
  if (f.maxActiveCampaigns === null) {
    availabilityScore = 15;
  } else if (f.activeTermsCount < f.maxActiveCampaigns) {
    availabilityScore = 15;
    reasons.push(`${f.activeTermsCount} active campaign${f.activeTermsCount === 1 ? "" : "s"} of max ${f.maxActiveCampaigns}`);
  } else {
    availabilityScore = 0;
    warnings.push("active-campaign cap reached");
  }

  // Confidence follows sample size — thin evidence lowers confidence,
  // never silently destroys the score.
  const sample = f.verifiedTotal + f.settledCollaborations;
  const confidence: MatchConfidence = sample >= 10 ? "HIGH" : sample >= 3 ? "MEDIUM" : "LOW";
  if (confidence === "LOW") warnings.push("low sample — treat score as provisional");

  const matchScore = clampSub(fitScore + evidenceScore + economicsScore + availabilityScore, 100);

  // REVIEW requires at least one positive signal (stated fit or real
  // evidence). Eligible but signal-free stays SKIP — never penalized,
  // just not worth the organization's attention yet.
  const hasSignal = fitScore > 10 || evidenceScore > 0;
  let recommendedAction: RecommendedAction;
  if (f.eligibility !== "ELIGIBLE") {
    recommendedAction = "NOT_ELIGIBLE";
  } else if (matchScore >= 60 && confidence !== "LOW") {
    recommendedAction = "INVITE";
  } else if (matchScore >= 45 && hasSignal) {
    recommendedAction = "REVIEW";
  } else {
    recommendedAction = "SKIP";
  }

  return {
    creatorUserId: f.creatorUserId,
    handle: f.handle,
    creatorType: f.creatorType,
    matchScore,
    fitScore,
    evidenceScore,
    economicsScore,
    availabilityScore,
    confidence,
    reliability: toMatchReliability(f),
    eligibility: f.eligibility,
    eligibilityReason: f.eligibilityReason,
    reasons,
    warnings,
    recommendedAction,
  };
}

/* ---------------- Organization-facing DTO (safe by construction) ---------------- */

export interface OrganizationCreatorMatch {
  creatorUserId: string;
  handle: string | null;
  creatorType: CreatorType | null;
  matchScore: number;
  fitScore: number;
  evidenceScore: number;
  economicsScore: number;
  availabilityScore: number;
  confidence: MatchConfidence;
  eligibility: MatchEligibility;
  eligibilityReason: string;
  reasons: string[];
  warnings: string[];
  recommendedAction: RecommendedAction;
  /** Slice 7: evidence-backed reliability (counts, never accusations). */
  reliability: {
    score: number;
    confidence: MatchConfidence;
    level: string;
    verifiedOutcomes: number;
    campaignsWithVerified: number;
    retainedOutcomes: number;
    settledCollaborations: number;
  };
}

export interface MatchEngineReport {
  campaignId: string;
  workspaceName: string;
  /** Live public bounty (string micro-USDC) so the org can quote the offer. */
  publicBountyMicroUsdc: string;
  evaluated: number;
  invite: OrganizationCreatorMatch[];
  review: OrganizationCreatorMatch[];
  skip: OrganizationCreatorMatch[];
  notEligible: OrganizationCreatorMatch[];
}

function toOrganizationDto(m: CreatorMatch): OrganizationCreatorMatch {
  // Deliberately narrow: no email, no wallet, no rules internals, no
  // partner IDs, no sessions. creatorUserId stays: Slice 2 invites need
  // a target, and it is the same public identity behind /@handle.
  return {
    creatorUserId: m.creatorUserId,
    handle: m.handle,
    creatorType: m.creatorType,
    matchScore: m.matchScore,
    fitScore: m.fitScore,
    evidenceScore: m.evidenceScore,
    economicsScore: m.economicsScore,
    availabilityScore: m.availabilityScore,
    confidence: m.confidence,
    eligibility: m.eligibility,
    eligibilityReason: m.eligibilityReason,
    reasons: [...m.reasons],
    warnings: [...m.warnings],
    recommendedAction: m.recommendedAction,
    reliability: { ...m.reliability },
  };
}

/* ---------------- Service: top matches for a campaign ---------------- */

export interface MatchEngineDeps {
  store: MarketStore;
  audit: AuditSink;
  now?: () => Date;
}

export interface CampaignMatchContext {
  campaign: { id: string; workspaceId: string; state: string };
  workspace: { id: string; name: string; category: string | null } | null;
  market: { campaignId: string; publicBountyMicroUsdc: bigint; status: string; version: number; policyVersion: number };
  version: {
    deadline: Date | null;
    minQualifyingPurchaseMicroUsdc: bigint | null;
    refundHoldSeconds: number | null;
  };
  kinds: string[];
}

/** Shared campaign context loader: market truth + observable outcome kinds. */
export async function loadCampaignMatchContext(
  store: MarketStore,
  campaignId: string,
): Promise<CampaignMatchContext> {
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  const workspace = await store.getWorkspace(campaign.workspaceId);
  const market = await store.getMarket(campaignId);
  if (!market) fail(404, "MARKET_NOT_OPEN", "No open market for this campaign");
  const version = await store.getVersion(campaignId, market.policyVersion);
  if (!version) fail(500, "INTERNAL", "Market policy version is missing");
  const kinds = ["referral"];
  if (version.minQualifyingPurchaseMicroUsdc !== null && version.minQualifyingPurchaseMicroUsdc !== undefined) {
    kinds.push("purchase");
  }
  return { campaign, workspace, market, version, kinds };
}

/**
 * Single-creator evaluation through the SAME kernel + eligibility gates as
 * the ranked run. Invitations reuse this — never a parallel ranking.
 */
export async function evaluateCreatorForCampaign(
  store: MarketStore,
  ctx: CampaignMatchContext,
  candidate: CapabilitySeed,
  history: HistorySeed | null,
  now: Date,
): Promise<CreatorMatch> {
  const profile = await store.getPartnerByUserId(candidate.userId).catch(() => null);
  const parsed = parsePartnerRules(profile?.rulesJson ?? {});
  let eligibility: MatchEligibility = "UNKNOWN";
  let eligibilityReason = "Creator profile incomplete — cannot prove eligibility yet.";
  let activeTermsCount = history?.activeTermsCount ?? 0;
  let rules: PartnerRules | null = null;
  if (!candidate.onboardingCompleted) {
    eligibilityReason = "Creator has not finished onboarding.";
  } else if (!profile) {
    eligibilityReason = "No creator participation profile yet.";
  } else if (!parsed.ok) {
    eligibilityReason = "Stored creator rules are invalid.";
  } else {
    rules = (parsed as { ok: true; rules: PartnerRules }).rules;
    const terms = await store.listPartnerTerms(profile.id).catch(() => []);
    if (history?.activeTermsCount === undefined) {
      activeTermsCount = terms.filter((t) => t.status === "ACTIVE").length;
    }
    const check = checkJoinEligibility({
      marketStatus: ctx.market.status as "OPEN",
      campaignLive: ctx.campaign.state === "LIVE",
      deadline: ctx.version.deadline,
      publicBountyMicroUsdc: ctx.market.publicBountyMicroUsdc,
      rules,
      campaignCategory: ctx.workspace?.category ?? null,
      activeTermsCount,
      requestedAllocation: 1,
      payoutWallet: profile.payoutWallet,
      now,
    });
    if (check.ok) {
      eligibility = "ELIGIBLE";
      eligibilityReason = "Eligible under current campaign and creator rules.";
    } else {
      eligibility = "NOT_ELIGIBLE";
      eligibilityReason = check.message;
    }
  }
  return scoreCreatorMatch({
    creatorUserId: candidate.userId,
    handle: candidate.handle,
    creatorType: candidate.creatorType,
    interests: candidate.interests,
    preferences: candidate.preferences,
    profileCategory: candidate.profileCategory,
    campaignCategory: ctx.workspace?.category ?? null,
    campaignKinds: ctx.kinds,
    bountyMicroUsdc: ctx.market.publicBountyMicroUsdc,
    minBountyMicroUsdc: rules ? rules.minimumBountyMicroUsdc : null,
    verifiedTotal: history?.verifiedTotal ?? 0,
    settledCollaborations: history?.settledCollaborations ?? 0,
    campaignsWithVerified: history?.campaignsWithVerified ?? 0,
    retainedOutcomes: history?.retainedOutcomes ?? 0,
    activeTermsCount,
    maxActiveCampaigns: rules ? rules.maxActiveCampaigns : null,
    eligibility,
    eligibilityReason,
  });
}

export interface CapabilitySeed {
  userId: string;
  handle: string | null;
  creatorType: CreatorType | null;
  interests: string[];
  preferences: string[];
  profileCategory: string | null;
  onboardingCompleted: boolean;
}

export interface HistorySeed {
  verifiedTotal: number;
  settledCollaborations: number;
  activeTermsCount: number;
  /** Slice 7: distinct campaigns with ≥1 verified outcome (default 0). */
  campaignsWithVerified?: number;
  /** Slice 7: D7-qualified retained outcomes (default 0). */
  retainedOutcomes?: number;
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

async function defaultCapabilities(): Promise<CapabilitySeed[]> {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(userPersonas)
      .where(and(eq(userPersonas.persona, "CREATOR"), isNotNull(userPersonas.onboardingCompletedAt)));
    return rows.map((r) => ({
      userId: r.userId,
      handle: r.handle,
      creatorType: (r.creatorType as CreatorType | null) ?? null,
      interests: [...(r.interests ?? [])],
      preferences: [...(r.preferences ?? [])],
      profileCategory: r.category,
      onboardingCompleted: Boolean(r.onboardingCompletedAt),
    }));
  } catch {
    return [];
  }
}

export async function loadCandidateSeed(userId: string): Promise<CapabilitySeed | null> {
  try {
    const db = getDb();
    const [row] = await db.select().from(userPersonas).where(eq(userPersonas.userId, userId)).limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      handle: row.handle,
      creatorType: (row.creatorType as CreatorType | null) ?? null,
      interests: [...(row.interests ?? [])],
      preferences: [...(row.preferences ?? [])],
      profileCategory: row.category,
      onboardingCompleted: Boolean(row.onboardingCompletedAt),
    };
  } catch {
    return null;
  }
}

async function defaultHistory(store: MarketStore, partnerId: string | null): Promise<HistorySeed> {
  const zero = { verifiedTotal: 0, settledCollaborations: 0, activeTermsCount: 0 };
  if (!partnerId) return zero;
  try {
    const db = getDb();
    const [verifiedOutcomes, settledPayouts, terms] = await Promise.all([
      db.select({ id: outcomes.id, campaignId: outcomes.campaignId, customerKeyHash: outcomes.customerKeyHash, verifiedAt: outcomes.verifiedAt, status: outcomes.status }).from(outcomes).where(eq(outcomes.partnerId, partnerId)).catch(() => []),
      db.select({ id: payouts.id }).from(payouts).where(eq(payouts.partnerId, partnerId)).catch(() => []),
      store.listPartnerTerms(partnerId).catch(() => []),
    ]);
    const verifiedRows = verifiedOutcomes.filter((o) => (o as { status?: string }).status === "VERIFIED");
    // Slice 7: consistency + retained outcomes from the same rows (no new queries).
    const campaignsWithVerified = new Set(verifiedRows.map((o) => (o as { campaignId?: string }).campaignId ?? "")).size;
    let retainedOutcomes = 0;
    try {
      const { evaluateRetention } = await import("./reliability");
      const { records } = evaluateRetention(
        verifiedRows.map((o) => ({
          id: (o as { id: string }).id,
          campaignId: (o as { campaignId: string }).campaignId,
          subjectRef: ((o as { customerKeyHash?: string | null }).customerKeyHash ?? null) as string | null,
          status: "VERIFIED",
          verifiedAtMs: ((o as { verifiedAt?: Date | null }).verifiedAt ?? null)?.getTime() ?? null,
        })),
        Date.now(),
      );
      retainedOutcomes = records.filter((r) => r.status === "QUALIFIED" && r.window === "D7").length;
    } catch {
      retainedOutcomes = 0;
    }
    return {
      verifiedTotal: verifiedRows.length,
      settledCollaborations: new Set(
        settledPayouts
          .filter((p) => (p as { state?: string }).state === "SETTLED")
          .map((p) => (p as { campaignId?: string }).campaignId ?? ""),
      ).size,
      activeTermsCount: terms.filter((t) => t.status === "ACTIVE").length,
      campaignsWithVerified,
      retainedOutcomes,
    };
  } catch {
    return zero;
  }
}

/**
 * Organization-authorized match run. The caller must be an organization
 * owner/member of the campaign's workspace — creators and outsiders get
 * 403 before any creator data is touched. One concise audit row per run.
 */
export async function findCreatorMatches(
  deps: MatchEngineDeps,
  params: { callerUserId: string; campaignId: string },
  opts?: {
    candidates?: CapabilitySeed[];
    histories?: Record<string, HistorySeed>;
  },
): Promise<MatchEngineReport> {
  const now = deps.now?.() ?? new Date();
  const ctx = await loadCampaignMatchContext(deps.store, params.campaignId);
  const { campaign, workspace } = ctx;
  const membership = workspace ? await deps.store.getMembership(workspace.id, params.callerUserId) : null;
  if (!membership || (membership.role !== "ORGANIZATION_OWNER" && membership.role !== "ORGANIZATION_MEMBER")) {
    fail(403, "FORBIDDEN", "Organization membership required");
  }
  const candidates = opts?.candidates ?? (await defaultCapabilities());
  const matches: CreatorMatch[] = [];
  for (const c of candidates) {
    if (!c.onboardingCompleted) continue;
    const profile = await deps.store.getPartnerByUserId(c.userId).catch(() => null);
    const history = opts?.histories?.[c.userId] ?? (await defaultHistory(deps.store, profile?.id ?? null));
    matches.push(await evaluateCreatorForCampaign(deps.store, ctx, c, history, now));
  }
  // Deterministic order: score desc, handle asc (nulls last), userId asc.
  matches.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    const ha = a.handle ?? "\uffff";
    const hb = b.handle ?? "\uffff";
    if (ha !== hb) return ha < hb ? -1 : 1;
    return a.creatorUserId < b.creatorUserId ? -1 : a.creatorUserId > b.creatorUserId ? 1 : 0;
  });
  const report: MatchEngineReport = {
    campaignId: campaign.id,
    workspaceName: workspace?.name ?? "Workspace",
    publicBountyMicroUsdc: ctx.market.publicBountyMicroUsdc.toString(),
    evaluated: matches.length,
    invite: matches.filter((m) => m.recommendedAction === "INVITE").map(toOrganizationDto),
    review: matches.filter((m) => m.recommendedAction === "REVIEW").map(toOrganizationDto),
    skip: matches.filter((m) => m.recommendedAction === "SKIP").map(toOrganizationDto),
    notEligible: matches.filter((m) => m.recommendedAction === "NOT_ELIGIBLE").map(toOrganizationDto),
  };
  await deps
    .audit({
      actorType: "USER",
      actorId: params.callerUserId,
      workspaceId: workspace?.id ?? null,
      partnerId: null,
      action: "match_engine.run",
      targetType: "campaign",
      targetId: campaign.id,
      metadata: {
        campaignId: campaign.id,
        evaluated: report.evaluated,
        invite: report.invite.map((m) => m.creatorUserId),
        review: report.review.map((m) => m.creatorUserId),
        skipCount: report.skip.length,
        notEligibleCount: report.notEligible.length,
        topScore: matches[0]?.matchScore ?? null,
      },
    })
    .catch(() => {});
  return report;
}
