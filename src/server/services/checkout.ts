import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import {
  assertChainMatches,
  buildUsdcTransfer,
  isTxHash,
  normalizeAddress,
  type ArcConfig,
  type VerifierChainReader,
} from "../chain/arc";
import { customerKeyFor, outcomeProofFor, serializeCheckoutIntent, serializeOutcome } from "../domain/checkout";
import { newId } from "../auth/session";
import type { AuditSink, MarketStore, StoredCheckoutIntent, StoredOutcome } from "./campaignStore";
import { isUniqueViolation } from "./campaignStore";
import { evaluateTargetSettled } from "./markets";

export interface CheckoutDeps {
  store: MarketStore;
  audit: AuditSink;
  config: ArcConfig | null;
  reader: VerifierChainReader | null;
  now?: () => Date;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

function orderId(): string {
  return `ord_${randomBytes(12).toString("hex")}`;
}

export interface SessionDeps {
  store: MarketStore;
  audit: AuditSink;
}

function handle(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Mint a portable opaque attribution handle for a resolved referral.
 * The handle carries nothing: all relationships stay server-side.
 */
export async function mintAttributionSession(
  deps: SessionDeps,
  params: { referralId: string; campaignId: string; partnerId: string; partnerTermsId: string; expiresAt: Date },
) {
  const session = await deps.store.insertAttributionSession({
    id: handle(),
    ...params,
  });
  return { handle: session.id, expiresAt: session.expiresAt.toISOString() };
}

export interface UnsignedPayment {
  chainId: number;
  token: Address;
  to: Address;
  data: Hex;
  value: "0";
  expectedPayer: Address;
  merchant: Address;
  amountMicroUsdc: string;
  checkoutIntentId: string;
  orderId: string;
  expiry: string;
}

/**
 * Customer-facing, account-free checkout intent. Returns an UNSIGNED
 * USDC transfer (customer -> company wallet). The backend never signs.
 */
export async function createCheckoutIntent(
  deps: CheckoutDeps,
  params: { attributionHandle: string; payerAddress: string; amountMicroUsdc: string },
): Promise<{ intent: ReturnType<typeof serializeCheckoutIntent>; payment: UnsignedPayment }> {
  const now = deps.now?.() ?? new Date();
  const payer = normalizeAddress(params.payerAddress);
  const amount = BigInt(params.amountMicroUsdc);
  if (amount <= 0n) fail(400, "BAD_REQUEST", "Amount must be positive");

  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const session = await ms.getAttributionSession(params.attributionHandle);
    if (!session) fail(404, "ATTRIBUTION_INVALID", "Unknown attribution handle");
    if (session.usedAt) fail(410, "ATTRIBUTION_USED", "Attribution handle was already consumed");
    if (session.expiresAt <= now) fail(410, "ATTRIBUTION_EXPIRED", "Attribution handle expired");
    const consumed = await ms.consumeAttributionSession(params.attributionHandle);
    if (!consumed) fail(409, "ATTRIBUTION_RACE", "Attribution handle was consumed concurrently");

    const campaign = await ms.getCampaign(session.campaignId);
    if (!campaign || campaign.state !== "LIVE") fail(400, "CAMPAIGN_NOT_LIVE", "Campaign is not live");
    const openMarket = await ms.getMarket(session.campaignId);
    if (openMarket) {
      const settled = await evaluateTargetSettled(ms, session.campaignId, openMarket.policyVersion);
      if (settled.complete) fail(403, "TARGET_REACHED", "Market objective is complete and settled; no new purchases");
    }
    const terms = await ms.getTerms(session.campaignId, session.partnerId);
    if (!terms || terms.id !== session.partnerTermsId || terms.status !== "ACTIVE") {
      fail(400, "TERMS_INVALID", "Partner terms are no longer applicable");
    }
    const version = await store.getVersion(session.campaignId, terms.policyVersion);
    if (!version || !version.deadline) fail(500, "INTERNAL", "Policy version is missing");
    if (version.deadline <= now) fail(400, "EXPIRED", "Campaign deadline has passed");
    if (terms.expiresAt <= now) fail(400, "TERMS_EXPIRED", "Partner terms have expired");
    // Policy version must still be the funded one.
    const funding = await ms.getFunding(session.campaignId, terms.policyVersion);
    if (!funding || funding.status !== "CONFIRMED") fail(400, "NOT_FUNDED", "Policy version is not funded");
    const current = await store.getCurrentVersion(session.campaignId);
    if (!current || current.id !== version.id) fail(400, "POLICY_SUPERSEDED", "Policy version is no longer current");

    const workspace = await ms.getWorkspace(campaign.workspaceId);
    const merchant = workspace?.companyWallet;
    if (!merchant) fail(500, "INTERNAL", "Company wallet is not configured");
    if (payer.toLowerCase() === merchant.toLowerCase()) fail(403, "SELF_PURCHASE", "Payer cannot be the company wallet");
    const minPurchase = version.minQualifyingPurchaseMicroUsdc;
    if (minPurchase !== null && amount < minPurchase) {
      fail(400, "BELOW_MINIMUM", "Amount is below the campaign minimum qualifying purchase");
    }
    if (!deps.config) fail(503, "ARC_UNCONFIGURED", "Arc chain configuration is absent");

    // Self-referral: the payer must not be the Partner payout wallet.
    const partnerProfile = await ms.getPartnerById(session.partnerId);
    if (partnerProfile?.payoutWallet && payer.toLowerCase() === partnerProfile.payoutWallet.toLowerCase()) {
      fail(403, "SELF_REFERRAL", "Payer cannot be the Partner payout wallet");
    }

    const expiresAt = new Date(Math.min(version.deadline.getTime(), terms.expiresAt.getTime(), now.getTime() + 30 * 60 * 1000));
    let intent: StoredCheckoutIntent | null = null;
    for (let attempt = 0; attempt < 3 && !intent; attempt += 1) {
      try {
        intent = await ms.insertCheckoutIntent({
          id: newId(),
          orderId: orderId(),
          campaignId: session.campaignId,
          policyVersionId: version.id,
          partnerId: session.partnerId,
          partnerTermsId: session.partnerTermsId,
          attributionSessionId: session.id,
          payerAddress: payer,
          merchantAddress: normalizeAddress(merchant),
          amountMicroUsdc: amount,
          chainId: deps.config.chainId,
          usdcAddress: deps.config.usdcAddress,
          expiresAt,
        });
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e;
      }
    }
    if (!intent) fail(500, "INTERNAL", "Could not create checkout intent");
    await audit({
      actorType: "SYSTEM",
      actorId: null,
      workspaceId: campaign.workspaceId,
      partnerId: session.partnerId,
      action: "checkout.intent_created",
      targetType: "checkout_intent",
      targetId: (intent as StoredCheckoutIntent).id,
      metadata: {
        checkoutIntentId: (intent as StoredCheckoutIntent).id,
        orderId: (intent as StoredCheckoutIntent).orderId,
        campaignId: session.campaignId,
        partnerId: session.partnerId,
        amountMicroUsdc: amount.toString(),
      },
    });
    const done = intent as StoredCheckoutIntent;
    return {
      intent: serializeCheckoutIntent(done),
      payment: {
        chainId: deps.config.chainId,
        token: deps.config.usdcAddress,
        to: deps.config.usdcAddress,
        data: buildUsdcTransfer({ usdc: deps.config.usdcAddress, to: normalizeAddress(merchant), amountMicroUsdc: amount }),
        value: "0",
        expectedPayer: payer,
        merchant: normalizeAddress(merchant),
        amountMicroUsdc: amount.toString(),
        checkoutIntentId: done.id,
        orderId: done.orderId,
        expiry: done.expiresAt.toISOString(),
      },
    };
  });
}

/**
 * Customer supplies only a tx hash. Persisted as SUBMITTED and bound to a
 * PENDING outcome. A submitted hash is NOT payment success and creates
 * NOTHING verifiable — verification reads Arc independently.
 */
export async function submitCheckoutTx(
  deps: CheckoutDeps,
  params: { intentId: string; txHash: string },
) {
  if (!isTxHash(params.txHash)) fail(400, "BAD_REQUEST", "Malformed transaction hash");
  const now = deps.now?.() ?? new Date();
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const intent = await ms.getCheckoutIntent(params.intentId);
    if (!intent) fail(404, "NOT_FOUND", "Checkout intent not found");
    if (intent.txHash === params.txHash && (intent.status === "SUBMITTED" || intent.status === "CONFIRMED")) {
      const existing = await ms.getOutcomeByIntent(intent.id);
      return { intent: serializeCheckoutIntent(intent), outcome: existing ? serializeOutcome(existing) : null, alreadySubmitted: true as const };
    }
    if (intent.status !== "PREPARED") {
      fail(409, "TX_CONFLICT", "Intent already advanced with a different transaction");
    }
    let updated: StoredCheckoutIntent;
    try {
      updated = await ms.updateCheckoutIntent(intent.id, {
        status: "SUBMITTED",
        txHash: params.txHash,
        submittedAt: now,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const clash = await ms.getOutcomeByTx(params.txHash);
      if (clash && clash.checkoutIntentId !== intent.id) {
        fail(409, "DUPLICATE_TX", "Purchase transaction was already used");
      }
      throw e;
    }
    const customerKeyHash = customerKeyFor(intent.chainId, intent.payerAddress, intent.campaignId);
    let outcome = await ms.getOutcomeByIntent(intent.id);
    if (!outcome) {
      try {
        outcome = await ms.insertOutcome({
          id: newId(),
          campaignId: intent.campaignId,
          partnerId: intent.partnerId,
          partnerTermsId: intent.partnerTermsId,
          checkoutIntentId: intent.id,
          customerKeyHash,
          purchaseTx: params.txHash,
          purchaseAmountMicroUsdc: intent.amountMicroUsdc,
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const clash = await ms.getOutcomeByTx(params.txHash);
        if (!clash || clash.checkoutIntentId === intent.id) {
          outcome = (await ms.getOutcomeByIntent(intent.id))!;
        } else {
          fail(409, "DUPLICATE_TX", "Purchase transaction was already used");
        }
      }
    }
    await audit({
      actorType: "SYSTEM",
      actorId: null,
      workspaceId: (await ms.getCampaign(intent.campaignId))?.workspaceId ?? null,
      partnerId: intent.partnerId,
      action: "checkout.submitted",
      targetType: "checkout_intent",
      targetId: intent.id,
      metadata: { checkoutIntentId: intent.id, orderId: intent.orderId, txHash: params.txHash },
    });
    return { intent: serializeCheckoutIntent(updated), outcome: outcome ? serializeOutcome(outcome) : null, alreadySubmitted: false as const };
  });
}

async function rejectOutcome(
  ms: MarketStore,
  audit: AuditSink,
  intent: StoredCheckoutIntent,
  outcome: StoredOutcome,
  workspaceId: string | null,
  code: string,
  details?: unknown,
) {
  const nextOutcome = await ms.updateOutcome(outcome.id, { status: "REJECTED", rejectionCode: code });
  const nextIntent = await ms.updateCheckoutIntent(intent.id, { status: "REJECTED", failureCode: code });
  const base = { checkoutIntentId: intent.id, orderId: intent.orderId, outcomeId: outcome.id, rejectionCode: code, details };
  await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: intent.partnerId, action: "checkout.rejected", targetType: "checkout_intent", targetId: intent.id, metadata: base });
  await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: intent.partnerId, action: "outcome.rejected", targetType: "outcome", targetId: outcome.id, metadata: base });
  return { intent: serializeCheckoutIntent(nextIntent), outcome: serializeOutcome(nextOutcome), verified: false as const, rejectionCode: code };
}

async function markAmbiguous(
  ms: MarketStore,
  audit: AuditSink,
  intent: StoredCheckoutIntent,
  workspaceId: string | null,
  code: string,
  details?: unknown,
) {
  const next = await ms.updateCheckoutIntent(intent.id, { status: "AMBIGUOUS", failureCode: code });
  await audit({
    actorType: "SYSTEM", actorId: null, workspaceId, partnerId: intent.partnerId,
    action: "checkout.ambiguous", targetType: "checkout_intent", targetId: intent.id,
    metadata: { checkoutIntentId: intent.id, orderId: intent.orderId, failureCode: code, details },
  });
  return { intent: serializeCheckoutIntent(next), outcome: null, verified: false as const, ambiguous: true as const, failureCode: code };
}

/**
 * Deterministic purchase verifier. Reads Arc, trusts nothing from the
 * request. Exactly one VERIFIED outcome per purchase tx / intent / customer.
 * VERIFIED means evidence passed — NOT that the Partner was paid.
 */
export async function verifyCheckoutIntent(deps: CheckoutDeps, params: { intentId: string }) {
  const now = deps.now?.() ?? new Date();
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const intent = await ms.getCheckoutIntent(params.intentId);
    if (!intent) fail(404, "NOT_FOUND", "Checkout intent not found");
    let outcome = await ms.getOutcomeByIntent(intent.id);
    if (intent.status === "PREPARED" || !intent.txHash) {
      fail(400, "NOT_SUBMITTED", "No transaction submitted for this intent yet");
    }
    if (!outcome) {
      // Submission and verification raced: bind the PENDING outcome now.
      outcome = await ms.insertOutcome({
        id: newId(),
        campaignId: intent.campaignId,
        partnerId: intent.partnerId,
        partnerTermsId: intent.partnerTermsId,
        checkoutIntentId: intent.id,
        customerKeyHash: customerKeyFor(intent.chainId, intent.payerAddress, intent.campaignId),
        purchaseTx: intent.txHash as string,
        purchaseAmountMicroUsdc: intent.amountMicroUsdc,
      });
    }
    if (outcome.status === "VERIFIED") {
      return { intent: serializeCheckoutIntent(intent), outcome: serializeOutcome(outcome), verified: true as const, alreadyVerified: true as const };
    }
    if (outcome.status === "REJECTED") {
      return { intent: serializeCheckoutIntent(intent), outcome: serializeOutcome(outcome), verified: false as const, alreadyVerified: false as const };
    }
    const campaign = await ms.getCampaign(intent.campaignId);
    const workspaceId = campaign?.workspaceId ?? null;
    if (!deps.config || !deps.reader) fail(503, "ARC_UNCONFIGURED", "Chain reader is required for verification");

    try {
      await assertChainMatches(deps.reader, intent.chainId);
    } catch (e) {
      return markAmbiguous(ms, audit, intent, workspaceId, "CHAIN_MISMATCH", (e as Error).message);
    }
    const receipt = await deps.reader.getReceipt(intent.txHash as Hex);
    if (!receipt) return markAmbiguous(ms, audit, intent, workspaceId, "RECEIPT_UNKNOWN", { txHash: intent.txHash });
    if (receipt.status !== "success") {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "TX_REVERTED", { txHash: intent.txHash });
    }
    const evidence = await deps.reader.getTransferEvidence(intent.txHash as Hex);
    if (!evidence) return markAmbiguous(ms, audit, intent, workspaceId, "RECEIPT_UNKNOWN", { txHash: intent.txHash });

    const usdc = intent.usdcAddress.toLowerCase();
    const payer = intent.payerAddress.toLowerCase();
    const merchant = intent.merchantAddress.toLowerCase();
    const usdcTransfers = evidence.transfers.filter((t) => t.token.toLowerCase() === usdc);
    if (usdcTransfers.length === 0) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "WRONG_TOKEN", { expected: intent.usdcAddress });
    }
    const exact = usdcTransfers.find(
      (t) => t.from.toLowerCase() === payer && t.to.toLowerCase() === merchant && t.amount === intent.amountMicroUsdc,
    );
    if (!exact) {
      const payerMerchant = usdcTransfers.find((t) => t.from.toLowerCase() === payer && t.to.toLowerCase() === merchant);
      if (payerMerchant) {
        return rejectOutcome(ms, audit, intent, outcome, workspaceId, "WRONG_AMOUNT", {
          observed: payerMerchant.amount.toString(),
          expected: intent.amountMicroUsdc.toString(),
        });
      }
      if (usdcTransfers.some((t) => t.from.toLowerCase() === payer)) {
        return rejectOutcome(ms, audit, intent, outcome, workspaceId, "WRONG_MERCHANT", { expected: intent.merchantAddress });
      }
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "WRONG_PAYER", { expected: intent.payerAddress });
    }
    // Canonical block time decides — never client time.
    const version = await store.getVersion(intent.campaignId, (await ms.getTerms(intent.campaignId, intent.partnerId))?.policyVersion ?? -1);
    const terms = await ms.getTerms(intent.campaignId, intent.partnerId);
    const deadlineMs = version?.deadline ? version.deadline.getTime() : null;
    if (deadlineMs !== null && evidence.blockTimestampMs > deadlineMs) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "LATE_TRANSACTION", { blockTimestampMs: evidence.blockTimestampMs });
    }
    if (evidence.blockTimestampMs > intent.expiresAt.getTime()) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "INTENT_EXPIRED", { blockTimestampMs: evidence.blockTimestampMs });
    }
    if (terms && evidence.blockTimestampMs > terms.expiresAt.getTime()) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "TERMS_EXPIRED", { blockTimestampMs: evidence.blockTimestampMs });
    }
    const partnerProfile = await ms.getPartnerById(intent.partnerId);
    if (partnerProfile?.payoutWallet && payer === partnerProfile.payoutWallet.toLowerCase()) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "SELF_REFERRAL", {});
    }
    if (payer === merchant) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "SELF_PURCHASE", {});
    }
    if (version?.minQualifyingPurchaseMicroUsdc !== null && version?.minQualifyingPurchaseMicroUsdc !== undefined && intent.amountMicroUsdc < (version.minQualifyingPurchaseMicroUsdc as bigint)) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "BELOW_MINIMUM", {});
    }
    // Policy version must remain the funded one.
    const funding = await ms.getFunding(intent.campaignId, terms?.policyVersion ?? -1);
    const live = await ms.getCampaign(intent.campaignId);
    if (!funding || funding.status !== "CONFIRMED" || !live || live.currentPolicyVersionId !== intent.policyVersionId) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "POLICY_SUPERSEDED", {});
    }
    // Uniqueness: one tx, one customer per campaign.
    const txClash = await ms.getOutcomeByTx(intent.txHash as string);
    if (txClash && txClash.id !== outcome.id) {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "DUPLICATE_TX", { txHash: intent.txHash });
    }
    const customerKeyHash = customerKeyFor(intent.chainId, intent.payerAddress, intent.campaignId);
    const customerClash = await ms.getOutcomeByCustomer(intent.campaignId, customerKeyHash);
    if (customerClash && customerClash.id !== outcome.id && customerClash.status === "VERIFIED") {
      return rejectOutcome(ms, audit, intent, outcome, workspaceId, "DUPLICATE_CUSTOMER", {});
    }

    const verifiedAt = now;
    const occurredAt = new Date(evidence.blockTimestampMs);
    const proofHash = outcomeProofFor({
      chainId: intent.chainId,
      purchaseTx: intent.txHash as Hex,
      campaignId: intent.campaignId,
      partnerId: intent.partnerId,
      payer: intent.payerAddress,
      amountMicroUsdc: intent.amountMicroUsdc,
      blockNumber: evidence.blockNumber,
      occurredAtMs: evidence.blockTimestampMs,
    });
    const refundHoldMs = (version?.refundHoldSeconds ?? 0) * 1000;
    const nextOutcome = await ms.updateOutcome(outcome.id, {
      status: "VERIFIED",
      purchaseAmountMicroUsdc: intent.amountMicroUsdc,
      customerKeyHash,
      proofHash,
      blockNumber: Number(evidence.blockNumber),
      occurredAt,
      verifiedAt,
      holdUntil: new Date(verifiedAt.getTime() + refundHoldMs),
    });
    const nextIntent = await ms.updateCheckoutIntent(intent.id, { status: "CONFIRMED", confirmedAt: verifiedAt });
    const base = {
      checkoutIntentId: intent.id,
      orderId: intent.orderId,
      outcomeId: outcome.id,
      purchaseTx: intent.txHash,
      purchaseAmountMicroUsdc: intent.amountMicroUsdc.toString(),
      proofHash,
      holdUntil: nextOutcome.holdUntil?.toISOString() ?? null,
    };
    await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: intent.partnerId, action: "checkout.confirmed", targetType: "checkout_intent", targetId: intent.id, metadata: base });
    await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: intent.partnerId, action: "outcome.verified", targetType: "outcome", targetId: outcome.id, metadata: base });
    return { intent: serializeCheckoutIntent(nextIntent), outcome: serializeOutcome(nextOutcome), verified: true as const, alreadyVerified: false as const };
  });
}

export interface AttributionMetadata {
  campaignId: string;
  productName: string;
  requiredAmountMicroUsdc: string;
  merchant: Address;
  partnerPayoutWallet: Address | null;
  chainId: number;
  usdcAddress: Address;
  deadline: string;
  handleExpiresAt: string;
}

/**
 * Public pre-purchase metadata for an attribution handle. Read-only: never
 * consumes the handle and never creates state. Mirrors the eligibility
 * preconditions of createCheckoutIntent so the page can show the exact
 * required amount before any intent exists.
 */
export async function resolveAttributionMetadata(
  deps: CheckoutDeps,
  params: { attributionHandle: string },
): Promise<AttributionMetadata> {
  const now = deps.now?.() ?? new Date();
  const ms = deps.store as MarketStore;
  const session = await ms.getAttributionSession(params.attributionHandle);
  if (!session) fail(404, "ATTRIBUTION_INVALID", "Unknown purchase reference");
  if (session.usedAt) fail(410, "ATTRIBUTION_USED", "This purchase link was already used");
  if (session.expiresAt <= now) fail(410, "ATTRIBUTION_EXPIRED", "This purchase link has expired");
  const campaign = await ms.getCampaign(session.campaignId);
  if (!campaign || campaign.state !== "LIVE") fail(400, "CAMPAIGN_NOT_LIVE", "Campaign is not live");
  const terms = await ms.getTerms(session.campaignId, session.partnerId);
  if (!terms || terms.id !== session.partnerTermsId || terms.status !== "ACTIVE") {
    fail(400, "TERMS_INVALID", "Partner terms are no longer applicable");
  }
  const version = await deps.store.getVersion(session.campaignId, terms.policyVersion);
  if (!version || !version.deadline) fail(500, "INTERNAL", "Policy version is missing");
  if (version.deadline <= now) fail(400, "EXPIRED", "Campaign deadline has passed");
  if (terms.expiresAt <= now) fail(400, "TERMS_EXPIRED", "Partner terms have expired");
  const funding = await ms.getFunding(session.campaignId, terms.policyVersion);
  if (!funding || funding.status !== "CONFIRMED") fail(400, "NOT_FUNDED", "Policy version is not funded");
  const current = await deps.store.getCurrentVersion(session.campaignId);
  if (!current || current.id !== version.id) fail(400, "POLICY_SUPERSEDED", "Policy version is no longer current");
  const workspace = await ms.getWorkspace(campaign.workspaceId);
  const merchant = workspace?.companyWallet;
  if (!merchant) fail(500, "INTERNAL", "Company wallet is not configured");
  if (version.minQualifyingPurchaseMicroUsdc === null || version.minQualifyingPurchaseMicroUsdc === undefined) {
    fail(500, "INTERNAL", "Campaign minimum purchase is missing");
  }
  if (!deps.config) fail(503, "ARC_UNCONFIGURED", "Arc chain configuration is absent");
  const partnerProfile = await ms.getPartnerById(session.partnerId);
  return {
    campaignId: session.campaignId,
    productName: version.intentText,
    requiredAmountMicroUsdc: (version.minQualifyingPurchaseMicroUsdc as bigint).toString(),
    merchant: normalizeAddress(merchant),
    partnerPayoutWallet: partnerProfile?.payoutWallet ? normalizeAddress(partnerProfile.payoutWallet) : null,
    chainId: deps.config.chainId,
    usdcAddress: deps.config.usdcAddress,
    deadline: version.deadline.toISOString(),
    handleExpiresAt: session.expiresAt.toISOString(),
  };
}

/**
 * Safe public payment/outcome state. No Partner internals, no attribution
 * material, no private policy — only what a customer receipt needs.
 */
export async function getCheckoutPublicState(deps: CheckoutDeps, params: { intentId: string }) {
  const intent = await deps.store.getCheckoutIntent(params.intentId);
  if (!intent) fail(404, "NOT_FOUND", "Checkout intent not found");
  const outcome = await deps.store.getOutcomeByIntent(params.intentId);
  return {
    intent: {
      id: intent.id,
      orderId: intent.orderId,
      status: intent.status,
      amountMicroUsdc: intent.amountMicroUsdc.toString(),
      merchant: intent.merchantAddress,
      payer: intent.payerAddress,
      expiresAt: intent.expiresAt.toISOString(),
      txHash: intent.txHash,
    },
    outcome: outcome
      ? {
          id: outcome.id,
          status: outcome.status,
          verifiedAt: outcome.verifiedAt?.toISOString() ?? null,
          holdUntil: outcome.holdUntil?.toISOString() ?? null,
          rejectionCode: outcome.rejectionCode,
        }
      : null,
  };
}
