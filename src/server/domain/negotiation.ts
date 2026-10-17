import { z } from "zod";
import { microUsdcStringSchema } from "./validation";

/**
 * S7 deterministic negotiation kernel (pure).
 *
 * The kernel decides ACCEPT / COUNTER / REJECT / HOLD from exact integer
 * inputs only. An LLM may narrate the outcome; it can never move the price,
 * the decision class, the bounds, or the budget math.
 */

export const NEGOTIATION_STATUSES = [
  "OPEN",
  "COUNTERED",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "WITHDRAWN",
  "HOLD",
] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

export const NEGOTIATION_DECISIONS = ["ACCEPT", "COUNTER", "REJECT", "HOLD"] as const;
export type NegotiationDecision = (typeof NEGOTIATION_DECISIONS)[number];

export const SUPPLY_STATES = ["HEALTHY", "TIGHT", "CRITICAL", "EXHAUSTED"] as const;
export type SupplyState = (typeof SUPPLY_STATES)[number];

/** Hard stop: supplier asks beyond this round are rejected, never countered. */
export const MAX_NEGOTIATION_ROUNDS = 3;
/** Counters must move the price by at least this share of the reference. */
export const MIN_COUNTER_CHANGE_BPS = 500; // 5%
/** Default supplier-offer lifetime when none is supplied. */
export const DEFAULT_OFFER_TTL_MS = 24 * 3_600_000; // 24h

export interface NegotiationKernelInputs {
  askMicroUsdc: bigint;
  referenceBountyMicroUsdc: bigint;
  bountyFloorMicroUsdc: bigint;
  bountyCeilingMicroUsdc: bigint;
  /** Funded (observed) minus committed (reserved+submitted+settled). */
  freeMicroUsdc: bigint;
  /** Outcomes still required (target - verified, >= 0). */
  remainingRequired: number;
  /** S6 pace, reused — never recomputed here. */
  paceState: string;
  /** 1-based supplier round. */
  round: number;
  /** Ms since epoch (injectable clock). */
  nowMs: number;
}

export type NegotiationReason =
  | "ASK_MALFORMED"
  | "ASK_BELOW_FLOOR"
  | "ASK_ABOVE_CEILING"
  | "ROUND_EXCEEDED"
  | "NO_SOLVENCY"
  | "WITHIN_SAFE_BAND"
  | "COUNTERED_TOWARD_ASK"
  | "CANNOT_MEET_ASK"
  | "MARKET_MOVED"
  | "STALLED_SUPPLIER";

export interface NegotiationKernelResult {
  decision: NegotiationDecision;
  /** Exact counter price for COUNTER; null otherwise. */
  counterMicroUsdc: bigint | null;
  urgency: SupplyState;
  reasons: NegotiationReason[];
  /** Exact inputs echoed for audit. */
  inputs: { [k: string]: string | number };
  /** Highest unit price this campaign can still afford (solvency cap). */
  maxAffordableMicroUsdc: bigint;
}

function echoInputs(i: NegotiationKernelInputs): { [k: string]: string | number } {
  return {
    askMicroUsdc: i.askMicroUsdc.toString(),
    referenceBountyMicroUsdc: i.referenceBountyMicroUsdc.toString(),
    bountyFloorMicroUsdc: i.bountyFloorMicroUsdc.toString(),
    bountyCeilingMicroUsdc: i.bountyCeilingMicroUsdc.toString(),
    freeMicroUsdc: i.freeMicroUsdc.toString(),
    remainingRequired: i.remainingRequired,
    paceState: i.paceState,
    round: i.round,
    nowMs: i.nowMs,
  };
}

/**
 * Deterministic supply urgency from the solvency margin, measured in units
 * of the reference bounty the free budget still covers beyond the remaining
 * requirement. Distinct from S6 pace (progress-vs-time); both feed the band.
 */
export function deriveSupplyUrgency(args: {
  freeMicroUsdc: bigint;
  remainingRequired: number;
  referenceBountyMicroUsdc: bigint;
  bountyFloorMicroUsdc: bigint;
}): SupplyState {
  const { freeMicroUsdc: free, remainingRequired: remaining, referenceBountyMicroUsdc: ref, bountyFloorMicroUsdc: floor } = args;
  if (remaining <= 0 || free < floor || ref <= 0n) return "EXHAUSTED";
  // units = free / ref (floor division); surplus = units - remaining.
  const units = free / ref;
  const surplus = units - BigInt(remaining);
  if (surplus < 0n) return "CRITICAL";
  if (surplus < BigInt(remaining)) return "TIGHT";
  return "HEALTHY";
}

/**
 * Solvency cap: the highest per-outcome price that still leaves floor-level
 * funding for every remaining outcome. Accepting above this would starve
 * the rest of the campaign even when this single ask looks affordable.
 */
export function solvencyCap(freeMicroUsdc: bigint, remainingRequired: number): bigint {
  if (remainingRequired <= 0 || freeMicroUsdc < 0n) return 0n;
  return freeMicroUsdc / BigInt(remainingRequired);
}

export function evaluateNegotiationOffer(i: NegotiationKernelInputs): NegotiationKernelResult {
  const base = { urgency: deriveSupplyUrgency(i), inputs: echoInputs(i), maxAffordableMicroUsdc: 0n };
  const fail = (
    reasons: NegotiationReason[],
    urgency: SupplyState = base.urgency,
  ): NegotiationKernelResult => ({
    decision: "REJECT",
    counterMicroUsdc: null,
    urgency,
    reasons,
    inputs: base.inputs,
    maxAffordableMicroUsdc: 0n,
  });

  if (i.askMicroUsdc <= 0n) return fail(["ASK_MALFORMED"]);
  if (i.round < 1 || i.round > MAX_NEGOTIATION_ROUNDS) return fail(["ROUND_EXCEEDED"]);
  if (i.askMicroUsdc < i.bountyFloorMicroUsdc) return fail(["ASK_BELOW_FLOOR"]);
  if (i.askMicroUsdc > i.bountyCeilingMicroUsdc) return fail(["ASK_ABOVE_CEILING"]);

  // Band: solvency first, then pace willingness. Healthy supply never
  // overpays the reference; behind-pace demand may stretch toward the cap.
  // Nothing ever exceeds the hard ceiling.
  const cap = [i.bountyCeilingMicroUsdc, solvencyCap(i.freeMicroUsdc, i.remainingRequired)]
    .reduce((a, b) => (a < b ? a : b));
  if (cap < i.bountyFloorMicroUsdc) {
    return { ...fail(["NO_SOLVENCY"]), maxAffordableMicroUsdc: cap };
  }
  const willing = i.paceState === "UNDER_PACED" ? cap : cap < i.referenceBountyMicroUsdc ? cap : i.referenceBountyMicroUsdc;
  const result: NegotiationKernelResult = {
    decision: "REJECT",
    counterMicroUsdc: null,
    urgency: base.urgency,
    reasons: [],
    inputs: base.inputs,
    maxAffordableMicroUsdc: cap,
  };

  // ACCEPT at the supplier's ask when it sits inside the willing band.
  if (i.askMicroUsdc <= willing) {
    result.decision = "ACCEPT";
    result.reasons = ["WITHIN_SAFE_BAND"];
    return result;
  }

  // Otherwise move toward the ask without matching it: counter at the cap,
  // but only when the counter is meaningfully above the reference.
  if (willing > i.referenceBountyMicroUsdc) {
    const lift = willing - i.referenceBountyMicroUsdc;
    const minLift = i.referenceBountyMicroUsdc * BigInt(MIN_COUNTER_CHANGE_BPS) / 10_000n;
    if (lift >= (minLift > 0n ? minLift : 1n)) {
      result.decision = "COUNTER";
      result.counterMicroUsdc = willing;
      result.reasons = ["COUNTERED_TOWARD_ASK"];
      return result;
    }
  }
  result.decision = "REJECT";
  result.reasons = ["CANNOT_MEET_ASK"];
  return result;
}

/* ---------------- Wire schemas ---------------- */

export const proposeNegotiationSchema = z.object({
  askMicroUsdc: microUsdcStringSchema,
  allocationCount: z.number().int().min(1).max(100_000).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
