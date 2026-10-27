import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AuditSink, MarketStore } from "./campaignStore";
import { loadCampaignQuality } from "./reliability";

/**
 * Verification procurement agent (Slice 8).
 *
 * Answers: this obligation exposes X; confidence is weak / signals exist;
 * an external check costs Y — is the check worth buying, inside authority,
 * and what do we do with its result?
 *
 * Hard boundaries:
 * - The external result is EVIDENCE. It can never directly mutate
 *   VERIFIED / REJECTED / PAID / SETTLED, never auto-accuses a creator.
 * - No blind signing: the agent signs ONLY the exact approved requirement
 *   (provider, resource, amount, asset, network, payTo, expiry).
 * - Provider endpoints come from server-side allowlisted configuration.
 *   Creators, customers, org free text and provider responses can never
 *   supply a URL the server will fetch or pay.
 * - Ambiguous post-sign failures NEVER blind-repay (AMBIGUOUS + escalate).
 * - No real external call, no wallet funding in this slice.
 *
 * Protocol (x402 v2 HTTP, per product spec; no x402 npm dep installed):
 *   request → 402 + PAYMENT-REQUIRED → validate → sign →
 *   retry + PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE.
 * CAIP-2 network ids; Arc mainnet is eip155:5042. Provider payload shapes
 * beyond these headers are adapter-isolated and must be confirmed against
 * the current official x402 spec before any mainnet use.
 */

export const X402_VERSION = 2;
export const ARC_MAINNET_CAIP2 = "eip155:5042";
export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_RESPONSE_HEADER = "payment-response";

export type CheckType =
  | "TRANSACTION_RISK"
  | "ATTRIBUTION_INTEGRITY"
  | "SUBJECT_DUPLICATION"
  | "PAYMENT_REFERENCE_CHECK"
  | "OUTCOME_ENRICHMENT";

export type NormalizedVerification = "CHECK_CLEAR" | "RISK_SIGNAL" | "INCONCLUSIVE";

export type ProcurementDecisionKind = "NO_CHECK" | "BUY_CHECK" | "WAIT" | "ESCALATE" | "REFUSE";
export type ProcurementState =
  | "CANDIDATE"
  | "QUOTED"
  | "REFUSED"
  | "ESCALATED"
  | "APPROVED"
  | "PAYMENT_AUTHORIZED"
  | "PURCHASED"
  | "RESULT_RECEIVED"
  | "AMBIGUOUS"
  | "FAILED";

export interface VerificationQuote {
  providerId: string;
  checkType: CheckType;
  costMicroUsdc: bigint;
  asset: string;
  network: string;
  payTo: string;
  resourceUrl: string;
  expiresAt: Date;
  quoteVersion: string;
}

export interface NormalizedResult {
  result: NormalizedVerification;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reasonCodes: string[];
  evidenceRefs: string[];
  providerId: string;
  rawResponseHash: string;
}

export interface VerificationProvider {
  id: string;
  displayName: string;
  supportedCheckTypes: CheckType[];
  supportedNetworks: string[];
  transport: "x402-v2";
  quote(params: { checkType: CheckType; campaignId: string; outcomeId: string }): Promise<VerificationQuote>;
  check(params: { quote: VerificationQuote; fetchImpl?: FetchImpl }): Promise<NormalizedResult>;
}

export interface ProcurementPolicy {
  verificationProcurementEnabled: boolean;
  maxCostPerCheckMicroUsdc: bigint;
  maxVerificationSpendPerPeriodMicroUsdc: bigint;
  periodDays: number;
  maxCostBpsOfExposure: number;
  allowedProviders: string[];
  allowedCheckTypes: CheckType[];
  humanApprovalThresholdMicroUsdc: bigint | null;
}

export const DEFAULT_PROCUREMENT_POLICY: ProcurementPolicy = {
  verificationProcurementEnabled: false,
  maxCostPerCheckMicroUsdc: 2_000_000n,
  maxVerificationSpendPerPeriodMicroUsdc: 10_000_000n,
  periodDays: 30,
  maxCostBpsOfExposure: 200,
  allowedProviders: [],
  allowedCheckTypes: [],
  humanApprovalThresholdMicroUsdc: null,
};

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface X402Accepted {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface X402PaymentRequired {
  x402Version: number;
  resource: { url: string };
  accepted: X402Accepted[];
}

export interface ApprovedPayment {
  providerId: string;
  resourceUrl: string;
  checkType: CheckType;
  campaignId: string;
  outcomeId: string;
  amountMicroUsdc: bigint;
  asset: string;
  network: string;
  payTo: string;
  quoteVersion: string;
  expiresAtMs: number;
}

export function requestFingerprint(p: {
  providerId: string; resourceUrl: string; checkType: string; campaignId: string; outcomeId: string;
  amountMicroUsdc: bigint; asset: string; network: string; payTo: string; quoteVersion: string;
}): string {
  return [p.providerId, p.resourceUrl, p.checkType, p.campaignId, p.outcomeId,
    p.amountMicroUsdc.toString(), p.asset.toLowerCase(), p.network, p.payTo.toLowerCase(), p.quoteVersion].join("|");
}

/* ---------------- SSRF-safe transport ---------------- */

export function assertAllowedUrl(rawUrl: string, allowedHosts: string[]): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw fail(400, "BAD_URL", "Provider URL is not a valid absolute URL.");
  }
  const host = u.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local && u.protocol !== "https:") {
    throw fail(400, "INSECURE_URL", "Provider endpoints require HTTPS (localhost allowed for tests only).");
  }
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw fail(403, "UNTRUSTED_HOST", "Provider host is not allowlisted.");
  }
  return u;
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

/* ---------------- x402 v2 client (narrow, server-only) ---------------- */

export function parsePaymentRequired(header: string | null): X402PaymentRequired {
  if (!header) fail(402, "NO_PAYMENT_HEADER", "Expected a PAYMENT-REQUIRED header.");
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw fail(400, "MALFORMED_402", "PAYMENT-REQUIRED is not valid base64 JSON.");
  }
  const v = (body ?? {}) as { x402Version?: unknown; resource?: unknown; accepted?: unknown };
  if (v.x402Version !== X402_VERSION) {
    throw fail(400, "WRONG_X402_VERSION", `Unsupported x402 version (want ${X402_VERSION}; v1 X-PAYMENT semantics are never accepted).`);
  }
  const resource = v.resource as { url?: unknown } | undefined;
  const accepted = v.accepted as X402Accepted[] | undefined;
  if (!resource || typeof resource.url !== "string" || !Array.isArray(accepted) || accepted.length === 0) {
    throw fail(400, "MALFORMED_402", "PAYMENT-REQUIRED is missing resource or accepted terms.");
  }
  return { x402Version: v.x402Version, resource: { url: resource.url }, accepted };
}

/** Fail closed on anything unexpected. Amounts must fit the approved quote exactly. */
export function selectAcceptedTerms(req: X402PaymentRequired, approved: ApprovedPayment, nowMs: number = Date.now()): X402Accepted {
  if (req.resource.url !== approved.resourceUrl) {
    throw fail(400, "RESOURCE_MISMATCH", "Payment requirement targets an unexpected resource.");
  }
  if (approved.expiresAtMs <= nowMs) fail(409, "QUOTE_EXPIRED", "Approved quote expired — re-evaluate.");
  const match = req.accepted.find((a) => a.network === approved.network && a.asset.toLowerCase() === approved.asset.toLowerCase());
  if (!match) throw fail(400, "ASSET_OR_NETWORK_MISMATCH", "No accepted term matches the approved asset/network.");
  if (match.scheme !== "exact") throw fail(400, "UNSUPPORTED_SCHEME", `Only the exact scheme is supported (got ${match.scheme}).`);
  let amount: bigint;
  try {
    amount = BigInt(match.amount);
  } catch {
    throw fail(400, "BAD_AMOUNT", "Accepted amount is not an integer.");
  }
  if (amount <= 0n || amount !== approved.amountMicroUsdc) {
    throw fail(400, "AMOUNT_MISMATCH", "Accepted amount differs from the approved quote — refusing to sign.");
  }
  if (!isAddress(match.payTo) || getAddress(match.payTo) !== getAddress(approved.payTo)) {
    throw fail(400, "PAYEE_MISMATCH", "payTo differs from the approved provider payee.");
  }
  if (!Number.isFinite(match.maxTimeoutSeconds) || match.maxTimeoutSeconds <= 0 || match.maxTimeoutSeconds > 3600) {
    throw fail(400, "BAD_TIMEOUT", "Insane payment timeout — refusing.");
  }
  return match;
}

export function authorizationEnvelope(signerAddress: string, signature: Hex, terms: X402Accepted): string {
  return Buffer.from(JSON.stringify({ x402Version: X402_VERSION, signer: signerAddress, signature, terms }), "utf8").toString("base64");
}

export function parsePaymentResponse(header: string | null): Record<string, unknown> | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * One guarded x402 purchase. fetchImpl is injectable for tests; production
 * uses global fetch. Redirects are manual and re-validated. Throws on any
 * validation failure BEFORE signing whenever possible.
 */
export async function purchaseWithX402(params: {
  url: string;
  approved: ApprovedPayment;
  signer: { address: string; sign: (message: string) => Promise<Hex> };
  allowedHosts: string[];
  fetchImpl?: FetchImpl;
  body?: unknown;
  /** Evaluation clock (defaults to wall time). Threaded so frozen-time tests are honest. */
  nowMs?: number;
}): Promise<{ data: unknown; paymentResponse: Record<string, unknown> | null; signed: boolean }> {
  // SSRF guard first: nothing is fetched, let alone paid, off-allowlist.
  assertAllowedUrl(params.url, params.allowedHosts);
  const nowMs = params.nowMs ?? Date.now();
  const fetchImpl = params.fetchImpl ?? fetch;
  const first = await fetchImpl(params.url, {
    method: params.body !== undefined ? "POST" : "GET",
    headers: params.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    redirect: "manual",
  }).catch((e) => {
    throw fail(503, "PROVIDER_UNREACHABLE", `Provider request failed: ${(e as Error).message}`);
  });
  if (first.status >= 300 && first.status < 400) {
    throw fail(400, "UNTRUSTED_REDIRECT", "Provider redirects are not followed (SSRF guard).");
  }
  if (first.status !== 402) {
    if (!first.ok) throw fail(502, "PROVIDER_ERROR", `Provider returned ${first.status} without a payment requirement.`);
    return { data: await first.json().catch(() => null), paymentResponse: null, signed: false };
  }
  const required = parsePaymentRequired(first.headers.get(PAYMENT_REQUIRED_HEADER));
  const terms = selectAcceptedTerms(required, params.approved, nowMs);
  const canonical = JSON.stringify({
    x402Version: X402_VERSION, resource: params.url, scheme: terms.scheme, network: terms.network,
    asset: terms.asset, amount: terms.amount, payTo: terms.payTo,
  });
  const signature = await params.signer.sign(canonical).catch((e) => {
    throw fail(500, "SIGNING_FAILED", `Procurement signer failed: ${(e as Error).message}`);
  });
  const second = await fetchImpl(params.url, {
    method: params.body !== undefined ? "POST" : "GET",
    headers: {
      ...(params.body !== undefined ? { "content-type": "application/json" } : {}),
      [PAYMENT_SIGNATURE_HEADER]: authorizationEnvelope(params.signer.address, signature, terms),
    },
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    redirect: "manual",
  }).catch((e) => {
    // Signed but outcome unknown: the caller MUST mark AMBIGUOUS, never repay blindly.
    // (fail() throws, so the flag must ride on the thrown object itself.)
    throw Object.assign(new Error(`Retry failed after signing: ${(e as Error).message}`), {
      status: 503,
      code: "PAYMENT_AMBIGUOUS",
      ambiguousAfterSign: true as const,
    });
  });
  if (second.status >= 300 && second.status < 400) {
    throw fail(400, "UNTRUSTED_REDIRECT", "Provider redirects are not followed (SSRF guard).");
  }
  if (!second.ok) {
    const ambiguous = second.status === 429 || second.status >= 500;
    throw Object.assign(new Error(`Provider rejected the payment retry (${second.status}).`), {
      status: 502,
      code: "PURCHASE_FAILED",
      ambiguousAfterSign: ambiguous,
    });
  }
  return {
    data: await second.json().catch(() => null),
    paymentResponse: parsePaymentResponse(second.headers.get(PAYMENT_RESPONSE_HEADER)),
    signed: true,
  };
}

/* ---------------- Dedicated procurement signer ---------------- */

export interface ProcurementSigner {
  address: string;
  sign: (message: string) => Promise<Hex>;
}

export function getProcurementSigner(env: NodeJS.ProcessEnv = process.env): ProcurementSigner {
  const key = (env.THESMA_PROCUREMENT_PRIVATE_KEY ?? "").trim();
  if (!key) throw fail(503, "PROCUREMENT_NOT_CONFIGURED", "THESMA_PROCUREMENT_PRIVATE_KEY is not configured.");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  } catch {
    throw fail(503, "PROCUREMENT_NOT_CONFIGURED", "Procurement key is not a valid private key.");
  }
  const expected = (env.THESMA_PROCUREMENT_ADDRESS ?? "").trim();
  if (expected && getAddress(expected) !== account.address) {
    throw fail(503, "PROCUREMENT_MISCONFIGURED", "Procurement key does not derive to THESMA_PROCUREMENT_ADDRESS.");
  }
  return {
    address: account.address,
    sign: async (message: string) => account.signMessage({ message }),
  };
}

/* ---------------- Procurement decision engine (pure) ---------------- */

export interface ProcurementDecisionInput {
  readiness: "NONE" | "REVIEW" | "EXTERNAL_CHECK_CANDIDATE";
  reviewSeverity: "NONE" | "INFO" | "REVIEW";
  economicExposureMicroUsdc: bigint;
  quote: { costMicroUsdc: bigint; expiresAtMs: number; providerId: string; checkType: CheckType } | null;
  quoteError: string | null;
  policy: ProcurementPolicy;
  providerAllowlisted: boolean;
  checkTypeSupported: boolean;
  periodSpentMicroUsdc: bigint;
  availableMicroUsdc: bigint;
  reserveMicroUsdc: bigint;
  campaignLive: boolean;
  outcomeRelevant: boolean;
  existingProcurementState: ProcurementState | null;
  signerConfigured: boolean;
  nowMs: number;
}

export interface ProcurementDecision {
  decision: ProcurementDecisionKind;
  costMicroUsdc: string;
  economicExposureMicroUsdc: string;
  costExposureBps: number | null;
  policyBounds: { maxCostPerCheckMicroUsdc: string; maxCostBpsOfExposure: number; periodRemainingMicroUsdc: string };
  liquidityContext: { availableMicroUsdc: string; reserveMicroUsdc: string };
  reasons: string[];
  warnings: string[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export function decideVerificationProcurement(input: ProcurementDecisionInput): ProcurementDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const base = {
    costMicroUsdc: (input.quote?.costMicroUsdc ?? 0n).toString(),
    economicExposureMicroUsdc: input.economicExposureMicroUsdc.toString(),
    costExposureBps: null as number | null,
    policyBounds: {
      maxCostPerCheckMicroUsdc: input.policy.maxCostPerCheckMicroUsdc.toString(),
      maxCostBpsOfExposure: input.policy.maxCostBpsOfExposure,
      periodRemainingMicroUsdc: (() => {
        const r = input.policy.maxVerificationSpendPerPeriodMicroUsdc - input.periodSpentMicroUsdc;
        return (r > 0n ? r : 0n).toString();
      })(),
    },
    liquidityContext: { availableMicroUsdc: input.availableMicroUsdc.toString(), reserveMicroUsdc: input.reserveMicroUsdc.toString() },
  };
  const refuse = (rule: string, reason: string): ProcurementDecision =>
    ({ ...base, decision: "REFUSE", reasons: [rule, reason], warnings, confidence: "HIGH" });
  const escalate = (rule: string, reason: string): ProcurementDecision =>
    ({ ...base, decision: "ESCALATE", reasons: [rule, reason], warnings, confidence: "MEDIUM" });

  if (input.existingProcurementState === "RESULT_RECEIVED" || input.existingProcurementState === "PURCHASED") {
    return { ...base, decision: "NO_CHECK", reasons: ["DUPLICATE", "This exact check already completed — never pay twice."], warnings, confidence: "HIGH" };
  }
  if (input.existingProcurementState === "AMBIGUOUS") {
    return escalate("AMBIGUOUS_PAYMENT", "A prior authorization has unknown settlement — reconcile before any new spend.");
  }
  if (input.existingProcurementState === "PAYMENT_AUTHORIZED" || input.existingProcurementState === "APPROVED") {
    return { ...base, decision: "WAIT", reasons: ["IN_FLIGHT", "A procurement for this check is already in flight."], warnings, confidence: "HIGH" };
  }
  if (input.readiness === "NONE") {
    return { ...base, decision: "NO_CHECK", reasons: ["NO_SIGNAL", "Quality state needs no external check."], warnings, confidence: "HIGH" };
  }
  if (input.readiness === "REVIEW") {
    return { ...base, decision: "NO_CHECK", reasons: ["HUMAN_REVIEW", "Review-grade state without an external-check candidate — no paid check."], warnings, confidence: "HIGH" };
  }
  if (!input.policy.verificationProcurementEnabled) return refuse("POLICY_DISABLED", "Verification procurement is disabled by policy.");
  if (!input.campaignLive) return refuse("CAMPAIGN_CLOSED", "Campaign is no longer live.");
  if (!input.outcomeRelevant) return refuse("OUTCOME_IRRELEVANT", "Outcome state no longer warrants a check.");
  if (!input.providerAllowlisted) return refuse("PROVIDER_NOT_ALLOWLISTED", "Provider is not allowlisted.");
  if (!input.checkTypeSupported) return refuse("CHECK_TYPE_UNSUPPORTED", "Provider does not support this check type.");
  if (!input.quote || input.quoteError) {
    return escalate("QUOTE_UNAVAILABLE", input.quoteError ?? "No valid quote could be obtained.");
  }
  if (input.quote.expiresAtMs <= input.nowMs) return escalate("QUOTE_EXPIRED", "Quote expired before decision — re-quote.");
  const cost = input.quote.costMicroUsdc;
  if (cost <= 0n) return refuse("BAD_QUOTE", "Quote cost is not positive.");
  if (cost > input.policy.maxCostPerCheckMicroUsdc) {
    return escalate("OVER_PER_CHECK_LIMIT", `Check costs ${cost} vs ${input.policy.maxCostPerCheckMicroUsdc} autonomous per-check limit.`);
  }
  if (input.economicExposureMicroUsdc <= 0n) return refuse("NO_EXPOSURE", "No economic exposure to protect.");
  const bps = Number((cost * 10_000n) / input.economicExposureMicroUsdc);
  if (bps > input.policy.maxCostBpsOfExposure) {
    return refuse("OVER_BPS_LIMIT", `Check is ${bps} bps of exposure vs ${input.policy.maxCostBpsOfExposure} bps policy maximum.`);
  }
  if (input.periodSpentMicroUsdc + cost > input.policy.maxVerificationSpendPerPeriodMicroUsdc) {
    return escalate("PERIOD_CAP", "Period verification budget would be exceeded.");
  }
  if (input.availableMicroUsdc - cost < input.reserveMicroUsdc) {
    return escalate("LIQUIDITY", "Liquidity would fall below reserve after the check.");
  }
  if (!input.signerConfigured) return escalate("SIGNER_NOT_CONFIGURED", "Procurement signer is not configured.");
  if (input.reviewSeverity === "REVIEW" && input.policy.humanApprovalThresholdMicroUsdc !== null && cost > input.policy.humanApprovalThresholdMicroUsdc) {
    return escalate("HUMAN_APPROVAL", "Review-grade exposure above the human-approval threshold.");
  }
  return {
    ...base,
    costExposureBps: bps,
    decision: "BUY_CHECK",
    reasons: [
      "WITHIN_AUTHORITY",
      `Check is ${bps} bps of ${input.economicExposureMicroUsdc} exposure (limit ${input.policy.maxCostBpsOfExposure}).`,
      "Liquidity stays above reserve; period budget has room.",
    ],
    warnings,
    confidence: "HIGH",
  };
}

/* ---------------- Provider registry ---------------- */

const CHECK_FOR_SIGNAL: Record<string, CheckType> = {
  DUPLICATE_PAYMENT_REFERENCE: "PAYMENT_REFERENCE_CHECK",
  ATTRIBUTION_CONFLICT: "ATTRIBUTION_INTEGRITY",
  UNUSUAL_BURST: "SUBJECT_DUPLICATION",
  REPEATED_SHARED_ORIGIN: "OUTCOME_ENRICHMENT",
};

export function checkTypeForSignals(signals: { type: string; severity: string }[]): CheckType | null {
  const review = signals.filter((s) => s.severity === "REVIEW");
  if (review.length === 0) return null;
  const counts = new Map<CheckType, number>();
  for (const s of review) {
    const t = CHECK_FOR_SIGNAL[s.type];
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: CheckType | null = null;
  let bestN = 0;
  for (const [t, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}

export function normalizeProviderVerdict(params: {
  providerId: string;
  verdict: string;
  confidence?: string;
  reasonCodes?: string[];
  evidenceRefs?: string[];
  rawResponse: unknown;
}): NormalizedResult {
  const v = params.verdict.trim().toLowerCase();
  const result: NormalizedVerification = v === "clear" || v === "check_clear" || v === "low_risk"
    ? "CHECK_CLEAR"
    : v === "risk" || v === "risk_signal" || v === "high_risk" || v === "suspicious"
      ? "RISK_SIGNAL"
      : "INCONCLUSIVE";
  const c = (params.confidence ?? "medium").toLowerCase();
  const hash = simpleHash(JSON.stringify(params.rawResponse ?? null));
  return {
    result,
    confidence: c === "high" ? "HIGH" : c === "low" ? "LOW" : "MEDIUM",
    reasonCodes: (params.reasonCodes ?? []).slice(0, 12).map(String),
    evidenceRefs: (params.evidenceRefs ?? []).slice(0, 12).map(String),
    providerId: params.providerId,
    rawResponseHash: hash,
  };
}

function simpleHash(s: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0");
}

/** Test/placeholder provider kinds. Real paid providers register adapters here. */
export type ProviderKind = "local-test" | "unconfigured";

export function providerKindForId(providerId: string, env: NodeJS.ProcessEnv = process.env): ProviderKind {
  if (providerId === "local-test") return "local-test";
  const url = (env.THESMA_VERIFICATION_PROVIDER_URL ?? "").trim();
  if (!url) return "unconfigured";
  return "unconfigured";
}
