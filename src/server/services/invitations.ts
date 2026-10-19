import { newId } from "../auth/session";
import { isUniqueViolation } from "./campaignStore";
import type { AuditSink, InvitationStatus, MarketStore, StoredInvitation } from "./campaignStore";
import {
  evaluateCreatorForCampaign,
  loadCandidateSeed,
  loadCampaignMatchContext,
  type CapabilitySeed,
  type HistorySeed,
} from "./matching";

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
  offered: InvitationOffer;
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

function toDto(row: StoredInvitation, handle: string | null): InvitationDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    creatorUserId: row.creatorUserId,
    creatorHandle: handle,
    status: row.status,
    offered: {
      outcomeKind: row.offeredOutcomeKind,
      bountyMicroUsdc: row.offeredBountyMicroUsdc.toString(),
      minQualifyingMicroUsdc: row.offeredMinQualifyingMicroUsdc?.toString() ?? null,
      holdSeconds: row.offeredHoldSeconds,
      policyVersion: row.offeredPolicyVersion,
      marketVersion: row.offeredMarketVersion,
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
  opts?: { candidate?: CapabilitySeed | null; history?: HistorySeed | null },
): Promise<InviteResult> {
  const now = deps.now?.() ?? new Date();
  if (params.creatorUserId === params.callerUserId) {
    fail(400, "BAD_REQUEST", "Creators cannot invite themselves");
  }
  const ctx = await loadCampaignMatchContext(deps.store, params.campaignId);
  await requireOrgMember(deps.store, ctx.workspace?.id ?? null, params.callerUserId);
  if (ctx.campaign.state !== "LIVE" || ctx.market.status !== "OPEN") {
    fail(409, "INVITATIONS_CLOSED", "Invitations require a live campaign with an open market");
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
  if (!profile) {
    fail(409, "NOT_ELIGIBLE", "Creator has no participation profile yet");
  }
  const activeTerms = opts?.history?.activeTermsCount;
  const history: HistorySeed = opts?.history ?? {
    verifiedTotal: 0,
    settledCollaborations: 0,
    activeTermsCount: 0,
  };
  if (activeTerms === undefined) {
    const terms = await deps.store.listPartnerTerms(profile.id).catch(() => []);
    history.activeTermsCount = terms.filter((t) => t.status === "ACTIVE").length;
  }
  const match = await evaluateCreatorForCampaign(deps.store, ctx, candidate, history, now);
  if (match.eligibility !== "ELIGIBLE") {
    fail(409, "NOT_ELIGIBLE", match.eligibilityReason);
  }
  if (match.recommendedAction !== "INVITE" && match.recommendedAction !== "REVIEW") {
    fail(409, "NOT_RECOMMENDED", `Match action is ${match.recommendedAction} — invite is limited to INVITE or REVIEW matches`);
  }
  const outcomeKind = ctx.version.minQualifyingPurchaseMicroUsdc !== null &&
      ctx.version.minQualifyingPurchaseMicroUsdc !== undefined
    ? "purchase"
    : "referral";
  const id = newId();
  let row: StoredInvitation;
  try {
    row = await deps.store.insertInvitation({
      id,
      campaignId: params.campaignId,
      organizationUserId: params.callerUserId,
      creatorUserId: params.creatorUserId,
      offeredOutcomeKind: outcomeKind,
      offeredBountyMicroUsdc: ctx.market.publicBountyMicroUsdc,
      offeredMinQualifyingMicroUsdc: ctx.version.minQualifyingPurchaseMicroUsdc,
      offeredHoldSeconds: ctx.version.refundHoldSeconds,
      offeredPolicyVersion: ctx.market.policyVersion,
      offeredMarketVersion: ctx.market.version,
      offeredBonusJson: {},
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
      },
    })
    .catch(() => {});
  return { invitation: toDto(row, candidate.handle), alreadyInvited: false };
}

/** Bounded bulk invite: one creator's failure never corrupts the batch. */
export async function inviteCreators(
  deps: InvitationDeps,
  params: { callerUserId: string; campaignId: string; creatorUserIds: string[] },
  opts?: { candidates?: Record<string, CapabilitySeed | null>; histories?: Record<string, HistorySeed> },
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
    out.push(toDto(row, await handleFor(deps.store, row.creatorUserId)));
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

/* ---------------- Slice 3 contract (interface only — not implemented) ---------------- */

/** Slice 3: creator accepts → creates participation + referral from the frozen offer. */
export async function acceptInvitation(
  _deps: InvitationDeps,
  _params: { creatorUserId: string; invitationId: string },
): Promise<never> {
  fail(501, "NOT_IMPLEMENTED", "Invitation acceptance ships in Slice 3");
  throw new Error("unreachable");
}

/** Slice 3: creator declines → marks DECLINED, no participation. */
export async function declineInvitation(
  _deps: InvitationDeps,
  _params: { creatorUserId: string; invitationId: string },
): Promise<never> {
  fail(501, "NOT_IMPLEMENTED", "Invitation decline ships in Slice 3");
  throw new Error("unreachable");
}
