import type { Address, Hex } from "viem";
import { assertChainMatches, normalizeAddress, type ArcConfig, type PayoutChainReader } from "../chain/arc";
import { outcomeId32For, PROOF_TTL_MS, serializePayout, serializeReservation } from "../domain/payout";
import type { OutcomeProofSigner, PayoutExecutor } from "../chain/signers";
import { newId } from "../auth/session";
import type { AuditSink, MarketStore, StoredOutcome, StoredPayout, StoredReservation } from "./campaignStore";

export interface PayoutDeps {
  store: MarketStore;
  audit: AuditSink;
  config: ArcConfig | null;
  reader: PayoutChainReader | null;
  signer: OutcomeProofSigner | null;
  executor: PayoutExecutor | null;
  now?: () => Date;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

const ACTIVE_RESERVATION = ["RESERVED", "SUBMITTED", "AMBIGUOUS", "SETTLED"] as const;

interface ReservationContext {
  outcome: StoredOutcome;
  campaign: { id: string; state: string; workspaceId: string; currentPolicyVersionId: string | null };
  version: { id: string; version: number; bountyCeilingMicroUsdc: bigint | null };
  terms: { id: string; priceMicroUsdc: bigint; allocationCount: number; policyVersion: number; status: string };
  funding: { campaignKey: string; policyHash: string; observedAmountMicroUsdc: bigint | null; expectedAmountMicroUsdc: bigint; status: string };
  recipient: Address;
  amount: bigint;
}

async function loadReservationContext(
  store: MarketStore,
  outcome: StoredOutcome,
): Promise<ReservationContext> {
  const campaign = await store.getCampaign(outcome.campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  const terms = await store.getTerms(outcome.campaignId, outcome.partnerId);
  if (!terms || terms.id !== outcome.partnerTermsId) {
    fail(500, "INTERNAL", "Outcome terms do not match the frozen Partner terms");
  }
  const version = await store.getVersion(outcome.campaignId, terms.policyVersion);
  if (!version) fail(500, "INTERNAL", "Policy version is missing");
  const funding = await store.getFunding(outcome.campaignId, terms.policyVersion);
  if (!funding) fail(500, "INTERNAL", "Funding record is missing");
  const profile = await store.getPartnerById(outcome.partnerId);
  if (!profile?.payoutWallet) {
    // No registered wallet: retryable, not an error (worker skips until set).
    return { outcome, campaign, version, terms, funding, recipient: "" as Address, amount: terms.priceMicroUsdc, noWallet: true } as unknown as ReservationContext;
  }
  return {
    outcome, campaign, version, terms, funding,
    recipient: normalizeAddress(profile.payoutWallet),
    amount: terms.priceMicroUsdc,
  };
}

export async function committedForCampaign(store: MarketStore, campaignId: string): Promise<bigint> {
  const rows = await store.listReservationsByCampaign(campaignId);
  const reservations = rows
    .filter((r) => (ACTIVE_RESERVATION as readonly string[]).includes(r.state))
    .reduce((sum, r) => sum + r.amountMicroUsdc, 0n);
  // Accepted-but-not-yet-downstream supply commitments count too; the first
  // S5 reservation for their terms consumes them, so they are never double-
  // counted (consumed rows leave the ACTIVE set before the reservation lands).
  const commitments = await store.listActiveCommitments(campaignId);
  return reservations + commitments.reduce((sum, c) => sum + c.amountMicroUsdc, 0n);
}

async function allocationUsed(store: MarketStore, campaignId: string, partnerId: string, termsId: string, excludeReservationId?: string): Promise<number> {
  const rows = await store.listReservationsByCampaign(campaignId);
  return rows.filter(
    (r) =>
      r.partnerId === partnerId &&
      r.partnerTermsId === termsId &&
      r.id !== excludeReservationId &&
      (ACTIVE_RESERVATION as readonly string[]).includes(r.state),
  ).length;
}

/**
 * Transactionally reserve budget for a VERIFIED outcome + create its PREPARED
 * payout. Idempotent per outcome. Returns (not throws) for retryable
 * not-yet-eligible states so the worker can skip without failing.
 */
export async function reserveOutcomePayout(deps: PayoutDeps, params: { outcomeId: string }) {
  const now = deps.now?.() ?? new Date();
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const outcome = await ms.getOutcome(params.outcomeId);
    if (!outcome) fail(404, "NOT_FOUND", "Outcome not found");
    if (outcome.status !== "VERIFIED") {
      fail(400, "NOT_VERIFIED", "Only VERIFIED outcomes can reserve budget");
    }
    const existing = await ms.getReservationByOutcome(params.outcomeId);
    if (existing && (ACTIVE_RESERVATION as readonly string[]).includes(existing.state)) {
      const payout = await ms.getPayoutByReservation(existing.id);
      return { reserved: true as const, alreadyReserved: true as const, reservation: serializeReservation(existing), payout: payout ? serializePayout(payout) : null };
    }
    if (existing && existing.state === "SETTLED") {
      const payout = await ms.getPayoutByReservation(existing.id);
      return { reserved: true as const, alreadyReserved: true as const, settled: true as const, reservation: serializeReservation(existing), payout: payout ? serializePayout(payout) : null };
    }
    // RELEASED / FAILED rows are retried IN PLACE (one reservation + one
    // payout per outcome for life, enforced by unique constraints); history
    // lives in audit events, never in duplicate rows.
    const retried = existing && (existing.state === "RELEASED" || existing.state === "FAILED");
    if (outcome.holdUntil && now < outcome.holdUntil) {
      return { reserved: false as const, reason: "HOLD_ACTIVE" as const };
    }
    const ctx = await loadReservationContext(ms, outcome);
    if (!["LIVE", "CLOSING", "CLOSED"].includes(ctx.campaign.state)) {
      return { reserved: false as const, reason: "CAMPAIGN_NOT_PAYABLE" as const };
    }
    if (ctx.terms.status !== "ACTIVE") {
      fail(400, "TERMS_INACTIVE", "Partner terms are no longer active");
    }
    if ((ctx as unknown as { noWallet?: boolean }).noWallet) {
      return { reserved: false as const, reason: "NO_WALLET" as const };
    }
    if (ctx.version.bountyCeilingMicroUsdc !== null && ctx.amount > ctx.version.bountyCeilingMicroUsdc) {
      fail(500, "POLICY_VIOLATION", "Frozen terms price exceeds the bounty ceiling");
    }
    if (ctx.funding.status !== "CONFIRMED" || ctx.campaign.currentPolicyVersionId !== ctx.version.id) {
      return { reserved: false as const, reason: "POLICY_NOT_FUNDED" as const };
    }
    const used = await allocationUsed(ms, ctx.campaign.id, outcome.partnerId, ctx.terms.id);
    if (used >= ctx.terms.allocationCount) {
      return { reserved: false as const, reason: "ALLOCATION_EXHAUSTED" as const };
    }
    const funded = ctx.funding.observedAmountMicroUsdc ?? ctx.funding.expectedAmountMicroUsdc;
    // The outcome's own ACTIVE commitment (if any) already earmarks this
    // exact unit: exclude it so the reservation converts rather than
    // double-counts it. First-come-first-served across outcomes is intended.
    const ownCommitment = await ms.getCommitmentByTerms(ctx.terms.id);
    const committedAll = await committedForCampaign(ms, ctx.campaign.id);
    const free = funded - (ownCommitment ? committedAll - ownCommitment.amountMicroUsdc : committedAll);
    if (ctx.amount > free) {
      return { reserved: false as const, reason: "INSUFFICIENT_BUDGET" as const };
    }
    if (!outcome.proofHash) fail(500, "INTERNAL", "VERIFIED outcome is missing its proof hash");
    let reservation: StoredReservation;
    let payout: StoredPayout;
    if (retried && existing) {
      reservation = await ms.updateReservation(existing.id, { state: "RESERVED" });
      const oldPayout = await ms.getPayoutByReservation(existing.id);
      if (!oldPayout) fail(500, "INTERNAL", "Reservation has no payout");
      // Recipient/amount follow the CURRENT registration and frozen terms.
      payout = await ms.updatePayout(oldPayout.id, {
        state: "PREPARED",
        recipient: ctx.recipient,
        amountMicroUsdc: ctx.amount,
        proofHash: outcome.proofHash as string,
        verifierSignature: null,
        txHash: null,
        submittedAt: null,
        failureCode: null,
      });
    } else {
      reservation = await ms.insertReservation({
        id: newId(),
        campaignId: ctx.campaign.id,
        outcomeId: outcome.id,
        partnerId: outcome.partnerId,
        partnerTermsId: ctx.terms.id,
        amountMicroUsdc: ctx.amount,
        policyVersionId: ctx.version.id,
      });
      payout = await ms.insertPayout({
        id: newId(),
        reservationId: reservation.id,
        outcomeId: outcome.id,
        campaignId: ctx.campaign.id,
        partnerId: outcome.partnerId,
        recipient: ctx.recipient,
        amountMicroUsdc: ctx.amount,
        proofHash: outcome.proofHash,
      });
    }
    // Consume the matching pre-outcome commitment exactly once, if present.
    // Legacy (pre-commitment) outcomes simply have no ACTIVE row: compatible.
    const commitment = await ms.getCommitmentByTerms(ctx.terms.id);
    let consumedCommitmentId: string | null = null;
    if (commitment) {
      await ms.updateSupplyCommitment(commitment.id, {
        state: "CONSUMED",
        consumedByOutcomeId: outcome.id,
        consumedByReservationId: reservation.id,
      });
      consumedCommitmentId = commitment.id;
    }
    const base = {
      campaignId: ctx.campaign.id,
      outcomeId: outcome.id,
      reservationId: reservation.id,
      payoutId: payout.id,
      partnerId: outcome.partnerId,
      amountMicroUsdc: ctx.amount.toString(),
      consumedCommitmentId,
    };
    await audit({ actorType: "SYSTEM", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: outcome.partnerId, action: "payout.reserved", targetType: "spend_reservation", targetId: reservation.id, metadata: base });
    await audit({ actorType: "SYSTEM", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: outcome.partnerId, action: "payout.prepared", targetType: "payout", targetId: payout.id, metadata: base });
    return { reserved: true as const, alreadyReserved: false as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
  });
}

async function releaseReservation(
  ms: MarketStore,
  audit: AuditSink,
  reservation: StoredReservation,
  payout: StoredPayout,
  workspaceId: string | null,
  failureCode: string,
  details?: unknown,
) {
  const nextReservation = await ms.updateReservation(reservation.id, { state: "RELEASED" });
  // Restore this reservation's consumed commitment (if any) so the still-
  // VERIFIED outcome keeps exactly one backing promise for its retry.
  const consumed = await ms.getCommitmentByOutcome(payout.outcomeId);
  if (consumed && consumed.state === "CONSUMED" && consumed.consumedByReservationId === reservation.id) {
    await ms.updateSupplyCommitment(consumed.id, {
      state: "ACTIVE",
      consumedByOutcomeId: null,
      consumedByReservationId: null,
    });
  }
  const nextPayout = await ms.updatePayout(payout.id, { state: "FAILED", failureCode });
  const base = { campaignId: payout.campaignId, outcomeId: payout.outcomeId, reservationId: payout.reservationId, payoutId: payout.id, failureCode, details };
  await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: payout.partnerId, action: "payout.failed", targetType: "payout", targetId: payout.id, metadata: base });
  await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: payout.partnerId, action: "payout.released", targetType: "spend_reservation", targetId: reservation.id, metadata: base });
  return { reservation: serializeReservation(nextReservation), payout: serializePayout(nextPayout) };
}

function requireChainDeps(deps: PayoutDeps) {
  if (!deps.config?.vaultAddress) fail(503, "VAULT_UNCONFIGURED", "Vault address is not configured");
  if (!deps.reader) fail(503, "ARC_UNCONFIGURED", "Chain reader is required");
  if (!deps.signer) fail(503, "SIGNER_UNCONFIGURED", "Verifier signer is not configured");
  if (!deps.executor) fail(503, "EXECUTOR_UNCONFIGURED", "Payout executor is not configured");
  if (deps.config.executorAddress && deps.executor.address.toLowerCase() !== deps.config.executorAddress.toLowerCase()) {
    fail(503, "EXECUTOR_MISMATCH", "Executor identity does not match configuration");
  }
  if (deps.config.verifierAddress && deps.signer.address.toLowerCase() !== deps.config.verifierAddress.toLowerCase()) {
    fail(503, "SIGNER_MISMATCH", "Signer identity does not match configuration");
  }
  return { config: deps.config, reader: deps.reader, signer: deps.signer, executor: deps.executor };
}

/**
 * Sign + broadcast a RESERVED payout. Revalidates everything; SUBMITTED is
 * idempotent (never resends). Pre-broadcast failures release safely.
 */
export async function settleReservedPayout(deps: PayoutDeps, params: { reservationId: string }) {
  const now = deps.now?.() ?? new Date();
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const reservation = await ms.getReservation(params.reservationId);
    if (!reservation) fail(404, "NOT_FOUND", "Reservation not found");
    const payout = await ms.getPayoutByReservation(params.reservationId);
    if (!payout) fail(500, "INTERNAL", "Reservation has no payout");
    if (reservation.state === "SUBMITTED" || payout.state === "SUBMITTED") {
      return { advanced: false as const, alreadySubmitted: true as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
    }
    if (reservation.state === "SETTLED" || payout.state === "SETTLED") {
      return { advanced: false as const, alreadySettled: true as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
    }
    if (reservation.state !== "RESERVED" || payout.state !== "PREPARED") {
      fail(409, "NOT_RESERVABLE", "Reservation is no longer payable; reconcile or re-reserve");
    }
    const outcome = await ms.getOutcome(reservation.outcomeId);
    if (!outcome || outcome.status !== "VERIFIED") fail(400, "OUTCOME_CHANGED", "Outcome is no longer VERIFIED");
    if (outcome.holdUntil && now < outcome.holdUntil) fail(409, "HOLD_ACTIVE", "Refund hold has not cleared");
    const ctx = await loadReservationContext(ms, outcome);
    if ((ctx as unknown as { noWallet?: boolean }).noWallet) fail(400, "NO_WALLET", "Partner payout wallet is missing");
    if (!["LIVE", "CLOSING", "CLOSED"].includes(ctx.campaign.state)) fail(400, "CAMPAIGN_NOT_PAYABLE", "Campaign cannot pay out");
    if (ctx.funding.status !== "CONFIRMED" || ctx.campaign.currentPolicyVersionId !== ctx.version.id) {
      fail(400, "POLICY_SUPERSEDED", "Funded policy binding changed");
    }
    if (ctx.recipient.toLowerCase() !== payout.recipient.toLowerCase()) {
      const released = await releaseReservation(ms, audit, reservation, payout, ctx.campaign.workspaceId, "RECIPIENT_CHANGED", {
        expected: payout.recipient,
        registered: ctx.recipient,
      });
      return { advanced: false as const, ...released, failureCode: "RECIPIENT_CHANGED" as const };
    }
    if (ctx.amount !== payout.amountMicroUsdc || payout.proofHash !== outcome.proofHash) {
      fail(500, "INTERNAL", "Reservation drifted from frozen terms");
    }
    const othersUsed = await allocationUsed(ms, ctx.campaign.id, outcome.partnerId, ctx.terms.id, reservation.id);
    if (othersUsed >= ctx.terms.allocationCount) {
      const released = await releaseReservation(ms, audit, reservation, payout, ctx.campaign.workspaceId, "ALLOCATION_EXHAUSTED", {});
      return { advanced: false as const, ...released, failureCode: "ALLOCATION_EXHAUSTED" as const };
    }

    const { config, reader, signer, executor } = requireChainDeps(deps);
    try {
      await assertChainMatches(reader, config.chainId);
    } catch (e) {
      fail(503, "CHAIN_MISMATCH", (e as Error).message);
    }
    const onchain = await reader.readVaultCampaign(config.vaultAddress as Address, ctx.funding.campaignKey as Hex);
    const check = async (cond: boolean, code: string, details?: unknown) => {
      if (!cond) {
        const released = await releaseReservation(ms, audit, reservation, payout, ctx.campaign.workspaceId, code, details);
        return { advanced: false as const, ...released, failureCode: code };
      }
      return null;
    };
    if (!onchain.exists) {
      return check(false, "UNKNOWN_CAMPAIGN", {});
    }
    const mismatch =
      onchain.policyHash?.toLowerCase() !== ctx.funding.policyHash.toLowerCase() ||
      onchain.executor?.toLowerCase() !== executor.address.toLowerCase() ||
      onchain.verifier?.toLowerCase() !== signer.address.toLowerCase();
    if (mismatch) {
      return check(false, "VAULT_BINDING_MISMATCH", {
        policyHash: onchain.policyHash,
        executor: onchain.executor,
        verifier: onchain.verifier,
      });
    }
    if (onchain.funded - onchain.spent < payout.amountMicroUsdc) {
      return check(false, "INSUFFICIENT_VAULT", { funded: onchain.funded.toString(), spent: onchain.spent.toString() });
    }
    if (!outcome.occurredAt) fail(500, "INTERNAL", "VERIFIED outcome is missing occurredAt");

    const occurredAt = BigInt(Math.floor((outcome.occurredAt as Date).getTime() / 1000));
    const validUntil = BigInt(Math.floor(now.getTime() / 1000)) + BigInt(PROOF_TTL_MS / 1000);
    const message = {
      campaignKey: ctx.funding.campaignKey as Hex,
      policyHash: ctx.funding.policyHash as Hex,
      outcomeId: outcomeId32For(outcome.id),
      recipient: payout.recipient as Address,
      amount: payout.amountMicroUsdc,
      proofHash: payout.proofHash as Hex,
      occurredAt,
      validUntil,
    };
    const signature = await signer.signVerifiedOutcomeProof({ chainId: config.chainId, vault: config.vaultAddress as Address, message });
    const txHash = await executor.submitVerifiedOutcomePayout({ vault: config.vaultAddress as Address, ...message, signature });
    const nextReservation = await ms.updateReservation(reservation.id, { state: "SUBMITTED" });
    const nextPayout = await ms.updatePayout(payout.id, {
      state: "SUBMITTED",
      verifierSignature: signature,
      txHash,
      submittedAt: now,
    });
    await audit({
      actorType: "SYSTEM", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: payout.partnerId,
      action: "payout.submitted", targetType: "payout", targetId: payout.id,
      metadata: {
        campaignId: payout.campaignId, outcomeId: payout.outcomeId, reservationId: payout.reservationId,
        payoutId: payout.id, txHash, recipient: payout.recipient, amountMicroUsdc: payout.amountMicroUsdc.toString(),
      },
    });
    return { advanced: true as const, reservation: serializeReservation(nextReservation), payout: serializePayout(nextPayout), txHash };
  });
}

/**
 * Independently reconcile a payout against canonical chain evidence.
 * SETTLED only on a matching OutcomePaid event. Never resends. Idempotent.
 */
export async function reconcilePayout(deps: PayoutDeps, params: { payoutId: string }) {
  const now = deps.now?.() ?? new Date();
  void now;
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const payout = await ms.getPayout(params.payoutId);
    if (!payout) fail(404, "NOT_FOUND", "Payout not found");
    const reservation = await ms.getReservation(payout.reservationId);
    if (!reservation) fail(500, "INTERNAL", "Payout has no reservation");
    if (payout.state === "SETTLED") {
      return { settled: true as const, already: true as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
    }
    if (payout.state === "FAILED") {
      // No automatic retry: check consumption so an operator can decide safely.
      if (!deps.config?.vaultAddress || !deps.reader) fail(503, "ARC_UNCONFIGURED", "Chain reader is required");
      const outcomeRow = await ms.getOutcome(payout.outcomeId);
      const consumed = await deps.reader.isOutcomeConsumed(deps.config.vaultAddress as Address, outcomeId32For(payout.outcomeId));
      void outcomeRow;
      if (consumed) {
        const next = await ms.updatePayout(payout.id, { state: "AMBIGUOUS", failureCode: "OUTCOME_CONSUMED" });
        await audit({
          actorType: "SYSTEM", actorId: null, workspaceId: null, partnerId: payout.partnerId,
          action: "payout.ambiguous", targetType: "payout", targetId: payout.id,
          metadata: { payoutId: payout.id, outcomeId: payout.outcomeId, failureCode: "OUTCOME_CONSUMED" },
        });
        return { settled: false as const, already: false as const, reservation: serializeReservation(reservation), payout: serializePayout(next) };
      }
      return { settled: false as const, already: true as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
    }
    if (!deps.config?.vaultAddress || !deps.reader) fail(503, "ARC_UNCONFIGURED", "Chain reader is required");
    const vault = deps.config.vaultAddress as Address;
    const outcome = await ms.getOutcome(payout.outcomeId);
    const campaign = outcome ? await ms.getCampaign(outcome.campaignId) : null;
    const workspaceId = campaign?.workspaceId ?? null;
    try {
      await assertChainMatches(deps.reader, deps.config.chainId);
    } catch (e) {
      if (payout.state === "AMBIGUOUS" && payout.failureCode === "CHAIN_MISMATCH") {
        return { settled: false as const, already: true as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
      }
      return markPayoutAmbiguous(ms, audit, reservation, payout, workspaceId, "CHAIN_MISMATCH", (e as Error).message);
    }
    // Crash-recovery path: broadcast may have happened without a stored hash.
    if (!payout.txHash) {
      const consumed = await deps.reader.isOutcomeConsumed(vault, outcomeId32For(payout.outcomeId));
      if (consumed) {
        return markPayoutAmbiguous(ms, audit, reservation, payout, workspaceId, "OUTCOME_CONSUMED_UNKNOWN_TX", {});
      }
      return { settled: false as const, already: true as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
    }
    const evidence = await deps.reader.getPayoutEvidence(payout.txHash as Hex);
    if (!evidence) {
      if (payout.state === "AMBIGUOUS" && payout.failureCode === "RECEIPT_UNKNOWN") {
        return { settled: false as const, already: true as const, reservation: serializeReservation(reservation), payout: serializePayout(payout) };
      }
      return markPayoutAmbiguous(ms, audit, reservation, payout, workspaceId, "RECEIPT_UNKNOWN", { txHash: payout.txHash });
    }
    if (evidence.status !== "success") {
      // Reverted broadcast paid nothing: FAILED + safe release is evidence-backed.
      return releaseAndFail(ms, audit, reservation, payout, workspaceId, "TX_REVERTED", { txHash: payout.txHash });
    }
    if (!evidence.to || evidence.to.toLowerCase() !== vault.toLowerCase()) {
      return releaseAndFail(ms, audit, reservation, payout, workspaceId, "WRONG_VAULT", { to: evidence.to });
    }
    const outcomeId32 = outcomeId32For(payout.outcomeId);
    const expectedKey = await fundingKey(ms, payout);
    const match = evidence.paid.find(
      (e) =>
        e.campaignKey.toLowerCase() === expectedKey.toLowerCase() &&
        e.outcomeId.toLowerCase() === outcomeId32.toLowerCase() &&
        e.recipient.toLowerCase() === payout.recipient.toLowerCase() &&
        e.amount === payout.amountMicroUsdc &&
        e.proofHash.toLowerCase() === payout.proofHash.toLowerCase(),
    );
    if (!match) {
      return releaseAndFail(ms, audit, reservation, payout, workspaceId, "NO_PAYOUT_EVENT", { txHash: payout.txHash });
    }
    const nextReservation = await ms.updateReservation(reservation.id, { state: "SETTLED" });
    const at = deps.now?.() ?? new Date();
    const nextPayout = await ms.updatePayout(payout.id, {
      state: "SETTLED",
      blockNumber: Number(evidence.blockNumber),
      settledAt: at,
      reconciledAt: at,
      failureCode: null,
    });
    const base = {
      campaignId: payout.campaignId, outcomeId: payout.outcomeId, reservationId: payout.reservationId,
      payoutId: payout.id, txHash: payout.txHash, blockNumber: Number(evidence.blockNumber),
      recipient: payout.recipient, amountMicroUsdc: payout.amountMicroUsdc.toString(), proofHash: payout.proofHash,
    };
    await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: payout.partnerId, action: "payout.settled", targetType: "payout", targetId: payout.id, metadata: base });
    return { settled: true as const, already: false as const, reservation: serializeReservation(nextReservation), payout: serializePayout(nextPayout) };
  });
}

async function fundingKey(ms: MarketStore, payout: StoredPayout): Promise<string> {
  const outcome = await ms.getOutcome(payout.outcomeId);
  const terms = outcome ? await ms.getTerms(outcome.campaignId, outcome.partnerId) : null;
  const funding = terms ? await ms.getFunding(outcome!.campaignId, terms.policyVersion) : null;
  if (!funding) fail(500, "INTERNAL", "Funding record is missing for reconciliation");
  return funding.campaignKey;
}

async function markPayoutAmbiguous(
  ms: MarketStore,
  audit: AuditSink,
  reservation: StoredReservation,
  payout: StoredPayout,
  workspaceId: string | null,
  code: string,
  details?: unknown,
) {
  // No silent early-return here: callers re-read chain state first and only
  // land here on a genuine transition (or an unchanged re-check that still
  // deserves no new audit — handled by the caller comparing states).
  const nextPayout = await ms.updatePayout(payout.id, { state: "AMBIGUOUS", failureCode: code });
  const nextReservation =
    reservation.state === "RESERVED" || reservation.state === "PREPARED" as string
      ? await ms.updateReservation(reservation.id, { state: "AMBIGUOUS" })
      : reservation;
  await audit({
    actorType: "SYSTEM", actorId: null, workspaceId, partnerId: payout.partnerId,
    action: "payout.ambiguous", targetType: "payout", targetId: payout.id,
    metadata: { payoutId: payout.id, outcomeId: payout.outcomeId, reservationId: payout.reservationId, failureCode: code, details },
  });
  return { settled: false as const, already: false as const, reservation: serializeReservation(nextReservation), payout: serializePayout(nextPayout) };
}

async function releaseAndFail(
  ms: MarketStore,
  audit: AuditSink,
  reservation: StoredReservation,
  payout: StoredPayout,
  workspaceId: string | null,
  code: string,
  details?: unknown,
) {
  // Release is safe here ONLY because canonical evidence proves this payout
  // moved nothing (reverted tx, wrong vault, or success without our event).
  const nextReservation = await ms.updateReservation(reservation.id, { state: "RELEASED" });
  const nextPayout = await ms.updatePayout(payout.id, { state: "FAILED", failureCode: code });
  const base = { payoutId: payout.id, outcomeId: payout.outcomeId, reservationId: payout.reservationId, failureCode: code, details };
  await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: payout.partnerId, action: "payout.failed", targetType: "payout", targetId: payout.id, metadata: base });
  await audit({ actorType: "SYSTEM", actorId: null, workspaceId, partnerId: payout.partnerId, action: "payout.released", targetType: "spend_reservation", targetId: reservation.id, metadata: base });
  return { settled: false as const, already: false as const, reservation: serializeReservation(nextReservation), payout: serializePayout(nextPayout) };
}

export interface WorkerSummary {
  scanned: number;
  reserved: number;
  submitted: number;
  settled: number;
  skipped: Array<{ outcomeId: string; reason: string }>;
  failed: Array<{ outcomeId: string; error: string }>;
}

/**
 * Automatic payout worker (no Redis, no per-outcome approval).
 * Per outcome: reserve -> execute -> reconcile as appropriate. The company
 * granted this authority when it funded the campaign inside hard policy.
 * Duplicate invocations are safe: every step is idempotent.
 */
export async function processEligiblePayouts(deps: PayoutDeps, opts?: { limit?: number }): Promise<WorkerSummary> {
  const now = deps.now?.() ?? new Date();
  const limit = opts?.limit ?? 25;
  const summary: WorkerSummary = { scanned: 0, reserved: 0, submitted: 0, settled: 0, skipped: [], failed: [] };
  const outcomes = await deps.store.listOutcomesByStatus("VERIFIED", limit);
  summary.scanned = outcomes.length;
  for (const outcome of outcomes) {
    try {
      if (outcome.holdUntil && now < outcome.holdUntil) {
        summary.skipped.push({ outcomeId: outcome.id, reason: "HOLD_ACTIVE" });
        continue;
      }
      const existing = await deps.store.getPayoutByOutcome(outcome.id);
      if (existing?.state === "SETTLED") {
        summary.skipped.push({ outcomeId: outcome.id, reason: "ALREADY_SETTLED" });
        continue;
      }
      if (existing && (existing.state === "SUBMITTED" || existing.state === "AMBIGUOUS")) {
        const rec = await reconcilePayout(deps, { payoutId: existing.id });
        if (rec.settled) summary.settled += 1;
        else summary.skipped.push({ outcomeId: outcome.id, reason: "RECONCILED_PENDING" });
        continue;
      }
      if (existing && existing.state === "FAILED") {
        summary.skipped.push({ outcomeId: outcome.id, reason: "PAYOUT_FAILED" });
        continue;
      }
      const reserved = await reserveOutcomePayout(deps, { outcomeId: outcome.id });
      if (!reserved.reserved || !reserved.reservation || !reserved.payout) {
        summary.skipped.push({ outcomeId: outcome.id, reason: (reserved as { reason?: string }).reason ?? "NOT_ELIGIBLE" });
        continue;
      }
      const resAny = reserved as { alreadyReserved?: boolean; reservation?: { id: string } | null };
      if (!resAny.alreadyReserved) summary.reserved += 1;
      if (!resAny.reservation) {
        summary.skipped.push({ outcomeId: outcome.id, reason: "NO_RESERVATION" });
        continue;
      }
      const settled = await settleReservedPayout(deps, { reservationId: resAny.reservation.id });
      const setAny = settled as {
        advanced?: boolean;
        alreadySubmitted?: boolean;
        alreadySettled?: boolean;
        failureCode?: string;
        payout?: { id: string } | null;
      };
      if (setAny.alreadySubmitted || setAny.alreadySettled) {
        summary.skipped.push({ outcomeId: outcome.id, reason: "ALREADY_ADVANCED" });
        continue;
      }
      if (!setAny.advanced || !setAny.payout) {
        summary.skipped.push({ outcomeId: outcome.id, reason: setAny.failureCode ?? "NOT_ADVANCED" });
        continue;
      }
      summary.submitted += 1;
      const rec = await reconcilePayout(deps, { payoutId: setAny.payout.id });
      const recAny = rec as { settled?: boolean };
      if (recAny.settled) summary.settled += 1;
      else summary.skipped.push({ outcomeId: outcome.id, reason: "RECONCILED_PENDING" });
    } catch (e) {
      summary.failed.push({ outcomeId: outcome.id, error: (e as Error).message });
    }
  }
  return summary;
}

/** Human-readable receipt. Truthful language: SUBMITTED is never "paid". */
export async function getPayoutReceipt(
  store: MarketStore,
  params: { payoutId: string },
  opts?: { now?: Date; explorerBaseUrl?: string | null },
) {
  const now = opts?.now ?? new Date();
  const payout = await store.getPayout(params.payoutId);
  if (!payout) fail(404, "NOT_FOUND", "Payout not found");
  const reservation = await store.getReservation(payout.reservationId);
  const outcome = await store.getOutcome(payout.outcomeId);
  const campaign = outcome ? await store.getCampaign(outcome.campaignId) : null;
  const terms = outcome ? await store.getTerms(outcome.campaignId, outcome.partnerId) : null;
  const funding = terms ? await store.getFunding(outcome!.campaignId, terms.policyVersion) : null;
  const partner = await store.getPartnerById(payout.partnerId);
  const checks = {
    policyFunded: !!funding && funding.status === "CONFIRMED",
    amountMatchesTerms: !!terms && terms.priceMicroUsdc === payout.amountMicroUsdc,
    recipientMatchesWallet: !!partner?.payoutWallet && partner.payoutWallet.toLowerCase() === payout.recipient.toLowerCase(),
    holdCleared: !outcome?.holdUntil || now >= outcome.holdUntil,
  };
  return {
    payout: {
      id: payout.id,
      state: payout.state,
      amountMicroUsdc: payout.amountMicroUsdc.toString(),
      recipient: payout.recipient,
      proofHash: payout.proofHash,
      txHash: payout.txHash,
      blockNumber: payout.blockNumber,
      submittedAt: payout.submittedAt?.toISOString() ?? null,
      settledAt: payout.settledAt?.toISOString() ?? null,
      reconciledAt: payout.reconciledAt?.toISOString() ?? null,
      failureCode: payout.failureCode,
    },
    reservation: reservation ? { id: reservation.id, state: reservation.state, amountMicroUsdc: reservation.amountMicroUsdc.toString() } : null,
    outcome: outcome ? { id: outcome.id, status: outcome.status, verifiedAt: outcome.verifiedAt?.toISOString() ?? null, holdUntil: outcome.holdUntil?.toISOString() ?? null } : null,
    campaign: campaign ? { id: campaign.id, state: campaign.state } : null,
    terms: terms
      ? { id: terms.id, source: terms.source, priceMicroUsdc: terms.priceMicroUsdc.toString(), policyVersion: terms.policyVersion, marketVersion: terms.marketVersion }
      : null,
    checks,
    explorerUrl: payout.txHash && opts?.explorerBaseUrl ? `${opts.explorerBaseUrl.replace(/\/$/, "")}/tx/${payout.txHash}` : null,
    settledMeansReconciled: payout.state === "SETTLED",
  };
}
