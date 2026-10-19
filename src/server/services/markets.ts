import { createHash, randomBytes } from "node:crypto";
import { newId } from "../auth/session";
import {
  assertSafeDestinationUrl,
  checkJoinEligibility,
  checkTargetSettled,
  newReferralCode,
  parsePartnerRules,
  serializePartnerRules,
  TERMS_SOURCE_INVITED,
  TERMS_SOURCE_PUBLIC,
  type PartnerRules,
} from "../domain/market";
import { campaignInScope } from "./campaigns";
import { isUniqueViolation } from "./campaignStore";
import type {
  AuditSink,
  FundingStore,
  MarketStore,
  StoredMarket,
  StoredReferral,
  StoredTerms,
} from "./campaignStore";

export interface MarketDeps {
  store: MarketStore;
  audit: AuditSink;
  now?: () => Date;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

async function ownerOrFail(deps: MarketDeps, workspaceId: string, userId: string) {
  const m = await deps.store.getMembership(workspaceId, userId);
  if (!m) fail(403, "FORBIDDEN", "Not a workspace member");
  if (m.role !== "ORGANIZATION_OWNER") fail(403, "FORBIDDEN", "Owner-only operation");
  return m;
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function serializeMarket(m: StoredMarket) {
  return {
    campaignId: m.campaignId,
    publicBountyMicroUsdc: m.publicBountyMicroUsdc.toString(),
    status: m.status,
    destinationUrl: m.destinationUrl,
    version: m.version,
    policyVersion: m.policyVersion,
    openedAt: m.openedAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function serializeTerms(t: StoredTerms) {
  return {
    id: t.id,
    campaignId: t.campaignId,
    partnerId: t.partnerId,
    priceMicroUsdc: t.priceMicroUsdc.toString(),
    allocationCount: t.allocationCount,
    source: t.source,
    expiresAt: t.expiresAt.toISOString(),
    policyVersion: t.policyVersion,
    marketVersion: t.marketVersion,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * Open a market at an owner-approved bootstrap bounty (S3 seam).
 * S6 Demand Agent + pricing kernel will own opening-price strategy; nothing
 * here implies agent pricing is shipped.
 */
export async function openMarket(
  deps: MarketDeps,
  params: {
    campaignId: string;
    userId: string;
    expectedPolicyVersion: number;
    openingBountyMicroUsdc: string;
    destinationUrl: string;
  },
) {
  const now = deps.now?.() ?? new Date();
  const { campaign, version } = await campaignInScope(deps, params.campaignId, params.userId);
  await ownerOrFail(deps, campaign.workspaceId, params.userId);
  if (version.version !== params.expectedPolicyVersion) {
    fail(409, "CONFLICT", "Stale policy version", { expected: params.expectedPolicyVersion, current: version.version });
  }
  if (campaign.state !== "LIVE" || version.status !== "APPROVED") {
    fail(400, "BAD_REQUEST", "Market can only open on a LIVE campaign with its APPROVED policy");
  }
  const funding = await deps.store.getFunding(campaign.id, version.version);
  if (!funding || funding.status !== "CONFIRMED") {
    fail(400, "NOT_FUNDED", "Market requires confirmed funding for the current policy version");
  }
  if (
    version.targetOutcomeCount === null ||
    version.budgetMicroUsdc === null ||
    version.bountyFloorMicroUsdc === null ||
    version.bountyCeilingMicroUsdc === null ||
    version.deadline === null
  ) {
    fail(500, "INTERNAL", "Approved policy is missing economic fields");
  }
  const bounty = BigInt(params.openingBountyMicroUsdc);
  if (bounty < (version.bountyFloorMicroUsdc as bigint)) fail(400, "BELOW_FLOOR", "Opening bounty is below the policy floor");
  if (bounty > (version.bountyCeilingMicroUsdc as bigint)) fail(400, "ABOVE_CEILING", "Opening bounty exceeds the policy ceiling");
  const funded = funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc;
  if (BigInt(version.targetOutcomeCount) * bounty > funded) {
    fail(400, "UNAFFORDABLE", "Opening bounty is not affordable against funded budget");
  }
  if ((version.deadline as Date) <= now) fail(400, "EXPIRED", "Campaign deadline has passed");
  const destination = assertSafeDestinationUrl(params.destinationUrl, {
    allowLocalhost: process.env.NODE_ENV !== "production",
  });

  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const existing = await ms.getMarket(campaign.id);
    if (existing) fail(409, "ALREADY_OPEN", "Market is already open for this campaign");
    const market = await ms.insertMarket({
      campaignId: campaign.id,
      publicBountyMicroUsdc: bounty,
      status: "OPEN",
      destinationUrl: destination,
      version: 1,
      policyVersion: version.version,
    });
    await audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: campaign.workspaceId,
      action: "market.opened",
      targetType: "market",
      targetId: campaign.id,
      metadata: {
        campaignId: campaign.id,
        policyVersionId: version.id,
        version: version.version,
        marketVersion: 1,
        publicBountyMicroUsdc: bounty.toString(),
        campaignKey: funding.campaignKey,
        chainId: funding.chainId,
      },
    });
    return { market: serializeMarket(market) };
  });
}

/* ---------------- Target-settled completion (canonical) ---------------- */

export interface TargetSettledEvaluation {
  target: number | null;
  verified: number;
  settledPayouts: number;
  complete: boolean;
}

/**
 * Canonical completion rule. A market is target-settled only when the policy
 * target exists, enough outcomes are VERIFIED, and at least that many payouts
 * for THIS campaign are genuinely SETTLED. VERIFIED != PAID;
 * SUBMITTED/PREPARED/AMBIGUOUS never count. No chain reads, no broadcasts.
 */
export async function evaluateTargetSettled(
  store: MarketStore,
  campaignId: string,
  policyVersion: number,
): Promise<TargetSettledEvaluation> {
  const version = await store.getVersion(campaignId, policyVersion);
  const target = version?.targetOutcomeCount ?? null;
  if (target === null) return { target, verified: 0, settledPayouts: 0, complete: false };
  const verified = await store.countVerifiedOutcomes(campaignId);
  let settledPayouts = 0;
  if (verified >= target) {
    settledPayouts = await countSettledPayouts(store, campaignId);
  }
  return { target, verified, settledPayouts, complete: checkTargetSettled({ target, verifiedOutcomes: verified, settledPayouts }) };
}

/** Shared settled-payout count used by evaluation and the detail fast path. */
export async function countSettledPayouts(store: MarketStore, campaignId: string): Promise<number> {
  const reservations = await store.listReservationsByCampaign(campaignId);
  const payouts = await Promise.all(reservations.map((r) => store.getPayoutByReservation(r.id)));
  let settledPayouts = 0;
  for (const payout of payouts) {
    if (payout && payout.campaignId === campaignId && payout.state === "SETTLED") {
      settledPayouts += 1;
    }
  }
  return settledPayouts;
}

export type FinalizeResult =
  | { finalized: true; marketVersion: number; target: number; verified: number; settledPayouts: number }
  | { finalized: false; reason: string; target: number | null; verified: number; settledPayouts: number };

/**
 * Idempotent market finalization. Closes participation (market CLOSED +
 * version bump, ONE market.completed audit) once the objective is genuinely
 * target-settled. Never touches campaign/vault state, never broadcasts.
 */
export async function finalizeMarketIfTargetSettled(
  store: MarketStore,
  audit: AuditSink,
  params: { campaignId: string },
): Promise<FinalizeResult> {
  const market = await store.getMarket(params.campaignId);
  if (!market) return { finalized: false, reason: "NO_MARKET", target: null, verified: 0, settledPayouts: 0 };
  if (market.status === "CLOSED") {
    return { finalized: false, reason: "ALREADY_CLOSED", target: null, verified: 0, settledPayouts: 0 };
  }
  const ev = await evaluateTargetSettled(store, params.campaignId, market.policyVersion);
  if (!ev.complete || ev.target === null) {
    return { finalized: false, reason: "NOT_COMPLETE", target: ev.target, verified: ev.verified, settledPayouts: ev.settledPayouts };
  }
  let next;
  try {
    next = await store.updateMarket(params.campaignId, market.version, { status: "CLOSED", version: market.version + 1 });
  } catch (e) {
    if ((e as { code?: string }).code === "STALE_MARKET") {
      return { finalized: false, reason: "STALE_VERSION", target: ev.target, verified: ev.verified, settledPayouts: ev.settledPayouts };
    }
    throw e;
  }
  await audit({
    actorType: "SYSTEM",
    actorId: null,
    workspaceId: null,
    partnerId: null,
    action: "market.completed",
    targetType: "market",
    targetId: params.campaignId,
    metadata: {
      campaignId: params.campaignId,
      marketVersion: next.version,
      targetOutcomeCount: ev.target,
      verifiedOutcomes: ev.verified,
      settledPayoutCount: ev.settledPayouts,
      reason: "TARGET_SETTLED",
    },
  });
  return { finalized: true, marketVersion: next.version, target: ev.target, verified: ev.verified, settledPayouts: ev.settledPayouts };
}

/** Public feed: LIVE + OPEN + unexpired + PUBLIC visibility only. */
export async function listPublicMarkets(deps: MarketDeps) {
  const now = deps.now?.() ?? new Date();
  const markets = await deps.store.listMarkets();
  const items = [];
  for (const m of markets) {
    if (m.status !== "OPEN") continue;
    const campaign = await deps.store.getCampaign(m.campaignId);
    if (!campaign || campaign.state !== "LIVE") continue;
    const version = await deps.store.getVersion(m.campaignId, m.policyVersion);
    if (!version || version.status !== "APPROVED") continue;
    if (version.marketVisibility !== "PUBLIC") continue;
    if (!version.deadline || version.deadline <= now) continue;
    // A provably target-settled market is never advertised as live,
    // even if its row has not been finalized to CLOSED yet.
    const settled = await evaluateTargetSettled(deps.store, m.campaignId, m.policyVersion);
    if (settled.complete) continue;
    // Lifecycle strip inputs for live cards: funding + verified + settled counts.
    const [funding, verifiedOutcomes, settledPayouts, workspace] = await Promise.all([
      deps.store.getFunding(m.campaignId, m.policyVersion),
      deps.store.countVerifiedOutcomes(m.campaignId),
      countSettledPayouts(deps.store, m.campaignId),
      deps.store.getWorkspace(campaign.workspaceId),
    ]);
    items.push({
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      workspaceName: workspace?.name ?? "Workspace",
      category: workspace?.category ?? null,
      publicBountyMicroUsdc: m.publicBountyMicroUsdc.toString(),
      marketVersion: m.version,
      policyVersion: m.policyVersion,
      deadline: version.deadline.toISOString(),
      targetOutcomeCount: version.targetOutcomeCount,
      minQualifyingPurchaseMicroUsdc: version.minQualifyingPurchaseMicroUsdc?.toString() ?? null,
      marketStatus: m.status,
      fundingStatus: funding?.status ?? null,
      verifiedOutcomes,
      settledPayouts,
    });
  }
  return { markets: items };
}

/* ---------------- Public history + judge detail (read-only) ---------------- */

function isLivePublicMarket(
  market: StoredMarket,
  campaign: { state: string },
  version: { status: string; marketVisibility: string; deadline: Date | null } | null,
  now: Date,
): boolean {
  if (market.status !== "OPEN") return false;
  if (campaign.state !== "LIVE") return false;
  if (!version || version.status !== "APPROVED") return false;
  if (version.marketVisibility !== "PUBLIC") return false;
  if (!version.deadline || version.deadline <= now) return false;
  return true;
}

export interface CompletedMarketMetrics {
  verifiedOutcomes: number;
  settledPayouts: number;
  settledSpendMicroUsdc: string;
  verifiedRevenueMicroUsdc: string | null;
  realizedCacMicroUsdc: string | null;
  remainingMicroUsdc: string | null;
  partnerCount: number;
}

async function completedMetrics(
  deps: MarketDeps,
  campaignId: string,
  budgetMicroUsdc: bigint | null,
): Promise<CompletedMarketMetrics> {
  const reservations = await deps.store.listReservationsByCampaign(campaignId);
  const [payoutRows, verifiedCount] = await Promise.all([
    Promise.all(reservations.map((r) => deps.store.getPayoutByReservation(r.id))),
    deps.store.countVerifiedOutcomes(campaignId),
  ]);
  let spend = 0n;
  let revenue = 0n;
  let verified = 0;
  let settledPayouts = 0;
  const partners = new Set<string>();
  for (let i = 0; i < reservations.length; i++) {
    const r = reservations[i];
    const payout = payoutRows[i];
    partners.add(r.partnerId);
    if (r.state === "SETTLED") spend += r.amountMicroUsdc;
    if (payout && payout.campaignId === campaignId && payout.state === "SETTLED") settledPayouts += 1;
    const outcome = await deps.store.getOutcome(r.outcomeId);
    if (outcome && outcome.status === "VERIFIED") {
      verified += 1;
      revenue += outcome.purchaseAmountMicroUsdc;
    }
  }
  return {
    verifiedOutcomes: Math.max(verified, verifiedCount),
    settledPayouts,
    settledSpendMicroUsdc: spend.toString(),
    verifiedRevenueMicroUsdc: verified > 0 ? revenue.toString() : null,
    realizedCacMicroUsdc: verified > 0 && spend > 0n ? (spend / BigInt(verified)).toString() : null,
    remainingMicroUsdc: budgetMicroUsdc === null ? null : (budgetMicroUsdc - spend).toString(),
    partnerCount: partners.size,
  };
}

/**
 * Public markets that are no longer accepting participation but keep proof.
 * Never mutates; never includes non-PUBLIC campaigns.
 */
export async function listCompletedMarkets(deps: MarketDeps) {
  const now = deps.now?.() ?? new Date();
  const markets = await deps.store.listMarkets();
  const items = [];
  for (const m of markets) {
    const campaign = await deps.store.getCampaign(m.campaignId);
    if (!campaign) continue;
    const version = await deps.store.getVersion(m.campaignId, m.policyVersion);
    if (!version || version.status !== "APPROVED") continue;
    if (version.marketVisibility !== "PUBLIC") continue;
    const settled = await evaluateTargetSettled(deps.store, m.campaignId, m.policyVersion);
    if (isLivePublicMarket(m, campaign, version, now) && !settled.complete) continue;
    const [workspace, metrics, funding] = await Promise.all([
      deps.store.getWorkspace(campaign.workspaceId),
      completedMetrics(deps, m.campaignId, version.budgetMicroUsdc),
      deps.store.getFunding(m.campaignId, m.policyVersion),
    ]);
    items.push({
      campaignId: campaign.id,
      workspaceName: workspace?.name ?? "Workspace",
      fundingStatus: funding?.status ?? null,
      category: workspace?.category ?? null,
      goal: version.targetOutcomeCount,
      finalState: campaign.state,
      marketStatus: m.status,
      completionReason: settled.complete ? "TARGET_SETTLED" : "ENDED",
      finalBountyMicroUsdc: m.publicBountyMicroUsdc.toString(),
      deadline: version.deadline?.toISOString() ?? null,
      startedAt: campaign.createdAt.toISOString(),
      policyVersion: m.policyVersion,
      ...metrics,
    });
  }
  return { markets: items };
}

function txUrl(explorerBaseUrl: string | null, txHash: string | null): string | null {
  if (!explorerBaseUrl || !txHash) return null;
  return `${explorerBaseUrl.replace(/\/$/, "")}/tx/${txHash}`;
}

/**
 * Judge-proof public detail. PUBLIC campaigns only; private ones 404.
 * Exposes only safe fields: no policy JSON, no secrets, no customer PII,
 * no private negotiation terms.
 */
export async function getPublicMarketDetail(
  deps: MarketDeps,
  params: { campaignId: string; explorerBaseUrl?: string | null },
) {
  const now = deps.now?.() ?? new Date();
  const base = params.explorerBaseUrl ?? null;
  // Batch 1: campaign + market are independent of each other.
  const [campaign, market] = await Promise.all([
    deps.store.getCampaign(params.campaignId),
    deps.store.getMarket(params.campaignId),
  ]);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  if (!market) fail(404, "MARKET_NOT_FOUND", "No market for this campaign");
  // Batch 2: everything derivable from campaign + market, all independent.
  const [version, workspace, verifiedCount, reservations, funding, latestDecision] = await Promise.all([
    deps.store.getVersion(params.campaignId, market.policyVersion),
    deps.store.getWorkspace(campaign.workspaceId),
    deps.store.countVerifiedOutcomes(params.campaignId),
    deps.store.listReservationsByCampaign(params.campaignId),
    deps.store.getFunding(params.campaignId, market.policyVersion),
    deps.store.getLatestPricingDecision(params.campaignId),
  ]);
  if (!version || version.marketVisibility !== "PUBLIC") fail(404, "NOT_FOUND", "Campaign not found");
  // Batch 3: per-reservation payout + outcome pairs, all independent.
  // Each outcome is fetched exactly once and reused below (no second loop,
  // no re-read inside completion evaluation).
  const perReservation = await Promise.all(
    reservations.map(async (r) => ({
      reservation: r,
      payout: await deps.store.getPayoutByReservation(r.id),
      outcome: await deps.store.getOutcome(r.outcomeId),
    })),
  );
  const target = version.targetOutcomeCount ?? null;
  let settledPayouts = 0;
  for (const { payout } of perReservation) {
    if (payout && payout.campaignId === params.campaignId && payout.state === "SETTLED") {
      settledPayouts += 1;
    }
  }
  const targetComplete = checkTargetSettled({ target, verifiedOutcomes: verifiedCount, settledPayouts });
  const live = isLivePublicMarket(market, campaign, version, now) && !targetComplete;
  const partners = new Set<string>();
  let spend = 0n;
  const payouts: Array<{
    id: string; recipient: string; amountMicroUsdc: string; state: string;
    txHash: string | null; explorerUrl: string | null; blockNumber: number | null; settledAt: string | null;
  }> = [];
  const outcomeProofs: string[] = [];
  const purchaseTxs: Array<{ txHash: string; explorerUrl: string | null; amountMicroUsdc: string; status: string }> = [];
  let settledPayoutTotal = 0n;
  let revenue = 0n;
  let verified = 0;
  for (const { reservation: r, payout, outcome } of perReservation) {
    partners.add(r.partnerId);
    if (r.state === "SETTLED") spend += r.amountMicroUsdc;
    if (payout) {
      if (payout.state === "SETTLED") settledPayoutTotal += payout.amountMicroUsdc;
      payouts.push({
        id: payout.id,
        recipient: payout.recipient,
        amountMicroUsdc: payout.amountMicroUsdc.toString(),
        state: payout.state,
        txHash: payout.txHash,
        explorerUrl: txUrl(base, payout.txHash),
        blockNumber: payout.blockNumber,
        settledAt: payout.settledAt?.toISOString() ?? null,
      });
    }
    if (outcome?.proofHash) outcomeProofs.push(outcome.proofHash);
    if (outcome && outcome.status === "VERIFIED") {
      verified += 1;
      revenue += outcome.purchaseAmountMicroUsdc;
      purchaseTxs.push({
        txHash: outcome.purchaseTx,
        explorerUrl: txUrl(base, outcome.purchaseTx),
        amountMicroUsdc: outcome.purchaseAmountMicroUsdc.toString(),
        status: outcome.status,
      });
    }
  }
  const core = {
    campaignId: campaign.id,
    workspaceName: workspace?.name ?? "Workspace",
    category: workspace?.category ?? null,
    state: campaign.state,
    marketStatus: market.status,
    live,
    objective: version.intentText,
    qualificationRule: version.minQualifyingPurchaseMicroUsdc?.toString() ?? null,
    approvedBudgetMicroUsdc: version.budgetMicroUsdc?.toString() ?? null,
    publicBountyMicroUsdc: market.publicBountyMicroUsdc.toString(),
    bountyFloorMicroUsdc: version.bountyFloorMicroUsdc?.toString() ?? null,
    bountyCeilingMicroUsdc: version.bountyCeilingMicroUsdc?.toString() ?? null,
    deadline: version.deadline?.toISOString() ?? null,
    startedAt: campaign.createdAt.toISOString(),
    progress: { verified: verifiedCount, target: version.targetOutcomeCount },
    participatingPartners: partners.size,
    latestAgentDecision: latestDecision
      ? {
          decision: latestDecision.decision,
          paceState: latestDecision.paceState,
          reasonCodes: latestDecision.reasonCodes,
          oldBountyMicroUsdc: latestDecision.oldBountyMicroUsdc?.toString() ?? null,
          newBountyMicroUsdc: latestDecision.newBountyMicroUsdc?.toString() ?? null,
          createdAt: latestDecision.createdAt.toISOString(),
        }
      : null,
    verifiedOutcomes: verifiedCount,
    funding: funding
      ? {
          status: funding.status,
          expectedMicroUsdc: funding.expectedAmountMicroUsdc.toString(),
          observedMicroUsdc: funding.observedAmountMicroUsdc?.toString() ?? null,
          createTxHash: funding.createTxHash,
          fundingTxHash: funding.fundingTxHash,
          fundingExplorerUrl: txUrl(base, funding.fundingTxHash),
          blockNumber: funding.blockNumber,
        }
      : null,
  };
  if (live) return { ...core, kind: "live" as const };
  // revenue/verified already accumulated in the single pass above.
  return {
    ...core,
    kind: "completed" as const,
    completionReason: targetComplete ? "TARGET_SETTLED" : "ENDED",
    settledSpendMicroUsdc: spend.toString(),
    finalOutcome: {
      reachedTarget: version.targetOutcomeCount !== null && verifiedCount >= version.targetOutcomeCount,
      verifiedOutcomes: verifiedCount,
      goal: version.targetOutcomeCount,
    },
    timeline: { startedAt: campaign.createdAt.toISOString(), deadline: version.deadline?.toISOString() ?? null },
    payouts,
    settledPayoutTotalMicroUsdc: settledPayoutTotal.toString(),
    purchaseTxs,
    displayNotes: [
      "SUBMITTED is not SETTLED: only onchain OutcomePaid reconciliation settles a payout.",
      "A VERIFIED outcome is not a paid Partner: payment happens only through the payout path above.",
    ],
    verifiedRevenueMicroUsdc: verified > 0 ? revenue.toString() : null,
    realizedCacMicroUsdc: verified > 0 && spend > 0n ? (spend / BigInt(verified)).toString() : null,
    remainingMicroUsdc:
      version.budgetMicroUsdc === null ? null : (version.budgetMicroUsdc - spend).toString(),
    decisionReceipts: latestDecision
      ? [{ decision: latestDecision.decision, reasonCodes: latestDecision.reasonCodes, createdAt: latestDecision.createdAt.toISOString() }]
      : [],
    outcomeProofs,
    payoutExplorerUrls: payouts.map((p) => p.explorerUrl).filter((u): u is string => u !== null),
  };
}

/** Market state for an authenticated user (public-safe fields only). */
export async function getMarketState(deps: MarketDeps, params: { campaignId: string; userId: string }) {
  const campaign = await deps.store.getCampaign(params.campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  // Any authenticated user may read public-safe market fields (join UX).
  const market = await deps.store.getMarket(params.campaignId);
  if (!market) fail(404, "MARKET_NOT_OPEN", "No open market for this campaign");
  const version = await deps.store.getVersion(params.campaignId, market.policyVersion);
  return {
    market: serializeMarket(market),
    campaign: { id: campaign.id, state: campaign.state, workspaceId: campaign.workspaceId },
    deadline: version?.deadline?.toISOString() ?? null,
    visibility: version?.marketVisibility ?? null,
  };
}

export async function getPartnerRules(deps: MarketDeps, params: { userId: string }): Promise<{ rules: ReturnType<typeof serializePartnerRules> }> {
  const profile = await deps.store.getPartnerByUserId(params.userId);
  if (!profile) fail(404, "PARTNER_PROFILE_REQUIRED", "Create a Partner profile first");
  const parsed = parsePartnerRules(profile.rulesJson);
  if (!parsed.ok) fail(500, "INTERNAL", "Stored Partner rules are invalid", parsed.issues);
  return { rules: serializePartnerRules((parsed as { ok: true; rules: PartnerRules }).rules) };
}

export async function updatePartnerRules(
  deps: MarketDeps,
  params: { userId: string; rules: Record<string, unknown> },
) {
  const profile = await deps.store.getPartnerByUserId(params.userId);
  if (!profile) fail(404, "PARTNER_PROFILE_REQUIRED", "Create a Partner profile first");
  const parsed = parsePartnerRules(params.rules);
  if (!parsed.ok) fail(400, "BAD_REQUEST", "Invalid Partner rules", parsed.issues);
  // autoJoin/autoNegotiate/minScoutConfidence/maxAutoJoinsPerDay are STORED
  // in S3; autonomous action reads them as hard gates (see scout authority).
  const updated = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const next = await (store as MarketStore).updatePartnerRules(profile.id, params.rules);
    await audit({
      actorType: "USER",
      actorId: params.userId,
      action: "partner.rules_updated",
      targetType: "partner",
      targetId: profile.id,
      metadata: { partnerId: profile.id },
    });
    return next;
  });
  const reparsed = parsePartnerRules(updated.rulesJson);
  if (!reparsed.ok) fail(500, "INTERNAL", "Stored Partner rules are invalid");
  return { rules: serializePartnerRules((reparsed as { ok: true; rules: PartnerRules }).rules) };
}

/**
 * Authenticated Partner joins at a snapshot of the current public bounty.
 * Idempotent per (campaign, partner): repeats return the original referral.
 * A lost insert race resolves to the winner's terms (no duplicate identity).
 */
export async function joinCampaign(
  deps: MarketDeps,
  params: {
    campaignId: string;
    userId: string;
    allocationCount?: number;
    expectedMarketVersion?: number;
    inviteToken?: string;
    /**
     * Frozen invitation offer: participation is priced + versioned from the
     * invitation, never from the current market. Countersigned markets skip
     * the staleness gate and the private-market token gate (the org
     * invitation is the authorization). Everything else is identical.
     */
    frozenOffer?: { bountyMicroUsdc: bigint; policyVersion: number; marketVersion: number };
  },
) {
  const now = deps.now?.() ?? new Date();
  return deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const profile = await ms.getPartnerByUserId(params.userId);
    if (!profile) fail(404, "PARTNER_PROFILE_REQUIRED", "Create a Partner profile first");
    await ms.lockPartnerRow(profile.id);

    const campaign = await ms.getCampaign(params.campaignId);
    if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
    const market = await ms.getMarket(params.campaignId);
    if (!market) fail(404, "MARKET_NOT_OPEN", "No open market for this campaign");
    // Target-settled markets are closed to new participation even before the
    // row flips to CLOSED: the objective is complete and fully paid.
    const settled = await evaluateTargetSettled(ms, params.campaignId, market.policyVersion);
    if (settled.complete) fail(403, "TARGET_REACHED", "Market objective is complete and settled; participation is closed");
    if (!params.frozenOffer && params.expectedMarketVersion !== undefined && params.expectedMarketVersion !== market.version) {
      fail(409, "STALE_MARKET", "Market version changed; re-read before joining", {
        expected: params.expectedMarketVersion,
        current: market.version,
      });
    }
    const version = await store.getVersion(params.campaignId, market.policyVersion);
    if (!version || !version.deadline) fail(500, "INTERNAL", "Market policy version is missing");

    // Idempotent re-join: return the original terms + referral without
    // consuming another invite or creating a duplicate identity.
    const existing = await ms.getTerms(params.campaignId, profile.id);
    if (existing) {
      const referral = await ms.getReferralByTerms(existing.id);
      if (!referral) fail(500, "INTERNAL", "Terms exist without a referral");
      return {
        terms: serializeTerms(existing),
        referral: { id: referral.id, code: referral.code },
        alreadyJoined: true as const,
      };
    }

    // Private campaigns require a valid owner-issued invite — unless the
    // join countersigns a frozen org invitation (which is the authorization).
    if (version.marketVisibility === "PRIVATE" && !params.frozenOffer) {
      if (!params.inviteToken) fail(403, "INVITE_REQUIRED", "This is a private market: a valid invite is required");
      const invite = await ms.getInviteByHash(hashInviteToken(params.inviteToken));
      if (!invite || invite.campaignId !== params.campaignId) fail(403, "INVITE_INVALID", "Invite is invalid");
      if (invite.expiresAt <= now) fail(403, "INVITE_EXPIRED", "Invite has expired");
      if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
        fail(403, "INVITE_EXHAUSTED", "Invite has no remaining uses");
      }
      await ms.useInvite(invite.tokenHash);
    }

    const parsed = parsePartnerRules(profile.rulesJson);
    if (!parsed.ok) fail(500, "INTERNAL", "Stored Partner rules are invalid", parsed.issues);
    const rules = (parsed as { ok: true; rules: PartnerRules }).rules;
    const workspace = await ms.getWorkspace(campaign.workspaceId);
    const activeCount = (await ms.listPartnerTerms(profile.id)).filter((t) => t.status === "ACTIVE").length;
    const requested = params.allocationCount ?? rules.maxAllocationCount ?? 1;
    const priceMicroUsdc = params.frozenOffer?.bountyMicroUsdc ?? market.publicBountyMicroUsdc;
    const eligibility = checkJoinEligibility({
      marketStatus: market.status,
      campaignLive: campaign.state === "LIVE",
      deadline: version.deadline,
      publicBountyMicroUsdc: priceMicroUsdc,
      rules,
      campaignCategory: workspace?.category ?? null,
      activeTermsCount: activeCount,
      requestedAllocation: requested,
      payoutWallet: profile.payoutWallet,
      now,
    });
    if (!eligibility.ok) {
      const code = eligibility.reason === "MIN_BOUNTY" || eligibility.reason === "MAX_ACTIVE" || eligibility.reason === "MAX_ALLOCATION" || eligibility.reason === "CATEGORY_BLOCKED" || eligibility.reason === "CATEGORY_NOT_ALLOWED" || eligibility.reason === "WALLET_REQUIRED" ? 403 : 400;
      fail(code, eligibility.reason, eligibility.message);
    }

    const termsId = newId();
    let terms: StoredTerms;
    try {
      terms = await ms.insertTerms({
        id: termsId,
        campaignId: params.campaignId,
        partnerId: profile.id,
        priceMicroUsdc: priceMicroUsdc,
        allocationCount: requested,
        source: params.frozenOffer ? TERMS_SOURCE_INVITED : TERMS_SOURCE_PUBLIC,
        expiresAt: version.deadline,
        policyVersion: params.frozenOffer?.policyVersion ?? market.policyVersion,
        marketVersion: params.frozenOffer?.marketVersion ?? market.version,
      });
    } catch (e) {
      // Lost the insert race: return the winner's snapshot (idempotent).
      if (!isUniqueViolation(e)) throw e;
      const winner = await ms.getTerms(params.campaignId, profile.id);
      if (!winner) throw e;
      const winnerReferral = await ms.getReferralByTerms(winner.id);
      if (!winnerReferral) throw e;
      return {
        terms: serializeTerms(winner),
        referral: { id: winnerReferral.id, code: winnerReferral.code },
        alreadyJoined: true as const,
      };
    }

    let referral: StoredReferral | null = null;
    for (let attempt = 0; attempt < 3 && !referral; attempt += 1) {
      try {
        referral = await ms.insertReferral({
          id: newId(),
          code: newReferralCode(),
          campaignId: params.campaignId,
          partnerId: profile.id,
          partnerTermsId: terms.id,
        });
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e;
      }
    }
    if (!referral) fail(500, "INTERNAL", "Could not mint a referral code");

    await audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: campaign.workspaceId,
      partnerId: profile.id,
      action: "partner.joined",
      targetType: "partner_terms",
      targetId: terms.id,
      metadata: {
        campaignId: params.campaignId,
        partnerId: profile.id,
        termsId: terms.id,
        priceMicroUsdc: terms.priceMicroUsdc.toString(),
        policyVersion: terms.policyVersion,
        marketVersion: terms.marketVersion,
      },
    });
    await audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: campaign.workspaceId,
      partnerId: profile.id,
      action: "referral.created",
      targetType: "referral",
      targetId: (referral as StoredReferral).id,
      metadata: {
        campaignId: params.campaignId,
        partnerId: profile.id,
        referralId: (referral as StoredReferral).id,
        code: (referral as StoredReferral).code,
      },
    });
    return {
      terms: serializeTerms(terms),
      referral: { id: (referral as StoredReferral).id, code: (referral as StoredReferral).code },
      alreadyJoined: false as const,
    };
  });
}

/** Partner's joined campaigns with joined-vs-current price context. */
export async function listMyCampaigns(deps: MarketDeps, params: { userId: string }) {
  const profile = await deps.store.getPartnerByUserId(params.userId);
  if (!profile) fail(404, "PARTNER_PROFILE_REQUIRED", "Create a Partner profile first");
  const terms = await deps.store.listPartnerTerms(profile.id);
  const items = [];
  for (const t of terms) {
    const market = await deps.store.getMarket(t.campaignId);
    const campaign = await deps.store.getCampaign(t.campaignId);
    const referral = await deps.store.getReferralByTerms(t.id);
    items.push({
      terms: serializeTerms(t),
      referral: referral ? { id: referral.id, code: referral.code } : null,
      campaignState: campaign?.state ?? null,
      currentPublicBountyMicroUsdc: market?.publicBountyMicroUsdc.toString() ?? null,
      marketVersion: market?.version ?? null,
    });
  }
  return { campaigns: items };
}

/**
 * Creator campaign cards foundation (public-safe).
 *
 * For a creator's partner profile, returns the LIVE campaigns they are
 * participating in with everything a profile card needs: campaign,
 * organization/workspace, objective, payout, state — plus the destination
 * ACTION as a Thesma-tracked referral path (`/r/:code`), never the raw
 * organization URL. The /r route records a CLICK, mints attribution, then
 * redirects to the stored `market_states.destination_url`, so the funnel
 * stays referral → customer action → verification → hold → payout with
 * each stage recorded separately (a click is never a verified outcome).
 *
 * Only genuinely live + public + unexpired + non-target-settled markets
 * are returned. Read-only: no terms, joins, or financial writes.
 */
export interface CreatorLiveCampaignCard {
  campaignId: string;
  workspaceId: string;
  workspaceName: string;
  category: string | null;
  objective: string;
  publicBountyMicroUsdc: string;
  campaignState: string;
  marketStatus: string;
  deadline: string | null;
  referralCode: string;
  /** Tracked CTA destination. Resolve via GET /r/:code for attribution. */
  referralPath: string;
}

export async function listCreatorLiveCampaigns(
  deps: MarketDeps,
  params: { partnerId: string },
): Promise<{ campaigns: CreatorLiveCampaignCard[] }> {
  const now = deps.now?.() ?? new Date();
  const profile = await deps.store.getPartnerById(params.partnerId);
  if (!profile) fail(404, "PARTNER_NOT_FOUND", "Creator profile not found");
  const terms = await deps.store.listPartnerTerms(params.partnerId);
  const items: CreatorLiveCampaignCard[] = [];
  for (const t of terms) {
    if (t.status !== "ACTIVE") continue;
    const [market, campaign] = await Promise.all([
      deps.store.getMarket(t.campaignId),
      deps.store.getCampaign(t.campaignId),
    ]);
    if (!market || !campaign) continue;
    const version = await deps.store.getVersion(t.campaignId, market.policyVersion);
    if (!isLivePublicMarket(market, campaign, version, now)) continue;
    const settled = await evaluateTargetSettled(deps.store, t.campaignId, market.policyVersion);
    if (settled.complete) continue;
    const referral = await deps.store.getReferralByTerms(t.id);
    if (!referral || referral.status !== "ACTIVE") continue;
    const workspace = await deps.store.getWorkspace(campaign.workspaceId);
    items.push({
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      workspaceName: workspace?.name ?? "Workspace",
      category: workspace?.category ?? null,
      objective: version?.intentText ?? "",
      publicBountyMicroUsdc: market.publicBountyMicroUsdc.toString(),
      campaignState: campaign.state,
      marketStatus: market.status,
      deadline: version?.deadline?.toISOString() ?? null,
      referralCode: referral.code,
      referralPath: `/r/${referral.code}`,
    });
  }
  return { campaigns: items };
}

/**
 * Creator discovery: every genuinely live public campaign with this
 * creator's participation state. Unjoined rows carry joined:false;
 * joined rows carry the stable referral code + tracked path (`/r/:code`)
 * created by joinCampaign (idempotent re-join reuses the same referral).
 * Completed / non-public / expired / target-settled markets are excluded
 * by the same rules as the public feed — joining them is refused downstream
 * by joinCampaign itself. Read-only.
 */
export interface CreatorDiscoveryItem {
  campaignId: string;
  workspaceName: string;
  category: string | null;
  objective: string;
  publicBountyMicroUsdc: string;
  campaignState: string;
  marketStatus: string;
  deadline: string | null;
  joined: boolean;
  referralCode: string | null;
  referralPath: string | null;
}

export async function listCreatorDiscovery(
  deps: MarketDeps,
  params: { userId: string },
): Promise<{ campaigns: CreatorDiscoveryItem[] }> {
  const now = deps.now?.() ?? new Date();
  const profile = await deps.store.getPartnerByUserId(params.userId).catch(() => null);
  const markets = await deps.store.listMarkets();
  const items: CreatorDiscoveryItem[] = [];
  for (const m of markets) {
    const campaign = await deps.store.getCampaign(m.campaignId);
    if (!campaign) continue;
    const version = await deps.store.getVersion(m.campaignId, m.policyVersion);
    if (!isLivePublicMarket(m, campaign, version, now)) continue;
    const settled = await evaluateTargetSettled(deps.store, m.campaignId, m.policyVersion);
    if (settled.complete) continue;
    let joined = false;
    let referralCode: string | null = null;
    if (profile) {
      const terms = await deps.store.getTerms(m.campaignId, profile.id);
      if (terms && terms.status === "ACTIVE") {
        const referral = await deps.store.getReferralByTerms(terms.id);
        if (referral && referral.status === "ACTIVE") {
          joined = true;
          referralCode = referral.code;
        }
      }
    }
    const workspace = await deps.store.getWorkspace(campaign.workspaceId);
    items.push({
      campaignId: campaign.id,
      workspaceName: workspace?.name ?? "Workspace",
      category: workspace?.category ?? null,
      objective: version?.intentText ?? "",
      publicBountyMicroUsdc: m.publicBountyMicroUsdc.toString(),
      campaignState: campaign.state,
      marketStatus: m.status,
      deadline: version?.deadline?.toISOString() ?? null,
      joined,
      referralCode,
      referralPath: referralCode ? `/r/${referralCode}` : null,
    });
  }
  return { campaigns: items };
}

/**
 * Pure funnel math shared by the creator + organization views. Inputs are
 * raw rows; outputs are display counts. No I/O, no policy — stage truth
 * stays in the tables (referral_events → checkout_intents/outcomes →
 * reservations/payouts). CLICKED != CONVERTED != VERIFIED != PAID.
 */
export interface FunnelInput {
  clicks: number;
  outcomes: { status: string; holdUntil: Date | null }[];
  settledPayoutMicroUsdc: bigint[];
}

export interface FunnelSummary {
  clicks: number;
  conversions: number;
  verified: number;
  inHold: number;
  settledOutcomes: number;
  settledPayoutMicroUsdc: string;
}

export function summarizeFunnel(input: FunnelInput, now: Date = new Date()): FunnelSummary {
  const verified = input.outcomes.filter((o) => o.status === "VERIFIED").length;
  const inHold = input.outcomes.filter(
    (o) => o.status === "VERIFIED" && o.holdUntil !== null && o.holdUntil.getTime() > now.getTime(),
  ).length;
  const total = input.settledPayoutMicroUsdc.reduce((s, v) => s + v, 0n);
  return {
    clicks: input.clicks,
    conversions: input.outcomes.length,
    verified,
    inHold,
    settledOutcomes: input.settledPayoutMicroUsdc.length,
    settledPayoutMicroUsdc: total.toString(),
  };
}

/** Owner-issued private-market invite. Raw token is returned once, hash stored. */
export async function createInvite(
  deps: MarketDeps,
  params: { campaignId: string; userId: string; expiresAt?: string; maxUses?: number },
) {
  const now = deps.now?.() ?? new Date();
  const campaign = await deps.store.getCampaign(params.campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  await ownerOrFail(deps, campaign.workspaceId, params.userId);
  const version = await deps.store.getCurrentVersion(params.campaignId);
  if (!version || version.marketVisibility !== "PRIVATE") {
    fail(400, "BAD_REQUEST", "Invites are only meaningful for PRIVATE-visibility campaigns");
  }
  const expiresAt = params.expiresAt ? new Date(params.expiresAt) : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    fail(400, "BAD_REQUEST", "Invite expiry must be a future datetime");
  }
  const token = randomBytes(32).toString("hex");
  const invite = await deps.store.atomic(deps.audit, async ({ store, audit }) => {
    const ms = store as MarketStore;
    const row = await ms.insertInvite({
      id: newId(),
      campaignId: params.campaignId,
      tokenHash: hashInviteToken(token),
      expiresAt,
      maxUses: params.maxUses ?? null,
      createdByUserId: params.userId,
    });
    await audit({
      actorType: "USER",
      actorId: params.userId,
      workspaceId: campaign.workspaceId,
      action: "private_invite.created",
      targetType: "private_invite",
      targetId: row.id,
      metadata: {
        campaignId: params.campaignId,
        inviteId: row.id,
        tokenHash: row.tokenHash,
        expiresAt: row.expiresAt.toISOString(),
        maxUses: row.maxUses,
      },
    });
    return row;
  });
  return {
    invite: {
      id: invite.id,
      campaignId: invite.campaignId,
      token,
      expiresAt: invite.expiresAt.toISOString(),
      maxUses: invite.maxUses,
    },
  };
}

export interface ResolvedReferral {
  referral: StoredReferral;
  terms: StoredTerms;
  market: StoredMarket;
  campaignId: string;
  partnerId: string;
  attributable: boolean;
  destinationUrl: string;
}

/**
 * Resolve a referral code for the /r/:code route. Records nothing — the
 * route inserts the CLICK event so visitor context stays at the boundary.
 */
export async function resolveReferral(
  deps: MarketDeps,
  params: { code: string },
): Promise<ResolvedReferral> {
  const now = deps.now?.() ?? new Date();
  const referral = await deps.store.getReferralByCode(params.code);
  if (!referral || referral.status !== "ACTIVE") fail(404, "NOT_FOUND", "Referral not found");
  const terms = (await deps.store.getTerms(referral.campaignId, referral.partnerId)) ?? null;
  if (!terms || terms.id !== referral.partnerTermsId || terms.status !== "ACTIVE") {
    fail(404, "NOT_FOUND", "Referral is no longer active");
  }
  const market = await deps.store.getMarket(referral.campaignId);
  const campaign = await deps.store.getCampaign(referral.campaignId);
  if (!market || !campaign) fail(404, "NOT_FOUND", "Referral is no longer active");
  const version = await deps.store.getVersion(referral.campaignId, terms.policyVersion);
  const targetSettled = await evaluateTargetSettled(deps.store, referral.campaignId, market.policyVersion);
  const attributable =
    market.status === "OPEN" &&
    campaign.state === "LIVE" &&
    !targetSettled.complete &&
    !!version?.deadline &&
    (version.deadline as Date) > now;
  return {
    referral,
    terms,
    market,
    campaignId: referral.campaignId,
    partnerId: referral.partnerId,
    attributable,
    destinationUrl: market.destinationUrl,
  };
}
