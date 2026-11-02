import { randomBytes } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { getDb, isDbConfigured, type Db } from "../db/client";
import {
  auditEvents,
  developerGrowthPrograms,
  externalOutcomeEvents,
  growthAttributionIdentities,
  growthProgramParticipants,
  userPersonas,
  users,
} from "../db/schema";
import { newId } from "../auth/session";
import type { AuditSink } from "./campaignStore";
import { recordAuditEvent } from "./audit";
import { assertExecutionAllowed, getOrganizationOperatorMode, type OrganizationOperatorMode } from "./operatorMode";
import { createProductionGrowthProgramService, type SafeGrowthProgram } from "./growthPrograms";

export const GROWTH_PROGRAM_PARTICIPANT_KINDS = ["CREATOR", "REFERRAL_PARTNER"] as const;
export type GrowthProgramParticipantKind = (typeof GROWTH_PROGRAM_PARTICIPANT_KINDS)[number];

export const GROWTH_PROGRAM_PARTICIPANT_STATUSES = ["INVITED", "APPLIED", "APPROVED", "ACTIVE", "PAUSED", "DECLINED", "REMOVED"] as const;
export type GrowthProgramParticipantStatus = (typeof GROWTH_PROGRAM_PARTICIPANT_STATUSES)[number];

export const GROWTH_PROGRAM_PARTICIPATION_SOURCES = ["INVITE", "OPEN_JOIN", "EXTERNAL"] as const;
export type GrowthProgramParticipationSource = (typeof GROWTH_PROGRAM_PARTICIPATION_SOURCES)[number];

export type GrowthAttributionIdentityStatus = "ACTIVE" | "REVOKED";
export type GrowthAttributionResolutionStatus = "ACTIVE" | "REVOKED" | "NOT_FOUND" | "WRONG_PROGRAM" | "WRONG_PROJECT" | "PARTICIPANT_INACTIVE" | "AMBIGUOUS";

export interface GrowthProgramParticipantRow {
  id: string;
  workspaceId: string;
  growthProgramId: string;
  participantType: GrowthProgramParticipantKind;
  creatorUserId: string | null;
  externalPartnerId: string | null;
  displayName: string;
  handle: string | null;
  status: GrowthProgramParticipantStatus;
  participationSource: GrowthProgramParticipationSource;
  rewardPolicySnapshotJson: Record<string, unknown>;
  joinedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GrowthAttributionIdentityRow {
  id: string;
  workspaceId: string;
  growthProgramId: string;
  participantId: string;
  publicCode: string;
  status: GrowthAttributionIdentityStatus;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface ParticipantEventStats {
  attributedEvents: number;
  verifiedOutcomes: number;
  underReview: number;
  refused: number;
}

export interface SafeGrowthProgramParticipant {
  id: string;
  growthProgramId: string;
  participantType: GrowthProgramParticipantKind;
  creatorUserId: string | null;
  externalPartnerId: string | null;
  displayName: string;
  handle: string | null;
  status: GrowthProgramParticipantStatus;
  participationSource: GrowthProgramParticipationSource;
  rewardPolicySnapshot: Record<string, unknown>;
  attribution: { id: string; code: string; status: GrowthAttributionIdentityStatus } | null;
  joinedAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: ParticipantEventStats;
}

export interface SafeGrowthProgramAnalytics {
  participants: number;
  activeParticipants: number;
  invited: number;
  pendingReview: number;
  attributedEvents: number;
  verifiedAttributedOutcomes: number;
  unattributedOutcomes: number;
  attributionConflicts: number;
}

export interface AttributionResolution {
  status: GrowthAttributionResolutionStatus;
  attributionIdentityId: string | null;
  participantId: string | null;
}

interface ParticipantRepository {
  listParticipants(workspaceId: string, growthProgramId: string): Promise<GrowthProgramParticipantRow[]>;
  getParticipant(workspaceId: string, growthProgramId: string, participantId: string): Promise<GrowthProgramParticipantRow | null>;
  findByCreator(workspaceId: string, growthProgramId: string, creatorUserId: string): Promise<GrowthProgramParticipantRow | null>;
  findByExternalPartner(workspaceId: string, growthProgramId: string, externalPartnerId: string): Promise<GrowthProgramParticipantRow | null>;
  insertParticipant(input: Omit<GrowthProgramParticipantRow, "createdAt" | "updatedAt">): Promise<GrowthProgramParticipantRow>;
  updateParticipant(workspaceId: string, growthProgramId: string, participantId: string, patch: Partial<Pick<GrowthProgramParticipantRow, "status" | "joinedAt" | "approvedAt" | "updatedAt">>): Promise<GrowthProgramParticipantRow>;
  listIdentities(workspaceId: string, growthProgramId: string, participantId?: string): Promise<GrowthAttributionIdentityRow[]>;
  insertIdentity(input: Omit<GrowthAttributionIdentityRow, "createdAt" | "revokedAt">): Promise<GrowthAttributionIdentityRow>;
  revokeIdentities(workspaceId: string, growthProgramId: string, participantId: string, at: Date): Promise<void>;
  updateProgramReadiness(workspaceId: string, growthProgramId: string, patch: { attributionStatus?: "NOT_CONFIGURED" | "CONFIGURED" }): Promise<void>;
  resolveAttribution(workspaceId: string, growthProgramId: string, reference: string): Promise<AttributionResolution>;
  getParticipantStats?(workspaceId: string, growthProgramId: string, participantId: string): Promise<ParticipantEventStats>;
  getAnalytics?(workspaceId: string, growthProgramId: string): Promise<SafeGrowthProgramAnalytics>;
}

export interface CreatorDirectoryEntry {
  userId: string;
  displayName: string | null;
  handle: string | null;
  creatorType: string | null;
  reliability?: Record<string, unknown> | null;
}

export interface GrowthProgramParticipationDependencies {
  repository: ParticipantRepository;
  getProgram: (workspaceId: string, growthProgramId: string) => Promise<SafeGrowthProgram>;
  setParticipationStatus?: (params: { workspaceId: string; id: string; status: "CLOSED" | "INVITE_ONLY" | "OPEN"; actorId: string | null }) => Promise<SafeGrowthProgram>;
  getMode?: (workspaceId: string) => Promise<OrganizationOperatorMode>;
  getCreator?: (creatorUserId: string) => Promise<CreatorDirectoryEntry | null>;
  audit: AuditSink;
  now?: () => Date;
}

export interface CreateParticipantInput {
  workspaceId: string;
  growthProgramId: string;
  actorId: string | null;
  participantType: unknown;
  creatorUserId?: unknown;
  externalPartnerId?: unknown;
  displayName?: unknown;
  handle?: unknown;
  participationSource?: unknown;
  initialStatus?: unknown;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

function safeString(value: unknown, field: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(400, "INVALID_REQUEST", `${field} must be a non-empty safe string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max = 160): string | null {
  if (value === undefined || value === null || value === "") return null;
  return safeString(value, field, max);
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail(400, "INVALID_REQUEST", `${field} must be one of: ${values.join(", ")}.`);
  return value as T[number];
}

function rewardSnapshot(program: SafeGrowthProgram, at: Date): Record<string, unknown> {
  return {
    growthProgramId: program.id,
    campaignId: program.campaignId,
    policyVersionId: program.policyVersionId,
    outcomeDefinitionId: program.outcomeDefinition.id,
    rewardStructure: program.rewardStructure,
    rewardCeilingMicroUsdc: program.rewardCeilingMicroUsdc,
    maxVerifiedCacMicroUsdc: program.maxVerifiedCacMicroUsdc,
    capturedAt: at.toISOString(),
  };
}

function publicCode(): string {
  return `ref_${randomBytes(8).toString("hex")}`;
}

function toSafeParticipant(row: GrowthProgramParticipantRow, identity: GrowthAttributionIdentityRow | null, stats: ParticipantEventStats): SafeGrowthProgramParticipant {
  return {
    id: row.id,
    growthProgramId: row.growthProgramId,
    participantType: row.participantType,
    creatorUserId: row.creatorUserId,
    externalPartnerId: row.externalPartnerId,
    displayName: row.displayName,
    handle: row.handle,
    status: row.status,
    participationSource: row.participationSource,
    rewardPolicySnapshot: row.rewardPolicySnapshotJson,
    attribution: identity ? { id: identity.id, code: identity.publicCode, status: identity.status } : null,
    joinedAt: row.joinedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stats,
  };
}

function emptyStats(): ParticipantEventStats {
  return { attributedEvents: 0, verifiedOutcomes: 0, underReview: 0, refused: 0 };
}

export function createGrowthProgramParticipationService(deps: GrowthProgramParticipationDependencies) {
  const now = () => deps.now?.() ?? new Date();

  async function program(workspaceId: string, growthProgramId: string) {
    return deps.getProgram(workspaceId, growthProgramId);
  }

  async function identityFor(workspaceId: string, growthProgramId: string, participantId: string): Promise<GrowthAttributionIdentityRow | null> {
    return (await deps.repository.listIdentities(workspaceId, growthProgramId, participantId)).find((identity) => identity.status === "ACTIVE") ?? null;
  }

  async function safeParticipant(row: GrowthProgramParticipantRow): Promise<SafeGrowthProgramParticipant> {
    const [identity, stats] = await Promise.all([
      identityFor(row.workspaceId, row.growthProgramId, row.id),
      deps.repository.getParticipantStats?.(row.workspaceId, row.growthProgramId, row.id) ?? Promise.resolve(emptyStats()),
    ]);
    return toSafeParticipant(row, identity, stats);
  }

  async function ensureIdentity(row: GrowthProgramParticipantRow, at: Date): Promise<GrowthAttributionIdentityRow> {
    const current = await identityFor(row.workspaceId, row.growthProgramId, row.id);
    if (current) return current;
    const identity = await deps.repository.insertIdentity({
      id: `attr_${newId()}`,
      workspaceId: row.workspaceId,
      growthProgramId: row.growthProgramId,
      participantId: row.id,
      publicCode: publicCode(),
      status: "ACTIVE",
    });
    await deps.repository.updateProgramReadiness(row.workspaceId, row.growthProgramId, { attributionStatus: "CONFIGURED" });
    await deps.audit({
      actorType: "SYSTEM",
      actorId: null,
      workspaceId: row.workspaceId,
      action: "developer.growth_program.attribution_identity.created",
      targetType: "growth_attribution_identity",
      targetId: identity.id,
      metadata: { growthProgramId: row.growthProgramId, participantId: row.id, attributionId: identity.id, publicCode: identity.publicCode, createdAt: at.toISOString() },
    });
    return identity;
  }

  return {
    async createParticipant(input: CreateParticipantInput): Promise<SafeGrowthProgramParticipant> {
      const currentProgram = await program(input.workspaceId, input.growthProgramId);
      if (currentProgram.participationStatus === "CLOSED") fail(409, "PARTICIPATION_CLOSED", "This Growth Program is closed to new participants.");
      const participantType = enumValue(input.participantType, GROWTH_PROGRAM_PARTICIPANT_KINDS, "participantType") as GrowthProgramParticipantKind;
      const configuredType = participantType === "CREATOR" ? "CREATORS" : "REFERRAL_PARTNERS";
      if (!currentProgram.participantTypes.includes(configuredType)) fail(409, "PARTICIPANT_TYPE_NOT_ENABLED", `${participantType} is not enabled for this Growth Program.`);
      const source = enumValue(input.participationSource ?? (currentProgram.participationStatus === "OPEN" ? "OPEN_JOIN" : "INVITE"), GROWTH_PROGRAM_PARTICIPATION_SOURCES, "participationSource") as GrowthProgramParticipationSource;
      if (currentProgram.participationStatus === "INVITE_ONLY" && source === "OPEN_JOIN") {
        fail(409, "INVITE_ONLY", "This Growth Program only accepts invited participants.");
      }
      const creatorUserId = optionalString(input.creatorUserId, "creatorUserId");
      const externalPartnerId = optionalString(input.externalPartnerId, "externalPartnerId");
      if (participantType === "CREATOR") {
        if (!creatorUserId || externalPartnerId) fail(400, "CREATOR_IDENTITY_REQUIRED", "CREATOR participants require a creatorUserId and no externalPartnerId.");
        const existing = await deps.repository.findByCreator(input.workspaceId, input.growthProgramId, creatorUserId);
        if (existing) return safeParticipant(existing);
        const creator = await deps.getCreator?.(creatorUserId);
        if (!creator) fail(404, "CREATOR_NOT_FOUND", "Creator identity is not available or has not completed creator onboarding.");
        const displayName = optionalString(input.displayName, "displayName") ?? creator.displayName ?? creator.handle ?? creator.userId;
        const handle = optionalString(input.handle, "handle") ?? creator.handle;
        const requestedStatus = input.initialStatus === undefined ? source === "INVITE" ? "INVITED" : "APPLIED" : enumValue(input.initialStatus, GROWTH_PROGRAM_PARTICIPANT_STATUSES, "initialStatus");
        if (source === "INVITE" || requestedStatus === "INVITED") {
          const mode = await (deps.getMode?.(input.workspaceId) ?? Promise.resolve("AUTONOMOUS" as const));
          if (currentProgram.operatorMode === "SHADOW" || mode === "SHADOW") assertExecutionAllowed("SHADOW", "CREATOR_INVITE");
        }
        const at = now();
        const row = await deps.repository.insertParticipant({
          id: newId(), workspaceId: input.workspaceId, growthProgramId: input.growthProgramId,
          participantType, creatorUserId, externalPartnerId: null, displayName, handle,
          status: requestedStatus as GrowthProgramParticipantStatus, participationSource: source,
          rewardPolicySnapshotJson: rewardSnapshot(currentProgram, at),
          joinedAt: requestedStatus === "ACTIVE" ? at : null,
          approvedAt: requestedStatus === "ACTIVE" ? at : null,
        });
        if (row.status === "ACTIVE") await ensureIdentity(row, at);
        await deps.audit({ actorType: input.actorId ? "USER" : "SYSTEM", actorId: input.actorId, workspaceId: input.workspaceId, action: "developer.growth_program.participant.created", targetType: "growth_program_participant", targetId: row.id, metadata: { growthProgramId: row.growthProgramId, participantId: row.id, participantType, creatorUserId, status: row.status, participationSource: source } });
        return safeParticipant(row);
      }

      if (creatorUserId || !externalPartnerId) fail(400, "REFERRAL_PARTNER_ID_REQUIRED", "REFERRAL_PARTNER participants require a project-scoped externalPartnerId.");
      const existing = await deps.repository.findByExternalPartner(input.workspaceId, input.growthProgramId, externalPartnerId);
      if (existing) return safeParticipant(existing);
      const displayName = safeString(input.displayName, "displayName");
      const requestedStatus = input.initialStatus === undefined ? source === "INVITE" ? "INVITED" : "APPLIED" : enumValue(input.initialStatus, GROWTH_PROGRAM_PARTICIPANT_STATUSES, "initialStatus");
      if (source === "INVITE" || requestedStatus === "INVITED") {
        const mode = await (deps.getMode?.(input.workspaceId) ?? Promise.resolve("AUTONOMOUS" as const));
        if (currentProgram.operatorMode === "SHADOW" || mode === "SHADOW") assertExecutionAllowed("SHADOW", "CREATOR_INVITE");
      }
      const at = now();
      const row = await deps.repository.insertParticipant({
        id: newId(), workspaceId: input.workspaceId, growthProgramId: input.growthProgramId,
        participantType, creatorUserId: null, externalPartnerId, displayName, handle: optionalString(input.handle, "handle"),
        status: requestedStatus as GrowthProgramParticipantStatus, participationSource: source,
        rewardPolicySnapshotJson: rewardSnapshot(currentProgram, at),
        joinedAt: requestedStatus === "ACTIVE" ? at : null,
        approvedAt: requestedStatus === "ACTIVE" ? at : null,
      });
      if (row.status === "ACTIVE") await ensureIdentity(row, at);
      await deps.audit({ actorType: input.actorId ? "USER" : "SYSTEM", actorId: input.actorId, workspaceId: input.workspaceId, action: "developer.growth_program.participant.created", targetType: "growth_program_participant", targetId: row.id, metadata: { growthProgramId: row.growthProgramId, participantId: row.id, participantType, externalPartnerId, status: row.status, participationSource: source } });
      return safeParticipant(row);
    },

    async setParticipationMode(params: { workspaceId: string; growthProgramId: string; participationStatus: "CLOSED" | "INVITE_ONLY" | "OPEN"; actorId: string | null }): Promise<SafeGrowthProgram> {
      if (!deps.setParticipationStatus) fail(503, "PROGRAM_MODE_UNAVAILABLE", "Participation mode changes are not configured.");
      return deps.setParticipationStatus({ workspaceId: params.workspaceId, id: params.growthProgramId, status: params.participationStatus, actorId: params.actorId });
    },

    async getParticipant(params: { workspaceId: string; growthProgramId: string; participantId: string }): Promise<SafeGrowthProgramParticipant> {
      await program(params.workspaceId, params.growthProgramId);
      const row = await deps.repository.getParticipant(params.workspaceId, params.growthProgramId, params.participantId);
      if (!row) fail(404, "PARTICIPANT_NOT_FOUND", "Growth Program participant not found.");
      return safeParticipant(row);
    },

    async listParticipants(params: { workspaceId: string; growthProgramId: string }): Promise<SafeGrowthProgramParticipant[]> {
      await program(params.workspaceId, params.growthProgramId);
      const rows = await deps.repository.listParticipants(params.workspaceId, params.growthProgramId);
      return Promise.all(rows.map(safeParticipant));
    },

    async getAnalytics(params: { workspaceId: string; growthProgramId: string }): Promise<SafeGrowthProgramAnalytics> {
      await program(params.workspaceId, params.growthProgramId);
      if (deps.repository.getAnalytics) return deps.repository.getAnalytics(params.workspaceId, params.growthProgramId);
      const rows = await deps.repository.listParticipants(params.workspaceId, params.growthProgramId);
      return {
        participants: rows.length,
        activeParticipants: rows.filter((row) => row.status === "ACTIVE").length,
        invited: rows.filter((row) => row.status === "INVITED").length,
        pendingReview: rows.filter((row) => row.status === "APPLIED" || row.status === "APPROVED").length,
        attributedEvents: 0,
        verifiedAttributedOutcomes: 0,
        unattributedOutcomes: 0,
        attributionConflicts: 0,
      };
    },

    async acceptCreatorInvitation(params: { workspaceId: string; growthProgramId: string; participantId: string; creatorUserId: string }): Promise<SafeGrowthProgramParticipant> {
      await program(params.workspaceId, params.growthProgramId);
      const row = await deps.repository.getParticipant(params.workspaceId, params.growthProgramId, params.participantId);
      if (!row) fail(404, "PARTICIPANT_NOT_FOUND", "Growth Program participant not found.");
      if (row.participantType !== "CREATOR" || row.creatorUserId !== params.creatorUserId) fail(403, "FORBIDDEN", "This creator invitation belongs to another creator.");
      if (row.status === "ACTIVE") return safeParticipant(row);
      if (row.status !== "INVITED") fail(409, "INVITATION_LOCKED", `Creator invitation is ${row.status} and cannot be accepted.`);
      const at = now();
      const updated = await deps.repository.updateParticipant(params.workspaceId, params.growthProgramId, params.participantId, { status: "ACTIVE", joinedAt: at, approvedAt: at, updatedAt: at });
      await ensureIdentity(updated, at);
      await deps.audit({ actorType: "USER", actorId: params.creatorUserId, workspaceId: params.workspaceId, action: "developer.growth_program.creator_invitation.accepted", targetType: "growth_program_participant", targetId: row.id, metadata: { growthProgramId: params.growthProgramId, participantId: row.id, creatorUserId: params.creatorUserId, mode: "CREATOR" } });
      return safeParticipant(updated);
    },

    async transitionParticipant(params: { workspaceId: string; growthProgramId: string; participantId: string; action: "APPROVE" | "PAUSE" | "REMOVE" | "DECLINE"; actorId: string | null }): Promise<SafeGrowthProgramParticipant> {
      await program(params.workspaceId, params.growthProgramId);
      const row = await deps.repository.getParticipant(params.workspaceId, params.growthProgramId, params.participantId);
      if (!row) fail(404, "PARTICIPANT_NOT_FOUND", "Growth Program participant not found.");
      const at = now();
      let nextStatus: GrowthProgramParticipantStatus;
      if (params.action === "APPROVE") {
        if (!["INVITED", "APPLIED", "PAUSED", "APPROVED"].includes(row.status)) fail(409, "PARTICIPANT_TRANSITION_INVALID", `Cannot approve a participant in ${row.status} state.`);
        nextStatus = "ACTIVE";
      } else if (params.action === "PAUSE") {
        if (row.status !== "ACTIVE") fail(409, "PARTICIPANT_TRANSITION_INVALID", "Only ACTIVE participants can be paused.");
        nextStatus = "PAUSED";
      } else if (params.action === "DECLINE") {
        if (!["INVITED", "APPLIED"].includes(row.status)) fail(409, "PARTICIPANT_TRANSITION_INVALID", "Only invited or pending participants can decline.");
        nextStatus = "DECLINED";
      } else {
        if (row.status === "REMOVED") return safeParticipant(row);
        nextStatus = "REMOVED";
      }
      const updated = await deps.repository.updateParticipant(params.workspaceId, params.growthProgramId, params.participantId, {
        status: nextStatus,
        joinedAt: nextStatus === "ACTIVE" ? row.joinedAt ?? at : row.joinedAt,
        approvedAt: nextStatus === "ACTIVE" ? row.approvedAt ?? at : row.approvedAt,
        updatedAt: at,
      });
      if (nextStatus === "ACTIVE") await ensureIdentity(updated, at);
      if (["PAUSED", "DECLINED", "REMOVED"].includes(nextStatus)) {
        await deps.repository.revokeIdentities(params.workspaceId, params.growthProgramId, row.id, at);
        await deps.audit({ actorType: params.actorId ? "USER" : "SYSTEM", actorId: params.actorId, workspaceId: params.workspaceId, action: "developer.growth_program.attribution_identity.revoked", targetType: "growth_program_participant", targetId: row.id, metadata: { growthProgramId: params.growthProgramId, participantId: row.id, reason: nextStatus } });
      }
      await deps.audit({ actorType: params.actorId ? "USER" : "SYSTEM", actorId: params.actorId, workspaceId: params.workspaceId, action: `developer.growth_program.participant.${nextStatus.toLowerCase()}`, targetType: "growth_program_participant", targetId: row.id, metadata: { growthProgramId: params.growthProgramId, participantId: row.id, previousStatus: row.status, status: nextStatus } });
      return safeParticipant(updated);
    },

    async resolveAttribution(params: { workspaceId: string; growthProgramId: string; reference: string }): Promise<{ attributionId: string; code: string; participant: SafeGrowthProgramParticipant }> {
      await program(params.workspaceId, params.growthProgramId);
      const result = await deps.repository.resolveAttribution(params.workspaceId, params.growthProgramId, safeString(params.reference, "attributionId", 200));
      if (result.status === "NOT_FOUND") fail(404, "ATTRIBUTION_NOT_FOUND", "Attribution identity not found.");
      if (result.status === "WRONG_PROJECT" || result.status === "WRONG_PROGRAM") fail(409, "INVALID_ATTRIBUTION", "Attribution identity does not belong to this program.");
      if (result.status === "REVOKED") fail(409, "ATTRIBUTION_REVOKED", "Attribution identity has been revoked.");
      if (result.status === "AMBIGUOUS") fail(409, "AMBIGUOUS_ATTRIBUTION", "Attribution reference matches more than one eligible identity.");
      if (result.status !== "ACTIVE" || !result.attributionIdentityId || !result.participantId) fail(409, "ATTRIBUTION_INACTIVE", "Attribution identity is not active for this participant.");
      const row = await deps.repository.getParticipant(params.workspaceId, params.growthProgramId, result.participantId);
      if (!row) fail(404, "PARTICIPANT_NOT_FOUND", "Attribution participant not found.");
      const identity = (await deps.repository.listIdentities(params.workspaceId, params.growthProgramId, row.id)).find((item) => item.id === result.attributionIdentityId);
      if (!identity) fail(404, "ATTRIBUTION_NOT_FOUND", "Attribution identity not found.");
      return { attributionId: identity.id, code: identity.publicCode, participant: await safeParticipant(row) };
    },

    async resolveAttributionForEvent(workspaceId: string, growthProgramId: string, reference: string): Promise<AttributionResolution> {
      return deps.repository.resolveAttribution(workspaceId, growthProgramId, reference);
    },
  };
}

function mapParticipant(row: typeof growthProgramParticipants.$inferSelect, workspaceId: string): GrowthProgramParticipantRow {
  return {
    id: row.id,
    workspaceId,
    growthProgramId: row.growthProgramId,
    participantType: row.participantType as GrowthProgramParticipantKind,
    creatorUserId: row.creatorUserId,
    externalPartnerId: row.externalPartnerId,
    displayName: row.displayName,
    handle: row.handle,
    status: row.status as GrowthProgramParticipantStatus,
    participationSource: row.participationSource as GrowthProgramParticipationSource,
    rewardPolicySnapshotJson: row.rewardPolicySnapshotJson as Record<string, unknown>,
    joinedAt: row.joinedAt,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapIdentity(row: typeof growthAttributionIdentities.$inferSelect, workspaceId: string): GrowthAttributionIdentityRow {
  return {
    id: row.id,
    workspaceId,
    growthProgramId: row.growthProgramId,
    participantId: row.participantId,
    publicCode: row.publicCode,
    status: row.status as GrowthAttributionIdentityStatus,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

export function createDrizzleGrowthProgramParticipantRepository(db: Db = getDb()): ParticipantRepository {
  async function programBelongs(workspaceId: string, growthProgramId: string): Promise<boolean> {
    const [row] = await db.select({ id: developerGrowthPrograms.id }).from(developerGrowthPrograms).where(and(eq(developerGrowthPrograms.id, growthProgramId), eq(developerGrowthPrograms.workspaceId, workspaceId))).limit(1);
    return Boolean(row);
  }
  return {
    async listParticipants(workspaceId, growthProgramId) {
      if (!(await programBelongs(workspaceId, growthProgramId))) return [];
      const rows = await db.select().from(growthProgramParticipants).where(eq(growthProgramParticipants.growthProgramId, growthProgramId)).orderBy(desc(growthProgramParticipants.createdAt));
      return rows.map((row) => mapParticipant(row, workspaceId));
    },
    async getParticipant(workspaceId, growthProgramId, participantId) {
      if (!(await programBelongs(workspaceId, growthProgramId))) return null;
      const [row] = await db.select().from(growthProgramParticipants).where(and(eq(growthProgramParticipants.id, participantId), eq(growthProgramParticipants.growthProgramId, growthProgramId))).limit(1);
      return row ? mapParticipant(row, workspaceId) : null;
    },
    async findByCreator(workspaceId, growthProgramId, creatorUserId) {
      if (!(await programBelongs(workspaceId, growthProgramId))) return null;
      const [row] = await db.select().from(growthProgramParticipants).where(and(eq(growthProgramParticipants.growthProgramId, growthProgramId), eq(growthProgramParticipants.creatorUserId, creatorUserId))).limit(1);
      return row ? mapParticipant(row, workspaceId) : null;
    },
    async findByExternalPartner(workspaceId, growthProgramId, externalPartnerId) {
      if (!(await programBelongs(workspaceId, growthProgramId))) return null;
      const [row] = await db.select().from(growthProgramParticipants).where(and(eq(growthProgramParticipants.growthProgramId, growthProgramId), eq(growthProgramParticipants.externalPartnerId, externalPartnerId))).limit(1);
      return row ? mapParticipant(row, workspaceId) : null;
    },
    async insertParticipant(input) {
      const [row] = await db.insert(growthProgramParticipants).values({
        id: input.id, growthProgramId: input.growthProgramId, participantType: input.participantType,
        creatorUserId: input.creatorUserId, externalPartnerId: input.externalPartnerId, displayName: input.displayName,
        handle: input.handle, status: input.status, participationSource: input.participationSource,
        rewardPolicySnapshotJson: input.rewardPolicySnapshotJson, joinedAt: input.joinedAt, approvedAt: input.approvedAt,
      }).returning();
      return mapParticipant(row, input.workspaceId);
    },
    async updateParticipant(workspaceId, growthProgramId, participantId, patch) {
      const [row] = await db.update(growthProgramParticipants).set({ ...patch }).where(and(eq(growthProgramParticipants.id, participantId), eq(growthProgramParticipants.growthProgramId, growthProgramId))).returning();
      if (!row) fail(404, "PARTICIPANT_NOT_FOUND", "Growth Program participant not found.");
      return mapParticipant(row, workspaceId);
    },
    async listIdentities(workspaceId, growthProgramId, participantId) {
      if (!(await programBelongs(workspaceId, growthProgramId))) return [];
      const filters = [eq(growthAttributionIdentities.growthProgramId, growthProgramId)];
      if (participantId) filters.push(eq(growthAttributionIdentities.participantId, participantId));
      const rows = await db.select().from(growthAttributionIdentities).where(and(...filters)).orderBy(desc(growthAttributionIdentities.createdAt));
      return rows.map((row) => mapIdentity(row, workspaceId));
    },
    async insertIdentity(input) {
      const [row] = await db.insert(growthAttributionIdentities).values({
        id: input.id, growthProgramId: input.growthProgramId, participantId: input.participantId,
        publicCode: input.publicCode, status: input.status,
      }).returning();
      return mapIdentity(row, input.workspaceId);
    },
    async revokeIdentities(workspaceId, growthProgramId, participantId, at) {
      await db.update(growthAttributionIdentities).set({ status: "REVOKED", revokedAt: at }).where(and(eq(growthAttributionIdentities.growthProgramId, growthProgramId), eq(growthAttributionIdentities.participantId, participantId), eq(growthAttributionIdentities.status, "ACTIVE")));
    },
    async updateProgramReadiness(workspaceId, growthProgramId, patch) {
      await db.update(developerGrowthPrograms).set({ ...patch, updatedAt: new Date() }).where(and(eq(developerGrowthPrograms.id, growthProgramId), eq(developerGrowthPrograms.workspaceId, workspaceId)));
    },
    async resolveAttribution(workspaceId, growthProgramId, reference) {
      const [row] = await db.select({
        attributionIdentityId: growthAttributionIdentities.id,
        identityProgramId: growthAttributionIdentities.growthProgramId,
        identityStatus: growthAttributionIdentities.status,
        participantId: growthProgramParticipants.id,
        participantStatus: growthProgramParticipants.status,
        programWorkspaceId: developerGrowthPrograms.workspaceId,
      }).from(growthAttributionIdentities)
        .innerJoin(growthProgramParticipants, eq(growthProgramParticipants.id, growthAttributionIdentities.participantId))
        .innerJoin(developerGrowthPrograms, eq(developerGrowthPrograms.id, growthAttributionIdentities.growthProgramId))
        .where(or(eq(growthAttributionIdentities.id, reference), eq(growthAttributionIdentities.publicCode, reference))).limit(1);
      if (!row) return { status: "NOT_FOUND" as const, attributionIdentityId: null, participantId: null };
      if (row.programWorkspaceId !== workspaceId) return { status: "WRONG_PROJECT" as const, attributionIdentityId: null, participantId: null };
      if (row.identityProgramId !== growthProgramId) return { status: "WRONG_PROGRAM" as const, attributionIdentityId: row.attributionIdentityId, participantId: row.participantId };
      if (row.identityStatus !== "ACTIVE") return { status: "REVOKED" as const, attributionIdentityId: row.attributionIdentityId, participantId: row.participantId };
      if (row.participantStatus !== "ACTIVE") return { status: "PARTICIPANT_INACTIVE" as const, attributionIdentityId: row.attributionIdentityId, participantId: row.participantId };
      return { status: "ACTIVE" as const, attributionIdentityId: row.attributionIdentityId, participantId: row.participantId };
    },
    async getParticipantStats(workspaceId, growthProgramId, participantId) {
      const rows = await db.select({ verificationState: externalOutcomeEvents.verificationState, attributionStatus: externalOutcomeEvents.attributionStatus })
        .from(externalOutcomeEvents)
        .innerJoin(growthAttributionIdentities, eq(growthAttributionIdentities.id, externalOutcomeEvents.attributionIdentityId))
        .where(and(eq(externalOutcomeEvents.workspaceId, workspaceId), eq(externalOutcomeEvents.growthProgramId, growthProgramId), eq(growthAttributionIdentities.participantId, participantId)));
      return {
        attributedEvents: rows.filter((row) => row.attributionStatus === "DIRECT_ATTRIBUTION").length,
        verifiedOutcomes: rows.filter((row) => row.verificationState === "VERIFIED").length,
        underReview: rows.filter((row) => row.verificationState === "REVIEW").length,
        refused: rows.filter((row) => row.verificationState === "REFUSED").length,
      };
    },
    async getAnalytics(workspaceId, growthProgramId) {
      const [participants, events, conflicts] = await Promise.all([
        this.listParticipants(workspaceId, growthProgramId),
        db.select({ verificationState: externalOutcomeEvents.verificationState, attributionStatus: externalOutcomeEvents.attributionStatus })
          .from(externalOutcomeEvents)
          .where(and(eq(externalOutcomeEvents.workspaceId, workspaceId), eq(externalOutcomeEvents.growthProgramId, growthProgramId))),
        db.select({ metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.action, "developer.outcome.attribution_conflict"))),
      ]);
      return {
        participants: participants.length,
        activeParticipants: participants.filter((row) => row.status === "ACTIVE").length,
        invited: participants.filter((row) => row.status === "INVITED").length,
        pendingReview: participants.filter((row) => row.status === "APPLIED" || row.status === "APPROVED").length,
        attributedEvents: events.filter((row) => row.attributionStatus === "DIRECT_ATTRIBUTION").length,
        verifiedAttributedOutcomes: events.filter((row) => row.attributionStatus === "DIRECT_ATTRIBUTION" && row.verificationState === "VERIFIED").length,
        unattributedOutcomes: events.filter((row) => row.attributionStatus === "UNATTRIBUTED").length,
        attributionConflicts: conflicts.filter((row) => (row.metadata as { growthProgramId?: unknown } | null)?.growthProgramId === growthProgramId).length,
      };
    },
  };
}

export function createMemoryGrowthProgramParticipantRepository(): ParticipantRepository & { participants: Map<string, GrowthProgramParticipantRow>; identities: Map<string, GrowthAttributionIdentityRow> } {
  const participants = new Map<string, GrowthProgramParticipantRow>();
  const identities = new Map<string, GrowthAttributionIdentityRow>();
  return {
    participants,
    identities,
    async listParticipants(workspaceId, growthProgramId) { return [...participants.values()].filter((row) => row.workspaceId === workspaceId && row.growthProgramId === growthProgramId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); },
    async getParticipant(workspaceId, growthProgramId, participantId) { const row = participants.get(participantId); return row?.workspaceId === workspaceId && row.growthProgramId === growthProgramId ? row : null; },
    async findByCreator(workspaceId, growthProgramId, creatorUserId) { return [...participants.values()].find((row) => row.workspaceId === workspaceId && row.growthProgramId === growthProgramId && row.creatorUserId === creatorUserId) ?? null; },
    async findByExternalPartner(workspaceId, growthProgramId, externalPartnerId) { return [...participants.values()].find((row) => row.workspaceId === workspaceId && row.growthProgramId === growthProgramId && row.externalPartnerId === externalPartnerId) ?? null; },
    async insertParticipant(input) { const at = new Date("2026-01-01T00:00:00.000Z"); const row = { ...input, createdAt: at, updatedAt: at }; participants.set(row.id, row); return row; },
    async updateParticipant(workspaceId, growthProgramId, participantId, patch) { const current = await this.getParticipant(workspaceId, growthProgramId, participantId); if (!current) fail(404, "PARTICIPANT_NOT_FOUND", "Growth Program participant not found."); const row = { ...current, ...patch }; participants.set(row.id, row); return row; },
    async listIdentities(workspaceId, growthProgramId, participantId) { return [...identities.values()].filter((row) => row.workspaceId === workspaceId && row.growthProgramId === growthProgramId && (!participantId || row.participantId === participantId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); },
    async insertIdentity(input) { const at = new Date("2026-01-01T00:00:00.000Z"); const row = { ...input, createdAt: at, revokedAt: null }; identities.set(row.id, row); return row; },
    async revokeIdentities(workspaceId, growthProgramId, participantId, at) { for (const [id, row] of identities) if (row.workspaceId === workspaceId && row.growthProgramId === growthProgramId && row.participantId === participantId && row.status === "ACTIVE") identities.set(id, { ...row, status: "REVOKED", revokedAt: at }); },
    async updateProgramReadiness() {},
    async resolveAttribution(workspaceId, growthProgramId, reference) {
      const row = [...identities.values()].find((identity) => identity.id === reference || identity.publicCode === reference);
      if (!row) return { status: "NOT_FOUND" as const, attributionIdentityId: null, participantId: null };
      if (row.workspaceId !== workspaceId) return { status: "WRONG_PROJECT" as const, attributionIdentityId: null, participantId: null };
      if (row.growthProgramId !== growthProgramId) return { status: "WRONG_PROGRAM" as const, attributionIdentityId: row.id, participantId: row.participantId };
      if (row.status !== "ACTIVE") return { status: "REVOKED" as const, attributionIdentityId: row.id, participantId: row.participantId };
      const participant = participants.get(row.participantId);
      if (!participant || participant.status !== "ACTIVE") return { status: "PARTICIPANT_INACTIVE" as const, attributionIdentityId: row.id, participantId: row.participantId };
      return { status: "ACTIVE" as const, attributionIdentityId: row.id, participantId: row.participantId };
    },
    async getParticipantStats() { return emptyStats(); },
    async getAnalytics(workspaceId, growthProgramId) {
      const rows = await this.listParticipants(workspaceId, growthProgramId);
      return { participants: rows.length, activeParticipants: rows.filter((row) => row.status === "ACTIVE").length, invited: rows.filter((row) => row.status === "INVITED").length, pendingReview: rows.filter((row) => row.status === "APPLIED" || row.status === "APPROVED").length, attributedEvents: 0, verifiedAttributedOutcomes: 0, unattributedOutcomes: 0, attributionConflicts: 0 };
    },
  };
}

export function createProductionGrowthProgramParticipationService() {
  if (!isDbConfigured()) fail(503, "UNCONFIGURED", "Database is not configured.");
  const db = getDb();
  const programs = createProductionGrowthProgramService();
  return createGrowthProgramParticipationService({
    repository: createDrizzleGrowthProgramParticipantRepository(db),
    getProgram: (workspaceId, growthProgramId) => programs.getProgram({ workspaceId, id: growthProgramId }),
    setParticipationStatus: (params) => programs.setParticipationStatus({ workspaceId: params.workspaceId, id: params.id, status: params.status, actorId: params.actorId }),
    getMode: getOrganizationOperatorMode,
    getCreator: async (creatorUserId) => {
      const [row] = await db.select({ userId: userPersonas.userId, handle: userPersonas.handle, creatorType: userPersonas.creatorType, displayName: users.name, persona: userPersonas.persona, onboardingCompletedAt: userPersonas.onboardingCompletedAt }).from(userPersonas).leftJoin(users, eq(users.id, userPersonas.userId)).where(eq(userPersonas.userId, creatorUserId)).limit(1);
      if (!row || row.persona !== "CREATOR" || !row.onboardingCompletedAt) return null;
      return { userId: row.userId, displayName: row.displayName, handle: row.handle, creatorType: row.creatorType };
    },
    audit: (input) => recordAuditEvent(db, input),
  });
}

export type { ParticipantRepository };
