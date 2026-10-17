import { createHash, randomBytes } from "node:crypto";
import { newId } from "../auth/session";
import { microToUsdcString } from "../domain/money";
import { DEFAULT_PRICING_POLICY, derivePace } from "../domain/pricing";
import {
  DEFAULT_OFFER_TTL_MS,
  evaluateNegotiationOffer,
  MAX_NEGOTIATION_ROUNDS,
  type NegotiationKernelInputs,
  type NegotiationKernelResult,
} from "../domain/negotiation";
import { TERMS_SOURCE_NEGOTIATED, checkJoinEligibility } from "../domain/market";
import type { PartnerRules } from "../domain/market";
import { parsePartnerRules } from "../domain/market";
import { newReferralCode } from "../domain/market";
import { committedForCampaign } from "./payouts";
import { campaignInScope } from "./campaigns";
import type { AuditSink, MarketStore, StoredNegotiation } from "./campaignStore";
import { isUniqueViolation } from "./campaignStore";

export interface NegotiationDeps {
  store: MarketStore;
  audit: AuditSink;
  now?: () => Date;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

function inputsHash(negotiationId: string, round: number, inputs: NegotiationKernelResult["inputs"]): string {
  return createHash("sha256").update(JSON.stringify([negotiationId, round, inputs]), "utf8").digest("hex");
}

/** Deterministic narrator (no LLM): fixed rendering of kernel outputs. */
export function explainNegotiation(result: NegotiationKernelResult): string {
  const ask = microToUsdcString(BigInt(result.inputs.askMicroUsdc as string));
  const ref = microToUsdcString(BigInt(result.inputs.referenceBountyMicroUsdc as string));
  const reasons = result.reasons.join(", ");
  if (result.decision === "ACCEPT") {
    return `Ask ${ask} USDC accepted against bounty ${ref} USDC (${reasons}). Frozen terms are minted at the ask; no payment occurs now.`;
  }
  if (result.decision === "COUNTER") {
    return `Ask ${ask} USDC above the safe band: counter ${microToUsdcString(result.counterMicroUsdc as bigint)} USDC toward the ask (${reasons}).`;
  }
  if (result.decision === "HOLD") {
    return `Negotiation held (${reasons}): no state change until fresh supplier input arrives.`;
  }
  return `Ask ${ask} USDC rejected against bounty ${ref} USDC (${reasons}).`;
}

export function serializeNegotiation(n: StoredNegotiation) {
  return {
    id: n.id,
    campaignId: n.campaignId,
    partnerId: n.partnerId,
    round: n.round,
    status: n.status,
    askMicroUsdc: n.askMicroUsdc.toString(),
    referenceBountyMicroUsdc: n.referenceBountyMicroUsdc.toString(),
    counterMicroUsdc: n.counterMicroUsdc === null ? null : n.counterMicroUsdc.toString(),
    policyVersion: n.policyVersion,
    marketVersion: n.marketVersion,
    allocationCount: n.allocationCount,
    expiresAt: n.expiresAt.toISOString(),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

interface SupplierContext {
  campaign: { id: string; state: string; workspaceId: string; currentPolicyVersionId: string | null };
  workspaceCategory: string | null;
  market: {
    campaignId: string;
    publicBountyMicroUsdc: bigint;
    status: string;
    version: number;
    policyVersion: number;
    openedAt: Date;
  };
  version: {
    id: string;
    version: number;
    targetOutcomeCount: number | null;
    bountyFloorMicroUsdc: bigint | null;
    bountyCeilingMicroUsdc: bigint | null;
    minQualifyingPurchaseMicroUsdc: bigint | null;
    deadline: Date | null;
    marketVisibility: string;
  };
  funding: { campaignKey: string; policyHash: string; observedAmountMicroUsdc: bigint | null; expectedAmountMicroUsdc: bigint; status: string };
  profile: { id: string; payoutWallet: string | null; rules: PartnerRules };
}

async function loadSupplierContext(
  store: MarketStore,
  campaignId: string,
  userId: string,
): Promise<SupplierContext> {
  const profile = await store.getPartnerByUserId(userId);
  if (!profile) fail(404, "PARTNER_PROFILE_REQUIRED", "Create a Partner profile first");
  if (!profile.payoutWallet) fail(400, "WALLET_REQUIRED", "Partner payout wallet is required");
  const parsed = parsePartnerRules(profile.rulesJson);
  if (!parsed.ok) fail(500, "INTERNAL", "Stored Partner rules are invalid", parsed.issues);
  const campaign = await store.getCampaign(campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  const workspace = await store.getWorkspace(campaign.workspaceId);
  const market = await store.getMarket(campaignId);
  if (!market) fail(404, "MARKET_NOT_OPEN", "No market for this campaign");
  const version = await store.getVersion(campaignId, market.policyVersion);
  if (!version) fail(500, "INTERNAL", "Market policy version is missing");
  const funding = await store.getFunding(campaignId, market.policyVersion);
  if (!funding) fail(500, "INTERNAL", "Funding record is missing");
  // Baseline supplier eligibility mirrors join gates (category allow/block).
  const rules = (parsed as { ok: true; rules: PartnerRules }).rules;
  const category = (workspace?.category ?? "").trim().toLowerCase();
  const blocked = rules.blockedCategories.map((c) => c.toLowerCase());
  if (category && blocked.includes(category)) fail(403, "CATEGORY_BLOCKED", "Campaign category is blocked by Partner rules");
  const allowed = rules.allowedCategories.map((c) => c.toLowerCase());
  if (allowed.length > 0 && (!category || !allowed.includes(category))) {
    fail(403, "CATEGORY_NOT_ALLOWED", "Campaign category is not in Partner allowed list");
  }
  const activeCount = (await store.listPartnerTerms(profile.id)).filter((t) => t.status === "ACTIVE").length;
  if (rules.maxActiveCampaigns !== null && activeCount >= rules.maxActiveCampaigns) {
    fail(403, "MAX_ACTIVE", "Partner active campaign limit reached");
  }
  return {
    campaign: { id: campaign.id, state: campaign.state, workspaceId: campaign.workspaceId, currentPolicyVersionId: campaign.currentPolicyVersionId },
    workspaceCategory: workspace?.category ?? null,
    market: {
      campaignId: market.campaignId,
      publicBountyMicroUsdc: market.publicBountyMicroUsdc,
      status: market.status,
      version: market.version,
      policyVersion: market.policyVersion,
      openedAt: market.openedAt,
    },
    version: {
      id: version.id,
      version: version.version,
      targetOutcomeCount: version.targetOutcomeCount,
      bountyFloorMicroUsdc: version.bountyFloorMicroUsdc,
      bountyCeilingMicroUsdc: version.bountyCeilingMicroUsdc,
      minQualifyingPurchaseMicroUsdc: version.minQualifyingPurchaseMicroUsdc,
      deadline: version.deadline,
      marketVisibility: version.marketVisibility,
    },
    funding: {
      campaignKey: funding.campaignKey,
      policyHash: funding.policyHash,
      observedAmountMicroUsdc: funding.observedAmountMicroUsdc,
      expectedAmountMicroUsdc: funding.expectedAmountMicroUsdc,
      status: funding.status,
    },
    profile: { id: profile.id, payoutWallet: profile.payoutWallet, rules },
  };
}

async function buildKernelInputs(
  store: MarketStore,
  ctx: SupplierContext,
  ask: bigint,
  round: number,
  now: Date,
): Promise<NegotiationKernelInputs> {
  const funded = ctx.funding.observedAmountMicroUsdc ?? ctx.funding.expectedAmountMicroUsdc;
  const committed = await committedForCampaign(store, ctx.campaign.id);
  const verified = await store.countVerifiedOutcomes(ctx.campaign.id);
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const pace = derivePace(
    {
      publicBountyMicroUsdc: ctx.market.publicBountyMicroUsdc,
      bountyFloorMicroUsdc: ctx.version.bountyFloorMicroUsdc as bigint,
      bountyCeilingMicroUsdc: ctx.version.bountyCeilingMicroUsdc as bigint,
      fundedMicroUsdc: funded,
      committedMicroUsdc: committed,
      targetOutcomeCount: ctx.version.targetOutcomeCount as number,
      verifiedOutcomeCount: verified,
      openedAtMs: ctx.market.openedAt.getTime(),
      deadlineMs: (ctx.version.deadline as Date).getTime(),
      nowMs: now.getTime(),
      recentJoins: await store.countTermsSince(ctx.campaign.id, since),
      recentVerified: await store.countVerifiedOutcomesSince(ctx.campaign.id, since),
      msSinceLastReprice: null,
      marketStatus: ctx.market.status as "OPEN",
      campaignState: ctx.campaign.state,
    },
    DEFAULT_PRICING_POLICY,
  );
  return {
    askMicroUsdc: ask,
    referenceBountyMicroUsdc: ctx.market.publicBountyMicroUsdc,
    bountyFloorMicroUsdc: ctx.version.bountyFloorMicroUsdc as bigint,
    bountyCeilingMicroUsdc: ctx.version.bountyCeilingMicroUsdc as bigint,
    freeMicroUsdc: funded - committed,
    remainingRequired: Math.max(0, (ctx.version.targetOutcomeCount as number) - verified),
    paceState: pace,
    round,
    nowMs: now.getTime(),
  };
}

/**
 * Supplier proposes (or re-proposes with a new ask). Same ask twice is
 * idempotent: no round bump, no duplicate row. A new ask opens the next
 * round on the same row. Evaluation runs immediately; the worker repeats it
 * safely later.
 */
export async function proposeNegotiation(
  deps: NegotiationDeps,
  params: { campaignId: string; userId: string; askMicroUsdc: string; allocationCount?: number; expiresAt?: string },
) {
  const now = deps.now?.() ?? new Date();
  const ask = BigInt(params.askMicroUsdc);
  if (ask <= 0n) fail(400, "BAD_REQUEST", "Ask must be positive");
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const ctx = await loadSupplierContext(ms, params.campaignId, params.userId);
    if (ctx.market.status !== "OPEN") fail(400, "MARKET_NOT_OPEN", "Market is not accepting negotiations");
    if (ctx.campaign.state !== "LIVE") fail(400, "CAMPAIGN_NOT_LIVE", "Campaign is not live");
    if (!ctx.version.deadline || ctx.version.deadline <= now) fail(400, "EXPIRED", "Campaign deadline has passed");
    if (ctx.funding.status !== "CONFIRMED") fail(400, "NOT_FUNDED", "Policy version is not funded");
    const existingTerms = await ms.getTerms(params.campaignId, ctx.profile.id);
    if (existingTerms) fail(409, "TERMS_EXIST", "Partner already holds frozen terms for this campaign");
    const requested = params.allocationCount ?? ctx.profile.rules.maxAllocationCount ?? 1;
    if (!Number.isInteger(requested) || requested < 1) fail(400, "BAD_REQUEST", "Allocation must be a positive integer");
    if (ctx.profile.rules.maxAllocationCount !== null && requested > ctx.profile.rules.maxAllocationCount) {
      fail(400, "MAX_ALLOCATION", "Requested allocation exceeds Partner maximum");
    }
    const expiry = params.expiresAt ? new Date(params.expiresAt) : new Date(Math.min(ctx.version.deadline.getTime(), now.getTime() + DEFAULT_OFFER_TTL_MS));
    if (Number.isNaN(expiry.getTime()) || expiry <= now) fail(400, "BAD_REQUEST", "Offer expiry must be in the future");
    if (expiry > ctx.version.deadline) fail(400, "BAD_REQUEST", "Offer expiry cannot exceed the campaign deadline");

    const active = await ms.getActiveNegotiation(params.campaignId, ctx.profile.id);
    let row: StoredNegotiation;
    if (!active) {
      row = await ms.insertNegotiation({
        id: newId(),
        campaignId: params.campaignId,
        partnerId: ctx.profile.id,
        askMicroUsdc: ask,
        referenceBountyMicroUsdc: ctx.market.publicBountyMicroUsdc,
        policyVersion: ctx.market.policyVersion,
        marketVersion: ctx.market.version,
        allocationCount: requested,
        expiresAt: expiry,
      });
      await audit({
        actorType: "USER", actorId: params.userId, workspaceId: ctx.campaign.workspaceId, partnerId: ctx.profile.id,
        action: "negotiation.opened", targetType: "negotiation", targetId: row.id,
        metadata: { campaignId: params.campaignId, partnerId: ctx.profile.id, negotiationId: row.id, round: 1, askMicroUsdc: ask.toString() },
      });
    } else {
      // Identical ask against the identical market state: pure duplicate.
      // A moved market (new version) always starts a fresh round instead.
      if (active.askMicroUsdc === ask && active.marketVersion === ctx.market.version) {
        const latest = await ms.getLatestNegotiationDecision(active.id);
        return { negotiation: serializeNegotiation(active), evaluation: latest ? serializeDecision(latest) : null, alreadyRecorded: true as const };
      }
      if (active.round + 1 > MAX_NEGOTIATION_ROUNDS + 1) {
        fail(409, "MAX_ROUNDS", "Negotiation round limit reached; start over after terminal state");
      }
      row = await ms.updateNegotiation(active.id, {
        round: active.round + 1,
        status: "OPEN",
        askMicroUsdc: ask,
        referenceBountyMicroUsdc: ctx.market.publicBountyMicroUsdc,
        counterMicroUsdc: null,
        marketVersion: ctx.market.version,
        expiresAt: expiry,
      });
    }
    const evaluated = await evaluateRow(ms, audit, row, ctx, params.userId, now);
    return {
      negotiation: serializeNegotiation(evaluated.row),
      evaluation: evaluated.decision,
      alreadyRecorded: false as const,
    };
  });
}

interface SerializedNegotiationDecision {
  id: string;
  decision: string;
  reasonCodes: string[];
  counterMicroUsdc: string | null;
  autoExecuted: boolean;
  inputsHash: string;
  inputs: Record<string, unknown>;
}

interface Evaluated {
  row: StoredNegotiation;
  decision: SerializedNegotiationDecision | null;
}

interface DecisionInput {
  decision: string;
  counterMicroUsdc: bigint | null;
  urgency: string;
  reasons: string[];
  inputs: Record<string, unknown>;
  maxAffordableMicroUsdc: bigint;
  inputsHash?: string;
}

async function evaluateRow(
  ms: MarketStore,
  audit: AuditSink,
  row: StoredNegotiation,
  ctx: Awaited<ReturnType<typeof loadSupplierContext>>,
  userId: string,
  now: Date,
): Promise<Evaluated> {
  if (row.status === "ACCEPTED" || row.status === "REJECTED" || row.status === "EXPIRED" || row.status === "WITHDRAWN") {
    const latest = await ms.getLatestNegotiationDecision(row.id);
    if (!latest) fail(500, "INTERNAL", "Terminal negotiation has no decision");
    return { row, decision: serializeDecision(latest) };
  }
  if (row.status === "HOLD") {
    const latest = await ms.getLatestNegotiationDecision(row.id);
    if (!latest) fail(500, "INTERNAL", "Held negotiation has no decision");
    return { row, decision: serializeDecision(latest) };
  }
  if (row.expiresAt <= now) {
    const expired = await ms.updateNegotiation(row.id, { status: "EXPIRED" });
    await audit({
      actorType: "SYSTEM", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: row.partnerId,
      action: "negotiation.expired", targetType: "negotiation", targetId: row.id,
      metadata: { campaignId: row.campaignId, negotiationId: row.id, round: row.round },
    });
    return { row: expired, decision: null as unknown as Evaluated["decision"] };
  }

  // Market moved under the offer (S6 repriced/paused): HOLD for fresh input.
  if (row.marketVersion !== ctx.market.version) {
    const held = await ms.updateNegotiation(row.id, { status: "HOLD", counterMicroUsdc: null });
    const decision = await recordDecision(ms, audit, held, ctx, {
      decision: "HOLD",
      counterMicroUsdc: null,
      urgency: "HEALTHY",
      reasons: ["MARKET_MOVED"],
      inputs: { marketVersionAtAsk: row.marketVersion, marketVersionNow: ctx.market.version },
      maxAffordableMicroUsdc: 0n,
    });
    return { row: held, decision };
  }

  const kernelInputs = await buildKernelInputs(ms, ctx, row.askMicroUsdc, row.round, now);
  const result = evaluateNegotiationOffer(kernelInputs);
  const hash = createHash("sha256").update(JSON.stringify([row.id, row.round, result.inputs]), "utf8").digest("hex");
  const latest = await ms.getLatestNegotiationDecision(row.id);
  if (latest && latest.inputsHash === hash) {
    return { row, decision: serializeDecision(latest) };
  }
  // ACCEPT commits economics first and records its decision after, so the
  // audit trail can never show an ACCEPT that did not actually commit.
  if (result.decision === "ACCEPT") {
    return acceptOffer(ms, audit, row, ctx, {
      reasons: [...result.reasons],
      inputs: result.inputs as Record<string, unknown>,
      inputsHash: hash,
      urgency: result.urgency,
    }, userId);
  }
  const decision = await recordDecision(ms, audit, row, ctx, { ...result, inputsHash: hash });

  if (result.decision === "COUNTER") {
    const countered = await ms.updateNegotiation(row.id, { status: "COUNTERED", counterMicroUsdc: result.counterMicroUsdc as bigint });
    await audit({
      actorType: "AGENT", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: row.partnerId,
      action: "negotiation.countered", targetType: "negotiation", targetId: row.id,
      metadata: { campaignId: row.campaignId, negotiationId: row.id, round: row.round, counterMicroUsdc: (result.counterMicroUsdc as bigint).toString() },
    });
    return { row: countered, decision };
  }
  if (result.decision === "HOLD") {
    const held = await ms.updateNegotiation(row.id, { status: "HOLD" });
    await audit({
      actorType: "AGENT", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: row.partnerId,
      action: "negotiation.held", targetType: "negotiation", targetId: row.id,
      metadata: { campaignId: row.campaignId, negotiationId: row.id, round: row.round, reasons: result.reasons },
    });
    return { row: held, decision };
  }
  const rejected = await ms.updateNegotiation(row.id, { status: "REJECTED" });
  await audit({
    actorType: "AGENT", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: row.partnerId,
    action: "negotiation.rejected", targetType: "negotiation", targetId: row.id,
    metadata: { campaignId: row.campaignId, negotiationId: row.id, round: row.round, reasons: result.reasons },
  });
  return { row: rejected, decision };
}

async function recordDecision(
  ms: MarketStore,
  audit: AuditSink,
  row: StoredNegotiation,
  _ctx: Awaited<ReturnType<typeof loadSupplierContext>>,
  result: DecisionInput,
) {
  void _ctx;
  const hash =
    result.inputsHash ??
    createHash("sha256").update(JSON.stringify([row.id, row.round, result.inputs]), "utf8").digest("hex");
  try {
    const inserted = await ms.insertNegotiationDecision({
      id: newId(),
      negotiationId: row.id,
      round: row.round,
      decision: result.decision,
      reasonCodes: [...result.reasons],
      inputsJson: result.inputs as Record<string, unknown>,
      inputsHash: hash,
      askMicroUsdc: row.askMicroUsdc,
      counterMicroUsdc: result.counterMicroUsdc,
      autoExecuted: true,
    });
    return serializeDecision(inserted);
  } catch (e) {
    const { isUniqueViolation } = await import("./campaignStore");
    if (!isUniqueViolation(e)) throw e;
    const winner = await ms.getLatestNegotiationDecision(row.id);
    if (!winner) throw e;
    return serializeDecision(winner);
  }
}

/**
 * ACCEPT freezes economics: mint PartnerTerms at the ask + a referral route
 * so S4/S5 consume the snapshot through the existing pipeline. No payment
 * happens here — only verified outcomes can ever pay, via S5.
 */
/**
 * ACCEPT commits economics: revalidate everything fresh inside the same
 * transaction, then mint terms + referral + supply commitment atomically.
 * The kernel result is advisory only — this commit is authoritative. On any
 * guard failure the negotiation closes REJECTED with an explicit reason, so
 * the audit trail always matches the outcome (never ACCEPT-decided-but-lost).
 */
async function acceptOffer(
  ms: MarketStore,
  audit: AuditSink,
  row: StoredNegotiation,
  ctx: Awaited<ReturnType<typeof loadSupplierContext>>,
  kernel: { reasons: string[]; inputs: Record<string, unknown>; inputsHash: string; urgency: string },
  userId: string,
): Promise<Evaluated> {
  const rejectWith = async (reasons: string[]) => {
    const rejected = await ms.updateNegotiation(row.id, { status: "REJECTED" });
    const decision = await recordDecision(ms, audit, rejected, ctx, {
      decision: "REJECT",
      counterMicroUsdc: null,
      urgency: kernel.urgency ?? "HEALTHY",
      reasons,
      inputs: kernel.inputs,
      maxAffordableMicroUsdc: 0n,
    });
    await audit({
      actorType: "AGENT", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: row.partnerId,
      action: "negotiation.rejected", targetType: "negotiation", targetId: row.id,
      metadata: { campaignId: row.campaignId, negotiationId: row.id, round: row.round, reasons },
    });
    return { row: rejected, decision };
  };

  // Fresh revalidation: funding, capacity, market, supplier may all have
  // moved since the kernel ran (concurrent accepts serialize here).
  const market = await ms.getMarket(row.campaignId);
  if (!market || market.status !== "OPEN" || market.version !== row.marketVersion) {
    return rejectWith([market && market.status !== "OPEN" ? "MARKET_NOT_OPEN" : "MARKET_MOVED"]);
  }
  const campaign = await ms.getCampaign(row.campaignId);
  if (!campaign || campaign.state !== "LIVE") return rejectWith(["CAMPAIGN_NOT_LIVE"]);
  const version = await ms.getVersion(row.campaignId, row.policyVersion);
  if (!version?.deadline || version.status !== "APPROVED") return rejectWith(["POLICY_SUPERSEDED"]);
  if (campaign.currentPolicyVersionId !== version.id) return rejectWith(["POLICY_SUPERSEDED"]);
  const funding = await ms.getFunding(row.campaignId, row.policyVersion);
  if (!funding || funding.status !== "CONFIRMED") return rejectWith(["POLICY_NOT_FUNDED"]);
  const profile = await ms.getPartnerById(row.partnerId);
  if (!profile?.payoutWallet) return rejectWith(["WALLET_REQUIRED"]);
  const existingTerms = await ms.getTerms(row.campaignId, row.partnerId);
  if (existingTerms) return rejectWith(["TERMS_EXIST"]);
  const funded = funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc;
  const reservations = await ms.listReservationsByCampaign(row.campaignId);
  const committedReservations = reservations
    .filter((r) => ["RESERVED", "SUBMITTED", "AMBIGUOUS", "SETTLED"].includes(r.state))
    .reduce((sum, r) => sum + r.amountMicroUsdc, 0n);
  const commitments = await ms.listActiveCommitments(row.campaignId);
  const committedSupply = commitments.reduce((sum, c) => sum + c.amountMicroUsdc, 0n);
  const free = funded - committedReservations - committedSupply;
  if (row.askMicroUsdc > free) return rejectWith(["INSUFFICIENT_BUDGET"]);
  const verified = await ms.countVerifiedOutcomes(row.campaignId);
  const remaining = Math.max(0, (version.targetOutcomeCount as number) - verified);
  if (commitments.length + 1 > remaining) return rejectWith(["NO_CAPACITY"]);
  if (version.bountyCeilingMicroUsdc !== null && row.askMicroUsdc > (version.bountyCeilingMicroUsdc as bigint)) {
    return rejectWith(["ASK_ABOVE_CEILING"]);
  }
  if (version.bountyFloorMicroUsdc !== null && row.askMicroUsdc < (version.bountyFloorMicroUsdc as bigint)) {
    return rejectWith(["ASK_BELOW_FLOOR"]);
  }

  try {
    const terms = await ms.insertTerms({
      id: newId(),
      campaignId: row.campaignId,
      partnerId: row.partnerId,
      priceMicroUsdc: row.askMicroUsdc,
      allocationCount: row.allocationCount,
      source: TERMS_SOURCE_NEGOTIATED,
      expiresAt: version.deadline as Date,
      policyVersion: row.policyVersion,
      marketVersion: row.marketVersion,
    });
    let referral: { id: string; code: string } | null = null;
    for (let attempt = 0; attempt < 3 && !referral; attempt += 1) {
      try {
        const inserted = await ms.insertReferral({
          id: newId(),
          code: newReferralCode(),
          campaignId: row.campaignId,
          partnerId: row.partnerId,
          partnerTermsId: terms.id,
        });
        referral = { id: inserted.id, code: inserted.code };
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e;
      }
    }
    if (!referral) fail(500, "INTERNAL", "Could not mint a referral code");
    const commitment = await ms.insertSupplyCommitment({
      id: newId(),
      campaignId: row.campaignId,
      negotiationId: row.id,
      partnerId: row.partnerId,
      partnerTermsId: terms.id,
      amountMicroUsdc: row.askMicroUsdc,
      expiresAt: version.deadline as Date,
    });
    const accepted = await ms.updateNegotiation(row.id, { status: "ACCEPTED" });
    const decision = await recordDecision(ms, audit, accepted, ctx, {
      decision: "ACCEPT",
      counterMicroUsdc: null,
      urgency: kernel.urgency ?? "HEALTHY",
      reasons: ["WITHIN_SAFE_BAND"],
      inputs: kernel.inputs,
      maxAffordableMicroUsdc: 0n,
    });
    void userId;
    await audit({
      actorType: "AGENT", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: row.partnerId,
      action: "negotiation.accepted", targetType: "negotiation", targetId: row.id,
      metadata: {
        campaignId: row.campaignId, negotiationId: row.id, round: row.round,
        priceMicroUsdc: row.askMicroUsdc.toString(), termsId: terms.id,
        referralId: (referral as { id: string }).id, policyVersion: row.policyVersion,
        commitmentId: commitment.id,
      },
    });
    await audit({
      actorType: "AGENT", actorId: null, workspaceId: ctx.campaign.workspaceId, partnerId: row.partnerId,
      action: "referral.created", targetType: "referral", targetId: (referral as { id: string }).id,
      metadata: { campaignId: row.campaignId, partnerId: row.partnerId, referralId: (referral as { id: string }).id },
    });
    return { row: accepted, decision };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Lost a race (or terms appeared via join meanwhile): deterministic close.
    const current = await ms.getNegotiation(row.id);
    if (current && current.status === "ACCEPTED") {
      const latest = await ms.getLatestNegotiationDecision(row.id);
      return { row: current, decision: latest ? serializeDecision(latest) : null };
    }
    return rejectWith(["TERMS_EXIST"]);
  }
}

/** Evaluate one negotiation by id (worker + read paths share this). */
export async function evaluateNegotiation(deps: NegotiationDeps, params: { negotiationId: string }) {
  const now = deps.now?.() ?? new Date();
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const row = await ms.getNegotiation(params.negotiationId);
    if (!row) fail(404, "NOT_FOUND", "Negotiation not found");
    const campaign = await ms.getCampaign(row.campaignId);
    if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
    // Rebuild context without supplier auth (worker path); profile lookup by id.
    const profile = await ms.getPartnerById(row.partnerId);
    if (!profile) fail(404, "NOT_FOUND", "Partner not found");
    const parsed = parsePartnerRules(profile.rulesJson);
    if (!parsed.ok || !profile.payoutWallet) fail(500, "INTERNAL", "Partner profile is invalid");
    const workspace = await ms.getWorkspace(campaign.workspaceId);
    const market = await ms.getMarket(row.campaignId);
    if (!market) fail(404, "MARKET_NOT_OPEN", "No market for this campaign");
    const version = await ms.getVersion(row.campaignId, market.policyVersion);
    const funding = await ms.getFunding(row.campaignId, market.policyVersion);
    if (!version || !funding) fail(500, "INTERNAL", "Policy/funding is missing");
    const ctx = {
      campaign: { id: campaign.id, state: campaign.state, workspaceId: campaign.workspaceId, currentPolicyVersionId: campaign.currentPolicyVersionId },
      workspaceCategory: workspace?.category ?? null,
      market: {
        campaignId: market.campaignId,
        publicBountyMicroUsdc: market.publicBountyMicroUsdc,
        status: market.status,
        version: market.version,
        policyVersion: market.policyVersion,
        openedAt: market.openedAt,
      },
      version: {
        id: version.id,
        version: version.version,
        targetOutcomeCount: version.targetOutcomeCount,
        bountyFloorMicroUsdc: version.bountyFloorMicroUsdc,
        bountyCeilingMicroUsdc: version.bountyCeilingMicroUsdc,
        minQualifyingPurchaseMicroUsdc: version.minQualifyingPurchaseMicroUsdc,
        deadline: version.deadline,
        marketVisibility: version.marketVisibility,
      },
      funding: {
        campaignKey: funding.campaignKey,
        policyHash: funding.policyHash,
        observedAmountMicroUsdc: funding.observedAmountMicroUsdc,
        expectedAmountMicroUsdc: funding.expectedAmountMicroUsdc,
        status: funding.status,
      },
      profile: {
        id: profile.id,
        payoutWallet: profile.payoutWallet,
        rules: (parsed as { ok: true; rules: PartnerRules }).rules,
      },
    };
    const evaluated = await evaluateRow(ms, audit, row, ctx, profile.userId, now);
    return {
      negotiation: serializeNegotiation(evaluated.row),
      evaluation: evaluated.decision,
      alreadyRecorded: false as const,
    };
  });
}

function serializeDecision(d: {
  id: string;
  decision: string;
  reasonCodes: string[];
  counterMicroUsdc: bigint | null;
  autoExecuted: boolean;
  inputsHash: string;
  inputsJson: Record<string, unknown>;
}) {
  return {
    id: d.id,
    decision: d.decision,
    reasonCodes: [...d.reasonCodes],
    counterMicroUsdc: d.counterMicroUsdc === null ? null : d.counterMicroUsdc.toString(),
    autoExecuted: d.autoExecuted,
    inputsHash: d.inputsHash,
    inputs: d.inputsJson,
  };
}

/** Supplier withdraws their open offer. Terminal, no kernel involvement. */
export async function withdrawNegotiation(deps: NegotiationDeps, params: { negotiationId: string; userId: string }) {
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const row = await ms.getNegotiation(params.negotiationId);
    if (!row) fail(404, "NOT_FOUND", "Negotiation not found");
    const profile = await ms.getPartnerByUserId(params.userId);
    if (!profile || profile.id !== row.partnerId) fail(403, "FORBIDDEN", "Only the offering supplier can withdraw");
    if (row.status !== "OPEN" && row.status !== "COUNTERED" && row.status !== "HOLD" && row.status !== "ACCEPTED") {
      fail(409, "NOT_WITHDRAWABLE", "Only open offers can be withdrawn");
    }
    const campaign = await ms.getCampaign(row.campaignId);
    // Withdrawing an ACCEPTED negotiation revokes its terms and releases its
    // commitment exactly once; downstream S5 rows keep their own lifecycle.
    let releasedCommitmentId: string | null = null;
    if (row.status === "ACCEPTED") {
      const terms = await ms.getTerms(row.campaignId, row.partnerId);
      if (terms) await ms.updateTermsStatus(terms.id, "REVOKED");
      const commitment = await ms.getCommitmentByNegotiation(row.id);
      if (commitment && commitment.state === "ACTIVE") {
        await ms.updateSupplyCommitment(commitment.id, { state: "RELEASED", releasedReason: "SUPPLIER_WITHDRAWN" });
        releasedCommitmentId = commitment.id;
      }
    }
    const withdrawn = await ms.updateNegotiation(row.id, { status: "WITHDRAWN" });
    await audit({
      actorType: "USER", actorId: params.userId, workspaceId: campaign?.workspaceId ?? null, partnerId: row.partnerId,
      action: "negotiation.withdrawn", targetType: "negotiation", targetId: row.id,
      metadata: { campaignId: row.campaignId, negotiationId: row.id, round: row.round, releasedCommitmentId },
    });
    return { negotiation: serializeNegotiation(withdrawn) };
  });
}

/** Read model: status, prices, rounds, urgency, reasons, expiry, frozen price. */
export async function getNegotiationView(deps: NegotiationDeps, params: { negotiationId: string; userId: string }) {
  const row = await deps.store.getNegotiation(params.negotiationId);
  if (!row) fail(404, "NOT_FOUND", "Negotiation not found");
  const campaign = await deps.store.getCampaign(row.campaignId);
  const profile = await deps.store.getPartnerByUserId(params.userId);
  const isSupplier = !!profile && profile.id === row.partnerId;
  const isMember = campaign ? await deps.store.getMembership(campaign.workspaceId, params.userId) : null;
  if (!isSupplier && !isMember) fail(403, "FORBIDDEN", "Not authorized for this negotiation");
  const latest = await deps.store.getLatestNegotiationDecision(row.id);
  const terms = await deps.store.getTerms(row.campaignId, row.partnerId);
  const frozen = row.status === "ACCEPTED" && terms ? { termsId: terms.id, priceMicroUsdc: terms.priceMicroUsdc.toString() } : null;
  const commitment = await deps.store.getCommitmentByNegotiation(row.id);
  return {
    negotiation: serializeNegotiation(row),
    latestDecision: latest ? serializeDecision(latest) : null,
    frozen,
    commitment: commitment
      ? {
          id: commitment.id,
          state: commitment.state,
          amountMicroUsdc: commitment.amountMicroUsdc.toString(),
          createdAt: commitment.createdAt.toISOString(),
          consumedByOutcomeId: commitment.consumedByOutcomeId,
          releasedReason: commitment.releasedReason,
        }
      : null,
  };
}

export interface NegotiationWorkerSummary {
  evaluated: number;
  decisions: Array<{ negotiationId: string; decision: string; status: string }>;
  failed: Array<{ negotiationId: string; error: string }>;
}

/** Evaluate OPEN/COUNTERED negotiations. Isolated per row, duplicate-safe. */
export async function processNegotiationEvaluations(
  deps: NegotiationDeps,
  opts?: { negotiationIds?: string[]; campaignId?: string; limit?: number },
): Promise<NegotiationWorkerSummary> {
  const summary: NegotiationWorkerSummary = { evaluated: 0, decisions: [], failed: [] };
  let targets: string[];
  if (opts?.negotiationIds && opts.negotiationIds.length > 0) {
    targets = opts.negotiationIds;
  } else {
    const rows = await deps.store.listActionableNegotiations(opts?.limit ?? 25);
    targets = rows
      .filter((r) => !opts?.campaignId || r.campaignId === opts.campaignId)
      .map((r) => r.id);
  }
  for (const negotiationId of targets) {
    try {
      const r = await evaluateNegotiation(deps, { negotiationId });
      summary.evaluated += 1;
      summary.decisions.push({
        negotiationId,
        decision: r.evaluation?.decision ?? "NONE",
        status: r.negotiation.status,
      });
    } catch (e) {
      summary.failed.push({ negotiationId, error: (e as Error).message });
    }
  }
  return summary;
}

