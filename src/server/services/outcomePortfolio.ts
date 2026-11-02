import { createHash } from "node:crypto";
import type { AuditSink, MarketStore, StoredOutcome, StoredVerificationProcurement } from "./campaignStore";
import type { CfoCampaignRow, CfoSnapshot } from "./cfo";
import { ARC_TESTNET_CAIP2 } from "./verification";
import { evaluateRetention, loadCampaignQuality, scoreReliability, type RetentionInput } from "./reliability";
import type { OperatorPolicy } from "./operator";

/**
 * Outcome Portfolio Operator — deterministic, prospective capital allocation
 * above the existing campaign/deal accounting boundary.
 *
 * The portfolio is intentionally conservative in V1: a member is an existing
 * campaign, because campaigns are the only capital destinations for which the
 * current vault, policy and verified economics are all represented together.
 * No creator, referral or deal member is fabricated when the source data cannot
 * support an honest capacity and cost calculation.
 */

export const PORTFOLIO_CHAIN_MOVEMENT = "UNAVAILABLE" as const;
export const PORTFOLIO_EXECUTION_RECOMMENDED = "RECOMMENDED" as const;

export type PortfolioRecommendation = "INCREASE" | "HOLD" | "REDUCE" | "PAUSE" | "REVIEW";
export type PortfolioMemberType = "CAMPAIGN";
export type EvidenceConfidence = "INSUFFICIENT" | "PROVISIONAL" | "ESTABLISHED";
export type PortfolioDecisionMode = "AUTONOMOUS" | "REVIEW";
export type PortfolioMemberStatus = "ELIGIBLE" | "INELIGIBLE";

export interface OutcomePortfolioObjective {
  organizationId: string;
  /** Existing campaign intent label(s), never an invented outcome enum. */
  targetOutcomeType: string | null;
  targetOutcomeCount: number | null;
  maxVerifiedCacMicro: string | null;
  totalBudgetMicro: string;
  reserveFloorBps: number;
  maxAllocationPerChannelBps: number;
  minimumEvidenceSample: number;
  deadline: string | null;
  retentionRequirement: number | null;
  qualityThreshold: number | null;
}

export interface OutcomePortfolioPolicy {
  /** Cost must be this many basis points below the ceiling to justify INCREASE. */
  increaseCacMarginBps: number;
  /** Near-ceiling economics reduce future prospective allocation without clawing back funds. */
  reduceCacThresholdBps: number;
  /** Established members below this score fail the hard reliability policy. */
  minimumReliabilityScore: number;
}

export const DEFAULT_OUTCOME_PORTFOLIO_POLICY: OutcomePortfolioPolicy = {
  increaseCacMarginBps: 1_000,
  reduceCacThresholdBps: 9_500,
  minimumReliabilityScore: 40,
};

export interface OutcomePortfolioMember {
  memberId: string;
  memberType: PortfolioMemberType;
  label: string;
  capitalAllocatedMicro: string;
  capitalCommittedMicro: string;
  capitalSpentMicro: string;
  verifiedOutcomeCount: number;
  verifiedOutcomeValueMicro: string | null;
  verificationSpendMicro: string;
  verificationSpendExcludedMicro: string;
  availableCapacityMicro: string;
  grossVerifiedAcquisitionCostMicro: string | null;
  verifiedAcquisitionCostMicro: string | null;
  allInVerifiedAcquisitionCostMicro: string | null;
  retainedAllInVerifiedAcquisitionCostMicro: string | null;
  reliabilityScore: number | null;
  reliability: string;
  reliabilityConfidence: string;
  sampleSize: number;
  sampleConfidence: EvidenceConfidence;
  retainedOutcomeCount: number | null;
  retentionRateBps: number | null;
  retentionDataAvailable: boolean;
  status: PortfolioMemberStatus;
  statusReason: string | null;
  conflictingEvidence: boolean;
  unresolvedVerification: boolean;
  unverifiedOutcomeCount: number;
}

export interface OutcomePortfolioMemberDecision extends OutcomePortfolioMember {
  recommendation: PortfolioRecommendation;
  recommendedNextAllocationMicro: string;
  reasonCodes: string[];
  humanReadableReasons: string[];
  confidence: EvidenceConfidence;
  effectiveVerifiedAcquisitionCostMicro: string | null;
  executionStatus: typeof PORTFOLIO_EXECUTION_RECOMMENDED;
}

export interface PortfolioAccounting {
  fundedMicro: string;
  spentMicro: string;
  committedMicro: string;
  verifiedUnpaidMicro: string;
  hybridCommittedMicro: string;
  availableMicro: string;
  protectedFromProspectiveAllocationMicro: string;
  identityBalanced: boolean;
}

export interface OutcomePortfolioPlan {
  workspaceId: string;
  generatedAt: string;
  decisionTimestamp: string;
  decisionMode: PortfolioDecisionMode;
  objective: OutcomePortfolioObjective;
  portfolioSnapshotHash: string;
  members: OutcomePortfolioMemberDecision[];
  allocations: Array<{
    memberId: string;
    recommendation: PortfolioRecommendation;
    recommendedNextAllocationMicro: string;
  }>;
  totalVerifiedOutcomeCount: number;
  remainingTargetOutcomeCount: number | null;
  availableCapitalMicro: string;
  allocatableCapitalMicro: string;
  recommendedCapitalMicro: string;
  reserveMicro: string;
  unallocatedMicro: string;
  verificationSpendMicro: string;
  arcTestnetVerificationSpendExcludedMicro: string;
  retentionDataAvailable: boolean;
  accounting: PortfolioAccounting;
  policyConstraints: {
    reserveFloorBps: number;
    maxAllocationPerChannelBps: number;
    minimumEvidenceSample: number;
    increaseCacMarginBps: number;
    reduceCacThresholdBps: number;
    minimumReliabilityScore: number;
  };
  chainMovement: typeof PORTFOLIO_CHAIN_MOVEMENT;
  executionStatus: typeof PORTFOLIO_EXECUTION_RECOMMENDED;
}

export interface OutcomePortfolioKernelInput {
  workspaceId: string;
  generatedAt: string;
  decisionTimestamp?: string;
  objective: OutcomePortfolioObjective;
  members: OutcomePortfolioMember[];
  availableCapitalMicro: string;
  protectedCapitalMicro?: string;
  minimumReserveMicro?: string;
  accounting?: PortfolioAccounting;
  policy?: Partial<OutcomePortfolioPolicy>;
}

export interface OutcomePortfolioLoadOptions {
  now?: Date;
  objective?: Partial<OutcomePortfolioObjective>;
  policy?: Partial<OutcomePortfolioPolicy>;
}

const TERMINAL_VERIFICATION_STATES = new Set(["PURCHASED", "RESULT_RECEIVED"]);
const UNRESOLVED_VERIFICATION_STATES = new Set(["CANDIDATE", "QUOTED", "APPROVED", "PAYMENT_AUTHORIZED", "AMBIGUOUS", "ESCALATED"]);

function micro(value: string | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return typeof value === "bigint" ? value : BigInt(value);
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.trunc(value)));
}

function ceilBps(amount: bigint, bps: number): bigint {
  if (amount <= 0n || bps <= 0) return 0n;
  const numerator = amount * BigInt(clampBps(bps));
  return (numerator + 9_999n) / 10_000n;
}

function floorBps(amount: bigint, bps: number): bigint {
  if (amount <= 0n || bps <= 0) return 0n;
  return (amount * BigInt(clampBps(bps))) / 10_000n;
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n);
}

function usdc(microAmount: bigint): string {
  const negative = microAmount < 0n;
  const absolute = negative ? -microAmount : microAmount;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function percentBps(value: bigint, ceiling: bigint): number {
  if (ceiling <= 0n || value >= ceiling) return 0;
  return Number(((ceiling - value) * 10_000n) / ceiling);
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}n"`;
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function snapshotHash(objective: OutcomePortfolioObjective, members: OutcomePortfolioMember[], accounting: PortfolioAccounting): string {
  return createHash("sha256")
    .update(stableJson({ objective, members, accounting }), "utf8")
    .digest("hex");
}

function sampleConfidence(sampleSize: number, minimumEvidenceSample: number): EvidenceConfidence {
  if (sampleSize <= 0) return "INSUFFICIENT";
  return sampleSize < minimumEvidenceSample ? "PROVISIONAL" : "ESTABLISHED";
}

function targetRemaining(objective: OutcomePortfolioObjective, members: OutcomePortfolioMember[]): number | null {
  if (objective.targetOutcomeCount === null) return null;
  const verified = members.reduce((sum, member) => sum + member.verifiedOutcomeCount, 0);
  return Math.max(0, objective.targetOutcomeCount - verified);
}

function chosenCost(member: OutcomePortfolioMember, objective: OutcomePortfolioObjective): { cost: bigint | null; retentionRequired: boolean } {
  if (objective.retentionRequirement === null) {
    return { cost: member.allInVerifiedAcquisitionCostMicro === null ? null : micro(member.allInVerifiedAcquisitionCostMicro), retentionRequired: false };
  }
  if (!member.retentionDataAvailable || member.retainedAllInVerifiedAcquisitionCostMicro === null) {
    return { cost: null, retentionRequired: true };
  }
  return { cost: micro(member.retainedAllInVerifiedAcquisitionCostMicro), retentionRequired: true };
}

function reasonForIncrease(cost: bigint, ceiling: bigint, member: OutcomePortfolioMember): string {
  const below = Math.max(0, Math.floor(percentBps(cost, ceiling) / 100));
  return `Current all-in verified CAC is ${usdc(cost)} USDC, ${below}% below the ${usdc(ceiling)} USDC ceiling, and ${usdc(micro(member.availableCapacityMicro))} USDC of eligible capacity remains.`;
}

function decideMember(
  member: OutcomePortfolioMember,
  objective: OutcomePortfolioObjective,
  remaining: number | null,
  policy: OutcomePortfolioPolicy,
): OutcomePortfolioMemberDecision {
  const reasons: string[] = [];
  const reasonCodes: string[] = [];
  const confidence = sampleConfidence(member.sampleSize, objective.minimumEvidenceSample);
  const selected = chosenCost(member, objective);
  const cost = selected.cost;
  const ceiling = objective.maxVerifiedCacMicro === null ? null : micro(objective.maxVerifiedCacMicro);
  const availableCapacity = micro(member.availableCapacityMicro);

  const base = (recommendation: PortfolioRecommendation, reason: string, code: string): OutcomePortfolioMemberDecision => {
    const humanReasons = reason && reasons[reasons.length - 1] !== reason ? [...reasons, reason] : reasons;
    return {
      ...member,
      recommendation,
      recommendedNextAllocationMicro: "0",
      reasonCodes: [...reasonCodes, code],
      humanReadableReasons: humanReasons,
      confidence,
      effectiveVerifiedAcquisitionCostMicro: cost === null ? null : cost.toString(),
      executionStatus: PORTFOLIO_EXECUTION_RECOMMENDED,
    };
  };

  if (member.status === "INELIGIBLE") {
    return base("PAUSE", member.statusReason ?? "Member is not eligible for new prospective allocation.", "MEMBER_INELIGIBLE");
  }
  if (member.conflictingEvidence) {
    return base("REVIEW", "Evidence is conflicting or contains a review-grade attribution signal; no confident economic decision is made.", "CONFLICTING_EVIDENCE");
  }
  if (member.unresolvedVerification) {
    return base("REVIEW", "Verification has an unresolved state; Thesma will not price new capital against incomplete proof.", "VERIFICATION_UNRESOLVED");
  }
  if (remaining === 0) {
    return base("HOLD", "The objective target is complete; no additional prospective allocation is needed.", "TARGET_COMPLETE");
  }
  if (availableCapacity <= 0n) {
    return base("HOLD", "Verified economics are acceptable, but this member has no additional eligible capacity.", "CAPACITY_SATURATED");
  }
  if (confidence === "INSUFFICIENT") {
    return base("REVIEW", "No verified outcomes exist yet; evidence is insufficient for an aggressive allocation decision.", "SAMPLE_INSUFFICIENT");
  }
  if (confidence === "PROVISIONAL") {
    return base(`REVIEW`, `Current verified evidence is provisional (${member.sampleSize} outcomes); Thesma will not make an aggressive allocation decision.`, "SAMPLE_PROVISIONAL");
  }
  if (selected.retentionRequired && !member.retentionDataAvailable) {
    return base("REVIEW", "Retention is required by objective policy, but real matured retention data is unavailable.", "RETENTION_DATA_UNAVAILABLE");
  }
  if (selected.retentionRequired && member.retainedOutcomeCount === 0) {
    return base("REVIEW", "Retention is required by objective policy, but no retained verified outcomes are available yet.", "RETENTION_EVIDENCE_INSUFFICIENT");
  }
  if (ceiling === null || cost === null) {
    return base("REVIEW", "Verified acquisition cost or the organization's CAC ceiling is unavailable; the kernel fails closed.", "ECONOMICS_UNAVAILABLE");
  }
  if (member.reliabilityScore !== null && member.reliabilityScore < policy.minimumReliabilityScore) {
    return base("PAUSE", `Reliability score ${member.reliabilityScore} is below the ${policy.minimumReliabilityScore} policy floor.`, "RELIABILITY_BELOW_POLICY");
  }
  if (cost > ceiling) {
    return base("PAUSE", `Established all-in verified CAC is ${usdc(cost)} USDC, above the ${usdc(ceiling)} USDC ceiling.`, "CAC_ABOVE_CEILING");
  }
  const increaseThreshold = (ceiling * BigInt(10_000 - clampBps(policy.increaseCacMarginBps))) / 10_000n;
  if (cost <= increaseThreshold) {
    reasonCodes.push("VERIFIED_CAC_BELOW_CEILING", "ADDITIONAL_CAPACITY");
    reasons.push(reasonForIncrease(cost, ceiling, member));
    return base("INCREASE", reasons[0]!, "ECONOMICS_STRONG");
  }
  const reduceThreshold = (ceiling * BigInt(clampBps(policy.reduceCacThresholdBps))) / 10_000n;
  if (cost >= reduceThreshold) {
    return base("REDUCE", `All-in verified CAC is ${usdc(cost)} USDC and near the ${usdc(ceiling)} USDC ceiling; future prospective allocation is reduced without moving existing funds.`, "CAC_NEAR_CEILING");
  }
  return base("HOLD", `All-in verified CAC is ${usdc(cost)} USDC and inside the ${usdc(ceiling)} USDC ceiling, but not materially enough below policy for more capital yet.`, "ECONOMICS_WITHIN_TARGET");
}

/**
 * Pure next-dollar allocation kernel. It never mutates member money and only
 * allocates from already available, uncommitted capital.
 */
export function evaluateOutcomePortfolio(input: OutcomePortfolioKernelInput): OutcomePortfolioPlan {
  const policy: OutcomePortfolioPolicy = {
    ...DEFAULT_OUTCOME_PORTFOLIO_POLICY,
    ...input.policy,
  };
  const objective: OutcomePortfolioObjective = {
    ...input.objective,
    reserveFloorBps: clampBps(input.objective.reserveFloorBps),
    maxAllocationPerChannelBps: clampBps(input.objective.maxAllocationPerChannelBps),
    minimumEvidenceSample: Math.max(0, Math.trunc(input.objective.minimumEvidenceSample)),
  };
  const members = [...input.members].sort((a, b) => a.memberId.localeCompare(b.memberId));
  const accounting = input.accounting ?? {
    fundedMicro: input.availableCapitalMicro,
    spentMicro: "0",
    committedMicro: input.protectedCapitalMicro ?? "0",
    verifiedUnpaidMicro: "0",
    hybridCommittedMicro: "0",
    availableMicro: input.availableCapitalMicro,
    protectedFromProspectiveAllocationMicro: input.protectedCapitalMicro ?? "0",
    identityBalanced: true,
  };
  const available = nonNegative(micro(input.availableCapitalMicro));
  const policyReserve = nonNegative(micro(input.minimumReserveMicro));
  const objectiveReserve = ceilBps(micro(objective.totalBudgetMicro), objective.reserveFloorBps);
  const reserve = minBigInt(available, policyReserve > objectiveReserve ? policyReserve : objectiveReserve);
  const allocatable = available > reserve ? available - reserve : 0n;
  const remaining = targetRemaining(objective, members);
  const decisions = members.map((member) => decideMember(member, objective, remaining, policy));
  const candidates = decisions
    .filter((decision) => decision.recommendation === "INCREASE")
    .sort((a, b) => {
      const aCost = a.effectiveVerifiedAcquisitionCostMicro === null ? 0n : micro(a.effectiveVerifiedAcquisitionCostMicro);
      const bCost = b.effectiveVerifiedAcquisitionCostMicro === null ? 0n : micro(b.effectiveVerifiedAcquisitionCostMicro);
      if (aCost !== bCost) return aCost < bCost ? -1 : 1;
      const aReliability = a.reliabilityScore ?? 0;
      const bReliability = b.reliabilityScore ?? 0;
      if (aReliability !== bReliability) return bReliability - aReliability;
      return a.memberId.localeCompare(b.memberId);
    });

  let remainingToBuy = remaining;
  let allocated = 0n;
  for (const candidate of candidates) {
    const cost = micro(candidate.effectiveVerifiedAcquisitionCostMicro);
    let desired = micro(candidate.availableCapacityMicro);
    if (remainingToBuy !== null && cost > 0n) desired = minBigInt(desired, cost * BigInt(remainingToBuy));
    const memberShareCap = floorBps(allocatable, objective.maxAllocationPerChannelBps);
    const grant = minBigInt(desired, memberShareCap, allocatable - allocated);
    candidate.recommendedNextAllocationMicro = grant.toString();
    if (grant < desired) {
      candidate.reasonCodes = [...candidate.reasonCodes, "ALLOCATION_BOUNDED"];
      candidate.humanReadableReasons = [...candidate.humanReadableReasons, "The recommendation is bounded by reserve, concentration policy, available capacity, and existing uncommitted capital."];
    }
    allocated += grant;
    if (remainingToBuy !== null && cost > 0n) {
      const estimated = grant / cost;
      remainingToBuy = Math.max(0, remainingToBuy - Number(estimated));
    }
  }

  const testnetExcluded = members.reduce((sum, member) => sum + micro(member.verificationSpendExcludedMicro), 0n);
  const verificationSpend = members.reduce((sum, member) => sum + micro(member.verificationSpendMicro), 0n);
  const verifiedCount = members.reduce((sum, member) => sum + member.verifiedOutcomeCount, 0);
  const retentionDataAvailable = members.some((member) => member.retentionDataAvailable);
  const hash = snapshotHash(objective, members, accounting);
  const overallConfidence: EvidenceConfidence =
    decisions.length === 0 || decisions.every((member) => member.confidence === "INSUFFICIENT")
      ? "INSUFFICIENT"
      : decisions.some((member) => member.confidence === "PROVISIONAL" || member.recommendation === "REVIEW")
        ? "PROVISIONAL"
        : "ESTABLISHED";
  const decisionTimestamp = input.decisionTimestamp ?? input.generatedAt;
  const unallocated = allocatable > allocated ? allocatable - allocated : 0n;

  return {
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt,
    decisionTimestamp,
    decisionMode: "AUTONOMOUS",
    objective,
    portfolioSnapshotHash: hash,
    members: decisions,
    allocations: decisions.map((member) => ({
      memberId: member.memberId,
      recommendation: member.recommendation,
      recommendedNextAllocationMicro: member.recommendedNextAllocationMicro,
    })),
    totalVerifiedOutcomeCount: verifiedCount,
    remainingTargetOutcomeCount: remaining,
    availableCapitalMicro: available.toString(),
    allocatableCapitalMicro: allocatable.toString(),
    recommendedCapitalMicro: allocated.toString(),
    reserveMicro: reserve.toString(),
    unallocatedMicro: unallocated.toString(),
    verificationSpendMicro: verificationSpend.toString(),
    arcTestnetVerificationSpendExcludedMicro: testnetExcluded.toString(),
    retentionDataAvailable,
    accounting,
    policyConstraints: {
      reserveFloorBps: objective.reserveFloorBps,
      maxAllocationPerChannelBps: objective.maxAllocationPerChannelBps,
      minimumEvidenceSample: objective.minimumEvidenceSample,
      increaseCacMarginBps: policy.increaseCacMarginBps,
      reduceCacThresholdBps: policy.reduceCacThresholdBps,
      minimumReliabilityScore: policy.minimumReliabilityScore,
    },
    chainMovement: PORTFOLIO_CHAIN_MOVEMENT,
    executionStatus: PORTFOLIO_EXECUTION_RECOMMENDED,
  };
}

export const buildOutcomePortfolioPlan = evaluateOutcomePortfolio;

function deriveObjective(snapshot: CfoSnapshot, operatorPolicy: OperatorPolicy, override: Partial<OutcomePortfolioObjective> = {}): OutcomePortfolioObjective {
  const rows = snapshot.campaigns;
  const totalBudget = rows.reduce((sum, row) => sum + micro(row.budgetMicroUsdc ?? row.financials.fundedMicroUsdc), 0n);
  const policyBudget = totalBudget > 0n ? totalBudget : micro(snapshot.totals.fundedMicroUsdc);
  const maxCacs = rows
    .map((row) => row.maxVerifiedCacMicroUsdc)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(micro);
  const maxCac = maxCacs.length > 0 ? maxCacs.reduce((min, value) => (value < min ? value : min), maxCacs[0]!) : null;
  const targets = rows.map((row) => row.targetOutcomeCount);
  const targetCount = targets.length > 0 && targets.every((value) => value !== null)
    ? targets.reduce((sum, value) => sum + (value ?? 0), 0)
    : null;
  const labels = [...new Set(rows.map((row) => row.objective.trim()).filter(Boolean))];
  const reserveFloorBpsBig = policyBudget > 0n ? (operatorPolicy.minReserveMicroUsdc * 10_000n + policyBudget - 1n) / policyBudget : 0n;
  const reserveFloorBps = reserveFloorBpsBig > 10_000n ? 10_000 : Number(reserveFloorBpsBig);
  const raw: OutcomePortfolioObjective = {
    organizationId: snapshot.workspaceId,
    targetOutcomeType: labels.length === 1 ? labels[0]! : null,
    targetOutcomeCount: targetCount,
    maxVerifiedCacMicro: maxCac === null ? null : maxCac.toString(),
    totalBudgetMicro: policyBudget.toString(),
    reserveFloorBps,
    maxAllocationPerChannelBps: 5_000,
    minimumEvidenceSample: 5,
    deadline: null,
    retentionRequirement: null,
    qualityThreshold: null,
    ...override,
  };
  return {
    ...raw,
    organizationId: snapshot.workspaceId,
    reserveFloorBps: clampBps(raw.reserveFloorBps),
    maxAllocationPerChannelBps: clampBps(raw.maxAllocationPerChannelBps),
    minimumEvidenceSample: Math.max(0, Math.trunc(raw.minimumEvidenceSample)),
  };
}

async function settledSpendForOutcomes(store: MarketStore, outcomes: StoredOutcome[]): Promise<{ spent: bigint; settledPartners: Set<string> }> {
  let spent = 0n;
  const settledPartners = new Set<string>();
  for (const outcome of outcomes) {
    const payout = await store.getPayoutByOutcome(outcome.id).catch(() => null);
    if (payout?.state !== "SETTLED") continue;
    spent += payout.amountMicroUsdc;
    settledPartners.add(outcome.partnerId);
  }
  return { spent, settledPartners };
}

function productionVerificationSpend(rows: StoredVerificationProcurement[]): { production: bigint; testnet: bigint; unresolved: boolean } {
  let production = 0n;
  let testnet = 0n;
  let unresolved = false;
  for (const row of rows) {
    if (UNRESOLVED_VERIFICATION_STATES.has(row.state)) unresolved = true;
    if (!TERMINAL_VERIFICATION_STATES.has(row.state)) continue;
    if (row.network === ARC_TESTNET_CAIP2) testnet += row.quotedCostMicroUsdc;
    else production += row.quotedCostMicroUsdc;
  }
  return { production, testnet, unresolved };
}

async function buildCampaignMember(
  store: MarketStore,
  row: CfoCampaignRow,
  verified: StoredOutcome[],
  unverified: StoredOutcome[],
  rejected: StoredOutcome[],
  procurementRows: StoredVerificationProcurement[],
  now: Date,
  minimumEvidenceSample: number,
): Promise<OutcomePortfolioMember> {
  const campaignVerified = verified.filter((outcome) => outcome.campaignId === row.campaignId);
  const campaignUnverified = unverified.filter((outcome) => outcome.campaignId === row.campaignId);
  const campaignRejected = rejected.filter((outcome) => outcome.campaignId === row.campaignId);
  const [payouts, intents, quality] = await Promise.all([
    settledSpendForOutcomes(store, campaignVerified),
    store.listCheckoutIntentsByCampaign(row.campaignId).catch(() => []),
    loadCampaignQuality(store, row.campaignId, now).catch(() => null),
  ]);
  const retentionRows: RetentionInput[] = campaignVerified.map((outcome) => ({
    id: outcome.id,
    campaignId: outcome.campaignId,
    subjectRef: outcome.customerKeyHash || null,
    status: "VERIFIED",
    verifiedAtMs: outcome.verifiedAt?.getTime() ?? null,
  }));
  const retention = evaluateRetention(retentionRows, now.getTime()).summary.find((summary) => summary.window === "D7");
  const matured = retention && retention.matured > 0;
  const retained = matured ? retention!.qualified : null;
  const retentionDataAvailable = retained !== null;
  const production = productionVerificationSpend(procurementRows.filter((procurement) => procurement.campaignId === row.campaignId));
  const verifiedCount = campaignVerified.length;
  const grossCreatorCost = payouts.spent;
  const allInCost = verifiedCount > 0 ? (grossCreatorCost + production.production) / BigInt(verifiedCount) : null;
  const retainedAllInCost = retained && retained > 0 ? (grossCreatorCost + production.production) / BigInt(retained) : null;
  const settledCollaborations = payouts.settledPartners.size;
  const reliability = scoreReliability({
    attributedActions: intents.length,
    verifiedOutcomes: verifiedCount,
    rejectedOutcomes: campaignRejected.length,
    settledCollaborations,
    campaignsWithVerified: verifiedCount > 0 ? 1 : 0,
    retentionQualified: retention?.qualified ?? 0,
    retentionMatured: retentionDataAvailable ? retention!.matured : null,
    recentVerified: campaignVerified.filter((outcome) => outcome.verifiedAt && outcome.verifiedAt.getTime() >= now.getTime() - 30 * 86_400_000).length,
  });
  const sampleSize = verifiedCount;
  const available = micro(row.financials.availableMicroUsdc);
  const headroom = row.budgetHeadroomMicroUsdc === null || row.budgetHeadroomMicroUsdc === undefined
    ? available
    : minBigInt(available, micro(row.budgetHeadroomMicroUsdc));
  const status: PortfolioMemberStatus = row.state === "LIVE" && row.marketStatus === "OPEN" ? "ELIGIBLE" : "INELIGIBLE";
  const statusReason = status === "INELIGIBLE" ? `Campaign is ${row.state}${row.marketStatus ? ` / market ${row.marketStatus}` : ""}; new prospective allocation is refused.` : null;
  const label = row.objective || `Campaign ${row.campaignId.slice(0, 8)}`;
  return {
    memberId: row.campaignId,
    memberType: "CAMPAIGN",
    label,
    capitalAllocatedMicro: row.financials.fundedMicroUsdc,
    capitalCommittedMicro: (
      micro(row.financials.committedMicroUsdc) + micro(row.financials.verifiedUnpaidMicroUsdc) + micro(row.financials.hybridCommittedMicroUsdc)
    ).toString(),
    capitalSpentMicro: row.financials.spentMicroUsdc,
    verifiedOutcomeCount: verifiedCount,
    verifiedOutcomeValueMicro: campaignVerified.reduce((sum, outcome) => sum + micro(outcome.purchaseAmountMicroUsdc), 0n).toString(),
    verificationSpendMicro: production.production.toString(),
    verificationSpendExcludedMicro: production.testnet.toString(),
    availableCapacityMicro: headroom.toString(),
    grossVerifiedAcquisitionCostMicro: verifiedCount > 0 ? (grossCreatorCost / BigInt(verifiedCount)).toString() : null,
    verifiedAcquisitionCostMicro: verifiedCount > 0 ? (grossCreatorCost / BigInt(verifiedCount)).toString() : null,
    allInVerifiedAcquisitionCostMicro: allInCost === null ? null : allInCost.toString(),
    retainedAllInVerifiedAcquisitionCostMicro: retainedAllInCost === null ? null : retainedAllInCost.toString(),
    reliabilityScore: reliability.reliabilityScore,
    reliability: reliability.level,
    reliabilityConfidence: reliability.confidence,
    sampleSize,
    sampleConfidence: sampleConfidence(sampleSize, minimumEvidenceSample),
    retainedOutcomeCount: retained,
    retentionRateBps: retention?.rate === null || retention?.rate === undefined ? null : retention.rate * 100,
    retentionDataAvailable,
    status,
    statusReason,
    conflictingEvidence: quality?.anomalySignals.some((signal) => signal.severity === "REVIEW") ?? false,
    unresolvedVerification: production.unresolved,
    unverifiedOutcomeCount: campaignUnverified.length,
  };
}

/** Read-only loader composing existing campaign, outcome, reliability and procurement truth. */
export async function loadOutcomePortfolioPlan(
  snapshot: CfoSnapshot,
  deps: { store: MarketStore; operatorPolicy: OperatorPolicy; now?: Date },
  options: OutcomePortfolioLoadOptions = {},
): Promise<OutcomePortfolioPlan> {
  const now = deps.now ?? new Date(snapshot.generatedAt);
  const objective = deriveObjective(snapshot, deps.operatorPolicy, options.objective);
  const [verified, pending, rejected, procurements] = await Promise.all([
    deps.store.listOutcomesByStatus("VERIFIED", 10_000).catch(() => []),
    deps.store.listOutcomesByStatus("PENDING", 10_000).catch(() => []),
    deps.store.listOutcomesByStatus("REJECTED", 10_000).catch(() => []),
    deps.store.listProcurementsByWorkspace(snapshot.workspaceId).catch(() => []),
  ]);
  const unverified = pending;
  const members = await Promise.all(
    snapshot.campaigns
      .slice()
      .sort((a, b) => a.campaignId.localeCompare(b.campaignId))
      .map((row) => buildCampaignMember(deps.store, row, verified, unverified, rejected, procurements, now, objective.minimumEvidenceSample)),
  );
  const funded = micro(snapshot.totals.fundedMicroUsdc);
  const spent = micro(snapshot.totals.spentMicroUsdc);
  const committed = micro(snapshot.totals.committedMicroUsdc);
  const verifiedUnpaid = micro(snapshot.totals.verifiedUnpaidMicroUsdc);
  const hybridCommitted = micro(snapshot.totals.hybridCommittedMicroUsdc);
  const available = micro(snapshot.totals.availableMicroUsdc);
  const protectedCapital = committed + verifiedUnpaid + hybridCommitted;
  const identityBalanced = funded === spent + protectedCapital + available;
  const accounting: PortfolioAccounting = {
    fundedMicro: funded.toString(),
    spentMicro: spent.toString(),
    committedMicro: committed.toString(),
    verifiedUnpaidMicro: verifiedUnpaid.toString(),
    hybridCommittedMicro: hybridCommitted.toString(),
    availableMicro: available.toString(),
    protectedFromProspectiveAllocationMicro: protectedCapital.toString(),
    identityBalanced,
  };
  const plan = evaluateOutcomePortfolio({
    workspaceId: snapshot.workspaceId,
    generatedAt: snapshot.generatedAt,
    decisionTimestamp: now.toISOString(),
    objective,
    members,
    availableCapitalMicro: available.toString(),
    protectedCapitalMicro: protectedCapital.toString(),
    minimumReserveMicro: deps.operatorPolicy.minReserveMicroUsdc.toString(),
    accounting,
    policy: options.policy,
  });
  return plan;
}

/** Record portfolio decisions in the existing append-only decision ledger. */
export async function recordOutcomePortfolioDecision(audit: AuditSink, plan: OutcomePortfolioPlan): Promise<void> {
  await audit({
    actorType: "AGENT",
    actorId: null,
    workspaceId: plan.workspaceId,
    partnerId: null,
    action: "cfo.portfolio.plan.generated",
    targetType: "workspace",
    targetId: plan.workspaceId,
    metadata: {
      decisionTimestamp: plan.decisionTimestamp,
      decisionMode: plan.decisionMode,
      objective: plan.objective,
      portfolioSnapshotHash: plan.portfolioSnapshotHash,
      policyConstraints: plan.policyConstraints,
      accounting: plan.accounting,
      reserveMicro: plan.reserveMicro,
      recommendedCapitalMicro: plan.recommendedCapitalMicro,
      unallocatedMicro: plan.unallocatedMicro,
      chainMovement: plan.chainMovement,
      executionStatus: plan.executionStatus,
      arcTestnetVerificationSpendExcludedMicro: plan.arcTestnetVerificationSpendExcludedMicro,
      allocations: plan.allocations,
      memberReasons: plan.members.map((member) => ({ memberId: member.memberId, recommendation: member.recommendation, reasonCodes: member.reasonCodes })),
    },
  }).catch(() => {});
  for (const member of plan.members) {
    await audit({
      actorType: "AGENT",
      actorId: null,
      workspaceId: plan.workspaceId,
      partnerId: null,
      action: "cfo.portfolio.member.decision",
      targetType: member.memberType.toLowerCase(),
      targetId: member.memberId,
      metadata: {
        recommendation: member.recommendation,
        recommendedNextAllocationMicro: member.recommendedNextAllocationMicro,
        reasonCodes: member.reasonCodes,
        humanReadableReasons: member.humanReadableReasons.slice(0, 6),
        confidence: member.confidence,
        sampleSize: member.sampleSize,
        allInVerifiedAcquisitionCostMicro: member.allInVerifiedAcquisitionCostMicro,
        executionStatus: member.executionStatus,
        portfolioSnapshotHash: plan.portfolioSnapshotHash,
      },
    }).catch(() => {});
  }
}

export { deriveObjective as deriveOutcomePortfolioObjective };
