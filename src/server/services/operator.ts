import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditEvents, operatorPolicies } from "../db/schema";
import type { ArcConfig } from "../chain/arc";
import { ARC_TESTNET_CHAIN_ID } from "../chain/arc";
import type { MarketStore } from "./campaignStore";
import { committedForCampaign, reconcilePayout, reserveOutcomePayout, settleReservedPayout, type PayoutDeps } from "./payouts";
import { buildAuditEvent, recordAuditEvent, type AuditInput } from "./audit";
import { newId } from "../auth/session";
import type { Db } from "../db/client";

/**
 * Autonomous Growth Operator v1 (RFB 04 core loop).
 *
 * AI PROPOSES → POLICY PERMITS/REFUSES → THESMA EXECUTES → LEDGER PROVES.
 *
 * - The financial snapshot + decision engine below are PURE: fully
 *   unit-testable, no I/O, no model calls.
 * - The planner is an interface; the shipped default is a deterministic
 *   heuristic (no LLM is wired anywhere in Thesma). A rogue planner can
 *   never authorize spending: every recommendation re-passes the
 *   deterministic validator before anything executes.
 * - Execution reuses the existing payout workflow (reserve → settle →
 *   reconcile) and is TESTNET-ONLY in this slice: any non-testnet
 *   config refuses before touching chain or store.
 * - The decision ledger IS the existing append-only audit table
 *   (actorType AGENT, action operator.*). No second ledger.
 */

export const MICRO_USDC_PER_USDC = 1_000_000n;

/** Conservative seed: 10 USDC autonomous cap, no required reserve until a human sets one. */
export const DEFAULT_OPERATOR_POLICY = {
  minReserveMicroUsdc: 0n,
  maxAutonomousPaymentMicroUsdc: 10n * MICRO_USDC_PER_USDC,
  maxAutonomousSpendPerPeriodMicroUsdc: null as bigint | null,
} as const;

export interface OperatorPolicy {
  minReserveMicroUsdc: bigint;
  maxAutonomousPaymentMicroUsdc: bigint;
  maxAutonomousSpendPerPeriodMicroUsdc: bigint | null;
}

export interface Obligation {
  outcomeId: string;
  campaignId: string;
  partnerId: string;
  amountMicroUsdc: bigint;
  status: string;
  holdUntil: Date | null;
  campaignState: string;
}

export interface OperatorSnapshotInput {
  fundedMicroUsdc: bigint;
  committedMicroUsdc: bigint;
  settledMicroUsdc: bigint;
  obligations: Obligation[];
  campaignProgress?: { campaignId: string; targetOutcomeCount: number | null; verifiedCount: number }[];
  now?: Date;
}

export type ObligationState = "ELIGIBLE" | "HELD" | "PENDING" | "OTHER";

export interface PricedObligation extends Obligation {
  state: ObligationState;
}

export interface CampaignProgress {
  campaignId: string;
  targetOutcomeCount: number | null;
  verifiedCount: number;
}

export interface OperatorSnapshot {
  fundedMicroUsdc: string;
  committedMicroUsdc: string;
  settledMicroUsdc: string;
  minReserveMicroUsdc: string;
  /** cash − committed − reserve, floored at 0. Never double-counts holds. */
  availableToDeployMicroUsdc: string;
  verifiedUnpaidMicroUsdc: string;
  heldMicroUsdc: string;
  eligibleMicroUsdc: string;
  nextDueAt: string | null;
  remainingObligations: number;
  obligations: PricedObligation[];
  /** Per-campaign target vs verified counts (progress, not money). */
  campaignProgress: CampaignProgress[];
}

function obligationState(o: Obligation, now: Date): ObligationState {
  if (o.status !== "VERIFIED") return o.status === "PENDING" ? "PENDING" : "OTHER";
  if (o.holdUntil && now < o.holdUntil) return "HELD";
  return "ELIGIBLE";
}

/**
 * Pure liquidity kernel. Holds are subsets of verified obligations —
 * they are reported, never added on top of committed spend.
 */
export function buildOperatorSnapshot(
  input: OperatorSnapshotInput,
  policy: OperatorPolicy,
): OperatorSnapshot {
  const now = input.now ?? new Date();
  const priced = input.obligations.map((o) => ({ ...o, state: obligationState(o, now) }));
  const sum = (os: PricedObligation[]) => os.reduce((s, o) => s + o.amountMicroUsdc, 0n);
  const verified = priced.filter((o) => o.state === "ELIGIBLE" || o.state === "HELD");
  const held = priced.filter((o) => o.state === "HELD");
  const eligible = priced.filter((o) => o.state === "ELIGIBLE");
  const raw = input.fundedMicroUsdc - input.committedMicroUsdc - policy.minReserveMicroUsdc;
  const nextDue = eligible.length
    ? eligible.map((o) => o.holdUntil?.getTime() ?? 0).sort((a, b) => a - b)[0]
    : null;
  return {
    fundedMicroUsdc: input.fundedMicroUsdc.toString(),
    committedMicroUsdc: input.committedMicroUsdc.toString(),
    settledMicroUsdc: input.settledMicroUsdc.toString(),
    minReserveMicroUsdc: policy.minReserveMicroUsdc.toString(),
    availableToDeployMicroUsdc: (raw > 0n ? raw : 0n).toString(),
    verifiedUnpaidMicroUsdc: sum(verified).toString(),
    heldMicroUsdc: sum(held).toString(),
    eligibleMicroUsdc: sum(eligible).toString(),
    nextDueAt: nextDue !== null && eligible.length > 0 ? new Date(Math.max(nextDue, 0)).toISOString() : null,
    remainingObligations: eligible.length,
    obligations: priced,
    campaignProgress: input.campaignProgress ?? [],
  };
}

export type OperatorDecisionKind =
  | "PAY_NOW"
  | "WAIT_FOR_HOLD"
  | "HOLD_FOR_LIQUIDITY"
  | "ESCALATE_APPROVAL"
  | "NO_ACTION";

export interface OperatorDecision {
  decision: OperatorDecisionKind;
  outcomeId: string | null;
  amountMicroUsdc: string;
  reason: string;
  /** Policy rule that produced this decision, e.g. MAX_AUTONOMOUS_PAYMENT. */
  rule: string;
  liquidityBeforeMicroUsdc: string;
  liquidityAfterMicroUsdc: string;
  autonomous: boolean;
}

/**
 * Deterministic authority validator. Given the snapshot + one obligation +
 * policy, returns the ONLY permitted decision. Pure: the AI planner's output
 * never reaches here — the planner only nominates candidates.
 */
export function decideObligation(
  snapshot: OperatorSnapshot,
  obligation: PricedObligation | null,
  policy: OperatorPolicy,
  spentThisPeriodMicroUsdc = 0n,
): OperatorDecision {
  const before = BigInt(snapshot.availableToDeployMicroUsdc);
  const noAction = (reason: string, rule: string): OperatorDecision => ({
    decision: "NO_ACTION",
    outcomeId: null,
    amountMicroUsdc: "0",
    reason,
    rule,
    liquidityBeforeMicroUsdc: before.toString(),
    liquidityAfterMicroUsdc: before.toString(),
    autonomous: true,
  });
  if (!obligation) return noAction("Nothing is due.", "NO_OBLIGATION");
  if (obligation.state !== "ELIGIBLE") {
    if (obligation.state === "HELD") {
      return {
        decision: "WAIT_FOR_HOLD",
        outcomeId: obligation.outcomeId,
        amountMicroUsdc: obligation.amountMicroUsdc.toString(),
        reason: `Hold expires ${obligation.holdUntil?.toISOString() ?? "unknown"}; settlement truth, not elapsed guesswork.`,
        rule: "SAFETY_HOLD",
        liquidityBeforeMicroUsdc: before.toString(),
        liquidityAfterMicroUsdc: before.toString(),
        autonomous: true,
      };
    }
    return noAction(`Outcome is ${obligation.status}, not payable.`, "NOT_VERIFIED");
  }
  const amount = obligation.amountMicroUsdc;
  if (amount > policy.maxAutonomousPaymentMicroUsdc) {
    return {
      decision: "ESCALATE_APPROVAL",
      outcomeId: obligation.outcomeId,
      amountMicroUsdc: amount.toString(),
      reason: `Obligation exceeds the ${policy.maxAutonomousPaymentMicroUsdc} autonomous payment cap.`,
      rule: "MAX_AUTONOMOUS_PAYMENT",
      liquidityBeforeMicroUsdc: before.toString(),
      liquidityAfterMicroUsdc: before.toString(),
      autonomous: false,
    };
  }
  if (
    policy.maxAutonomousSpendPerPeriodMicroUsdc !== null &&
    spentThisPeriodMicroUsdc + amount > policy.maxAutonomousSpendPerPeriodMicroUsdc
  ) {
    return {
      decision: "ESCALATE_APPROVAL",
      outcomeId: obligation.outcomeId,
      amountMicroUsdc: amount.toString(),
      reason: "Period autonomous spend cap would be exceeded.",
      rule: "MAX_AUTONOMOUS_SPEND_PER_PERIOD",
      liquidityBeforeMicroUsdc: before.toString(),
      liquidityAfterMicroUsdc: before.toString(),
      autonomous: false,
    };
  }
  if (amount > before) {
    return {
      decision: "HOLD_FOR_LIQUIDITY",
      outcomeId: obligation.outcomeId,
      amountMicroUsdc: amount.toString(),
      reason: `Paying would breach the reserve: ${before} available after commitments and reserve.`,
      rule: "MIN_RESERVE",
      liquidityBeforeMicroUsdc: before.toString(),
      liquidityAfterMicroUsdc: before.toString(),
      autonomous: true,
    };
  }
  return {
    decision: "PAY_NOW",
    outcomeId: obligation.outcomeId,
    amountMicroUsdc: amount.toString(),
    reason: `Eligible and inside authority: ${amount} ≤ cap, ${before - amount} remains above reserve.`,
    rule: "WITHIN_AUTHORITY",
    liquidityBeforeMicroUsdc: before.toString(),
    liquidityAfterMicroUsdc: (before - amount).toString(),
    autonomous: true,
  };
}

/* ---------------- AI planner (advisory only) ---------------- */

export interface PlannerRecommendation {
  outcomeId: string | null;
  rationale: string;
}

export interface OperatorPlanner {
  plan(snapshot: OperatorSnapshot, policy: OperatorPolicy): Promise<PlannerRecommendation>;
}

/**
 * Shipped default: deterministic oldest-eligible-first nomination.
 * No model, no network, no secrets. A future LLM planner implements the
 * same interface — authorization still happens in decideObligation.
 */
export class HeuristicOperatorPlanner implements OperatorPlanner {
  async plan(snapshot: OperatorSnapshot, _policy?: OperatorPolicy): Promise<PlannerRecommendation> {
    const eligible = snapshot.obligations.filter((o) => o.state === "ELIGIBLE");
    if (eligible.length === 0) return { outcomeId: null, rationale: "No eligible obligations." };
    const oldest = [...eligible].sort((a, b) => {
      const ha = a.holdUntil?.getTime() ?? 0;
      const hb = b.holdUntil?.getTime() ?? 0;
      return ha - hb;
    })[0];
    return {
      outcomeId: oldest.outcomeId,
      rationale: `${eligible.length} eligible obligation(s); nominating the oldest first. Validator decides.`,
    };
  }
}

/* ---------------- Human-controlled policy persistence ---------------- */

const MISSING_RELATION = /relation .* does not exist/i;

/** Human-set policy row, or null (caller falls back to DEFAULT_OPERATOR_POLICY). */
export async function getOperatorPolicy(workspaceId: string): Promise<OperatorPolicy | null> {
  try {
    const db = getDb();
    const [row] = await db.select().from(operatorPolicies).where(eq(operatorPolicies.workspaceId, workspaceId)).limit(1);
    if (!row) return null;
    return {
      minReserveMicroUsdc: BigInt(row.minReserveMicroUsdc),
      maxAutonomousPaymentMicroUsdc: BigInt(row.maxAutonomousPaymentMicroUsdc),
      maxAutonomousSpendPerPeriodMicroUsdc:
        row.maxAutonomousSpendPerPeriodMicroUsdc === null ? null : BigInt(row.maxAutonomousSpendPerPeriodMicroUsdc),
    };
  } catch (err) {
    if (MISSING_RELATION.test(err instanceof Error ? err.message : String(err ?? ""))) return null;
    throw err;
  }
}

export async function setOperatorPolicy(
  workspaceId: string,
  policy: OperatorPolicy,
  updatedByUserId: string,
): Promise<void> {
  if (policy.minReserveMicroUsdc < 0n) throw Object.assign(new Error("minReserve must be ≥ 0"), { status: 400, code: "BAD_REQUEST" });
  if (policy.maxAutonomousPaymentMicroUsdc <= 0n) {
    throw Object.assign(new Error("maxAutonomousPayment must be positive"), { status: 400, code: "BAD_REQUEST" });
  }
  const db = getDb();
  const now = new Date();
  await db
    .insert(operatorPolicies)
    .values({
      workspaceId,
      minReserveMicroUsdc: policy.minReserveMicroUsdc.toString(),
      maxAutonomousPaymentMicroUsdc: policy.maxAutonomousPaymentMicroUsdc.toString(),
      maxAutonomousSpendPerPeriodMicroUsdc: policy.maxAutonomousSpendPerPeriodMicroUsdc?.toString() ?? null,
      updatedByUserId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: operatorPolicies.workspaceId,
      set: {
        minReserveMicroUsdc: policy.minReserveMicroUsdc.toString(),
        maxAutonomousPaymentMicroUsdc: policy.maxAutonomousPaymentMicroUsdc.toString(),
        maxAutonomousSpendPerPeriodMicroUsdc: policy.maxAutonomousSpendPerPeriodMicroUsdc?.toString() ?? null,
        updatedByUserId,
        updatedAt: now,
      },
    });
}

/* ---------------- Store-backed loader (reuse, no new queries) ---------------- */

export interface OperatorWorkspaceInput {
  snapshot: OperatorSnapshot;
  policy: OperatorPolicy;
  spentThisPeriodMicroUsdc: bigint;
}

/**
 * Loads kernel inputs from existing store reads only: confirmed funding,
 * committed spend (reservations + commitments, via committedForCampaign),
 * settled payouts, and VERIFIED outcomes with frozen terms prices.
 * Eligibility mirrors the payout worker's settlement truth (it never pays
 * anything the worker itself would refuse downstream).
 */
export async function loadOperatorInput(
  store: MarketStore,
  workspaceId: string,
  policy: OperatorPolicy,
  now: Date = new Date(),
): Promise<OperatorWorkspaceInput> {
  const campaigns = await store.listCampaigns(workspaceId);
  let funded = 0n;
  let committed = 0n;
  let settled = 0n;
  const obligations: Obligation[] = [];
  const campaignProgress: { campaignId: string; targetOutcomeCount: number | null; verifiedCount: number }[] = [];
  for (const c of campaigns) {
    const version = await store.getCurrentVersion(c.id);
    const funding = version ? await store.getFunding(c.id, version.version).catch(() => null) : null;
    if (funding && funding.status === "CONFIRMED") {
      funded += funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc;
    }
    committed += await committedForCampaign(store, c.id).catch(() => 0n);
    campaignProgress.push({
      campaignId: c.id,
      targetOutcomeCount: version?.targetOutcomeCount ?? null,
      verifiedCount: await store.countVerifiedOutcomes(c.id).catch(() => 0),
    });
    const verified = await store.listOutcomesByStatus("VERIFIED", 200).catch(() => []);
    for (const o of verified.filter((v) => v.campaignId === c.id)) {
      const [terms, payout, reservation] = await Promise.all([
        store.getTerms(o.campaignId, o.partnerId).catch(() => null),
        store.getPayoutByOutcome(o.id).catch(() => null),
        store.getReservationByOutcome(o.id).catch(() => null),
      ]);
      if (payout && payout.state === "SETTLED") {
        settled += payout.amountMicroUsdc;
        continue;
      }
      // Anything already moving through the rail is the worker's truth —
      // the operator never double-counts or second-guesses it.
      if (payout && (payout.state === "SUBMITTED" || payout.state === "AMBIGUOUS" || payout.state === "FAILED")) continue;
      if (reservation && ["RESERVED", "SUBMITTED", "AMBIGUOUS", "SETTLED"].includes(reservation.state)) continue;
      if (!terms) continue;
      obligations.push({
        outcomeId: o.id,
        campaignId: o.campaignId,
        partnerId: o.partnerId,
        amountMicroUsdc: terms.priceMicroUsdc,
        status: o.status,
        holdUntil: o.holdUntil,
        campaignState: c.state,
      });
    }
  }
  return {
    snapshot: buildOperatorSnapshot(
      {
        fundedMicroUsdc: funded,
        committedMicroUsdc: committed,
        settledMicroUsdc: settled,
        obligations,
        campaignProgress,
        now,
      },
      policy,
    ),
    policy,
    spentThisPeriodMicroUsdc: 0n,
  };
}

/* ---------------- Decision ledger (existing audit table) ---------------- */

export const OPERATOR_DECISION_ACTION = "operator.decision";
export const OPERATOR_ESCALATION_ACTION = "operator.escalation";
export const OPERATOR_ESCALATION_DECISION_ACTION = "operator.escalation.decision";
export const OPERATOR_POLICY_UPDATED_ACTION = "operator.policy.updated";

export interface DecisionRecord {
  decision: OperatorDecision;
  campaignId: string | null;
  partnerId: string | null;
  plannerRationale: string | null;
  policy: OperatorPolicy;
  execution: { status: "EXECUTED" | "SKIPPED" | "ESCALATED" | "REFUSED"; payoutId?: string | null; txHash?: string | null; settled?: boolean; reason?: string };
  escalationId?: string | null;
}

/**
 * Appends one immutable AGENT row answering: WHAT did the AI do, WHY, WHAT
 * did it cost, WAS it allowed, WHAT is the proof. History is never rewritten:
 * approvals/rejections are separate USER rows referencing the escalation.
 */
export async function recordOperatorDecision(
  db: Db,
  workspaceId: string,
  record: DecisionRecord,
): Promise<{ id: string }> {
  const metadata: Record<string, unknown> = {
    decision: record.decision.decision,
    outcomeId: record.decision.outcomeId,
    campaignId: record.campaignId,
    partnerId: record.partnerId,
    amountMicroUsdc: record.decision.amountMicroUsdc,
    reason: record.decision.reason,
    rule: record.decision.rule,
    liquidityBeforeMicroUsdc: record.decision.liquidityBeforeMicroUsdc,
    liquidityAfterMicroUsdc: record.decision.liquidityAfterMicroUsdc,
    autonomous: record.decision.autonomous,
    plannerRationale: record.plannerRationale,
    policy: {
      minReserveMicroUsdc: record.policy.minReserveMicroUsdc.toString(),
      maxAutonomousPaymentMicroUsdc: record.policy.maxAutonomousPaymentMicroUsdc.toString(),
      maxAutonomousSpendPerPeriodMicroUsdc: record.policy.maxAutonomousSpendPerPeriodMicroUsdc?.toString() ?? null,
    },
    execution: record.execution,
    escalationId: record.escalationId ?? null,
  };
  const row = await recordAuditEvent(db, {
    actorType: "AGENT",
    workspaceId,
    partnerId: record.partnerId,
    action: OPERATOR_DECISION_ACTION,
    targetType: "outcome",
    targetId: record.decision.outcomeId,
    metadata,
  });
  return { id: row.id };
}

/** Durable human escalation. Returns the escalation id for later approval. */
export async function recordEscalation(
  db: Db,
  workspaceId: string,
  params: {
    decision: OperatorDecision;
    campaignId: string | null;
    partnerId: string | null;
    plannerRationale: string | null;
    policy: OperatorPolicy;
    liquidityMicroUsdc: string;
  },
): Promise<{ escalationId: string }> {
  const escalationId = newId();
  await recordAuditEvent(db, {
    actorType: "AGENT",
    workspaceId,
    partnerId: params.partnerId,
    action: OPERATOR_ESCALATION_ACTION,
    targetType: "outcome",
    targetId: params.decision.outcomeId,
    metadata: {
      escalationId,
      what: "creator obligation payment",
      outcomeId: params.decision.outcomeId,
      campaignId: params.campaignId,
      partnerId: params.partnerId,
      amountMicroUsdc: params.decision.amountMicroUsdc,
      whyProposed: params.plannerRationale,
      whyHuman: params.decision.reason,
      policyRule: params.decision.rule,
      liquidityMicroUsdc: params.liquidityMicroUsdc,
    },
  });
  return { escalationId };
}

/**
 * Human verdict on an escalation. Appends a USER row — the original AGENT
 * reasoning is never edited. Approved escalations still execute through the
 * normal settlement validation path.
 */
export async function decideEscalation(
  db: Db,
  params: { escalationId: string; workspaceId: string; decidedByUserId: string; approved: boolean },
): Promise<void> {
  await recordAuditEvent(db, {
    actorType: "USER",
    actorId: params.decidedByUserId,
    workspaceId: params.workspaceId,
    action: OPERATOR_ESCALATION_DECISION_ACTION,
    targetType: "operator_escalation",
    targetId: params.escalationId,
    metadata: { escalationId: params.escalationId, approved: params.approved },
  });
}

export interface OperatorAuditRow {
  id: string;
  action: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export async function listOperatorHistory(workspaceId: string, limit = 50): Promise<OperatorAuditRow[]> {
  const db = getDb();
  const rows = await db
    .select({ id: auditEvents.id, action: auditEvents.action, createdAt: auditEvents.createdAt, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(500);
  const wanted = new Set([OPERATOR_DECISION_ACTION, OPERATOR_ESCALATION_ACTION, OPERATOR_ESCALATION_DECISION_ACTION, OPERATOR_POLICY_UPDATED_ACTION]);
  return rows
    .filter((r) => wanted.has(r.action))
    .slice(0, limit)
    .map((r) => ({ id: r.id, action: r.action, createdAt: r.createdAt, metadata: (r.metadata ?? {}) as Record<string, unknown> }));
}

/** Pure RFB 04 metrics over operator audit rows. No fabrication: all derived. */
export interface OperatorMetrics {
  decisions: number;
  autonomousDecisions: number;
  escalated: number;
  approved: number;
  rejected: number;
  autonomousPaidMicroUsdc: string;
  obligationsSettledAutonomously: number;
  approvedExecuted: number;
  autonomousSettlementRate: number | null;
}

export function summarizeOperatorMetrics(rows: { action: string; metadata: Record<string, unknown> }[]): OperatorMetrics {
  let decisions = 0;
  let autonomousDecisions = 0;
  let escalated = 0;
  let approved = 0;
  let rejected = 0;
  let autonomousPaid = 0n;
  let settledAutonomously = 0;
  let approvedExecuted = 0;
  for (const r of rows) {
    const m = r.metadata ?? {};
    if (r.action === OPERATOR_DECISION_ACTION) {
      decisions += 1;
      if (m.autonomous === true) autonomousDecisions += 1;
      const ex = m.execution as { status?: string; settled?: boolean } | undefined;
      if (ex?.status === "EXECUTED" && m.autonomous === true) {
        if (typeof m.amountMicroUsdc === "string") autonomousPaid += BigInt(m.amountMicroUsdc);
        if (ex.settled === true) settledAutonomously += 1;
      }
      if (ex?.status === "EXECUTED" && m.autonomous === false) approvedExecuted += 1;
    } else if (r.action === OPERATOR_ESCALATION_ACTION) {
      escalated += 1;
    } else if (r.action === OPERATOR_ESCALATION_DECISION_ACTION) {
      if (m.approved === true) approved += 1;
      else rejected += 1;
    }
  }
  const denom = settledAutonomously + approvedExecuted;
  return {
    decisions,
    autonomousDecisions,
    escalated,
    approved,
    rejected,
    autonomousPaidMicroUsdc: autonomousPaid.toString(),
    obligationsSettledAutonomously: settledAutonomously,
    approvedExecuted,
    autonomousSettlementRate: denom > 0 ? settledAutonomously / denom : null,
  };
}

/** Pure: autonomous spend already executed today (period-cap input). */
export function sumAutonomousSpentToday(
  rows: { action: string; createdAt: Date; metadata: Record<string, unknown> }[],
  now: Date = new Date(),
): bigint {
  const day = now.toISOString().slice(0, 10);
  let sum = 0n;
  for (const r of rows) {
    if (r.action !== OPERATOR_DECISION_ACTION) continue;
    if (r.createdAt.toISOString().slice(0, 10) !== day) continue;
    const m = r.metadata ?? {};
    const ex = m.execution as { status?: string } | undefined;
    if (ex?.status === "EXECUTED" && m.autonomous === true && typeof m.amountMicroUsdc === "string") {
      sum += BigInt(m.amountMicroUsdc);
    }
  }
  return sum;
}

/* ---------------- Testnet-guarded execution ---------------- */

export interface OperatorExecution {
  executed: boolean;
  payoutId: string | null;
  txHash: string | null;
  settled: boolean;
  reason: string;
}

function forbidMainnet(config: ArcConfig | null): void {
  if (!config || config.network !== "testnet" || config.chainId !== ARC_TESTNET_CHAIN_ID) {
    throw Object.assign(
      new Error("Operator execution is testnet-only in v1 (Canteen chain 5042002). Mainnet execution is forbidden here."),
      { status: 403, code: "MAINNET_FORBIDDEN" },
    );
  }
}

/**
 * Executes a PAY_NOW decision through the EXISTING payout workflow
 * (reserve → settle → reconcile — the same functions the payout worker
 * uses). No second transfer path exists. Refuses loudly on any non-testnet
 * config BEFORE touching store or chain, so a mainnet deployment can never
 * broadcast from the operator flow.
 */
export async function executeOperatorDecision(
  deps: PayoutDeps,
  decision: OperatorDecision,
): Promise<OperatorExecution> {
  if (decision.decision !== "PAY_NOW" || !decision.outcomeId) {
    return { executed: false, payoutId: null, txHash: null, settled: false, reason: `Not executable: ${decision.decision}` };
  }
  forbidMainnet(deps.config);
  return settleOutcomeViaWorker(deps, decision.outcomeId, "autonomous");
}

/**
 * Human-approved executions (escalations) enter here: the autonomous-cap
 * check is replaced by the owner's verdict, but every settlement validator
 * (VERIFIED, hold, terms, wallet, ceiling, funding, allocation, budget)
 * still runs inside reserveOutcomePayout. Testnet guard applies equally.
 */
export async function executeApprovedObligation(
  deps: PayoutDeps,
  outcomeId: string,
): Promise<OperatorExecution> {
  forbidMainnet(deps.config);
  return settleOutcomeViaWorker(deps, outcomeId, "approved");
}

async function settleOutcomeViaWorker(deps: PayoutDeps, outcomeId: string, path: "autonomous" | "approved"): Promise<OperatorExecution> {
  const reserved = await reserveOutcomePayout(deps, { outcomeId });
  const resAny = reserved as { reserved?: boolean; alreadyReserved?: boolean; settled?: boolean; reason?: string; reservation?: { id: string } | null; payout?: { id: string } | null };
  if (!resAny.reserved || !resAny.reservation || !resAny.payout) {
    if (resAny.settled === true || resAny.alreadyReserved === true) {
      return { executed: false, payoutId: resAny.payout?.id ?? null, txHash: null, settled: resAny.settled === true, reason: "ALREADY_ADVANCED" };
    }
    return { executed: false, payoutId: null, txHash: null, settled: false, reason: resAny.reason ?? "NOT_ELIGIBLE" };
  }
  const settled = await settleReservedPayout(deps, { reservationId: resAny.reservation.id, path });
  const setAny = settled as { advanced?: boolean; payout?: { id: string } | null; failureCode?: string };
  if (!setAny.advanced || !setAny.payout) {
    return { executed: false, payoutId: null, txHash: null, settled: false, reason: setAny.failureCode ?? "NOT_ADVANCED" };
  }
  const rec = await reconcilePayout(deps, { payoutId: setAny.payout.id });
  const recAny = rec as { settled?: boolean };
  const payout = await deps.store.getPayout(setAny.payout.id).catch(() => null);
  return {
    executed: true,
    payoutId: setAny.payout.id,
    txHash: payout?.txHash ?? null,
    settled: recAny.settled === true,
    reason: recAny.settled === true ? "SETTLED" : "SUBMITTED_PENDING_RECONCILIATION",
  };
}

/** Pure builder for unit tests — mirrors the ledger row without a DB. */
export function buildOperatorDecisionAudit(input: AuditInput & { id: string }) {
  return buildAuditEvent(input);
}
