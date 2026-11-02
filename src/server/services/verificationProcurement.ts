import { getAddress, isAddress } from "viem";
import type { AuditSink, MarketStore } from "./campaignStore";
import {
  ARC_MAINNET_CAIP2,
  assertTestnetTerms,
  checkTypeForSignals,
  decideVerificationProcurement,
  evaluateValueOfInformation,
  getProcurementSigner,
  getRemoteX402Config,
  normalizeProviderVerdict,
  providerKindForId,
  purchaseWithX402,
  requestFingerprint,
  stableIdempotencyKey,
  type ApprovedPayment,
  type CheckType,
  type FetchImpl,
  type NormalizedResult,
  type ProcurementDecision,
  type ProcurementPolicy,
  type ProcurementSigner,
  type ProcurementState,
  type VerificationQuote,
} from "./verification";
import { DEFAULT_PROCUREMENT_POLICY } from "./verification";
import { committedForCampaign } from "./payouts";
import { getOperatorPolicy, DEFAULT_OPERATOR_POLICY } from "./operator";
import { loadCampaignQuality } from "./reliability";
import { getOrganizationOperatorMode } from "./operatorMode";

/**
 * Verification procurement orchestration (Slice 8).
 *
 * Evaluate → decide → (BUY only) sign exact terms → purchase → normalize.
 * Every terminal branch leaves a durable row + audit. Ambiguous post-sign
 * failures mark AMBIGUOUS and never blind-repay.
 */

export interface ProcurementDeps {
  store: MarketStore;
  audit: AuditSink;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  allowedHosts?: string[];
  /** Injected Circle buyer (tests / proof runner). When absent, the remote path resolves it from env. */
  circleBuyer?: ProcurementSigner | null;
}

export interface ProcurementExecution {
  evaluated: boolean;
  signed: boolean;
  purchased: boolean;
  ambiguous: boolean;
  result: NormalizedResult | null;
  paymentReference: string | null;
  route: "local-test" | "unconfigured" | "real";
}

export interface EvaluateResult {
  procurement: Record<string, unknown> | null;
  decision: ProcurementDecision;
  execution: ProcurementExecution;
}

const TERMINAL = new Set<ProcurementState>(["RESULT_RECEIVED", "PURCHASED", "REFUSED", "FAILED"]);
const TEST_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TEST_PAY_TO = "0x000000000000000000000000000000000000dEaD";

function toPolicy(row: {
  enabled: boolean; maxCostPerCheckMicroUsdc: bigint; maxSpendPerPeriodMicroUsdc: bigint;
  periodDays: number; maxCostBpsOfExposure: number; allowedProvidersJson: unknown;
  allowedCheckTypesJson: unknown; humanApprovalThresholdMicroUsdc: bigint | null;
} | null): ProcurementPolicy {
  if (!row) return { ...DEFAULT_PROCUREMENT_POLICY };
  const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const checkTypes = asStrings(row.allowedCheckTypesJson).filter((x): x is CheckType =>
    ["TRANSACTION_RISK", "ATTRIBUTION_INTEGRITY", "SUBJECT_DUPLICATION", "PAYMENT_REFERENCE_CHECK", "OUTCOME_ENRICHMENT"].includes(x));
  return {
    verificationProcurementEnabled: row.enabled,
    maxCostPerCheckMicroUsdc: row.maxCostPerCheckMicroUsdc,
    maxVerificationSpendPerPeriodMicroUsdc: row.maxSpendPerPeriodMicroUsdc,
    periodDays: row.periodDays,
    maxCostBpsOfExposure: row.maxCostBpsOfExposure,
    allowedProviders: asStrings(row.allowedProvidersJson),
    allowedCheckTypes: checkTypes,
    humanApprovalThresholdMicroUsdc: row.humanApprovalThresholdMicroUsdc,
  };
}

export async function verificationSpendForWorkspace(
  store: MarketStore,
  workspaceId: string,
  nowMs: number,
): Promise<{ spentMicroUsdc: bigint; pendingMicroUsdc: bigint; periodDays: number }> {
  const policyRow = await store.getProcurementPolicy(workspaceId).catch(() => null);
  const periodDays = policyRow?.periodDays ?? DEFAULT_PROCUREMENT_POLICY.periodDays;
  const since = nowMs - periodDays * 86_400_000;
  const rows = await store.listProcurementsByWorkspace(workspaceId).catch(() => []);
  let spent = 0n;
  let pending = 0n;
  for (const r of rows) {
    if (r.createdAt.getTime() < since) continue;
    if (r.state === "PURCHASED" || r.state === "RESULT_RECEIVED") spent += r.quotedCostMicroUsdc;
    else if (r.state === "APPROVED" || r.state === "PAYMENT_AUTHORIZED") pending += r.quotedCostMicroUsdc;
  }
  return { spentMicroUsdc: spent, pendingMicroUsdc: pending, periodDays };
}

function toDto(row: {
  id: string; workspaceId: string; campaignId: string; outcomeId: string; providerId: string; checkType: string;
  economicExposureMicroUsdc: bigint; quotedCostMicroUsdc: bigint; asset: string; network: string; payTo: string;
  resourceUrl: string; quoteVersion: string; quoteExpiresAt: Date; decision: string; state: string;
  dedupeKey: string; paymentReference: string | null; responseHash: string | null; normalizedResult: string | null;
  reasonCodesJson: unknown; decidedAt: Date | null; purchasedAt: Date | null; completedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}): Record<string, unknown> {
  const str = (v: bigint) => v.toString();
  return {
    ...row,
    economicExposureMicroUsdc: str(row.economicExposureMicroUsdc),
    quotedCostMicroUsdc: str(row.quotedCostMicroUsdc),
    quoteExpiresAt: row.quoteExpiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    purchasedAt: row.purchasedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function auditEvent(
  audit: AuditSink,
  action: string,
  params: { workspaceId: string | null; campaignId: string; outcomeId: string; providerId?: string; metadata: Record<string, unknown> },
): Promise<void> {
  await audit({
    actorType: "SYSTEM",
    actorId: null,
    workspaceId: params.workspaceId,
    partnerId: null,
    action,
    targetType: "outcome",
    targetId: params.outcomeId,
    metadata: { campaignId: params.campaignId, outcomeId: params.outcomeId, providerId: params.providerId ?? null, ...params.metadata },
  }).catch(() => {});
}

/**
 * Owner-triggered evaluation for one campaign. Selects the highest-exposure
 * VERIFIED outcome with review-grade signal evidence (or the highest-exposure
 * VERIFIED outcome when readiness already says EXTERNAL_CHECK_CANDIDATE).
 * Read-only except for the persisted decision row + audits; spending happens
 * only on BUY_CHECK with a configured provider.
 */
export async function evaluateVerificationCheck(
  deps: ProcurementDeps,
  params: {
    workspaceId: string; campaignId: string; outcomeId?: string; providerId?: string; checkType?: CheckType;
    /** Explicit verification confidence (bps) for the value-of-information gate. Absent → gate defers to policy. */
    confidenceBps?: { current: number; required: number };
    /** Shadow changes authority only: quote and decide, never persist a procurement or purchase it. */
    executionMode?: "AUTONOMOUS" | "SHADOW";
  },
): Promise<EvaluateResult> {
  const now = deps.now?.() ?? new Date();
  const organizationMode = await getOrganizationOperatorMode(params.workspaceId);
  const shadow = params.executionMode === "SHADOW" || organizationMode === "SHADOW";
  const env = deps.env ?? process.env;
  const store = deps.store;
  const campaign = await store.getCampaign(params.campaignId).catch(() => null);
  if (!campaign || campaign.workspaceId !== params.workspaceId) {
    throw Object.assign(new Error("Campaign not found."), { status: 404, code: "NOT_FOUND" });
  }
  const market = await store.getMarket(params.campaignId).catch(() => null);
  const campaignLive = campaign.state === "LIVE" && market?.status === "OPEN";
  const quality = await loadCampaignQuality(store, params.campaignId, now).catch(() => null);
  const readiness = quality?.readiness.recommendedAction ?? "NONE";
  const reviewAnomalies = (quality?.anomalySignals ?? []).filter((s) => s.severity === "REVIEW");

  // Candidate outcome: explicit, else highest-exposure review-flagged VERIFIED outcome.
  let outcomeId = params.outcomeId ?? null;
  let outcomeStatus: string | null = null;
  if (outcomeId) {
    const o = await store.getOutcome(outcomeId).catch(() => null);
    if (!o || o.campaignId !== params.campaignId) {
      throw Object.assign(new Error("Outcome not found for this campaign."), { status: 404, code: "NOT_FOUND" });
    }
    outcomeStatus = o.status;
  } else if (quality) {
    const verified = await store.listOutcomesByStatus("VERIFIED", 10_000).catch(() => []);
    const mine = verified.filter((o) => o.campaignId === params.campaignId);
    const flaggedIds = new Set<string>();
    for (const s of reviewAnomalies) for (const ref of s.evidenceRefs) flaggedIds.add(ref);
    const withExposure = await Promise.all(
      mine.map(async (o) => {
        const res = await store.getReservationByOutcome(o.id).catch(() => null);
        const terms = await store.getTerms(o.campaignId, o.partnerId).catch(() => null);
        const exposure = res?.amountMicroUsdc ?? terms?.priceMicroUsdc ?? market?.publicBountyMicroUsdc ?? 0n;
        return { o, exposure };
      }),
    );
    const flagged = withExposure.filter((x) => flaggedIds.has(x.o.id)).sort((a, b) => (b.exposure > a.exposure ? 1 : b.exposure < a.exposure ? -1 : 0));
    const pool = flagged.length > 0 ? flagged : withExposure.sort((a, b) => (b.exposure > a.exposure ? 1 : b.exposure < a.exposure ? -1 : 0));
    if (pool[0]) {
      outcomeId = pool[0].o.id;
      outcomeStatus = "VERIFIED";
    }
  }
  const outcomeRelevant = outcomeStatus === "VERIFIED" || outcomeStatus === "PENDING";

  const policyRow = await store.getProcurementPolicy(params.workspaceId).catch(() => null);
  const policy = toPolicy(policyRow);
  const checkType = params.checkType ?? checkTypeForSignals(reviewAnomalies.map((s) => ({ type: s.type, severity: s.severity })));
  const providerId = params.providerId ?? policy.allowedProviders[0] ?? "unconfigured";
  const kind = providerKindForId(providerId, env);

  // Economic exposure for the candidate outcome.
  let exposure = 0n;
  if (outcomeId) {
    const res = await store.getReservationByOutcome(outcomeId).catch(() => null);
    if (res) exposure = res.amountMicroUsdc;
    else {
      const o = await store.getOutcome(outcomeId).catch(() => null);
      const terms = o ? await store.getTerms(o.campaignId, o.partnerId).catch(() => null) : null;
      exposure = terms?.priceMicroUsdc ?? market?.publicBountyMicroUsdc ?? 0n;
    }
  }

  // Liquidity: funded − committed vs operator reserve (CFO truth reused).
  const funding = market ? await store.getFunding(params.campaignId, market.policyVersion).catch(() => null) : null;
  const funded = funding?.status === "CONFIRMED" ? (funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc) : 0n;
  const committed = await committedForCampaign(store, params.campaignId).catch(() => 0n);
  const available = funded - committed > 0n ? funded - committed : 0n;
  const opPolicy = await getOperatorPolicy(params.workspaceId).catch(() => null);
  const reserve = opPolicy?.minReserveMicroUsdc ?? DEFAULT_OPERATOR_POLICY.minReserveMicroUsdc;

  const { spentMicroUsdc: periodSpent } = await verificationSpendForWorkspace(store, params.workspaceId, now.getTime());
  const remoteConfig = kind === "remote-x402" ? getRemoteX402Config(env) : null;
  // Shadow has no signing authority. Treat signer availability as irrelevant to
  // the recommendation so it can answer "would buy" without owning a key.
  let signerConfigured = true;
  if (!shadow && kind === "remote-x402") {
    // The remote buyer signs ONLY through Circle. Never the raw-key signer.
    try {
      const { getCircleVerificationConfig } = await import("../chain/circle");
      signerConfigured = deps.circleBuyer != null || getCircleVerificationConfig(env) !== null;
    } catch {
      signerConfigured = deps.circleBuyer != null;
    }
  } else if (!shadow) {
    try {
      getProcurementSigner(env);
    } catch {
      signerConfigured = false;
    }
  }

  // Quote (no spend): local-test is deterministic; remote-x402 reads the
  // live 402 challenge (terms only, no payment); anything else needs config.
  let quote: VerificationQuote | null = null;
  let quoteError: string | null = null;
  if (checkType && outcomeId) {
    if (kind === "local-test") {
      const cost = BigInt((env.THESMA_TEST_CHECK_COST_MICRO_USDC ?? "80000").trim() || "80000");
      quote = {
        providerId: "local-test", checkType, costMicroUsdc: cost, asset: TEST_USDC,
        network: ARC_MAINNET_CAIP2, payTo: TEST_PAY_TO,
        // Bare endpoint: the check identity lives in the dedupe key, not the URL.
        resourceUrl: "http://localhost/x402-test/verify",
        expiresAt: new Date(now.getTime() + 5 * 60_000), quoteVersion: "test-1",
      };
    } else if (kind === "remote-x402" && remoteConfig) {
      try {
        const { fetchRemoteX402Quote } = await import("./verificationRemote");
        const extraHosts = (env.THESMA_VERIFICATION_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const fetched = await fetchRemoteX402Quote({
          url: remoteConfig.providerUrl,
          providerId: remoteConfig.providerId,
          checkType,
          campaignId: params.campaignId,
          outcomeId,
          expected: { network: remoteConfig.network, asset: remoteConfig.asset },
          allowedHosts: [...(deps.allowedHosts ?? []), new URL(remoteConfig.providerUrl).hostname, ...extraHosts],
          fetchImpl: deps.fetchImpl,
          nowMs: now.getTime(),
        });
        if (fetched.quote) quote = fetched.quote;
        else quoteError = "NO_CHARGE_RESOURCE";
      } catch (e) {
        quoteError = (e as { code?: string }).code ?? "QUOTE_FAILED";
      }
    } else {
      quoteError = "CONFIGURATION_REQUIRED";
    }
  }

  const dedupeKey = quote && outcomeId
    ? requestFingerprint({
        providerId: quote.providerId, resourceUrl: quote.resourceUrl, checkType: quote.checkType,
        campaignId: params.campaignId, outcomeId, amountMicroUsdc: quote.costMicroUsdc,
        asset: quote.asset, network: quote.network, payTo: quote.payTo, quoteVersion: quote.quoteVersion,
      })
    : null;
  const existing = dedupeKey ? await store.getProcurementByDedupe(dedupeKey).catch(() => null) : null;
  if (existing && TERMINAL.has(existing.state)) {
    const decision = decideVerificationProcurement({
      readiness, reviewSeverity: reviewAnomalies.length > 0 ? "REVIEW" : "NONE",
      economicExposureMicroUsdc: exposure, quote: null, quoteError: null, policy,
      providerAllowlisted: true, checkTypeSupported: true, periodSpentMicroUsdc: periodSpent,
      availableMicroUsdc: available, reserveMicroUsdc: reserve, campaignLive, outcomeRelevant,
      existingProcurementState: existing.state, signerConfigured, nowMs: now.getTime(),
    });
    const execution = { evaluated: true, signed: false, purchased: false, ambiguous: false, result: null, paymentReference: null, route: kind === "local-test" ? "local-test" : kind === "remote-x402" ? "real" : "unconfigured" } as const;
    if (shadow) {
      await auditEvent(deps.audit, "shadow.verification.procurement.evaluated", {
        workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId: outcomeId ?? "", providerId,
        metadata: {
          decision: decision.decision, checkType, reasons: decision.reasons, costMicroUsdc: decision.costMicroUsdc,
          executionStatus: "NOT_EXECUTED", existingProcurementState: existing.state,
        },
      });
      return { procurement: null, decision, execution };
    }
    return { procurement: toDto(existing), decision, execution };
  }

  const providerAllowlisted = policy.allowedProviders.includes(providerId);
  const checkTypeSupported = checkType !== null && policy.allowedCheckTypes.includes(checkType) &&
    (kind === "local-test" || kind === "remote-x402");
  let decision = decideVerificationProcurement({
    readiness: outcomeId ? readiness : "NONE",
    reviewSeverity: reviewAnomalies.length > 0 ? "REVIEW" : "NONE",
    economicExposureMicroUsdc: exposure,
    quote: quote ? { costMicroUsdc: quote.costMicroUsdc, expiresAtMs: quote.expiresAt.getTime(), providerId: quote.providerId, checkType: quote.checkType } : null,
    quoteError,
    policy,
    providerAllowlisted,
    checkTypeSupported: checkTypeSupported && checkType !== null,
    periodSpentMicroUsdc: periodSpent,
    availableMicroUsdc: available,
    reserveMicroUsdc: reserve,
    campaignLive,
    outcomeRelevant: outcomeId ? outcomeRelevant : false,
    existingProcurementState: existing?.state ?? null,
    signerConfigured,
    nowMs: now.getTime(),
  });

  // Value-of-information gate: runs only with explicit confidence inputs
  // on a live external-check candidate with a priced quote. NOT_NEEDED /
  // REFUSED / REVIEW override the policy decision; BUY defers to it
  // (liquidity/signer gates still apply). Absent confidence → gate
  // defers entirely, preserving legacy behavior.
  if (
    params.confidenceBps &&
    readiness === "EXTERNAL_CHECK_CANDIDATE" &&
    quote &&
    outcomeId &&
    checkType
  ) {
    const periodRemaining =
      policy.maxVerificationSpendPerPeriodMicroUsdc - periodSpent > 0n
        ? policy.maxVerificationSpendPerPeriodMicroUsdc - periodSpent
        : 0n;
    const voi = evaluateValueOfInformation({
      payoutAtRiskMicroUsdc: exposure,
      currentConfidenceBps: params.confidenceBps.current,
      requiredConfidenceBps: params.confidenceBps.required,
      providerPriceMicroUsdc: quote.costMicroUsdc,
      remainingVerificationBudgetMicroUsdc:
        kind === "remote-x402" && remoteConfig
          ? (remoteConfig.budgetMicroUsdc - periodSpent > 0n ? remoteConfig.budgetMicroUsdc - periodSpent : 0n)
          : periodRemaining,
      maxPerCheckMicroUsdc:
        kind === "remote-x402" && remoteConfig ? remoteConfig.maxPerCheckMicroUsdc : policy.maxCostPerCheckMicroUsdc,
      maxEvidenceCostShareBps: policy.maxCostBpsOfExposure,
      humanApprovalThresholdMicroUsdc: policy.humanApprovalThresholdMicroUsdc,
    });
    if (voi.decision === "NOT_NEEDED") {
      decision = { ...decision, decision: "NO_CHECK", reasons: voi.reasons };
    } else if (voi.decision === "REFUSED") {
      decision = { ...decision, decision: "REFUSE", reasons: voi.reasons };
    } else if (voi.decision === "REVIEW") {
      decision = { ...decision, decision: "ESCALATE", reasons: voi.reasons };
    }
  }

  const execBase = {
    evaluated: true, signed: false, purchased: false, ambiguous: false,
    result: null as import("./verification").NormalizedResult | null, paymentReference: null as string | null,
    route: (kind === "local-test" ? "local-test" : kind === "remote-x402" ? "real" : "unconfigured") as "local-test" | "unconfigured" | "real",
  };
  await auditEvent(deps.audit, shadow ? "shadow.verification.procurement.evaluated" : "verification.procurement.evaluated", {
    workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId: outcomeId ?? "",
    providerId,
    metadata: {
      decision: decision.decision,
      checkType,
      reasons: decision.reasons,
      costMicroUsdc: decision.costMicroUsdc,
      executionStatus: shadow ? "NOT_EXECUTED" : "AVAILABLE",
    },
  });

  // This is the hard x402 boundary: shadow evaluates the same quote and
  // deterministic policy, then exits before any procurement row, signer, or
  // purchase call can occur.
  if (shadow) return { procurement: null, decision, execution: execBase };

  if (!quote || !outcomeId || !checkType || decision.decision !== "BUY_CHECK") {
    const state = decision.decision === "REFUSE" ? "REFUSED" : decision.decision === "ESCALATE" ? "ESCALATED" : "CANDIDATE";
    let row: ReturnType<typeof toDto> | null = null;
    // Never clobber in-flight or ambiguous truth on re-evaluation.
    const SAFE_TO_UPDATE = new Set(["CANDIDATE", "QUOTED", "FAILED"]);
    if (existing) {
      if (!SAFE_TO_UPDATE.has(existing.state)) {
        return { procurement: toDto(existing), decision, execution: execBase };
      }
      const updated = await store.updateProcurement(existing.id, { state, decision: decision.decision, decidedAt: now }).catch(() => null);
      if (updated) row = toDto(updated);
    } else if (quote && outcomeId && checkType && (state === "REFUSED" || state === "ESCALATED")) {
      const created = await store.insertProcurement({
        id: `vp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
        workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId,
        providerId: quote.providerId, checkType: quote.checkType,
        economicExposureMicroUsdc: exposure, quotedCostMicroUsdc: quote.costMicroUsdc,
        asset: quote.asset, network: quote.network, payTo: quote.payTo, resourceUrl: quote.resourceUrl,
        quoteVersion: quote.quoteVersion, quoteExpiresAt: quote.expiresAt,
        decision: decision.decision, state, dedupeKey: dedupeKey as string,
      }).catch(() => null);
      if (created) {
        row = toDto(created);
        await auditEvent(deps.audit, decision.decision === "REFUSE" ? "verification.procurement.refused" : "verification.procurement.escalated", {
          workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId, providerId: quote.providerId,
          metadata: { decision: decision.decision, reasons: decision.reasons },
        });
      }
    }
    return { procurement: row, decision, execution: execBase };
  }

  // BUY path: persist APPROVED, re-check period spend atomically, then purchase.
  const created = existing ?? await store.insertProcurement({
    id: `vp_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId,
    providerId: quote.providerId, checkType: quote.checkType,
    economicExposureMicroUsdc: exposure, quotedCostMicroUsdc: quote.costMicroUsdc,
    asset: quote.asset, network: quote.network, payTo: quote.payTo, resourceUrl: quote.resourceUrl,
    quoteVersion: quote.quoteVersion, quoteExpiresAt: quote.expiresAt,
    decision: "BUY_CHECK", state: "APPROVED", dedupeKey: dedupeKey as string,
  }).catch(() => null);
  const record = created ?? (dedupeKey ? await store.getProcurementByDedupe(dedupeKey).catch(() => null) : null);
  if (!record) throw Object.assign(new Error("Could not persist procurement."), { status: 500, code: "INTERNAL" });
  await auditEvent(deps.audit, "verification.procurement.approved", {
    workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId, providerId: quote.providerId,
    metadata: {
      costMicroUsdc: quote.costMicroUsdc.toString(), exposureMicroUsdc: exposure.toString(),
      idempotencyKey: stableIdempotencyKey(dedupeKey as string),
    },
  });

  // Atomic pre-sign re-check: period cap + state gate inside the transaction (no network inside).
  try {
    await store.atomic(deps.audit, async ({ store: s }) => {
      const ms = s as MarketStore;
      const current = await ms.getProcurement(record.id).catch(() => null);
      if (!current || (current.state !== "APPROVED" && current.state !== "CANDIDATE" && current.state !== "QUOTED")) {
        throw Object.assign(new Error("Procurement no longer approved."), { status: 409, code: "NOT_APPROVABLE" });
      }
      const { spentMicroUsdc } = await verificationSpendForWorkspace(ms, params.workspaceId, now.getTime());
      if (spentMicroUsdc + quote.costMicroUsdc > policy.maxVerificationSpendPerPeriodMicroUsdc) {
        throw Object.assign(new Error("Period cap would be exceeded."), { status: 409, code: "PERIOD_CAP" });
      }
      await ms.updateProcurement(record.id, { state: "APPROVED", decision: "BUY_CHECK", decidedAt: now });
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const updated = await store.updateProcurement(record.id, { state: "ESCALATED", decision: "ESCALATE", decidedAt: now }).catch(() => null);
    await auditEvent(deps.audit, "verification.procurement.escalated", {
      workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId, providerId: quote.providerId,
      metadata: { reason: code === "PERIOD_CAP" ? "Period cap race — escalated without spend." : (e as Error).message },
    });
    return { procurement: updated ? toDto(updated) : null, decision: { ...decision, decision: "ESCALATE" }, execution: execBase };
  }

  // Sign + purchase (outside any transaction). Ambiguous errors never repay.
  // Remote testnet path: the ONLY spendable network/asset is Arc Testnet +
  // canonical testnet USDC — enforced here again at the signing gate, and
  // the signer is ALWAYS the Circle buyer, never a raw private key.
  const approved: ApprovedPayment = {
    providerId: quote.providerId, resourceUrl: quote.resourceUrl, checkType: quote.checkType,
    campaignId: params.campaignId, outcomeId, amountMicroUsdc: quote.costMicroUsdc,
    asset: quote.asset, network: quote.network, payTo: quote.payTo,
    quoteVersion: quote.quoteVersion, expiresAtMs: quote.expiresAt.getTime(),
  };
  let signer: ProcurementSigner;
  let timeoutCapSec: number | undefined;
  if (kind === "remote-x402") {
    if (!remoteConfig) {
      throw Object.assign(new Error("Remote verification is not configured."), { status: 503, code: "NOT_CONFIGURED" });
    }
    assertTestnetTerms({ network: approved.network, asset: approved.asset });
    if (approved.amountMicroUsdc > remoteConfig.maxPerCheckMicroUsdc) {
      throw Object.assign(new Error("Approved amount exceeds the remote per-check ceiling."), { status: 409, code: "OVER_PER_CHECK_LIMIT" });
    }
    timeoutCapSec = remoteConfig.timeoutCapSec;
    if (deps.circleBuyer) {
      signer = deps.circleBuyer;
    } else {
      const { createCircleVerificationBuyer } = await import("../chain/circle");
      const buyer = await createCircleVerificationBuyer(env);
      signer = { address: buyer.address, sign: buyer.sign, signTypedData: buyer.signTypedData };
    }
  } else {
    signer = getProcurementSigner(env);
  }
  const allowedHosts = [...(deps.allowedHosts ?? []), ...allowedHostsFor(env, quote.resourceUrl)];
  // Fetch resolution: explicit test seam wins; local-test wires its guarded
  // in-process resource (throws in production); everything else uses global fetch.
  let fetchImpl = deps.fetchImpl;
  if (!fetchImpl && quote.providerId === "local-test") {
    try {
      const { createLocalTestResource } = await import("./verification.test-resource");
      fetchImpl = createLocalTestResource({ env }).handler;
    } catch (e) {
      const updated = await store.updateProcurement(record.id, { state: "FAILED" }).catch(() => null);
      await auditEvent(deps.audit, "verification.procurement.escalated", {
        workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId, providerId: quote.providerId,
        metadata: { error: (e as Error).message, code: (e as { code?: string }).code ?? null },
      });
      return { procurement: updated ? toDto(updated) : null, decision, execution: { ...execBase } };
    }
  }
  let purchase: Awaited<ReturnType<typeof purchaseWithX402>> | null = null;
  try {
    purchase = await purchaseWithX402({
      url: quote.resourceUrl, approved,
      signer: { address: signer.address, sign: signer.sign, signTypedData: signer.signTypedData },
      allowedHosts, fetchImpl, nowMs: now.getTime(), timeoutCapSec,
    });
  } catch (e) {
    const ambiguous = (e as { ambiguousAfterSign?: boolean }).ambiguousAfterSign === true;
    const updated = await store.updateProcurement(record.id, {
      state: ambiguous ? "AMBIGUOUS" : "FAILED", paymentReference: null,
    }).catch(() => null);
    await auditEvent(deps.audit, ambiguous ? "verification.procurement.ambiguous" : "verification.procurement.escalated", {
      workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId, providerId: quote.providerId,
      metadata: { error: (e as Error).message, code: (e as { code?: string }).code ?? null },
    });
    return {
      procurement: updated ? toDto(updated) : null, decision,
      execution: { ...execBase, signed: true, ambiguous },
    };
  }
  const paymentRef = paymentReferenceFrom(purchase.paymentResponse, kind === "remote-x402" ? null : "local-purchase");
  const purchased = await store.updateProcurement(record.id, {
    state: "PURCHASED", paymentReference: paymentRef, purchasedAt: now,
  }).catch(() => null);
  await auditEvent(deps.audit, "verification.procurement.purchased", {
    workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId, providerId: quote.providerId,
    metadata: { paymentReference: paymentRef, costMicroUsdc: quote.costMicroUsdc.toString() },
  });

  // Provider output is evidence only: normalize, never mutate outcomes/payouts.
  const { normalizeProviderVerdict } = await import("./verification");
  const data = (purchase.data ?? {}) as { verdict?: string; confidence?: string; reasonCodes?: string[]; evidenceRefs?: string[] };
  const normalized = normalizeProviderVerdict({
    providerId: quote.providerId, verdict: String(data.verdict ?? "inconclusive"),
    confidence: data.confidence, reasonCodes: data.reasonCodes, evidenceRefs: data.evidenceRefs, rawResponse: purchase.data,
  });
  const completed = await store.updateProcurement(record.id, {
    state: "RESULT_RECEIVED", responseHash: normalized.rawResponseHash,
    normalizedResult: normalized.result, reasonCodesJson: normalized.reasonCodes, completedAt: now,
  }).catch(() => null);
  await auditEvent(deps.audit, "verification.procurement.result_received", {
    workspaceId: params.workspaceId, campaignId: params.campaignId, outcomeId, providerId: quote.providerId,
    metadata: {
      result: normalized.result, confidence: normalized.confidence,
      reasonCodes: normalized.reasonCodes, paymentReference: paymentRef,
    },
  });
  return {
    procurement: completed ? toDto(completed) : purchased ? toDto(purchased) : null,
    decision,
    execution: { ...execBase, signed: true, purchased: true, result: normalized, paymentReference: paymentRef },
  };
}

function paymentReferenceFrom(resp: Record<string, unknown> | null, fallback: string | null = "local-purchase"): string | null {
  const ref = resp?.paymentReference ?? resp?.reference ?? resp?.txHash ?? resp?.receiptId ?? resp?.settlementTx ?? resp?.id;
  return typeof ref === "string" && ref.length > 0 ? ref.slice(0, 128) : fallback;
}

function allowedHostsFor(env: NodeJS.ProcessEnv, resourceUrl: string): string[] {
  try {
    const u = new URL(resourceUrl);
    const extra = (env.THESMA_VERIFICATION_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return [u.hostname.toLowerCase(), ...extra];
  } catch {
    return (env.THESMA_VERIFICATION_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }
}

/** Read-only campaign procurement ledger. Never spends. */
export async function listCampaignProcurements(
  store: MarketStore,
  params: { workspaceId: string; campaignId: string },
): Promise<Record<string, unknown>[]> {
  const campaign = await store.getCampaign(params.campaignId).catch(() => null);
  if (!campaign || campaign.workspaceId !== params.workspaceId) return [];
  const rows = await store.listProcurementsByCampaign(params.campaignId).catch(() => []);
  return rows.map((r) => toDto(r as Parameters<typeof toDto>[0]));
}
