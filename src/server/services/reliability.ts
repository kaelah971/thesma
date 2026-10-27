import type { AuditSink, MarketStore } from "./campaignStore";

/**
 * Creator reliability + outcome quality / retention (Slice 7).
 *
 * VERIFIED HISTORY > SOCIAL VANITY. CLICKED != CONVERTED != VERIFIED
 * != RETAINED. Reliability is evidence-backed; thin samples lower
 * confidence but never brand a creator "bad". An anomaly is a REVIEW
 * SIGNAL — never "fraud" without objective adjudicated proof.
 *
 * Fairness rule (hard): settlement delay/failure caused by organization
 * liquidity, campaign holds, payout infrastructure, chain ambiguity or
 * policy refusal is NEVER counted against creator reliability. Only
 * settled positives add; unpaid obligations are invisible to the score.
 *
 * No follower counts, likes, impressions, self-reported audiences or
 * external engagement anywhere. No external verification purchasing
 * (Slice 8 consumes the machine-readable readiness state only).
 */

export type RetentionWindowKey = "D7" | "D30";
export type RetentionStatus = "PENDING" | "QUALIFIED" | "MISSED" | "UNSUPPORTED" | "REVIEW";
export type OutcomeQuality =
  | "VERIFIED_STANDARD"
  | "VERIFIED_HIGH_QUALITY"
  | "RETENTION_PENDING"
  | "RETAINED"
  | "QUALITY_REVIEW"
  | "INSUFFICIENT_EVIDENCE";
export type ReliabilityLevel = "PROVISIONAL" | "ESTABLISHED" | "STRONG_EVIDENCE";
export type ReliabilityConfidence = "LOW" | "MEDIUM" | "HIGH";
export type AnomalyType =
  | "DUPLICATE_PAYMENT_REFERENCE"
  | "ATTRIBUTION_CONFLICT"
  | "UNUSUAL_BURST"
  | "REPEATED_SHARED_ORIGIN";
export type AnomalySeverity = "INFO" | "REVIEW";
export type VerificationAction = "NONE" | "REVIEW" | "EXTERNAL_CHECK_CANDIDATE";

export interface RetentionWindow {
  key: RetentionWindowKey;
  /** Days after original verification when the window opens. */
  startDays: number;
  /** Days after original verification when the window closes. */
  endDays: number;
}

export const RETENTION_WINDOWS: RetentionWindow[] = [
  { key: "D7", startDays: 7, endDays: 37 },
  { key: "D30", startDays: 30, endDays: 60 },
];

const DAY_MS = 86_400_000;

export interface RetentionInput {
  id: string;
  campaignId: string;
  /** Privacy-safe subject reference (salted hash), never raw identity. */
  subjectRef: string | null;
  status: string;
  verifiedAtMs: number | null;
}

export interface RetentionRecord {
  originalOutcomeId: string;
  campaignId: string;
  window: RetentionWindowKey;
  status: RetentionStatus;
  qualifyingOutcomeId: string | null;
  windowEndsAt: string | null;
  reason: string;
}

export interface RetentionWindowSummary {
  window: RetentionWindowKey;
  eligible: number;
  matured: number;
  qualified: number;
  pending: number;
  missed: number;
  review: number;
  unsupported: number;
  /** qualified / (qualified + missed). Null when no matured unambiguous outcomes. */
  rate: number | null;
}

/**
 * Pure retention evaluation from canonical outcome rows. Clicks, visits
 * and wallet reconnects are not inputs and can never qualify. A second
 * VERIFIED outcome for the same subject inside the window is the only
 * qualifying event. Pre-threshold actions never qualify. Deterministic.
 */
export function evaluateRetention(
  rows: RetentionInput[],
  nowMs: number,
  windows: RetentionWindow[] = RETENTION_WINDOWS,
): { records: RetentionRecord[]; summary: RetentionWindowSummary[] } {
  const records: RetentionRecord[] = [];
  const bySubject = new Map<string, RetentionInput[]>();
  for (const r of rows) {
    if (!r.subjectRef) continue;
    const key = `${r.campaignId}::${r.subjectRef}`;
    const list = bySubject.get(key) ?? [];
    list.push(r);
    bySubject.set(key, list);
  }
  const summary: RetentionWindowSummary[] = windows.map((w) => ({
    window: w.key,
    eligible: 0,
    matured: 0,
    qualified: 0,
    pending: 0,
    missed: 0,
    review: 0,
    unsupported: 0,
    rate: null,
  }));
  const summaryByKey = new Map(summary.map((s) => [s.window, s]));
  for (const r of rows) {
    if (r.status !== "VERIFIED" || r.verifiedAtMs === null) continue;
    for (const w of windows) {
      const s = summaryByKey.get(w.key)!;
      if (!r.subjectRef) {
        s.unsupported += 1;
        records.push({
          originalOutcomeId: r.id,
          campaignId: r.campaignId,
          window: w.key,
          status: "UNSUPPORTED",
          qualifyingOutcomeId: null,
          windowEndsAt: null,
          reason: "No observable subject identity — retention cannot be evaluated, never fabricated.",
        });
        continue;
      }
      const start = r.verifiedAtMs + w.startDays * DAY_MS;
      const end = r.verifiedAtMs + w.endDays * DAY_MS;
      if (nowMs < start) continue; // window not yet open: excluded from every denominator.
      s.eligible += 1;
      const siblings = (bySubject.get(`${r.campaignId}::${r.subjectRef}`) ?? []).filter((o) => o.id !== r.id);
      const inWindow = siblings.filter((o) => o.verifiedAtMs !== null && o.verifiedAtMs >= start && o.verifiedAtMs <= end);
      // Deterministic qualifier: earliest verified event wins, id breaks ties.
      const qualifying = inWindow
        .filter((o) => o.status === "VERIFIED")
        .sort((a, b) => (a.verifiedAtMs as number) - (b.verifiedAtMs as number) || a.id.localeCompare(b.id))[0];
      if (qualifying) {
        s.matured += 1;
        s.qualified += 1;
        records.push({
          originalOutcomeId: r.id,
          campaignId: r.campaignId,
          window: w.key,
          status: "QUALIFIED",
          qualifyingOutcomeId: qualifying.id,
          windowEndsAt: new Date(end).toISOString(),
          reason: `Same subject verified again inside the ${w.key} window.`,
        });
        continue;
      }
      if (inWindow.length > 0) {
        // A later same-subject event exists but is not VERIFIED — ambiguous trail, excluded from rates.
        s.review += 1;
        records.push({
          originalOutcomeId: r.id,
          campaignId: r.campaignId,
          window: w.key,
          status: "REVIEW",
          qualifyingOutcomeId: null,
          windowEndsAt: new Date(end).toISOString(),
          reason: "A later same-subject event in-window is not verified — requires review, not counted either way.",
        });
        continue;
      }
      if (nowMs >= end) {
        s.matured += 1;
        s.missed += 1;
        records.push({
          originalOutcomeId: r.id,
          campaignId: r.campaignId,
          window: w.key,
          status: "MISSED",
          qualifyingOutcomeId: null,
          windowEndsAt: new Date(end).toISOString(),
          reason: `Window closed with no qualifying event — not retained, not a failure of the original verification.`,
        });
      } else {
        s.pending += 1;
        records.push({
          originalOutcomeId: r.id,
          campaignId: r.campaignId,
          window: w.key,
          status: "PENDING",
          qualifyingOutcomeId: null,
          windowEndsAt: new Date(end).toISOString(),
          reason: "Window still open — pending is not failed retention.",
        });
      }
    }
  }
  for (const s of summary) {
    const denom = s.qualified + s.missed;
    s.rate = denom > 0 ? Math.round((s.qualified / denom) * 1000) / 10 : null;
  }
  records.sort((a, b) => a.originalOutcomeId.localeCompare(b.originalOutcomeId) || a.window.localeCompare(b.window));
  return { records, summary };
}

export interface QualityContext {
  status: string;
  qualifyingAmountMicroUsdc: bigint | null;
  purchaseAmountMicroUsdc: bigint | null;
  retention: RetentionStatus | null;
  anomalyFlagged: boolean;
}

/**
 * Deterministic per-outcome quality. Anomaly flag dominates (review
 * first); retention evidence next; economics last. Unverified outcomes
 * carry no quality claim at all.
 */
export function classifyOutcomeQuality(ctx: QualityContext): OutcomeQuality {
  if (ctx.status !== "VERIFIED") return "INSUFFICIENT_EVIDENCE";
  if (ctx.anomalyFlagged) return "QUALITY_REVIEW";
  if (ctx.retention === "QUALIFIED") return "RETAINED";
  if (ctx.retention === "PENDING") return "RETENTION_PENDING";
  if (
    ctx.qualifyingAmountMicroUsdc !== null &&
    ctx.qualifyingAmountMicroUsdc > 0n &&
    ctx.purchaseAmountMicroUsdc !== null &&
    ctx.purchaseAmountMicroUsdc >= ctx.qualifyingAmountMicroUsdc * 3n
  ) {
    return "VERIFIED_HIGH_QUALITY";
  }
  return "VERIFIED_STANDARD";
}

export interface AnomalySignal {
  type: AnomalyType;
  severity: AnomalySeverity;
  campaignId: string;
  partnerId: string | null;
  evidenceRefs: string[];
  reason: string;
}

const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_COUNT = 5;

/**
 * Conservative anomaly detection over observable rows only. Returns
 * signals — never rejects, never blocks payout, never accuses. Sort
 * order deterministic (type, then evidence).
 */
export function detectAnomalies(args: {
  outcomes: { id: string; campaignId: string; partnerId: string; status: string; purchaseTx: string | null; customerKeyHash: string | null; verifiedAtMs: number | null }[];
  intents: { id: string; campaignId: string; partnerId: string; orderId: string; payerAddress: string }[];
}): AnomalySignal[] {
  const signals: AnomalySignal[] = [];
  const txGroups = new Map<string, typeof args.outcomes>();
  for (const o of args.outcomes) {
    if (!o.purchaseTx) continue;
    const list = txGroups.get(o.purchaseTx) ?? [];
    list.push(o);
    txGroups.set(o.purchaseTx, list);
  }
  for (const [tx, list] of txGroups) {
    if (list.length > 1) {
      signals.push({
        type: "DUPLICATE_PAYMENT_REFERENCE",
        severity: "REVIEW",
        campaignId: list[0].campaignId,
        partnerId: list[0].partnerId,
        evidenceRefs: list.map((o) => o.id).sort(),
        reason: `Payment reference ${tx.slice(0, 10)}… appears on ${list.length} outcomes — requires review before any conclusion.`,
      });
    }
  }
  const orderPartners = new Map<string, Set<string>>();
  const orderCampaign = new Map<string, string>();
  for (const i of args.intents) {
    const set = orderPartners.get(i.orderId) ?? new Set<string>();
    set.add(i.partnerId);
    orderPartners.set(i.orderId, set);
    orderCampaign.set(i.orderId, i.campaignId);
  }
  for (const [orderId, partners] of orderPartners) {
    if (partners.size > 1) {
      signals.push({
        type: "ATTRIBUTION_CONFLICT",
        severity: "REVIEW",
        campaignId: orderCampaign.get(orderId) ?? "",
        partnerId: null,
        evidenceRefs: [orderId, ...[...partners].sort()],
        reason: `Order ${orderId.slice(0, 8)}… is claimed by ${partners.size} creators — attribution needs review.`,
      });
    }
  }
  const verifiedByPartner = new Map<string, typeof args.outcomes>();
  for (const o of args.outcomes) {
    if (o.status !== "VERIFIED" || o.verifiedAtMs === null) continue;
    const list = verifiedByPartner.get(o.partnerId) ?? [];
    list.push(o);
    verifiedByPartner.set(o.partnerId, list);
  }
  for (const [partnerId, list] of verifiedByPartner) {
    const times = list.map((o) => o.verifiedAtMs as number).sort((a, b) => a - b);
    let burst = false;
    for (let i = 0; i + BURST_COUNT - 1 < times.length; i += 1) {
      if (times[i + BURST_COUNT - 1] - times[i] <= BURST_WINDOW_MS) {
        burst = true;
        break;
      }
    }
    if (burst) {
      signals.push({
        type: "UNUSUAL_BURST",
        severity: "INFO",
        campaignId: list[0].campaignId,
        partnerId,
        evidenceRefs: list.map((o) => o.id).sort().slice(0, 10),
        reason: `${BURST_COUNT}+ verifications inside 10 minutes — unusual tempo, informational only.`,
      });
    }
  }
  const payerCounts = new Map<string, { n: number; campaignId: string; partnerId: string }>();
  for (const i of args.intents) {
    const key = `${i.campaignId}::${i.partnerId}::${i.payerAddress.toLowerCase()}`;
    const cur = payerCounts.get(key) ?? { n: 0, campaignId: i.campaignId, partnerId: i.partnerId };
    cur.n += 1;
    payerCounts.set(key, cur);
  }
  for (const [, v] of payerCounts) {
    if (v.n >= 3) {
      signals.push({
        type: "REPEATED_SHARED_ORIGIN",
        severity: "INFO",
        campaignId: v.campaignId,
        partnerId: v.partnerId,
        evidenceRefs: [],
        reason: `Same payer behind ${v.n} intents for one creator — shared origin is common (same household/device), informational only.`,
      });
    }
  }
  signals.sort((a, b) => a.type.localeCompare(b.type) || a.campaignId.localeCompare(b.campaignId) || (a.partnerId ?? "").localeCompare(b.partnerId ?? ""));
  return signals;
}

export interface ReliabilityInput {
  attributedActions: number;
  verifiedOutcomes: number;
  rejectedOutcomes: number;
  /** Settled collaborations add; UNSETTLED NEVER SUBTRACTS (fairness rule). */
  settledCollaborations: number;
  campaignsWithVerified: number;
  retentionQualified: number;
  /** Null when no matured unambiguous retention history exists. */
  retentionMatured: number | null;
  recentVerified: number;
}

export interface ReliabilityComponent {
  score: number | null;
  weight: number;
  note: string;
}

export interface ReliabilitySnapshot {
  reliabilityScore: number;
  confidence: ReliabilityConfidence;
  level: ReliabilityLevel;
  components: {
    verificationQuality: ReliabilityComponent;
    settlementHistory: ReliabilityComponent;
    campaignConsistency: ReliabilityComponent;
    retentionQuality: ReliabilityComponent;
    evidenceDepth: ReliabilityComponent;
  };
  reasons: string[];
  warnings: string[];
}

/**
 * Canonical creator reliability. Thin samples cap confidence at LOW and
 * force PROVISIONAL — never "bad", never "untrusted". Deterministic.
 */
export function scoreReliability(input: ReliabilityInput): ReliabilitySnapshot {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const sample = input.verifiedOutcomes + input.settledCollaborations;

  let verification: ReliabilityComponent;
  const denom = input.verifiedOutcomes + input.rejectedOutcomes;
  if (input.attributedActions > 0 && denom > 0) {
    const rate = Math.round((input.verifiedOutcomes / denom) * 100);
    verification = { score: rate, weight: 30, note: `${input.verifiedOutcomes} of ${denom} attributable attempts verified.` };
    reasons.push(`${rate}% verification quality over ${denom} attributable attempts.`);
  } else {
    verification = { score: null, weight: 30, note: "No verified attempts to judge yet." };
    warnings.push("Verification quality unknown — no attributable attempt history.");
  }

  // Settlement adds only. Liquidity holds, policy refusals, infra delays
  // and chain ambiguity are deliberately not inputs.
  const settlementScore = Math.min(100, input.settledCollaborations * 25);
  const settlement: ReliabilityComponent = {
    score: settlementScore,
    weight: 20,
    note: input.settledCollaborations > 0 ? `${input.settledCollaborations} settled collaborations on record.` : "No settled collaborations yet — neutral, not negative.",
  };
  if (input.settledCollaborations > 0) reasons.push(`${input.settledCollaborations} settled collaborations.`);

  const consistencyScore = Math.min(100, input.campaignsWithVerified * 34);
  const consistency: ReliabilityComponent = {
    score: consistencyScore,
    weight: 20,
    note:
      input.campaignsWithVerified > 1
        ? `Verified results across ${input.campaignsWithVerified} campaigns — not a one-lucky-sample story.`
        : "Results concentrated in a single campaign so far.",
  };
  if (input.campaignsWithVerified > 1) reasons.push(`Evidence across ${input.campaignsWithVerified} campaigns.`);

  let retention: ReliabilityComponent;
  if (input.retentionMatured !== null && input.retentionMatured > 0) {
    const rate = Math.round((input.retentionQualified / input.retentionMatured) * 100);
    retention = { score: rate, weight: 15, note: `${input.retentionQualified} of ${input.retentionMatured} matured outcomes retained.` };
    reasons.push(`${rate}% retention over ${input.retentionMatured} matured outcomes.`);
  } else {
    retention = { score: null, weight: 15, note: "No matured retention history — eligible, not penalized." };
    warnings.push("Retention history still maturing.");
  }

  const depth: ReliabilityComponent = {
    score: Math.min(100, Math.round(Math.log10(1 + sample) * 50)),
    weight: 15,
    note: `Sample of ${sample} (verified + settled).`,
  };

  // Weighted score over AVAILABLE components only — missing evidence
  // abstains, it never drags the score toward zero.
  let num = 0;
  let wsum = 0;
  for (const c of [verification, settlement, consistency, retention, depth]) {
    if (c.score !== null) {
      num += c.score * c.weight;
      wsum += c.weight;
    }
  }
  let reliabilityScore = wsum > 0 ? Math.round(num / wsum) : 50;
  // No-history creators stay explicitly neutral.
  if (sample === 0 && input.attributedActions === 0) reliabilityScore = 50;

  const confidence: ReliabilityConfidence = sample >= 20 ? "HIGH" : sample >= 5 ? "MEDIUM" : "LOW";
  if (confidence === "LOW") warnings.push("Low sample — treat score as provisional.");
  const level: ReliabilityLevel =
    confidence === "HIGH" && input.campaignsWithVerified > 1 ? "STRONG_EVIDENCE" : confidence === "LOW" ? "PROVISIONAL" : "ESTABLISHED";
  if (level === "PROVISIONAL") reasons.push("Provisional standing — new creators remain discoverable.");
  return {
    reliabilityScore,
    confidence,
    level,
    components: { verificationQuality: verification, settlementHistory: settlement, campaignConsistency: consistency, retentionQuality: retention, evidenceDepth: depth },
    reasons,
    warnings,
  };
}

export interface VerificationReadiness {
  verificationConfidence: ReliabilityConfidence | "INSUFFICIENT_DATA";
  anomalySignals: AnomalySignal[];
  economicExposureMicroUsdc: string;
  recommendedAction: VerificationAction;
  reason: string;
}

/**
 * Machine-readable state for Slice 8 procurement. Recommends — never
 * purchases, never moves money, never calls out.
 */
export function verificationReadiness(params: {
  verifiedOutcomes: number;
  anomalySignals: AnomalySignal[];
  exposureMicroUsdc: bigint;
}): VerificationReadiness {
  const reviews = params.anomalySignals.filter((s) => s.severity === "REVIEW");
  if (reviews.length === 0) {
    return {
      verificationConfidence: params.verifiedOutcomes > 0 ? "MEDIUM" : "INSUFFICIENT_DATA",
      anomalySignals: params.anomalySignals,
      economicExposureMicroUsdc: params.exposureMicroUsdc.toString(),
      recommendedAction: "NONE",
      reason: "No review-grade signals — nothing to procure verification for.",
    };
  }
  return {
    verificationConfidence: "MEDIUM",
    anomalySignals: params.anomalySignals,
    economicExposureMicroUsdc: params.exposureMicroUsdc.toString(),
    recommendedAction: params.exposureMicroUsdc > 0n ? "EXTERNAL_CHECK_CANDIDATE" : "REVIEW",
    reason: `${reviews.length} review-grade signal(s) over ${params.exposureMicroUsdc} micro-USDC exposure — human review first, external check only if Slice 8 policy allows.`,
  };
}

/* ---------------- Loaders (read-only, store-backed) ---------------- */

export interface CreatorReliabilityView extends ReliabilitySnapshot {
  userId: string;
  partnerId: string | null;
  verifiedOutcomes: number;
  settledCollaborations: number;
  campaignsWithVerified: number;
  retainedOutcomes: number;
}

/** Memory-store compatible: uses MarketStore methods only. */
export async function loadCreatorReliability(store: MarketStore, userId: string, now: Date = new Date()): Promise<CreatorReliabilityView> {
  const partner = await store.getPartnerByUserId(userId).catch(() => null);
  if (!partner) {
    const snap = scoreReliability({
      attributedActions: 0, verifiedOutcomes: 0, rejectedOutcomes: 0, settledCollaborations: 0,
      campaignsWithVerified: 0, retentionQualified: 0, retentionMatured: null, recentVerified: 0,
    });
    return { ...snap, userId, partnerId: null, verifiedOutcomes: 0, settledCollaborations: 0, campaignsWithVerified: 0, retainedOutcomes: 0 };
  }
  const [verified, rejected, terms] = await Promise.all([
    store.listOutcomesByStatus("VERIFIED", 10_000).catch(() => []),
    store.listOutcomesByStatus("REJECTED", 10_000).catch(() => []),
    store.listPartnerTerms(partner.id).catch(() => []),
  ]);
  const mine = verified.filter((o) => o.partnerId === partner.id);
  const mineRejected = rejected.filter((o) => o.partnerId === partner.id);
  const campaigns = new Set(mine.map((o) => o.campaignId));
  const settledCampaigns = new Set<string>();
  for (const o of mine) {
    const payout = await store.getPayoutByOutcome(o.id).catch(() => null);
    if (payout && payout.state === "SETTLED") settledCampaigns.add(o.campaignId);
  }
  const byCampaign = new Map<string, RetentionInput[]>();
  for (const o of mine) {
    const list = byCampaign.get(o.campaignId) ?? [];
    list.push({ id: o.id, campaignId: o.campaignId, subjectRef: o.customerKeyHash ?? null, status: "VERIFIED", verifiedAtMs: o.verifiedAt?.getTime() ?? null });
    byCampaign.set(o.campaignId, list);
  }
  let retained = 0;
  let matured: number | null = null;
  let maturedTotal = 0;
  for (const [, rows] of byCampaign) {
    const { summary } = evaluateRetention(rows, now.getTime());
    const d7 = summary.find((s) => s.window === "D7")!;
    retained += d7.qualified;
    maturedTotal += d7.qualified + d7.missed;
  }
  matured = maturedTotal > 0 ? maturedTotal : null;
  const actions = await store.countCheckoutIntentsForPartner(partner.id).catch(() => 0);
  const snap = scoreReliability({
    attributedActions: actions,
    verifiedOutcomes: mine.length,
    rejectedOutcomes: mineRejected.length,
    settledCollaborations: settledCampaigns.size,
    campaignsWithVerified: campaigns.size,
    retentionQualified: retained,
    retentionMatured: matured,
    recentVerified: mine.filter((o) => o.verifiedAt && o.verifiedAt.getTime() >= now.getTime() - 30 * DAY_MS).length,
  });
  return {
    ...snap, userId, partnerId: partner.id, verifiedOutcomes: mine.length,
    settledCollaborations: settledCampaigns.size, campaignsWithVerified: campaigns.size, retainedOutcomes: retained,
  };
}

export interface CampaignQualityView {
  campaignId: string;
  verifiedAcquisitions: number;
  d7: RetentionWindowSummary;
  d30: RetentionWindowSummary;
  anomalySignals: AnomalySignal[];
  readiness: VerificationReadiness;
  overallConfidence: ReliabilityConfidence | "INSUFFICIENT_DATA";
}

/** Campaign quality from canonical rows: rates, anomalies, Slice-8 readiness. No writes. */
export async function loadCampaignQuality(store: MarketStore, campaignId: string, now: Date = new Date()): Promise<CampaignQualityView> {
  const [verified, pending, rejected, intents] = await Promise.all([
    store.listOutcomesByStatus("VERIFIED", 10_000).catch(() => []),
    store.listOutcomesByStatus("PENDING", 10_000).catch(() => []),
    store.listOutcomesByStatus("REJECTED", 10_000).catch(() => []),
    store.listCheckoutIntentsByCampaign(campaignId).catch(() => []),
  ]);
  const mine = [...verified, ...pending, ...rejected].filter((o) => o.campaignId === campaignId);
  const rows: RetentionInput[] = mine.map((o) => ({
    id: o.id, campaignId: o.campaignId, subjectRef: o.customerKeyHash ?? null,
    status: o.status, verifiedAtMs: o.verifiedAt?.getTime() ?? null,
  }));
  const { summary } = evaluateRetention(rows, now.getTime());
  const anomalies = detectAnomalies({
    outcomes: mine.map((o) => ({
      id: o.id, campaignId: o.campaignId, partnerId: o.partnerId, status: o.status,
      purchaseTx: o.purchaseTx, customerKeyHash: o.customerKeyHash ?? null, verifiedAtMs: o.verifiedAt?.getTime() ?? null,
    })),
    intents: intents.map((i) => ({ id: i.id, campaignId: i.campaignId, partnerId: i.partnerId, orderId: i.orderId, payerAddress: i.payerAddress })),
  });
  const reservations = await store.listReservationsByCampaign(campaignId).catch(() => []);
  const exposure = reservations.filter((r) => ["RESERVED", "SUBMITTED", "AMBIGUOUS"].includes(r.state)).reduce((s, r) => s + r.amountMicroUsdc, 0n);
  const d7 = summary.find((s) => s.window === "D7")!;
  const d30 = summary.find((s) => s.window === "D30")!;
  const maturedTotal = d7.qualified + d7.missed + d30.qualified + d30.missed;
  return {
    campaignId,
    verifiedAcquisitions: mine.filter((o) => o.status === "VERIFIED").length,
    d7,
    d30,
    anomalySignals: anomalies,
    readiness: verificationReadiness({ verifiedOutcomes: mine.filter((o) => o.status === "VERIFIED").length, anomalySignals: anomalies, exposureMicroUsdc: exposure }),
    overallConfidence: maturedTotal >= 20 ? "HIGH" : maturedTotal >= 5 ? "MEDIUM" : d7.eligible + d30.eligible > 0 ? "LOW" : "INSUFFICIENT_DATA",
  };
}

/** Durable retention qualification with both evidence references. Called on fresh VERIFIED only. */
export async function recordRetentionQualified(
  audit: AuditSink,
  params: { campaignId: string; partnerId: string; originalOutcomeId: string; qualifyingOutcomeId: string; window: RetentionWindowKey },
): Promise<void> {
  await audit({
    actorType: "SYSTEM",
    actorId: null,
    workspaceId: null,
    partnerId: params.partnerId,
    action: "retention.qualified",
    targetType: "outcome",
    targetId: params.originalOutcomeId,
    metadata: {
      campaignId: params.campaignId,
      window: params.window,
      originalOutcomeId: params.originalOutcomeId,
      qualifyingOutcomeId: params.qualifyingOutcomeId,
    },
  }).catch(() => {});
}
