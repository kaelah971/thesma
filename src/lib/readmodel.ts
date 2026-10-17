/**
 * UI read model for the authenticated app. Pure derivations over a
 * workspace snapshot (JSON-safe: money as micro-USDC strings, dates as ISO).
 *
 * Mirrors backend definitions — it never invents state:
 * - funded = confirmed funding (observed ?? expected), else 0
 * - committed = active reservations (RESERVED/SUBMITTED/AMBIGUOUS/SETTLED)
 *   + ACTIVE supply commitments (same rule as services/payouts.committedForCampaign)
 * - available = funded − committed
 * - VERIFIED never means paid; SUBMITTED never means settled.
 */

export interface FundingView {
  status: "PREPARED" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "AMBIGUOUS";
  policyVersion: number;
  expectedMicro: string;
  observedMicro: string | null;
  fundingTxHash: string | null;
  confirmedAt: string | null;
  failureCode: string | null;
}

export interface MarketView {
  status: string;
  bountyMicro: string;
  version: number;
  openedAt: string;
}

export interface CampaignView {
  id: string;
  state: string;
  intentText: string;
  version: number | null;
  policyStatus: string | null;
  targetOutcomeCount: number | null;
  budgetMicro: string | null;
  floorMicro: string | null;
  ceilingMicro: string | null;
  minPurchaseMicro: string | null;
  deadline: string | null;
  refundHoldSeconds: number;
  visibility: string;
  createdAt: string;
  updatedAt: string;
  funding: FundingView | null;
  market: MarketView | null;
}

export interface OutcomeView {
  id: string;
  campaignId: string;
  partnerId: string;
  status: "PENDING" | "VERIFIED" | "REJECTED";
  purchaseAmountMicro: string;
  purchaseTx: string;
  proofHash: string | null;
  occurredAt: string | null;
  verifiedAt: string | null;
  holdUntil: string | null;
  rejectionCode: string | null;
  createdAt: string;
}

export interface ReservationView {
  id: string;
  campaignId: string;
  outcomeId: string;
  amountMicro: string;
  state: "RESERVED" | "SUBMITTED" | "SETTLED" | "FAILED" | "AMBIGUOUS" | "RELEASED";
}

export interface PayoutView {
  id: string;
  campaignId: string;
  outcomeId: string;
  partnerId: string;
  recipient: string;
  amountMicro: string;
  state: "PREPARED" | "SUBMITTED" | "SETTLED" | "FAILED" | "AMBIGUOUS";
  txHash: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  reconciledAt: string | null;
  failureCode: string | null;
  createdAt: string;
}

export interface CommitmentView {
  campaignId: string;
  amountMicro: string;
}

export interface ActivityView {
  id: string;
  action: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
}

export interface WorkspaceSnapshot {
  workspace: { id: string; name: string; role: string; companyWallet: string | null; category: string | null };
  campaigns: CampaignView[];
  outcomes: OutcomeView[];
  reservations: ReservationView[];
  payouts: PayoutView[];
  activeCommitments: CommitmentView[];
  activity: ActivityView[];
  generatedAt: string;
}

const ACTIVE_RESERVATION = new Set(["RESERVED", "SUBMITTED", "AMBIGUOUS", "SETTLED"]);

export interface Financials {
  funded: bigint;
  committed: bigint;
  settled: bigint;
  inFlight: bigint;
  available: bigint;
}

export function fundedMicro(c: Pick<CampaignView, "funding">): bigint {
  if (!c.funding || c.funding.status !== "CONFIRMED") return 0n;
  return BigInt(c.funding.observedMicro ?? c.funding.expectedMicro);
}

export function campaignFinancials(
  campaignId: string,
  snap: Pick<WorkspaceSnapshot, "campaigns" | "reservations" | "activeCommitments" | "payouts">,
): Financials {
  const campaign = snap.campaigns.find((c) => c.id === campaignId);
  const funded = campaign ? fundedMicro(campaign) : 0n;
  const reserved = snap.reservations
    .filter((r) => r.campaignId === campaignId && ACTIVE_RESERVATION.has(r.state))
    .reduce((s, r) => s + BigInt(r.amountMicro), 0n);
  const commitments = snap.activeCommitments
    .filter((c) => c.campaignId === campaignId)
    .reduce((s, c) => s + BigInt(c.amountMicro), 0n);
  const settled = snap.payouts
    .filter((p) => p.campaignId === campaignId && p.state === "SETTLED")
    .reduce((s, p) => s + BigInt(p.amountMicro), 0n);
  const committed = reserved + commitments;
  const available = funded > committed ? funded - committed : 0n;
  return { funded, committed, settled, inFlight: committed > settled ? committed - settled : 0n, available };
}

export function workspaceFinancials(snap: WorkspaceSnapshot): Financials {
  return snap.campaigns.reduce<Financials>(
    (acc, c) => {
      const f = campaignFinancials(c.id, snap);
      return {
        funded: acc.funded + f.funded,
        committed: acc.committed + f.committed,
        settled: acc.settled + f.settled,
        inFlight: acc.inFlight + f.inFlight,
        available: acc.available + f.available,
      };
    },
    { funded: 0n, committed: 0n, settled: 0n, inFlight: 0n, available: 0n },
  );
}

/** Where an outcome sits on the settlement rail. */
export type OutcomeStage =
  | "AWAITING_VERIFICATION"
  | "REJECTED"
  | "SAFETY_HOLD"
  | "ELIGIBLE"
  | "RESERVED"
  | "SUBMITTED"
  | "SETTLED"
  | "FAILED"
  | "AMBIGUOUS"
  | "RELEASED";

export const STAGE_LABEL: Record<OutcomeStage, string> = {
  AWAITING_VERIFICATION: "Awaiting verification",
  REJECTED: "Rejected",
  SAFETY_HOLD: "Safety hold",
  ELIGIBLE: "Eligible for payout",
  RESERVED: "Reserved",
  SUBMITTED: "Submitted",
  SETTLED: "Settled",
  FAILED: "Failed · released",
  AMBIGUOUS: "Reconciling",
  RELEASED: "Released",
};

export type Tone = "mint" | "blue" | "lav" | "cream" | "rose" | "neutral" | "dark";

export const STAGE_TONE: Record<OutcomeStage, Tone> = {
  AWAITING_VERIFICATION: "neutral",
  REJECTED: "rose",
  SAFETY_HOLD: "cream",
  ELIGIBLE: "blue",
  RESERVED: "lav",
  SUBMITTED: "lav",
  SETTLED: "mint",
  FAILED: "rose",
  AMBIGUOUS: "cream",
  RELEASED: "neutral",
};

/** Ordered rail used across the product (landing, phone, app). */
export const RAIL: { key: OutcomeStage; label: string }[] = [
  { key: "AWAITING_VERIFICATION", label: "Verify" },
  { key: "SAFETY_HOLD", label: "Hold" },
  { key: "RESERVED", label: "Reserve" },
  { key: "SUBMITTED", label: "Submit" },
  { key: "SETTLED", label: "Settle" },
];

export function railIndex(stage: OutcomeStage): number {
  switch (stage) {
    case "AWAITING_VERIFICATION":
    case "REJECTED":
      return 0;
    case "SAFETY_HOLD":
      return 1;
    case "ELIGIBLE":
    case "RESERVED":
    case "RELEASED":
      return 2;
    case "SUBMITTED":
    case "AMBIGUOUS":
    case "FAILED":
      return 3;
    case "SETTLED":
      return 4;
  }
}

export function outcomeStage(
  outcome: OutcomeView,
  reservation: ReservationView | undefined,
  payout: PayoutView | undefined,
  now: number,
): OutcomeStage {
  if (outcome.status === "PENDING") return "AWAITING_VERIFICATION";
  if (outcome.status === "REJECTED") return "REJECTED";
  if (payout) {
    if (payout.state === "PREPARED") return "RESERVED";
    return payout.state;
  }
  if (reservation) {
    if (reservation.state === "SETTLED") return "SETTLED";
    if (reservation.state === "SUBMITTED") return "SUBMITTED";
    if (reservation.state === "AMBIGUOUS") return "AMBIGUOUS";
    if (reservation.state === "FAILED") return "FAILED";
    if (reservation.state === "RELEASED") return "RELEASED";
    return "RESERVED";
  }
  if (outcome.holdUntil && new Date(outcome.holdUntil).getTime() > now) return "SAFETY_HOLD";
  return "ELIGIBLE";
}

export interface OutcomeRow extends OutcomeView {
  stage: OutcomeStage;
  holdRemainingMs: number | null;
  payout: PayoutView | undefined;
  reservation: ReservationView | undefined;
}

export function outcomeRows(snap: WorkspaceSnapshot, now: number, campaignId?: string): OutcomeRow[] {
  const resByOutcome = new Map(snap.reservations.map((r) => [r.outcomeId, r]));
  const payByOutcome = new Map(snap.payouts.map((p) => [p.outcomeId, p]));
  return snap.outcomes
    .filter((o) => !campaignId || o.campaignId === campaignId)
    .map((o) => {
      const reservation = resByOutcome.get(o.id);
      const payout = payByOutcome.get(o.id);
      const stage = outcomeStage(o, reservation, payout, now);
      const holdRemainingMs =
        stage === "SAFETY_HOLD" && o.holdUntil ? new Date(o.holdUntil).getTime() - now : null;
      return { ...o, stage, holdRemainingMs, payout, reservation };
    });
}

export function stageCounts(rows: OutcomeRow[]): Record<OutcomeStage, number> {
  const counts = Object.fromEntries(Object.keys(STAGE_LABEL).map((k) => [k, 0])) as Record<OutcomeStage, number>;
  for (const r of rows) counts[r.stage] += 1;
  return counts;
}

export function verifiedCount(snap: WorkspaceSnapshot, campaignId?: string): number {
  return snap.outcomes.filter((o) => o.status === "VERIFIED" && (!campaignId || o.campaignId === campaignId)).length;
}

export const CAMPAIGN_STATE_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  REVIEW: "cream",
  APPROVED: "blue",
  FUNDING: "lav",
  LIVE: "mint",
  PAUSED: "neutral",
  CLOSING: "cream",
  CLOSED: "neutral",
};

export const PAYOUT_STATE_TONE: Record<string, Tone> = {
  PREPARED: "lav",
  SUBMITTED: "lav",
  SETTLED: "mint",
  FAILED: "rose",
  AMBIGUOUS: "cream",
};

export const FUNDING_STATE_TONE: Record<string, Tone> = {
  PREPARED: "neutral",
  SUBMITTED: "lav",
  CONFIRMED: "mint",
  FAILED: "rose",
  AMBIGUOUS: "cream",
};

/** Human labels for audit actions. Unknown actions fall back to a readable form. */
const ACTION_LABELS: Record<string, string> = {
  "workspace.created": "Workspace created",
  "workspace.company_wallet_registered": "Company wallet registered",
  "campaign.created": "Campaign drafted",
  "campaign.draft_revised": "Draft revised",
  "campaign.review_requested": "Review requested",
  "campaign.policy_approved": "Policy approved",
  "campaign.policy_revision_created": "Policy revision created",
  "campaign.funding_prepared": "Funding prepared",
  "campaign.funding_submitted": "Funding submitted",
  "campaign.funding_confirmed": "Budget funded onchain",
  "campaign.funding_failed": "Funding failed",
  "campaign.funding_ambiguous": "Funding reconciling",
  "campaign.live": "Campaign went live",
  "market.opened": "Market opened",
  "pricing.decision": "Pricing decision recorded",
  "negotiation.opened": "Negotiation opened",
  "negotiation.countered": "Negotiation countered",
  "negotiation.accepted": "Negotiation accepted",
  "negotiation.rejected": "Negotiation rejected",
  "negotiation.held": "Negotiation on hold",
  "negotiation.expired": "Negotiation expired",
  "negotiation.withdrawn": "Negotiation withdrawn",
  "partner.created": "Partner profile created",
  "partner.updated": "Partner profile updated",
  "partner.joined": "Partner joined",
  "partner.rules_updated": "Partner rules updated",
  "referral.created": "Referral route created",
  "private_invite.created": "Private invite issued",
  "checkout.intent_created": "Checkout started",
  "checkout.submitted": "Purchase submitted",
  "checkout.confirmed": "Purchase confirmed",
  "checkout.rejected": "Purchase rejected",
  "checkout.ambiguous": "Purchase reconciling",
  "outcome.verified": "Outcome verified",
  "outcome.rejected": "Outcome rejected",
  "payout.reserved": "Budget reserved for payout",
  "payout.prepared": "Payout prepared",
  "payout.submitted": "Payout submitted",
  "payout.settled": "Payout settled",
  "payout.failed": "Payout failed",
  "payout.ambiguous": "Payout reconciling",
  "payout.released": "Reservation released",
};

export function activityLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  const [, rest = action] = action.split(".");
  const text = rest.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function activityTone(action: string): Tone {
  if (/settled|confirmed|verified|live|approved/.test(action)) return "mint";
  if (/failed|rejected/.test(action)) return "rose";
  if (/ambiguous|hold|paused/.test(action)) return "cream";
  if (/payout|reserved|submitted/.test(action)) return "lav";
  if (/funding|market|reprice/.test(action)) return "blue";
  return "neutral";
}
