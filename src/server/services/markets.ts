import { createHash, randomBytes } from "node:crypto";
import { newId } from "../auth/session";
import {
  assertSafeDestinationUrl,
  checkJoinEligibility,
  newReferralCode,
  parsePartnerRules,
  serializePartnerRules,
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
    const workspace = await deps.store.getWorkspace(campaign.workspaceId);
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
    });
  }
  return { markets: items };
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
  // autoJoin/autoNegotiate are STORED ONLY in S3 — no autonomous action reads them.
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
  params: { campaignId: string; userId: string; allocationCount?: number; expectedMarketVersion?: number; inviteToken?: string },
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
    if (params.expectedMarketVersion !== undefined && params.expectedMarketVersion !== market.version) {
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

    // Private campaigns require a valid owner-issued invite.
    if (version.marketVisibility === "PRIVATE") {
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
    const eligibility = checkJoinEligibility({
      marketStatus: market.status,
      campaignLive: campaign.state === "LIVE",
      deadline: version.deadline,
      publicBountyMicroUsdc: market.publicBountyMicroUsdc,
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
        priceMicroUsdc: market.publicBountyMicroUsdc,
        allocationCount: requested,
        source: TERMS_SOURCE_PUBLIC,
        expiresAt: version.deadline,
        policyVersion: market.policyVersion,
        marketVersion: market.version,
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
  const attributable =
    market.status === "OPEN" &&
    campaign.state === "LIVE" &&
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
