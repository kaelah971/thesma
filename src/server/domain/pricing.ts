import type { MarketState } from "./enums";

/**
 * S6 deterministic pricing kernel + pace derivation.
 *
 * The kernel is pure: same inputs -> same decision, always. No LLM, no
 * randomness, no floats (ratios are computed with integer micro-USDC
 * cross-multiplication). The Demand Agent (services/pricing.ts) may only
 * choose among the kernel's allowed actions; it cannot invent prices or
 * override bounds. LLM explanation text is TARGET (S6 ships a deterministic
 * templated summary instead).
 */

export const PRICING_DECISIONS = ["KEEP", "REPRICE", "PAUSE"] as const;
export type PricingDecision = (typeof PRICING_DECISIONS)[number];

export const PACE_STATES = ["UNDER_PACED", "ON_PACE", "OVER_PACED", "EXHAUSTED"] as const;
export type PaceState = (typeof PACE_STATES)[number];

export interface PricingPolicy {
  /** Pace tolerance: |ratio-1| within this (bps) counts as ON_PACE. */
  toleranceBps: number;
  /** Minimum relative change (bps) for a reprice to be worth executing. */
  minChangeBps: number;
  /** Maximum single-decision relative step (bps). */
  maxStepBps: number;
  /** Minimum time between executed REPRICEs on one market. */
  cooldownMs: number;
  /** Lookback window for the demand signal. */
  demandWindowMs: number;
}

export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  toleranceBps: 1500, // 15%
  minChangeBps: 500, // 5%
  maxStepBps: 2500, // 25%
  cooldownMs: 3_600_000, // 1h
  demandWindowMs: 24 * 3_600_000, // 24h
};

export interface KernelInputs {
  publicBountyMicroUsdc: bigint;
  bountyFloorMicroUsdc: bigint;
  bountyCeilingMicroUsdc: bigint;
  fundedMicroUsdc: bigint;
  /** Reserved + submitted + settled (everything committed, never released/failed). */
  committedMicroUsdc: bigint;
  targetOutcomeCount: number;
  verifiedOutcomeCount: number;
  openedAtMs: number;
  deadlineMs: number;
  nowMs: number;
  /** Joins inside the demand window. */
  recentJoins: number;
  /** Verified outcomes inside the demand window. */
  recentVerified: number;
  /** Ms since the last executed REPRICE on this market (null = never). */
  msSinceLastReprice: number | null;
  /** Current market status (OPEN expected; anything else short-circuits). */
  marketStatus: MarketState;
  /** Campaign state (LIVE expected). */
  campaignState: string;
}

export type PricingReason =
  | "MARKET_NOT_OPEN"
  | "CAMPAIGN_NOT_LIVE"
  | "INVALID_BOUNDS"
  | "INVALID_MONEY_STATE"
  | "TARGET_MET"
  | "BUDGET_EXHAUSTED"
  | "DEADLINE_PASSED"
  | "CANNOT_AFFORD_FLOOR"
  | "ON_PACE"
  | "NO_SUPPLY_BEHIND"
  | "SLOW_CONVERSION_BEHIND"
  | "AHEAD_OF_PACE"
  | "AT_CEILING"
  | "AT_FLOOR"
  | "COOLDOWN_ACTIVE"
  | "NO_SIGNIFICANT_CHANGE";

export interface KernelResult {
  decision: PricingDecision;
  pace: PaceState;
  reasons: PricingReason[];
  /** Exact inputs echoed for audit. */
  inputs: { [k: string]: string | number };
  newBountyMicroUsdc: bigint | null;
}

function echoInputs(i: KernelInputs): { [k: string]: string | number } {
  return {
    publicBountyMicroUsdc: i.publicBountyMicroUsdc.toString(),
    bountyFloorMicroUsdc: i.bountyFloorMicroUsdc.toString(),
    bountyCeilingMicroUsdc: i.bountyCeilingMicroUsdc.toString(),
    fundedMicroUsdc: i.fundedMicroUsdc.toString(),
    committedMicroUsdc: i.committedMicroUsdc.toString(),
    targetOutcomeCount: i.targetOutcomeCount,
    verifiedOutcomeCount: i.verifiedOutcomeCount,
    openedAtMs: i.openedAtMs,
    deadlineMs: i.deadlineMs,
    nowMs: i.nowMs,
    recentJoins: i.recentJoins,
    recentVerified: i.recentVerified,
    msSinceLastReprice: i.msSinceLastReprice ?? -1,
    marketStatus: i.marketStatus,
    campaignState: i.campaignState,
  };
}

/**
 * Pace ratio without floats: compares
 *   verified/target  vs  elapsed/total
 * via cross-multiplication verified*total ? target*elapsed.
 * Returns null when the ratio is undefined (no elapsed time yet -> ON_PACE
 * by convention: a just-opened market has no pace signal).
 */
export function paceRatioBps(i: KernelInputs): number | null {
  const total = i.deadlineMs - i.openedAtMs;
  const elapsed = i.nowMs - i.openedAtMs;
  if (!(total > 0) || !(elapsed > 0)) return null;
  if (i.targetOutcomeCount <= 0) return null;
  // ratio = (verified/target) / (elapsed/total), scaled by 10000.
  const num = BigInt(i.verifiedOutcomeCount) * BigInt(total) * 10_000n;
  const den = BigInt(i.targetOutcomeCount) * BigInt(elapsed);
  if (den <= 0n) return null;
  const bps = num / den;
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bps);
}

export function derivePace(i: KernelInputs, policy: PricingPolicy = DEFAULT_PRICING_POLICY): PaceState {
  const remaining = i.targetOutcomeCount - i.verifiedOutcomeCount;
  const free = i.fundedMicroUsdc - i.committedMicroUsdc;
  if (remaining <= 0) return "EXHAUSTED";
  if (i.nowMs >= i.deadlineMs) return "EXHAUSTED";
  if (free < i.bountyFloorMicroUsdc) return "EXHAUSTED";
  const ratio = paceRatioBps(i);
  if (ratio === null) return "ON_PACE";
  if (ratio < 10_000 - policy.toleranceBps) return "UNDER_PACED";
  if (ratio > 10_000 + policy.toleranceBps) return "OVER_PACED";
  return "ON_PACE";
}

function pause(
  i: KernelInputs,
  pace: PaceState,
  reasons: PricingReason[],
): KernelResult {
  return { decision: "PAUSE", pace, reasons, inputs: echoInputs(i), newBountyMicroUsdc: null };
}

function clampStep(bounty: bigint, rawStep: bigint, maxStep: bigint): bigint {
  if (rawStep < 1n) return 1n;
  return rawStep > maxStep ? maxStep : rawStep;
}

export function evaluatePricing(
  i: KernelInputs,
  policy: PricingPolicy = DEFAULT_PRICING_POLICY,
): KernelResult {
  // 1. Structural gates (fail closed, always PAUSE — never act on bad state).
  if (i.marketStatus !== "OPEN") {
    return pause(i, "EXHAUSTED", ["MARKET_NOT_OPEN"]);
  }
  if (i.campaignState !== "LIVE") {
    return pause(i, "EXHAUSTED", ["CAMPAIGN_NOT_LIVE"]);
  }
  if (
    i.bountyFloorMicroUsdc < 0n ||
    i.bountyCeilingMicroUsdc <= 0n ||
    i.fundedMicroUsdc <= 0n ||
    i.publicBountyMicroUsdc <= 0n ||
    i.bountyFloorMicroUsdc > i.bountyCeilingMicroUsdc ||
    i.committedMicroUsdc < 0n ||
    i.committedMicroUsdc > i.fundedMicroUsdc ||
    i.targetOutcomeCount <= 0 ||
    i.verifiedOutcomeCount < 0 ||
    !(i.deadlineMs > i.openedAtMs)
  ) {
    const moneyBad =
      i.bountyFloorMicroUsdc < 0n ||
      i.bountyCeilingMicroUsdc <= 0n ||
      i.fundedMicroUsdc <= 0n ||
      i.publicBountyMicroUsdc <= 0n ||
      i.committedMicroUsdc < 0n ||
      i.committedMicroUsdc > i.fundedMicroUsdc;
    return pause(i, "EXHAUSTED", [moneyBad ? "INVALID_MONEY_STATE" : "INVALID_BOUNDS"]);
  }
  if (i.publicBountyMicroUsdc < i.bountyFloorMicroUsdc || i.publicBountyMicroUsdc > i.bountyCeilingMicroUsdc) {
    return pause(i, "EXHAUSTED", ["INVALID_BOUNDS"]);
  }

  // 2. Exhaustion gates.
  const remaining = i.targetOutcomeCount - i.verifiedOutcomeCount;
  const free = i.fundedMicroUsdc - i.committedMicroUsdc;
  if (remaining <= 0) return pause(i, "EXHAUSTED", ["TARGET_MET"]);
  if (i.nowMs >= i.deadlineMs) return pause(i, "EXHAUSTED", ["DEADLINE_PASSED"]);
  if (free < i.bountyFloorMicroUsdc) return pause(i, "EXHAUSTED", ["BUDGET_EXHAUSTED"]);
  if (BigInt(remaining) * i.bountyFloorMicroUsdc > free) {
    return pause(i, "EXHAUSTED", ["CANNOT_AFFORD_FLOOR"]);
  }

  // 3. Pace classification.
  const pace = derivePace(i, policy);
  if (pace === "ON_PACE") {
    return { decision: "KEEP", pace, reasons: ["ON_PACE"], inputs: echoInputs(i), newBountyMicroUsdc: null };
  }
  if (pace === "EXHAUSTED") {
    // Defensive: derivePace found something the gates above missed.
    return pause(i, pace, ["BUDGET_EXHAUSTED"]);
  }

  // 4. Direction + bounded step.
  const bounty = i.publicBountyMicroUsdc;
  const maxStep = (bounty * BigInt(policy.maxStepBps)) / 10_000n;
  let candidate: bigint;
  let reasons: PricingReason[];
  if (pace === "UNDER_PACED") {
    const ratio = paceRatioBps(i) ?? 10_000;
    const gapBps = 10_000 - ratio; // > toleranceBps > 0
    const rawStep = (bounty * BigInt(gapBps)) / 10_000n;
    candidate = bounty + clampStep(bounty, rawStep, maxStep);
    if (candidate > i.bountyCeilingMicroUsdc) candidate = i.bountyCeilingMicroUsdc;
    reasons = i.recentJoins === 0 ? ["NO_SUPPLY_BEHIND"] : ["SLOW_CONVERSION_BEHIND"];
    if (candidate >= i.bountyCeilingMicroUsdc && bounty >= i.bountyCeilingMicroUsdc) {
      return { decision: "KEEP", pace, reasons: [...reasons, "AT_CEILING"], inputs: echoInputs(i), newBountyMicroUsdc: null };
    }
  } else {
    // OVER_PACED: ease the price down toward the floor.
    const ratio = paceRatioBps(i) ?? 10_000;
    const gapBps = ratio - 10_000; // > toleranceBps > 0
    const rawStep = (bounty * BigInt(gapBps)) / 10_000n;
    candidate = bounty - clampStep(bounty, rawStep, maxStep);
    const floor = i.bountyFloorMicroUsdc > 0n ? i.bountyFloorMicroUsdc : 1n;
    if (candidate < floor) candidate = floor;
    reasons = ["AHEAD_OF_PACE"];
    if (candidate <= floor && bounty <= floor) {
      return { decision: "KEEP", pace, reasons: [...reasons, "AT_FLOOR"], inputs: echoInputs(i), newBountyMicroUsdc: null };
    }
  }

  // 5. Anti-thrash: minimum significant change + cooldown (reprices only).
  const delta = candidate >= bounty ? candidate - bounty : bounty - candidate;
  if ((delta * 10_000n) / bounty < BigInt(policy.minChangeBps)) {
    return { decision: "KEEP", pace, reasons: [...reasons, "NO_SIGNIFICANT_CHANGE"], inputs: echoInputs(i), newBountyMicroUsdc: null };
  }
  if (i.msSinceLastReprice !== null && i.msSinceLastReprice < policy.cooldownMs) {
    return { decision: "KEEP", pace, reasons: [...reasons, "COOLDOWN_ACTIVE"], inputs: echoInputs(i), newBountyMicroUsdc: null };
  }
  if (candidate <= 0n) {
    return pause(i, pace, ["INVALID_MONEY_STATE"]);
  }
  return { decision: "REPRICE", pace, reasons, inputs: echoInputs(i), newBountyMicroUsdc: candidate };
}
