import { newId } from "../auth/session";
import { formatUsdc } from "@/lib/format";
import { isUniqueViolation } from "./campaignStore";
import type { AuditSink, InvitationStatus, MarketStore, StoredInvitation } from "./campaignStore";
import { createDrizzleNotificationStore, type NotificationStore } from "./creatorNotifications";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditEvents } from "../db/schema";
import { evaluateTargetSettled, joinCampaign, serializeTerms } from "./markets";
import {
  evaluateInvitationAuthority,
  loadScoutSnapshot,
  type InvitationAgentResult,
  type ScoutSnapshot,
} from "./scout";
import {
  evaluateCreatorForCampaign,
  loadCandidateSeed,
  loadCampaignMatchContext,
  type CapabilitySeed,
  type HistorySeed,
} from "./matching";
import {
  checkCapacity,
  computeExposure,
  createHybridDeal,
  invitationDeal,
  invitationDealCorrupt,
  parseDeal,
  type DealInput,
} from "./deals";

/**
 * Organization → creator invitations (Slice 2).
 *
 * An invitation is NOT participation:
 * INVITED != ACCEPTED, and creating one creates no terms, no referral,
 * no payout, no reservation, no notification. Offered economics are frozen
 * from live market truth at invite time; later repricing never mutates
 * the stored offer. Match ranking is never recomputed here — the shared
 * evaluateCreatorForCampaign kernel decides eligibility.
 */

export interface InvitationDeps {
  store: MarketStore;
  audit: AuditSink;
  now?: () => Date;
  notifications?: NotificationStore;
}

/** Human-readable frozen offer line. Shared by notifications and the inbox UI. */
export function describeOffer(outcomeKind: string, bountyMicroUsdc: string): string {
  const unit =
    outcomeKind === "purchase" ? "verified purchase" : outcomeKind === "signup" ? "verified signup" : "verified referral";
  return `${formatUsdc(bountyMicroUsdc)} USDC per ${unit}`;
}

export interface InvitationOffer {
  outcomeKind: string;
  bountyMicroUsdc: string;
  minQualifyingMicroUsdc: string | null;
  holdSeconds: number | null;
  policyVersion: number;
  marketVersion: number;
}

export interface InvitationDto {
  id: string;
  campaignId: string;
  creatorUserId: string;
  creatorHandle: string | null;
  status: InvitationStatus;
  /** Who accepted: AGENT (auto-accept), CREATOR (manual), or null (not accepted/unknown). */
  acceptedBy: "AGENT" | "CREATOR" | null;
  offered: InvitationOffer & { bonus: Record<string, unknown> };
  match: { score: number; confidence: string; action: string; reasons: string[] };
  createdAt: string;
  respondedAt: string | null;
}

export interface InviteResult {
  invitation: InvitationDto;
  alreadyInvited: boolean;
}

export type BulkInviteStatus = "INVITED" | "ALREADY_INVITED" | "NOT_ELIGIBLE" | "FAILED";

export interface BulkInviteItem {
  creatorUserId: string;
  status: BulkInviteStatus;
  invitationId: string | null;
  reason: string | null;
}

const MAX_BULK_INVITES = 20;

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

function toDto(row: StoredInvitation, handle: string | null, acceptedBy: "AGENT" | "CREATOR" | null = null): InvitationDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    creatorUserId: row.creatorUserId,
    creatorHandle: handle,
    status: row.status,
    acceptedBy: row.status === "ACCEPTED" ? acceptedBy : null,
    offered: {
      outcomeKind: row.offeredOutcomeKind,
      bountyMicroUsdc: row.offeredBountyMicroUsdc.toString(),
      minQualifyingMicroUsdc: row.offeredMinQualifyingMicroUsdc?.toString() ?? null,
      holdSeconds: row.offeredHoldSeconds,
      policyVersion: row.offeredPolicyVersion,
      marketVersion: row.offeredMarketVersion,
      bonus: (row.offeredBonusJson ?? {}) as Record<string, unknown>,
    },
    match: {
      score: row.matchScore,
      confidence: row.matchConfidence,
      action: row.matchAction,
      reasons: [...row.matchReasons],
    },
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}

async function requireOrgMember(store: MarketStore, workspaceId: string | null, callerUserId: string) {
  const membership = workspaceId ? await store.getMembership(workspaceId, callerUserId) : null;
  if (!membership || (membership.role !== "ORGANIZATION_OWNER" && membership.role !== "ORGANIZATION_MEMBER")) {
    fail(403, "FORBIDDEN", "Organization membership required");
  }
  return membership;
}

async function handleFor(store: MarketStore, creatorUserId: string): Promise<string | null> {
  const seed = await loadCandidateSeed(creatorUserId).catch(() => null);
  return seed?.handle ?? null;
}

/**
 * Invite one creator. Re-resolves economics + eligibility from live truth;
 * idempotent on (campaign, creator) while an INVITED row stands.
 */
export async function createInvitation(
  deps: InvitationDeps,
  params: { callerUserId: string; campaignId: string; creatorUserId: string },
  opts?: { candidate?: CapabilitySeed | null; history?: HistorySeed | null; snapshot?: ScoutSnapshot; joinsToday?: number; deal?: DealInput; offeredBountyMicroUsdc?: string },
): Promise<InviteResult> {
  const now = deps.now?.() ?? new Date();
  if (params.creatorUserId === params.callerUserId) {
    fail(400, "BAD_REQUEST", "Creators cannot invite themselves");
  }
  const ctx = await loadCampaignMatchContext(deps.store, params.campaignId, { allowPreview: true });
  await requireOrgMember(deps.store, ctx.workspace?.id ?? null, params.callerUserId);
  // Slice 10: pre-funding invitations. A live + open market keeps legacy
  // behavior (frozen live economics). An approved-but-unfunded campaign
  // may invite against an explicit org offer within policy bounds — the
  // same frozen-economics + capacity-gated path, marked as prospective.
  const prefunding = ctx.prefunding;
  if (!prefunding && (ctx.campaign.state !== "LIVE" || ctx.market.status !== "OPEN")) {
    fail(409, "INVITATIONS_CLOSED", "Invitations require a live campaign with an open market");
  }
  if (prefunding && ctx.campaign.state !== "APPROVED") {
    fail(409, "INVITATIONS_CLOSED", "Pre-funding invitations require an approved campaign");
  }
  let offeredBounty: bigint;
  if (prefunding) {
    if (opts?.offeredBountyMicroUsdc === undefined) {
      fail(400, "BAD_REQUEST", "Pre-funding invitations require an explicit offeredBountyMicroUsdc within the policy floor/ceiling");
    }
    try {
      offeredBounty = BigInt(opts.offeredBountyMicroUsdc as string);
    } catch {
      fail(400, "BAD_REQUEST", "offeredBountyMicroUsdc must be an integer micro-USDC string");
    }
    const full = await deps.store.getVersion(params.campaignId, ctx.market.policyVersion).catch(() => null);
    const floor = full?.bountyFloorMicroUsdc;
    const ceiling = full?.bountyCeilingMicroUsdc;
    if (floor === null || floor === undefined || ceiling === null || ceiling === undefined) {
      fail(500, "INTERNAL", "Approved policy is missing economic bounds");
    }
    if ((offeredBounty as bigint) < (floor as bigint) || (offeredBounty as bigint) > (ceiling as bigint)) {
      fail(400, "OFFER_OUT_OF_BOUNDS", `Offered bounty must stay within the policy floor and ceiling`);
    }
  } else {
    if (opts?.offeredBountyMicroUsdc !== undefined) {
      fail(400, "BAD_REQUEST", "Explicit offers are only for pre-funding invitations; live-market invitations freeze the public bounty");
    }
    offeredBounty = ctx.market.publicBountyMicroUsdc;
  }
  const existing = await deps.store.findActiveInvitation(params.campaignId, params.creatorUserId);
  if (existing) {
    return {
      invitation: toDto(existing, await handleFor(deps.store, params.creatorUserId)),
      alreadyInvited: true,
    };
  }
  const candidate = opts?.candidate !== undefined
    ? opts.candidate
    : await loadCandidateSeed(params.creatorUserId);
  if (!candidate || !candidate.onboardingCompleted) {
    fail(409, "NOT_ELIGIBLE", "Creator has not finished creator onboarding");
  }
  const profile = await deps.store.getPartnerByUserId(params.creatorUserId).catch(() => null);
  // Pre-funding invitations are prospective: discovery must not require the
  // creator to have joined already (that would be circular). The partner
  // profile + wallet are still enforced at accept time against the live
  // market, so nothing funds or pays out early.
  if (!profile && !prefunding) {
    fail(409, "NOT_ELIGIBLE", "Creator has no participation profile yet");
  }
  const activeTerms = opts?.history?.activeTermsCount;
  const history: HistorySeed = opts?.history ?? {
    verifiedTotal: 0,
    settledCollaborations: 0,
    activeTermsCount: 0,
  };
  if (activeTerms === undefined) {
    const terms = profile ? await deps.store.listPartnerTerms(profile.id).catch(() => []) : [];
    history.activeTermsCount = terms.filter((t) => t.status === "ACTIVE").length;
  }
  const match = await evaluateCreatorForCampaign(deps.store, ctx, candidate, history, now);
  if (!prefunding && match.eligibility !== "ELIGIBLE") {
    fail(409, "NOT_ELIGIBLE", match.eligibilityReason);
  }
  if (match.recommendedAction !== "INVITE" && match.recommendedAction !== "REVIEW") {
    fail(409, "NOT_RECOMMENDED", `Match action is ${match.recommendedAction} — invite is limited to INVITE or REVIEW matches`);
  }
  const outcomeKind = ctx.version.minQualifyingPurchaseMicroUsdc !== null &&
      ctx.version.minQualifyingPurchaseMicroUsdc !== undefined
    ? "purchase"
    : "referral";
  // Slice 6: optional hybrid economics. Validated, bounded, capacity-gated,
  // frozen into the invitation — later repricing never mutates it.
  let frozenDealJson: Record<string, unknown> = {};
  let frozenDealExposureTotal: string | null = null;
  if (opts?.deal !== undefined) {
    const parsed = parseDeal(opts.deal);
    if (!parsed.ok) fail(400, "BAD_DEAL", `Invalid hybrid deal: ${parsed.issues.join("; ")}`);
    const deal = (parsed as { ok: true; deal: import("./deals").CanonicalDeal }).deal;
    if (BigInt(deal.performanceBountyMicroUsdc) !== offeredBounty && deal.performanceBountyMicroUsdc !== "0") {
      fail(400, "DEAL_BOUNTY_MISMATCH", "Hybrid performance bounty must equal the frozen invitation bounty.");
    }
    const exposure = computeExposure(deal);
    const fullVersion = await deps.store.getVersion(params.campaignId, ctx.market.policyVersion).catch(() => null);
    const budgetMicroUsdc = fullVersion?.budgetMicroUsdc ?? null;
    if (budgetMicroUsdc === null || budgetMicroUsdc === undefined) {
      fail(409, "HYBRID_NO_BUDGET", "Hybrid offers require a campaign budget to bound exposure against.");
    }
    const funding = await deps.store.getFunding(params.campaignId, ctx.market.policyVersion).catch(() => null);
    const funded = funding?.status === "CONFIRMED"
      ? (funding.observedAmountMicroUsdc ?? funding.expectedAmountMicroUsdc)
      : 0n;
    const remaining = (budgetMicroUsdc as bigint) - funded;
    const capacity = checkCapacity(exposure, remaining > 0n ? remaining : 0n);
    if (!capacity.ok) fail(409, "HYBRID_OVER_CAPACITY", capacity.reason);
    frozenDealJson = { deal };
    frozenDealExposureTotal = exposure.maximumTotalMicroUsdc;
  }
  const id = newId();
  let row: StoredInvitation;
  try {
    row = await deps.store.insertInvitation({
      id,
      campaignId: params.campaignId,
      organizationUserId: params.callerUserId,
      creatorUserId: params.creatorUserId,
      offeredOutcomeKind: outcomeKind,
      // Pre-market sentinel: no market row exists yet. Accept-time joins
      // against the live market and records its version; the frozen
      // economics (bounty + policy) never change.
      offeredBountyMicroUsdc: offeredBounty,
      offeredMinQualifyingMicroUsdc: ctx.version.minQualifyingPurchaseMicroUsdc,
      offeredHoldSeconds: ctx.version.refundHoldSeconds,
      offeredPolicyVersion: ctx.market.policyVersion,
      offeredMarketVersion: prefunding ? 0 : ctx.market.version,
      offeredBonusJson: frozenDealJson,
      matchScore: match.matchScore,
      matchConfidence: match.confidence,
      matchAction: match.recommendedAction,
      matchReasons: [...match.reasons],
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const winner = await deps.store.findActiveInvitation(params.campaignId, params.creatorUserId);
      if (winner) {
        return {
          invitation: toDto(winner, await handleFor(deps.store, params.creatorUserId)),
          alreadyInvited: true,
        };
      }
    }
    throw e;
  }
  await deps
    .audit({
      actorType: "USER",
      actorId: params.callerUserId,
      workspaceId: ctx.workspace?.id ?? null,
      partnerId: null,
      action: "creator.invitation.created",
      targetType: "invitation",
      targetId: row.id,
      metadata: {
        campaignId: params.campaignId,
        creatorUserId: params.creatorUserId,
        invitationId: row.id,
        offeredBountyMicroUsdc: row.offeredBountyMicroUsdc.toString(),
        offeredOutcomeKind: outcomeKind,
        offeredPolicyVersion: row.offeredPolicyVersion,
        offeredMarketVersion: row.offeredMarketVersion,
        matchScore: row.matchScore,
        matchConfidence: row.matchConfidence,
        ...(frozenDealExposureTotal !== null
          ? {
              dealStructure: (frozenDealJson as { deal: { structure: string } }).deal.structure,
              dealMaximumTotalMicroUsdc: frozenDealExposureTotal,
            }
          : {}),
      },
    })
    .catch(() => {});
  // Slice 7: reliability snapshot at decision time (best-effort, bounded).
  // The invitation is the evaluation point — never a page render.
  try {
    const { loadCreatorReliability } = await import("./reliability");
    const rel = await loadCreatorReliability(deps.store, params.creatorUserId, now).catch(() => null);
    if (rel) {
      await deps
        .audit({
          actorType: "SYSTEM",
          actorId: null,
          workspaceId: ctx.workspace?.id ?? null,
          partnerId: rel.partnerId,
          action: "creator.reliability.evaluated",
          targetType: "invitation",
          targetId: row.id,
          metadata: {
            campaignId: params.campaignId,
            creatorUserId: params.creatorUserId,
            invitationId: row.id,
            reliabilityScore: rel.reliabilityScore,
            confidence: rel.confidence,
            level: rel.level,
            verifiedOutcomes: rel.verifiedOutcomes,
            campaignsWithVerified: rel.campaignsWithVerified,
            retainedOutcomes: rel.retainedOutcomes,
            settledCollaborations: rel.settledCollaborations,
          },
        })
        .catch(() => {});
    }
  } catch {
    // Reliability evidence never blocks the invitation.
  }
  // Slice 3 delivery: durable inbox alert, deduped on the invitation.
  // No email/push — dashboard only.
  try {
    const store = deps.notifications ?? createDrizzleNotificationStore();
    await store.insertIfAbsent(params.creatorUserId, {
      type: "CAMPAIGN_INVITED",
      campaignId: params.campaignId,
      title: `${ctx.workspace?.name ?? "An organization"} invited you to a campaign`,
      message: `${describeOffer(outcomeKind, row.offeredBountyMicroUsdc.toString())} — review the frozen offer before you decide.`,
      dedupeKey: `invite:${row.id}`,
      metadataJson: {
        invitationId: row.id,
        campaignId: params.campaignId,
        bountyMicroUsdc: row.offeredBountyMicroUsdc.toString(),
        outcomeKind,
      },
    });
  } catch {
    // Notification state never blocks the invitation.
  }
  // Slice 4: immediate agent evaluation. AUTO_ACCEPT flows through the same
  // accept service; anything else (or any technical failure) leaves the
  // valid invitation INVITED for human review and background retry.
  try {
    await evaluateAndAutoAcceptInvitation(
      deps,
      { creatorUserId: params.creatorUserId, invitationId: row.id },
      { joinsToday: opts?.joinsToday, snapshot: opts?.snapshot },
    );
  } catch {
    // Never fail invitation creation because of the agent pass.
  }
  const final = (await deps.store.getInvitation(row.id).catch(() => row)) ?? row;
  // An ACCEPTED row here can only come from this call's own agent accept.
  const acceptedBy = final.status === "ACCEPTED" ? ("AGENT" as const) : null;
  return {
    invitation: toDto(final, candidate.handle, acceptedBy),
    alreadyInvited: false,
  };
}

/* ---------------- Creator opportunity inbox (enriched, display-safe) ---------------- */

export interface CreatorOpportunity extends InvitationDto {
  campaign: {
    workspaceName: string;
    objective: string;
    category: string | null;
    deadline: string | null;
    visibility: string | null;
  };
  /** Live agent assessment for INVITED rows (display only, never audited here). */
  agent: { result: InvitationAgentResult; reasons: string[] } | null;
  /** Referral once participating; null until ACCEPTED. */
  referral: { code: string; path: string } | null;
}

/**
 * The creator's own opportunities with frozen economics + current campaign
 * context (objective/deadline are display truth; the offer never moves).
 */
export async function listCreatorOpportunities(
  deps: InvitationDeps,
  params: { creatorUserId: string },
  opts?: { joinsToday?: number; snapshot?: ScoutSnapshot },
): Promise<CreatorOpportunity[]> {
  const rows = await deps.store.listInvitationsByCreator(params.creatorUserId);
  const now = deps.now?.() ?? new Date();
  // One shared Scout snapshot for every pending row on this page.
  const snapshot = opts?.snapshot ?? (await loadScoutSnapshot(deps.store, params.creatorUserId, now).catch(() => null));
  const profile = await deps.store.getPartnerByUserId(params.creatorUserId).catch(() => null);
  const out: CreatorOpportunity[] = [];
  for (const row of rows) {
    const campaign = await deps.store.getCampaign(row.campaignId).catch(() => null);
    const workspace = campaign ? await deps.store.getWorkspace(campaign.workspaceId).catch(() => null) : null;
    const version = campaign
      ? await deps.store.getVersion(row.campaignId, row.offeredPolicyVersion).catch(() => null)
      : null;
    let agent: CreatorOpportunity["agent"] = null;
    if (row.status === "INVITED" && snapshot) {
      try {
        const assessment = await evaluateInvitationAuthority(
          { store: deps.store, now: () => now },
          {
            creatorUserId: params.creatorUserId,
            campaignId: row.campaignId,
            invitationId: row.id,
            invitationStatus: row.status,
            offeredBountyMicroUsdc: row.offeredBountyMicroUsdc,
          },
          { joinsToday: opts?.joinsToday, snapshot },
        );
        agent = { result: assessment.result, reasons: assessment.reasons };
      } catch {
        agent = null;
      }
    }
    let referral: CreatorOpportunity["referral"] = null;
    const acceptedBy = row.status === "ACCEPTED" ? await resolveAcceptedBy(deps, row.id) : null;
    if (row.status === "ACCEPTED" && profile) {
      const terms = await deps.store.getTerms(row.campaignId, profile.id).catch(() => null);
      const ref = terms ? await deps.store.getReferralByTerms(terms.id).catch(() => null) : null;
      if (ref) referral = { code: ref.code, path: `/r/${ref.code}` };
    }
    out.push({
      ...toDto(row, null, acceptedBy),
      campaign: {
        workspaceName: workspace?.name ?? "Unknown organization",
        objective: version?.intentText ?? "",
        category: workspace?.category ?? null,
        deadline: version?.deadline ? version.deadline.toISOString() : null,
        visibility: version?.marketVisibility ?? null,
      },
      agent,
      referral,
    });
  }
  return out;
}

/** Bounded bulk invite: one creator's failure never corrupts the batch. */
export async function inviteCreators(
  deps: InvitationDeps,
  params: { callerUserId: string; campaignId: string; creatorUserIds: string[] },
  opts?: { candidates?: Record<string, CapabilitySeed | null>; histories?: Record<string, HistorySeed>; deal?: DealInput; offeredBountyMicroUsdc?: string },
): Promise<{ campaignId: string; invited: number; results: BulkInviteItem[] }> {
  const ids = [...new Set(params.creatorUserIds)].slice(0, MAX_BULK_INVITES);
  const results: BulkInviteItem[] = [];
  for (const creatorUserId of ids) {
    try {
      const res = await createInvitation(
        deps,
        { callerUserId: params.callerUserId, campaignId: params.campaignId, creatorUserId },
        {
          candidate: opts?.candidates?.[creatorUserId],
          history: opts?.histories?.[creatorUserId],
          deal: opts?.deal,
          offeredBountyMicroUsdc: opts?.offeredBountyMicroUsdc,
        },
      );
      results.push({
        creatorUserId,
        status: res.alreadyInvited ? "ALREADY_INVITED" : "INVITED",
        invitationId: res.invitation.id,
        reason: null,
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const code = (e as { code?: string }).code;
      results.push({
        creatorUserId,
        status: status === 409 || code === "NOT_ELIGIBLE" || code === "NOT_RECOMMENDED" ? "NOT_ELIGIBLE" : "FAILED",
        invitationId: null,
        reason: (e as Error).message,
      });
    }
  }
  const invited = results.filter((r) => r.status === "INVITED").length;
  await deps
    .audit({
      actorType: "USER",
      actorId: params.callerUserId,
      workspaceId: null,
      partnerId: null,
      action: "creator.invitation.batch",
      targetType: "campaign",
      targetId: params.campaignId,
      metadata: {
        campaignId: params.campaignId,
        requested: ids.length,
        invited,
        alreadyInvited: results.filter((r) => r.status === "ALREADY_INVITED").length,
        notEligible: results.filter((r) => r.status === "NOT_ELIGIBLE").length,
        failed: results.filter((r) => r.status === "FAILED").length,
      },
    })
    .catch(() => {});
  return { campaignId: params.campaignId, invited, results };
}

/** Cancel an INVITED invitation. Only the owning org; never touches participation. */
export async function cancelInvitation(
  deps: InvitationDeps,
  params: { callerUserId: string; invitationId: string },
): Promise<InvitationDto> {
  const row = await deps.store.getInvitation(params.invitationId);
  if (!row) fail(404, "NOT_FOUND", "Invitation not found");
  const campaign = await deps.store.getCampaign(row.campaignId);
  await requireOrgMember(deps.store, campaign?.workspaceId ?? null, params.callerUserId);
  if (row.status !== "INVITED") {
    if (row.status === "CANCELLED") {
      return toDto(row, await handleFor(deps.store, row.creatorUserId));
    }
    fail(409, "INVITATION_LOCKED", `Invitation is ${row.status} and can no longer be cancelled`);
  }
  const updated = await deps.store.updateInvitationStatus(row.id, "CANCELLED");
  await deps
    .audit({
      actorType: "USER",
      actorId: params.callerUserId,
      workspaceId: campaign?.workspaceId ?? null,
      partnerId: null,
      action: "creator.invitation.cancelled",
      targetType: "invitation",
      targetId: row.id,
      metadata: { campaignId: row.campaignId, creatorUserId: row.creatorUserId, invitationId: row.id },
    })
    .catch(() => {});
  return toDto(updated, await handleFor(deps.store, row.creatorUserId));
}

/** Organization-scoped invitation list for a campaign. */
export async function listInvitations(
  deps: InvitationDeps,
  params: { callerUserId: string; campaignId: string },
): Promise<InvitationDto[]> {
  const campaign = await deps.store.getCampaign(params.campaignId);
  if (!campaign) fail(404, "NOT_FOUND", "Campaign not found");
  await requireOrgMember(deps.store, campaign.workspaceId, params.callerUserId);
  const rows = await deps.store.listInvitationsByCampaign(params.campaignId);
  const out: InvitationDto[] = [];
  for (const row of rows) {
    const acceptedBy = row.status === "ACCEPTED" ? await resolveAcceptedBy(deps, row.id) : null;
    out.push(toDto(row, await handleFor(deps.store, row.creatorUserId), acceptedBy));
  }
  return out;
}

/** Creator's own invitation inbox (Slice 3 delivery surface reads this). */
export async function listCreatorInvitations(
  deps: InvitationDeps,
  params: { creatorUserId: string },
): Promise<InvitationDto[]> {
  const rows = await deps.store.listInvitationsByCreator(params.creatorUserId);
  return rows.map((row) => toDto(row, null));
}

/* ---------------- Creator accept / decline (Slice 3) ---------------- */

export interface AcceptResult {
  invitation: InvitationDto;
  participation: {
    termsId: string;
    priceMicroUsdc: string;
    policyVersion: number;
    marketVersion: number;
    source: string;
  };
  referral: { id: string; code: string; path: string };
  alreadyJoined: boolean;
}

/** Best-effort: mark the invite notification read after a creator responds. */
async function markInviteNotificationRead(deps: InvitationDeps, creatorUserId: string, invitationId: string) {
  try {
    const store = deps.notifications ?? createDrizzleNotificationStore();
    const items = await store.listForCreator(creatorUserId, 200);
    const found = items.find((n) => n.dedupeKey === `invite:${invitationId}` && !n.readAt);
    if (found) await store.markRead(creatorUserId, found.id);
  } catch {
    // Notification state never blocks the response.
  }
}

async function requireOwnedInvitation(
  deps: InvitationDeps,
  params: { creatorUserId: string; invitationId: string },
): Promise<StoredInvitation> {
  const row = await deps.store.getInvitation(params.invitationId);
  if (!row) fail(404, "NOT_FOUND", "Invitation not found");
  if (row.creatorUserId !== params.creatorUserId) {
    fail(403, "FORBIDDEN", "This invitation belongs to another creator");
  }
  return row;
}

/**
 * Accept: transactional + idempotent. Re-checks live campaign truth, then
 * creates participation through the EXISTING join path countersigned with
 * the invitation's FROZEN economics — never the current bounty. Creates
 * no payout, no reservation, no verification.
 *
 * Slice 4 entry point: evaluate the invitation against creator rules, then
 * call this same service to AUTO_ACCEPT (no separate accept path).
 */
/** Who accepted: derived from the accept audit row (mode), never stored twice. */
async function resolveAcceptedBy(deps: InvitationDeps, invitationId: string): Promise<"AGENT" | "CREATOR" | null> {
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "creator.invitation.accepted"), eq(auditEvents.targetId, invitationId)))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    if (!row) return null;
    const mode = (row.metadata as { mode?: unknown } | null)?.mode;
    return mode === "AGENT" ? "AGENT" : "CREATOR";
  } catch {
    return null;
  }
}

export async function acceptInvitation(
  deps: InvitationDeps,
  params: { creatorUserId: string; invitationId: string },
  opts?: { mode?: "AGENT" | "MANUAL" },
): Promise<AcceptResult> {
  const now = deps.now?.() ?? new Date();
  const row = await requireOwnedInvitation(deps, params);
  if (row.status === "ACCEPTED") {
    const profile = await deps.store.getPartnerByUserId(params.creatorUserId).catch(() => null);
    const terms = profile ? await deps.store.getTerms(row.campaignId, profile.id).catch(() => null) : null;
    const referral = terms ? await deps.store.getReferralByTerms(terms.id).catch(() => null) : null;
    if (!terms || !referral) {
      fail(409, "INVITATION_ORPHANED", "Invitation is accepted but participation is missing — contact support");
    }
    await markInviteNotificationRead(deps, params.creatorUserId, row.id);
    return {
      invitation: toDto(row, await handleFor(deps.store, params.creatorUserId), await resolveAcceptedBy(deps, row.id)),
      participation: {
        termsId: terms.id,
        priceMicroUsdc: terms.priceMicroUsdc.toString(),
        policyVersion: terms.policyVersion,
        marketVersion: terms.marketVersion,
        source: terms.source,
      },
      referral: { id: referral.id, code: referral.code, path: `/r/${referral.code}` },
      alreadyJoined: true,
    };
  }
  if (row.status !== "INVITED") {
    fail(
      409,
      row.status === "DECLINED" ? "ALREADY_DECLINED" : "INVITATION_LOCKED",
      row.status === "DECLINED"
        ? "Invitation was already declined and cannot be accepted"
        : `Invitation is ${row.status} and can no longer be accepted`,
    );
  }
  const campaign = await deps.store.getCampaign(row.campaignId);
  if (!campaign || campaign.state !== "LIVE") {
    fail(409, "CAMPAIGN_CLOSED", "Campaign is no longer live");
  }
  const market = await deps.store.getMarket(row.campaignId);
  if (!market || market.status !== "OPEN") {
    fail(409, "CAMPAIGN_CLOSED", "Campaign market is no longer open");
  }
  const settled = await evaluateTargetSettled(deps.store, row.campaignId, market.policyVersion);
  if (settled.complete) {
    fail(409, "TARGET_REACHED", "Market objective is complete and settled; participation is closed");
  }
  const version = await deps.store.getVersion(row.campaignId, market.policyVersion);
  if (!version || !version.deadline || version.deadline <= now) {
    fail(409, "EXPIRED", "Campaign deadline has passed");
  }
  const profile = await deps.store.getPartnerByUserId(params.creatorUserId).catch(() => null);
  if (!profile) {
    fail(409, "NOT_ELIGIBLE", "Creator participation profile is missing");
  }
  // Edge: creator joined independently after being invited. Compatible
  // frozen economics resolve idempotently; anything else is a conflict —
  // historical terms always win over rewriting history.
  const existing = await deps.store.getTerms(row.campaignId, profile.id);
  if (existing) {
    // offeredMarketVersion 0 = invited before any market existed; only the
    // frozen economics (price + policy) are comparable in that case.
    const marketMatches = row.offeredMarketVersion === 0 || existing.marketVersion === row.offeredMarketVersion;
    const compatible =
      existing.priceMicroUsdc === row.offeredBountyMicroUsdc &&
      existing.policyVersion === row.offeredPolicyVersion &&
      marketMatches;
    if (!compatible) {
      fail(
        409,
        "PARTICIPATION_CONFLICT",
        `Existing participation pays ${existing.priceMicroUsdc.toString()} micro-USDC; invitation offers ${row.offeredBountyMicroUsdc.toString()}. Kept as-is — no rewrite.`,
      );
    }
  }
  const joined = existing
    ? await (async () => {
        const referral = await deps.store.getReferralByTerms(existing.id).catch(() => null);
        if (!referral) fail(500, "INTERNAL", "Terms exist without a referral");
        return { terms: serializeTerms(existing), referral: { id: referral.id, code: referral.code }, alreadyJoined: true as const };
      })()
    : await joinCampaign(deps, {
        campaignId: row.campaignId,
        userId: params.creatorUserId,
        frozenOffer: {
          bountyMicroUsdc: row.offeredBountyMicroUsdc,
          policyVersion: row.offeredPolicyVersion,
          // Pre-market invitations freeze economics but join against the
          // live market once it opens; terms always record the real market.
          marketVersion: row.offeredMarketVersion === 0 ? market.version : row.offeredMarketVersion,
        },
      });
  // Slice 6: frozen hybrid extension. The performance leg already lives in
  // partnerTerms (canonical, never rewritten); the base + milestone
  // extension starts PENDING — acceptance earns nothing, creates no payout
  // and no reservation. Idempotent per terms.
  const acceptedDeal = invitationDeal(row.offeredBonusJson);
  if (acceptedDeal && acceptedDeal.structure !== "PERFORMANCE_ONLY") {
    await createHybridDeal(deps.store, deps.audit, {
      termsId: joined.terms.id,
      campaignId: row.campaignId,
      partnerId: profile.id,
      invitationId: row.id,
      deal: acceptedDeal,
    });
  }
  const updated = await deps.store.updateInvitationStatus(row.id, "ACCEPTED");
  await deps
    .audit({
      actorType: "USER",
      actorId: params.creatorUserId,
      workspaceId: campaign.workspaceId,
      partnerId: profile.id,
      action: "creator.invitation.accepted",
      targetType: "invitation",
      targetId: row.id,
      metadata: {
        mode: opts?.mode ?? "MANUAL",
        campaignId: row.campaignId,
        creatorUserId: params.creatorUserId,
        invitationId: row.id,
        offeredBountyMicroUsdc: row.offeredBountyMicroUsdc.toString(),
        offeredOutcomeKind: row.offeredOutcomeKind,
        offeredPolicyVersion: row.offeredPolicyVersion,
        offeredMarketVersion: row.offeredMarketVersion,
        termsId: joined.terms.id,
        referralId: joined.referral.id,
        alreadyJoined: joined.alreadyJoined,
      },
    })
    .catch(() => {});
  await markInviteNotificationRead(deps, params.creatorUserId, row.id);
  return {
    invitation: toDto(
      updated,
      await handleFor(deps.store, params.creatorUserId),
      (opts?.mode ?? "MANUAL") === "AGENT" ? "AGENT" : "CREATOR",
    ),
    participation: {
      termsId: joined.terms.id,
      priceMicroUsdc: joined.terms.priceMicroUsdc,
      policyVersion: joined.terms.policyVersion,
      marketVersion: joined.terms.marketVersion,
      source: joined.terms.source,
    },
    referral: { id: joined.referral.id, code: joined.referral.code, path: `/r/${joined.referral.code}` },
    alreadyJoined: joined.alreadyJoined,
  };
}

/** Decline: INVITED → DECLINED. No participation, referral, or payout. Idempotent. */
export async function declineInvitation(
  deps: InvitationDeps,
  params: { creatorUserId: string; invitationId: string },
): Promise<InvitationDto> {
  const row = await requireOwnedInvitation(deps, params);
  if (row.status === "DECLINED") {
    return toDto(row, await handleFor(deps.store, params.creatorUserId));
  }
  if (row.status !== "INVITED") {
    fail(
      409,
      "INVITATION_LOCKED",
      row.status === "ACCEPTED"
        ? "Invitation is already accepted and cannot be declined"
        : `Invitation is ${row.status} and can no longer be declined`,
    );
  }
  const updated = await deps.store.updateInvitationStatus(row.id, "DECLINED");
  await deps
    .audit({
      actorType: "USER",
      actorId: params.creatorUserId,
      workspaceId: null,
      partnerId: null,
      action: "creator.invitation.declined",
      targetType: "invitation",
      targetId: row.id,
      metadata: { campaignId: row.campaignId, creatorUserId: params.creatorUserId, invitationId: row.id },
    })
    .catch(() => {});
  await markInviteNotificationRead(deps, params.creatorUserId, row.id);
  return toDto(updated, await handleFor(deps.store, params.creatorUserId));
}

/* ---------------- Agent auto-accept (Slice 4) ---------------- */

export interface AutoAcceptOutcome {
  accepted: boolean;
  result: InvitationAgentResult | "ERROR";
  reasons: string[];
  rule: string | null;
}

/**
 * Evaluate one pending invitation against the creator's existing rules and
 * auto-accept through the SAME accept service on AUTO_ACCEPT. REFUSE never
 * declines — the row stays INVITED for human review. Technical failures
 * keep the invitation intact for later retry.
 */
export async function evaluateAndAutoAcceptInvitation(
  deps: InvitationDeps,
  params: { creatorUserId: string; invitationId: string },
  opts?: { auditEvaluation?: boolean; joinsToday?: number; snapshot?: ScoutSnapshot },
): Promise<AutoAcceptOutcome> {
  const row = await deps.store.getInvitation(params.invitationId).catch(() => null);
  if (!row || row.creatorUserId !== params.creatorUserId) {
    return { accepted: false, result: "ERROR", reasons: ["Invitation not found."], rule: null };
  }
  // Slice 6: agent authority covers performance-only economics. Hybrid
  // structures and corrupt frozen payloads fail to human REVIEW — the
  // invitation stays INVITED, the agent never accepts.
  const hybridGate = async (
    result: InvitationAgentResult,
    rule: string,
    reasons: string[],
  ): Promise<AutoAcceptOutcome> => {
    if (opts?.auditEvaluation !== false) {
      await deps
        .audit({
          actorType: "SYSTEM",
          actorId: null,
          workspaceId: null,
          partnerId: null,
          action: "creator.invitation.agent_evaluated",
          targetType: "invitation",
          targetId: row.id,
          metadata: {
            campaignId: row.campaignId,
            creatorUserId: row.creatorUserId,
            invitationId: row.id,
            result,
            rule,
            frozenBountyMicroUsdc: row.offeredBountyMicroUsdc.toString(),
            confidence: null,
            reasons: reasons.slice(0, 6),
          },
        })
        .catch(() => {});
    }
    return { accepted: false, result, reasons, rule };
  };
  if (invitationDealCorrupt(row.offeredBonusJson)) {
    return hybridGate("REVIEW", "HYBRID_CORRUPT", ["Frozen hybrid offer is unreadable — your review is required."]);
  }
  const frozenDeal = invitationDeal(row.offeredBonusJson);
  if (frozenDeal && frozenDeal.structure !== "PERFORMANCE_ONLY") {
    return hybridGate("REVIEW", "HYBRID_REVIEW", [
      `Hybrid ${frozenDeal.structure} economics need human review — the agent auto-accepts performance-only offers.`,
    ]);
  }
  try {
    const assessment = await evaluateInvitationAuthority(
      { store: deps.store, now: deps.now },
      {
        creatorUserId: row.creatorUserId,
        campaignId: row.campaignId,
        invitationId: row.id,
        invitationStatus: row.status,
        offeredBountyMicroUsdc: row.offeredBountyMicroUsdc,
      },
      { joinsToday: opts?.joinsToday, snapshot: opts?.snapshot },
    );
    if (opts?.auditEvaluation !== false) {
      await deps
        .audit({
          actorType: "SYSTEM",
          actorId: null,
          workspaceId: null,
          partnerId: null,
          action: "creator.invitation.agent_evaluated",
          targetType: "invitation",
          targetId: row.id,
          metadata: {
            campaignId: row.campaignId,
            creatorUserId: row.creatorUserId,
            invitationId: row.id,
            result: assessment.result,
            rule: assessment.rule,
            frozenBountyMicroUsdc: row.offeredBountyMicroUsdc.toString(),
            confidence: assessment.confidence,
            reasons: assessment.reasons.slice(0, 6),
          },
        })
        .catch(() => {});
    }
    if (assessment.result !== "AUTO_ACCEPT") {
      return { accepted: false, result: assessment.result, reasons: assessment.reasons, rule: assessment.rule };
    }
    const accepted = await acceptInvitation(deps, { creatorUserId: row.creatorUserId, invitationId: row.id }, { mode: "AGENT" });
    // One deduped agent-acceptance alert (accept already marked CAMPAIGN_INVITED read).
    try {
      const store = deps.notifications ?? createDrizzleNotificationStore();
      const campaign = await deps.store.getCampaign(row.campaignId).catch(() => null);
      const workspace = campaign ? await deps.store.getWorkspace(campaign.workspaceId).catch(() => null) : null;
      await store.insertIfAbsent(row.creatorUserId, {
        type: "AUTO_JOINED",
        campaignId: row.campaignId,
        title: `Agent accepted ${workspace?.name ?? "a campaign"}`,
        message: `Your agent accepted ${workspace?.name ?? "a campaign"} because it satisfied your Scout rules — ${describeOffer(row.offeredOutcomeKind, row.offeredBountyMicroUsdc.toString())}, frozen at invite time.`,
        dedupeKey: `autoaccept:${row.id}`,
        metadataJson: {
          invitationId: row.id,
          campaignId: row.campaignId,
          referralCode: accepted.referral.code,
          referralPath: accepted.referral.path,
          mode: "AGENT",
        },
      });
    } catch {
      // Notification state never blocks the acceptance.
    }
    return { accepted: true, result: "AUTO_ACCEPT", reasons: assessment.reasons, rule: assessment.rule };
  } catch (e) {
    await deps
      .audit({
        actorType: "SYSTEM",
        actorId: null,
        workspaceId: null,
        partnerId: null,
        action: "creator.invitation.agent_evaluated",
        targetType: "invitation",
        targetId: row.id,
        metadata: {
          campaignId: row.campaignId,
          creatorUserId: row.creatorUserId,
          invitationId: row.id,
          result: "ERROR",
          error: (e as Error).message,
        },
      })
      .catch(() => {});
    return { accepted: false, result: "ERROR", reasons: [(e as Error).message], rule: null };
  }
}

/**
 * Background recovery: re-evaluate pending INVITED rows for one creator.
 * Quiet by design — only acceptances audit/notify; REVIEW/REFUSE rows
 * produce nothing so repeat runs stay silent.
 */
export async function recoverCreatorInvitations(
  deps: InvitationDeps,
  params: { creatorUserId: string },
  opts?: { joinsToday?: number; snapshot?: ScoutSnapshot },
): Promise<{ accepted: number; evaluated: number }> {
  const rows = await deps.store.listInvitationsByCreator(params.creatorUserId).catch(() => []);
  let accepted = 0;
  let evaluated = 0;
  for (const row of rows.filter((r) => r.status === "INVITED")) {
    try {
      evaluated += 1;
      const out = await evaluateAndAutoAcceptInvitation(
        deps,
        { creatorUserId: params.creatorUserId, invitationId: row.id },
        { auditEvaluation: false, joinsToday: opts?.joinsToday, snapshot: opts?.snapshot },
      );
      if (out.accepted) accepted += 1;
    } catch {
      // One row's failure never aborts the rest.
    }
  }
  return { accepted, evaluated };
}
