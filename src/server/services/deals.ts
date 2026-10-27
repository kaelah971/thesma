import { newId } from "../auth/session";
import type { AuditSink, MarketStore, StoredHybridDeal } from "./campaignStore";

/**
 * Hybrid creator deals + expanded outcome economics (Slice 6).
 *
 * Product model: CLEAR SCOPE → CLEAR ECONOMICS → FROZEN TERMS →
 * VERIFIED OBLIGATIONS → POLICY-BOUND SETTLEMENT.
 *
 * A creator NEVER earns base compensation merely by accepting
 * (ACCEPTED != EARNED). Base pays only for an explicit deliverable
 * obligation, and only after that obligation is verified. Milestones pay
 * only from canonical VERIFIED outcome counts — never clicks, never
 * unverified conversions, never submitted payouts.
 *
 * Settlement truth (audited against ThesmaMarketVault, Slice 6):
 * - performance bounty → SUPPORTED (existing per-outcome + proof path)
 * - verified base → SETTLEMENT_NOT_SUPPORTED (the vault settles a single
 *   outcomeId+proofHash per payout with replay protection; it has no
 *   deliverable registry, so a base obligation has no onchain representation)
 * - milestone bonus → SETTLEMENT_NOT_SUPPORTED (no milestone schedule
 *   onchain; anchoring a bonus to an already-paid outcomeId would replay)
 * No new contract in this slice. Unsupported obligations are recorded
 * truthfully and reported — never faked, never silently dropped.
 */

export type DealStructure =
  | "PERFORMANCE_ONLY"
  | "BASE_PLUS_PERFORMANCE"
  | "MILESTONE_PLUS_PERFORMANCE"
  | "HYBRID_FULL";

export type DeliverableVerification =
  | "VERIFICATION_SUPPORTED"
  | "MANUAL_REVIEW_REQUIRED"
  | "UNSUPPORTED";

export type BaseStatus = "PENDING" | "VERIFIED" | "SETTLEMENT_NOT_SUPPORTED" | "PAID";
export type MilestoneAwardStatus = "SETTLEMENT_NOT_SUPPORTED" | "PAID";

export const SETTLEMENT_SUPPORT = {
  performance: { supported: true as const, reason: "Settled through the existing per-outcome bounty + proof payout path." },
  base: {
    supported: false as const,
    reason:
      "ThesmaMarketVault settles one outcomeId+proofHash per payout with replay protection and has no deliverable registry; a verified base obligation has no onchain representation in this slice.",
  },
  milestone: {
    supported: false as const,
    reason:
      "The vault has no milestone schedule; anchoring a bonus to an already-settled outcomeId would replay. Recorded as a verified payable obligation without onchain settlement in this slice.",
  },
};

export interface DealDeliverable {
  kind: string;
  title: string;
  verification: DeliverableVerification;
}

export interface DealMilestone {
  threshold: number;
  amountMicroUsdc: string;
}

export interface DealInput {
  structure: DealStructure;
  baseAmountMicroUsdc?: string;
  deliverable?: { kind: string; title: string };
  performanceBountyMicroUsdc?: string;
  milestones?: { threshold: number; amountMicroUsdc: string }[];
  allocationCount?: number | null;
}

export interface CanonicalDeal {
  structure: DealStructure;
  baseAmountMicroUsdc: string;
  deliverable: DealDeliverable | null;
  performanceBountyMicroUsdc: string;
  milestones: DealMilestone[];
  /** Null = unbounded → never autonomously approvable. */
  allocationCount: number | null;
}

export interface DealExposure {
  maximumBaseMicroUsdc: string;
  maximumPerformanceMicroUsdc: string;
  maximumMilestoneMicroUsdc: string;
  maximumTotalMicroUsdc: string;
  bounded: boolean;
}

const MAX_MILESTONES = 5;

function isMicroUsdcString(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]+$/.test(v);
}

/**
 * No automatic verifier exists for content/tutorial/community work.
 * Onchain-anchored results verify through the existing outcome path;
 * everything else needs a human — or the deal cannot be offered.
 */
export function classifyDeliverable(kind: string): DeliverableVerification {
  const k = kind.trim().toLowerCase();
  if (k === "verified-outcome" || k === "onchain-result" || k === "purchase") return "VERIFICATION_SUPPORTED";
  if (k === "content" || k === "tutorial" || k === "review-post" || k === "video" || k === "community") {
    return "MANUAL_REVIEW_REQUIRED";
  }
  return "UNSUPPORTED";
}

export function parseDeal(input: DealInput): { ok: true; deal: CanonicalDeal } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const validStructures: DealStructure[] = ["PERFORMANCE_ONLY", "BASE_PLUS_PERFORMANCE", "MILESTONE_PLUS_PERFORMANCE", "HYBRID_FULL"];
  if (!validStructures.includes(input.structure)) issues.push(`Unknown deal structure "${(input as { structure: unknown }).structure}".`);
  const needsBase = input.structure === "BASE_PLUS_PERFORMANCE" || input.structure === "HYBRID_FULL";
  const needsMilestones = input.structure === "MILESTONE_PLUS_PERFORMANCE" || input.structure === "HYBRID_FULL";
  const needsPerformance =
    input.structure === "PERFORMANCE_ONLY" || input.structure === "BASE_PLUS_PERFORMANCE" || input.structure === "HYBRID_FULL";

  let base = 0n;
  if (input.baseAmountMicroUsdc !== undefined) {
    if (!isMicroUsdcString(input.baseAmountMicroUsdc)) issues.push("Base amount must be an integer micro-USDC string.");
    else base = BigInt(input.baseAmountMicroUsdc);
  }
  if (needsBase && base <= 0n) issues.push("Base component requires a positive base amount.");
  if (!needsBase && base > 0n) issues.push("Base amount supplied for a structure without a base component.");

  let deliverable: DealDeliverable | null = null;
  if (needsBase) {
    const kind = input.deliverable?.kind?.trim() ?? "";
    const title = input.deliverable?.title?.trim() ?? "";
    if (!kind || !title) issues.push("Base component requires an explicit deliverable kind and title.");
    else {
      const verification = classifyDeliverable(kind);
      if (verification === "UNSUPPORTED") issues.push(`Deliverable kind "${kind}" has no supported verification path.`);
      else deliverable = { kind, title, verification };
    }
  }

  let bounty = 0n;
  if (input.performanceBountyMicroUsdc !== undefined) {
    if (!isMicroUsdcString(input.performanceBountyMicroUsdc)) issues.push("Performance bounty must be an integer micro-USDC string.");
    else bounty = BigInt(input.performanceBountyMicroUsdc);
  }
  if (needsPerformance && bounty <= 0n) issues.push("Performance component requires a positive per-outcome bounty.");

  const milestones: DealMilestone[] = [];
  const milestoneInput = input.milestones;
  if (milestoneInput !== undefined && milestoneInput.length > 0) {
    if (milestoneInput.length > MAX_MILESTONES) issues.push(`At most ${MAX_MILESTONES} milestones per deal.`);
    else {
      let prev = 0;
      for (const [i, m] of milestoneInput.entries()) {
        if (!Number.isInteger(m.threshold) || m.threshold <= 0) issues.push(`Milestone ${i}: threshold must be a positive integer.`);
        else if (m.threshold <= prev) issues.push(`Milestone ${i}: thresholds must strictly increase.`);
        else prev = m.threshold;
        if (!isMicroUsdcString(m.amountMicroUsdc) || BigInt(m.amountMicroUsdc) <= 0n) {
          issues.push(`Milestone ${i}: amount must be a positive integer micro-USDC string.`);
        } else milestones.push({ threshold: m.threshold, amountMicroUsdc: m.amountMicroUsdc });
      }
    }
  }
  if (needsMilestones && milestones.length === 0 && issues.length === 0) {
    issues.push("Milestone component requires at least one milestone.");
  }
  const allocationCount = input.allocationCount ?? null;
  if (allocationCount !== null && (!Number.isInteger(allocationCount) || allocationCount <= 0)) {
    issues.push("allocationCount must be a positive integer when bounded.");
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    deal: {
      structure: input.structure,
      baseAmountMicroUsdc: base.toString(),
      deliverable,
      performanceBountyMicroUsdc: bounty.toString(),
      milestones,
      allocationCount,
    },
  };
}

/** Exact bounded exposure. Unbounded allocation ⇒ bounded:false, never auto-approvable. */
export function computeExposure(deal: CanonicalDeal): DealExposure {
  const base = BigInt(deal.baseAmountMicroUsdc);
  const bounty = BigInt(deal.performanceBountyMicroUsdc);
  const milestone = deal.milestones.reduce((s, m) => s + BigInt(m.amountMicroUsdc), 0n);
  const bounded = deal.allocationCount !== null;
  const performance = bounded ? bounty * BigInt(deal.allocationCount as number) : 0n;
  return {
    maximumBaseMicroUsdc: base.toString(),
    maximumPerformanceMicroUsdc: performance.toString(),
    maximumMilestoneMicroUsdc: milestone.toString(),
    maximumTotalMicroUsdc: (base + performance + milestone).toString(),
    bounded,
  };
}

/** A deal is offerable only when bounded and within remaining campaign capacity. */
export function checkCapacity(
  exposure: DealExposure,
  remainingCapacityMicroUsdc: bigint,
): { ok: true } | { ok: false; reason: string } {
  if (!exposure.bounded) {
    return { ok: false, reason: "Unbounded performance terms cannot receive autonomous approval — bound allocationCount first." };
  }
  if (BigInt(exposure.maximumTotalMicroUsdc) > remainingCapacityMicroUsdc) {
    return {
      ok: false,
      reason: `Maximum exposure ${exposure.maximumTotalMicroUsdc} exceeds remaining campaign capacity ${remainingCapacityMicroUsdc}.`,
    };
  }
  return { ok: true };
}

/** Org-side suggestion: hybrid only when headroom and creator minimum both fit. */
export function recommendDeal(params: {
  budgetHeadroomMicroUsdc: bigint;
  targetRemaining: number | null;
  creatorMinimumBountyMicroUsdc: bigint;
  publicBountyMicroUsdc: bigint;
}): { structure: DealStructure; reason: string } {
  const room = params.budgetHeadroomMicroUsdc;
  const perOutcome = params.publicBountyMicroUsdc >= params.creatorMinimumBountyMicroUsdc ? params.publicBountyMicroUsdc : params.creatorMinimumBountyMicroUsdc;
  const remaining = params.targetRemaining ?? 1;
  const performanceOnly = perOutcome * BigInt(Math.max(1, remaining));
  if (room < performanceOnly) {
    return { structure: "PERFORMANCE_ONLY", reason: "Headroom covers performance only — no base or milestone room." };
  }
  if (room >= performanceOnly + perOutcome * 2n) {
    return { structure: "MILESTONE_PLUS_PERFORMANCE", reason: "Headroom supports performance plus milestone upside for verified volume." };
  }
  return { structure: "PERFORMANCE_ONLY", reason: "Headroom is tight — keep the offer performance-only." };
}

/** Creator/Org-facing plain-language summary. No creator should calculate the deal. */
export function summarizeDeal(deal: CanonicalDeal): {
  earnLines: string[];
  maximumPayoutMicroUsdc: string;
  qualifiesLines: string[];
  whenPaidLines: string[];
} {
  const usdc = (v: string) => `${(Number(v) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;
  const earnLines: string[] = [];
  if (BigInt(deal.baseAmountMicroUsdc) > 0n) {
    earnLines.push(`${usdc(deal.baseAmountMicroUsdc)} base for "${deal.deliverable?.title ?? "the deliverable"}"`);
  }
  if (BigInt(deal.performanceBountyMicroUsdc) > 0n) {
    earnLines.push(`${usdc(deal.performanceBountyMicroUsdc)} per verified outcome`);
  }
  for (const m of deal.milestones) {
    earnLines.push(`${usdc(m.amountMicroUsdc)} bonus at ${m.threshold} verified outcomes`);
  }
  const qualifiesLines: string[] = [];
  if (deal.deliverable) {
    qualifiesLines.push(
      deal.deliverable.verification === "MANUAL_REVIEW_REQUIRED"
        ? `Base: "${deal.deliverable.title}" approved by the organization (human review).`
        : `Base: "${deal.deliverable.title}" verified onchain.`,
    );
  }
  if (BigInt(deal.performanceBountyMicroUsdc) > 0n) qualifiesLines.push("Performance: each verified purchase counts.");
  for (const m of deal.milestones) qualifiesLines.push(`Milestone: reaches ${m.threshold} verified outcomes (counts, not clicks).`);
  return {
    earnLines,
    maximumPayoutMicroUsdc: computeExposure(deal).maximumTotalMicroUsdc,
    qualifiesLines,
    whenPaidLines: [
      "Performance pays through the existing verified-outcome payout path.",
      "Verified base and milestone bonuses are recorded as payable — onchain settlement is not supported for these in this slice.",
    ],
  };
}

/** Read the frozen deal back from an invitation row. Null = performance-only legacy. */
export function invitationDeal(offeredBonusJson: Record<string, unknown> | null | undefined): CanonicalDeal | null {
  const raw = (offeredBonusJson as { deal?: unknown } | null)?.deal;
  if (raw == null) return null;
  const parsed = parseDeal(raw as DealInput);
  return parsed.ok ? parsed.deal : null;
}

/** Corrupt (unparseable) frozen deal payloads fail closed to human review. */
export function invitationDealCorrupt(offeredBonusJson: Record<string, unknown> | null | undefined): boolean {
  const raw = (offeredBonusJson as { deal?: unknown } | null)?.deal;
  if (raw == null) return false;
  return !parseDeal(raw as DealInput).ok;
}

export interface HybridDealRecord {
  id: string;
  termsId: string;
  campaignId: string;
  partnerId: string;
  invitationId: string;
  structure: DealStructure;
  baseAmountMicroUsdc: string;
  baseStatus: BaseStatus;
  deliverable: DealDeliverable | null;
  performanceBountyMicroUsdc: string;
  milestones: DealMilestone[];
  maximumTotalExposureMicroUsdc: string;
}

/**
 * Create the hybrid extension row for accepted terms. The performance leg
 * already lives in partnerTerms (canonical, untouched); this row carries
 * only the base + milestone extension. Base starts PENDING — acceptance
 * earns nothing. Idempotent per terms.
 */
export async function createHybridDeal(
  store: MarketStore,
  audit: AuditSink,
  params: { termsId: string; campaignId: string; partnerId: string; invitationId: string; deal: CanonicalDeal },
): Promise<HybridDealRecord> {
  const existing = await store.getHybridDealByTerms(params.termsId).catch(() => null);
  if (existing) return toHybridRecord(existing);
  const exposure = computeExposure(params.deal);
  const row = await store.insertHybridDeal({
    id: newId(),
    termsId: params.termsId,
    campaignId: params.campaignId,
    partnerId: params.partnerId,
    invitationId: params.invitationId,
    structure: params.deal.structure,
    baseAmountMicroUsdc: BigInt(params.deal.baseAmountMicroUsdc),
    baseStatus: "PENDING",
    deliverableJson: params.deal.deliverable ?? null,
    performanceBountyMicroUsdc: BigInt(params.deal.performanceBountyMicroUsdc),
    milestonesJson: params.deal.milestones,
    maximumTotalExposureMicroUsdc: BigInt(exposure.maximumTotalMicroUsdc),
  });
  await audit({
    actorType: "USER",
    actorId: params.partnerId,
    workspaceId: null,
    partnerId: params.partnerId,
    action: "creator.deal.accepted",
    targetType: "hybrid_deal",
    targetId: row.id,
    metadata: {
      termsId: params.termsId,
      campaignId: params.campaignId,
      invitationId: params.invitationId,
      structure: params.deal.structure,
      baseAmountMicroUsdc: params.deal.baseAmountMicroUsdc,
      baseStatus: "PENDING",
      milestones: params.deal.milestones,
      maximumTotalExposureMicroUsdc: exposure.maximumTotalMicroUsdc,
      settlementSupport: { base: "SETTLEMENT_NOT_SUPPORTED", milestone: "SETTLEMENT_NOT_SUPPORTED", performance: "SUPPORTED" },
    },
  }).catch(() => {});
  return toHybridRecord(row);
}

function toHybridRecord(row: {
  id: string; termsId: string; campaignId: string; partnerId: string; invitationId: string;
  structure: string; baseAmountMicroUsdc: bigint; baseStatus: string;
  deliverableJson: unknown; performanceBountyMicroUsdc: bigint;
  milestonesJson: unknown; maximumTotalExposureMicroUsdc: bigint;
}): HybridDealRecord {
  return {
    id: row.id,
    termsId: row.termsId,
    campaignId: row.campaignId,
    partnerId: row.partnerId,
    invitationId: row.invitationId,
    structure: row.structure as DealStructure,
    baseAmountMicroUsdc: row.baseAmountMicroUsdc.toString(),
    baseStatus: row.baseStatus as BaseStatus,
    deliverable: (row.deliverableJson ?? null) as DealDeliverable | null,
    performanceBountyMicroUsdc: row.performanceBountyMicroUsdc.toString(),
    milestones: (Array.isArray(row.milestonesJson) ? row.milestonesJson : []) as DealMilestone[],
    maximumTotalExposureMicroUsdc: row.maximumTotalExposureMicroUsdc.toString(),
  };
}

/**
 * Milestone evaluation from canonical VERIFIED outcome counts.
 * Each milestone fires once (unique dealId+index); awards are recorded
 * SETTLEMENT_NOT_SUPPORTED — payable in principle, no onchain
 * representation in this slice. Never creates payouts or reservations.
 * Never fails the caller: verification integrity comes first.
 */
export async function awardMilestones(
  store: MarketStore,
  audit: AuditSink,
  params: { campaignId: string; partnerId: string },
): Promise<{ awarded: number; verifiedCount: number }> {
  let verifiedCount = 0;
  try {
    verifiedCount = await store.countVerifiedOutcomesForPartner(params.campaignId, params.partnerId);
  } catch {
    return { awarded: 0, verifiedCount: 0 };
  }
  const deal = await store.getHybridDealByCampaignAndPartner(params.campaignId, params.partnerId).catch(() => null);
  if (!deal) return { awarded: 0, verifiedCount };
  const milestones = (Array.isArray(deal.milestonesJson) ? deal.milestonesJson : []) as DealMilestone[];
  let awarded = 0;
  for (const [index, m] of milestones.entries()) {
    if (verifiedCount < m.threshold) continue;
    try {
      await store.insertMilestoneAward({
        id: newId(),
        dealId: deal.id,
        milestoneIndex: index,
        threshold: m.threshold,
        amountMicroUsdc: BigInt(m.amountMicroUsdc),
        status: "SETTLEMENT_NOT_SUPPORTED",
      });
      awarded += 1;
      await audit({
        actorType: "SYSTEM",
        actorId: null,
        workspaceId: null,
        partnerId: params.partnerId,
        action: "creator.deal.milestone.awarded",
        targetType: "hybrid_deal",
        targetId: deal.id,
        metadata: {
          campaignId: params.campaignId,
          milestoneIndex: index,
          threshold: m.threshold,
          verifiedCount,
          amountMicroUsdc: m.amountMicroUsdc,
          status: "SETTLEMENT_NOT_SUPPORTED",
          settlementReason: SETTLEMENT_SUPPORT.milestone.reason,
        },
      }).catch(() => {});
    } catch {
      // Unique (dealId, milestoneIndex) already awarded — one-time by construction.
    }
  }
  return { awarded, verifiedCount };
}

/**
 * Owner review of a base deliverable. MANUAL_REVIEW_REQUIRED only, PENDING
 * only, idempotent. Verification records the obligation as
 * SETTLEMENT_NOT_SUPPORTED (payable, no onchain path) — never a payout.
 */
export async function verifyBaseDeliverable(
  store: MarketStore,
  audit: AuditSink,
  params: { dealId: string; reviewerUserId: string; workspaceId: string },
): Promise<HybridDealRecord> {
  const bad = (status: number, code: string, message: string): never => {
    throw Object.assign(new Error(message), { status, code });
  };
  const stored = await store.getHybridDeal(params.dealId).catch(() => null);
  if (!stored) bad(404, "NOT_FOUND", "Hybrid deal not found.");
  const deal: StoredHybridDeal = stored as StoredHybridDeal;
  if (deal.baseStatus !== "PENDING") return toHybridRecord(deal);
  const deliverable = (deal.deliverableJson ?? null) as DealDeliverable | null;
  if (!deliverable || BigInt(deal.baseAmountMicroUsdc) <= 0n) bad(409, "NO_BASE_OBLIGATION", "This deal carries no base obligation.");
  const verifiedDeliverable: DealDeliverable = deliverable as DealDeliverable;
  if (verifiedDeliverable.verification !== "MANUAL_REVIEW_REQUIRED") {
    bad(409, "REVIEW_NOT_APPLICABLE", "This deliverable does not take manual review.");
  }
  const updated = await store.updateHybridDealBase(deal.id, "SETTLEMENT_NOT_SUPPORTED");
  await audit({
    actorType: "USER",
    actorId: params.reviewerUserId,
    workspaceId: params.workspaceId,
    partnerId: deal.partnerId,
    action: "creator.deal.base.verified",
    targetType: "hybrid_deal",
    targetId: deal.id,
    metadata: {
      campaignId: deal.campaignId,
      baseAmountMicroUsdc: deal.baseAmountMicroUsdc.toString(),
      deliverable,
      baseStatus: "SETTLEMENT_NOT_SUPPORTED",
      settlementReason: SETTLEMENT_SUPPORT.base.reason,
    },
  }).catch(() => {});
  return toHybridRecord(updated);
}
