import { and, desc, eq } from "drizzle-orm";
import { getDb, isDbConfigured, type Db } from "../db/client";
import {
  campaignPolicyVersions,
  campaigns,
  developerGrowthPrograms,
  developerIntegrations,
  externalOutcomeDefinitions,
} from "../db/schema";
import { newId } from "../auth/session";
import type { AuditSink } from "./campaignStore";
import { recordAuditEvent } from "./audit";
import { createProductionOutcomeApiService, type SafeDefinition, type SafeIntegration } from "./buildWithThesma";
import { EXTERNAL_OUTCOME_TYPES, type ExternalOutcomeType } from "./outcomeAdapter";

export const GROWTH_PROGRAM_PARTICIPANT_TYPES = ["CREATORS", "REFERRAL_PARTNERS"] as const;
export type GrowthProgramParticipantType = (typeof GROWTH_PROGRAM_PARTICIPANT_TYPES)[number];

export const GROWTH_PROGRAM_REWARD_STRUCTURES = [
  "PERFORMANCE_ONLY",
  "BASE_PLUS_PERFORMANCE",
  "MILESTONE_PLUS_PERFORMANCE",
  "HYBRID_FULL",
] as const;
export type GrowthProgramRewardStructure = (typeof GROWTH_PROGRAM_REWARD_STRUCTURES)[number];

export const GROWTH_PROGRAM_OPERATOR_MODES = ["SHADOW", "REVIEW", "AUTONOMOUS"] as const;
export type GrowthProgramOperatorMode = (typeof GROWTH_PROGRAM_OPERATOR_MODES)[number];

export const GROWTH_PROGRAM_STATUSES = ["DRAFT", "READY", "LIVE", "PAUSED", "COMPLETED"] as const;
export type GrowthProgramStatus = (typeof GROWTH_PROGRAM_STATUSES)[number];

export const GROWTH_PROGRAM_PARTICIPATION_STATUSES = ["CLOSED", "INVITE_ONLY", "OPEN"] as const;
export type GrowthProgramParticipationStatus = (typeof GROWTH_PROGRAM_PARTICIPATION_STATUSES)[number];

export interface GrowthProgramBinding {
  id: string;
  workspaceId: string;
  integrationId: string | null;
  outcomeDefinitionId: string;
  operatorMode: GrowthProgramOperatorMode;
}

export interface GrowthProgramRow extends GrowthProgramBinding {
  campaignId: string;
  policyVersionId: string;
  name: string;
  slug: string;
  objectiveOutcomeType: ExternalOutcomeType;
  targetOutcomeCount: number;
  budgetMicroUsdc: bigint;
  maxVerifiedCacMicroUsdc: bigint;
  rewardStructure: GrowthProgramRewardStructure;
  rewardCeilingMicroUsdc: bigint;
  participantTypes: GrowthProgramParticipantType[];
  status: GrowthProgramStatus;
  participationStatus: GrowthProgramParticipationStatus;
  attributionStatus: "NOT_CONFIGURED" | "CONFIGURED";
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeGrowthProgram {
  id: string;
  projectId: string;
  /** Deprecated response alias retained for project/workspace compatibility. */
  workspaceId: string;
  campaignId: string;
  policyVersionId: string;
  name: string;
  slug: string;
  objectiveOutcomeType: ExternalOutcomeType;
  targetOutcomeCount: number;
  budgetMicroUsdc: string;
  maxVerifiedCacMicroUsdc: string;
  rewardStructure: GrowthProgramRewardStructure;
  rewardCeilingMicroUsdc: string;
  participantTypes: GrowthProgramParticipantType[];
  operatorMode: GrowthProgramOperatorMode;
  status: GrowthProgramStatus;
  participationStatus: GrowthProgramParticipationStatus;
  attributionStatus: "NOT_CONFIGURED" | "CONFIGURED";
  integrationReadiness: "CONNECTED" | "NOT_CONFIGURED";
  fundingStatus: "NOT_FUNDED";
  settlementStatus: "NOT_CONFIGURED";
  outcomeDefinition: {
    id: string;
    slug: string;
    name: string;
    outcomeType: ExternalOutcomeType;
    unitValueMicroUsdc: string;
    verificationPolicyId: string;
    requiredEvidenceFields: string[];
    holdSeconds: number;
  };
  integration: {
    id: string;
    name: string;
    status: "ACTIVE" | "REVOKED";
    apiKeyPrefix: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGrowthProgramInput {
  workspaceId: string;
  actorId: string;
  name: string;
  slug?: string;
  objectiveOutcomeType: unknown;
  targetOutcomeCount: unknown;
  budgetMicroUsdc: unknown;
  maxVerifiedCacMicroUsdc: unknown;
  rewardStructure?: unknown;
  rewardCeilingMicroUsdc: unknown;
  participantTypes?: unknown;
  operatorMode?: unknown;
  outcomeDefinitionId?: unknown;
  integrationId?: unknown;
  integrationName?: unknown;
}

export interface GrowthProgramRepository {
  get(workspaceId: string, id: string): Promise<GrowthProgramRow | null>;
  list(workspaceId: string): Promise<GrowthProgramRow[]>;
  insert(input: {
    id: string;
    campaignId: string;
    policyVersionId: string;
    workspaceId: string;
    createdByUserId: string;
    name: string;
    slug: string;
    objectiveOutcomeType: ExternalOutcomeType;
    targetOutcomeCount: number;
    budgetMicroUsdc: bigint;
    maxVerifiedCacMicroUsdc: bigint;
    rewardStructure: GrowthProgramRewardStructure;
    rewardCeilingMicroUsdc: bigint;
    participantTypes: GrowthProgramParticipantType[];
    operatorMode: GrowthProgramOperatorMode;
    status: GrowthProgramStatus;
    participationStatus: GrowthProgramParticipationStatus;
    attributionStatus: "NOT_CONFIGURED" | "CONFIGURED";
    outcomeDefinitionId: string;
    integrationId: string | null;
    holdSeconds: number;
    intentText: string;
  }): Promise<GrowthProgramRow>;
  getBinding?(workspaceId: string, id: string): Promise<GrowthProgramBinding | null>;
}

interface OutcomeApiForPrograms {
  createDefinition(params: { workspaceId: string; input: unknown; actorId?: string | null }): Promise<SafeDefinition>;
  getDefinitionById(params: { workspaceId: string; id: string }): Promise<SafeDefinition>;
  listDefinitions(workspaceId: string): Promise<SafeDefinition[]>;
  createIntegration(params: { workspaceId: string; name: string; actorId: string }): Promise<{ integration: SafeIntegration; apiKey: string }>;
  listIntegrations(workspaceId: string): Promise<SafeIntegration[]>;
}

export interface GrowthProgramDependencies {
  repository: GrowthProgramRepository;
  outcomeApi: OutcomeApiForPrograms;
  audit: AuditSink;
  now?: () => Date;
}

export interface CreateGrowthProgramResult {
  program: SafeGrowthProgram;
  integrationApiKey: string | null;
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  const error = Object.assign(new Error(message), { status, code, details });
  throw error;
}

function safeString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(400, "INVALID_REQUEST", `${field} must be a non-empty safe string.`);
  }
  return value.trim();
}

function safeSlug(value: unknown, name: string): string {
  const candidate = value == null || value === ""
    ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)
    : safeString(value, "slug", 80).toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(candidate)) {
    fail(400, "INVALID_REQUEST", "slug must use lowercase letters, numbers and hyphens.");
  }
  return candidate;
}

function exactMicro(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  fail(400, "INVALID_VALUE", `${field} must be a non-negative integer string.`);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(400, "INVALID_VALUE", `${field} must be a positive integer.`);
  }
  return value;
}

function boundedEnum<T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    fail(400, "INVALID_REQUEST", `${field} must be one of: ${values.join(", ")}.`);
  }
  return value as T[number];
}

function participantTypes(value: unknown): GrowthProgramParticipantType[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(400, "INVALID_PARTICIPANTS", "At least one supported participant type is required.");
  }
  const unique = [...new Set(value)];
  if (unique.some((item) => typeof item !== "string" || !GROWTH_PROGRAM_PARTICIPANT_TYPES.includes(item as GrowthProgramParticipantType))) {
    fail(400, "UNSUPPORTED_PARTICIPANT_TYPE", `Supported participant types: ${GROWTH_PROGRAM_PARTICIPANT_TYPES.join(", ")}.`);
  }
  return unique as GrowthProgramParticipantType[];
}

const REQUIRED_FIELDS: Record<ExternalOutcomeType, string[]> = {
  PURCHASE: ["purchaseId", "amountMicroUsdc", "purchasedAt"],
  ACTIVATED_USER: ["userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt"],
  QUALIFIED_REFERRAL: ["referrerId", "referredSubjectId", "qualifiedAt"],
  SUBSCRIPTION_STARTED: ["subscriptionId", "startedAt"],
};

function defaultDefinitionSchema(outcomeType: ExternalOutcomeType) {
  const required = REQUIRED_FIELDS[outcomeType];
  return {
    type: "object" as const,
    properties: Object.fromEntries(required.map((field) => [field, {
      type: /At$|Date$/i.test(field) ? "date-time" : /amount|count|total|price|quantity/i.test(field) ? "integer" : "string",
    }])),
    required,
    additionalProperties: false as const,
  };
}

function safeDefinition(definition: SafeDefinition) {
  return {
    id: definition.id,
    slug: definition.slug,
    name: definition.name,
    outcomeType: definition.outcomeType,
    unitValueMicroUsdc: definition.unitValueMicroUsdc,
    verificationPolicyId: definition.verificationPolicyId,
    requiredEvidenceFields: definition.requiredEvidenceFields,
    holdSeconds: definition.holdSeconds,
  };
}

function safeIntegration(integration: SafeIntegration | null) {
  return integration ? {
    id: integration.id,
    name: integration.name,
    status: integration.status,
    apiKeyPrefix: integration.apiKeyPrefix,
  } : null;
}

function toSafe(row: GrowthProgramRow, definition: SafeDefinition, integration: SafeIntegration | null): SafeGrowthProgram {
  return {
    id: row.id,
    projectId: row.workspaceId,
    workspaceId: row.workspaceId,
    campaignId: row.campaignId,
    policyVersionId: row.policyVersionId,
    name: row.name,
    slug: row.slug,
    objectiveOutcomeType: row.objectiveOutcomeType,
    targetOutcomeCount: row.targetOutcomeCount,
    budgetMicroUsdc: row.budgetMicroUsdc.toString(),
    maxVerifiedCacMicroUsdc: row.maxVerifiedCacMicroUsdc.toString(),
    rewardStructure: row.rewardStructure,
    rewardCeilingMicroUsdc: row.rewardCeilingMicroUsdc.toString(),
    participantTypes: row.participantTypes,
    operatorMode: row.operatorMode,
    status: row.status,
    participationStatus: row.participationStatus,
    attributionStatus: row.attributionStatus,
    integrationReadiness: integration ? "CONNECTED" : "NOT_CONFIGURED",
    fundingStatus: "NOT_FUNDED",
    settlementStatus: "NOT_CONFIGURED",
    outcomeDefinition: safeDefinition(definition),
    integration: safeIntegration(integration),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createGrowthProgramService(deps: GrowthProgramDependencies) {
  const now = () => deps.now?.() ?? new Date();

  async function definitionFor(workspaceId: string, id: string): Promise<SafeDefinition> {
    try {
      return await deps.outcomeApi.getDefinitionById({ workspaceId, id });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "OUTCOME_NOT_FOUND") {
        fail(404, "OUTCOME_NOT_FOUND", "The outcome definition is not available in this project.");
      }
      throw error;
    }
  }

  async function integrationFor(workspaceId: string, id: string): Promise<SafeIntegration> {
    const integration = (await deps.outcomeApi.listIntegrations(workspaceId)).find((item) => item.id === id);
    if (!integration) fail(404, "INTEGRATION_NOT_FOUND", "The integration is not available in this project.");
    if (integration.status !== "ACTIVE") fail(409, "INTEGRATION_REVOKED", "A revoked integration cannot be bound to a Growth Program.");
    return integration;
  }

  async function hydrate(row: GrowthProgramRow): Promise<SafeGrowthProgram> {
    const definition = await definitionFor(row.workspaceId, row.outcomeDefinitionId);
    const integration = row.integrationId ? await integrationFor(row.workspaceId, row.integrationId) : null;
    return toSafe(row, definition, integration);
  }

  return {
    async createProgram(input: CreateGrowthProgramInput): Promise<CreateGrowthProgramResult> {
      const name = safeString(input.name, "name", 120);
      const slug = safeSlug(input.slug, name);
      const outcomeType = boundedEnum(input.objectiveOutcomeType, EXTERNAL_OUTCOME_TYPES, "objectiveOutcomeType") as ExternalOutcomeType;
      const targetOutcomeCount = positiveInteger(input.targetOutcomeCount, "targetOutcomeCount");
      const budgetMicroUsdc = exactMicro(input.budgetMicroUsdc, "budgetMicroUsdc");
      const maxVerifiedCacMicroUsdc = exactMicro(input.maxVerifiedCacMicroUsdc, "maxVerifiedCacMicroUsdc");
      const rewardCeilingMicroUsdc = exactMicro(input.rewardCeilingMicroUsdc, "rewardCeilingMicroUsdc");
      if (budgetMicroUsdc <= 0n || maxVerifiedCacMicroUsdc <= 0n || rewardCeilingMicroUsdc <= 0n) {
        fail(400, "INVALID_VALUE", "Budget, verified CAC ceiling and reward ceiling must be greater than zero.");
      }
      if (rewardCeilingMicroUsdc > maxVerifiedCacMicroUsdc) {
        fail(400, "REWARD_EXCEEDS_CAC", "Reward ceiling cannot exceed the maximum verified CAC.");
      }
      const rewardStructure = boundedEnum(input.rewardStructure ?? "PERFORMANCE_ONLY", GROWTH_PROGRAM_REWARD_STRUCTURES, "rewardStructure") as GrowthProgramRewardStructure;
      const operatorMode = boundedEnum(input.operatorMode ?? "SHADOW", GROWTH_PROGRAM_OPERATOR_MODES, "operatorMode") as GrowthProgramOperatorMode;
      const allowedParticipants = participantTypes(input.participantTypes ?? ["CREATORS", "REFERRAL_PARTNERS"]);
      if (input.integrationId != null && input.integrationName != null && String(input.integrationName).trim()) {
        fail(400, "INTEGRATION_CONFLICT", "Choose an existing integration or create a new one, not both.");
      }

      let definition: SafeDefinition;
      if (input.outcomeDefinitionId != null && input.outcomeDefinitionId !== "") {
        definition = await definitionFor(input.workspaceId, safeString(input.outcomeDefinitionId, "outcomeDefinitionId", 120));
        if (!definition.active) fail(409, "OUTCOME_INACTIVE", "An inactive outcome definition cannot be bound to a new Growth Program.");
      } else {
        const existing = (await deps.outcomeApi.listDefinitions(input.workspaceId)).find((item) => item.active && item.outcomeType === outcomeType);
        definition = existing ?? await deps.outcomeApi.createDefinition({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          input: {
            slug: `${slug}-${outcomeType.toLowerCase().replaceAll("_", "-")}`.slice(0, 80),
            name: `${name} — ${outcomeType.replaceAll("_", " ")}`,
            description: `Bounded verification policy for the ${name} Growth Program.`,
            outcomeType,
            unitValueMicroUsdc: rewardCeilingMicroUsdc.toString(),
            evidenceSchemaVersion: 1,
            evidenceSchema: defaultDefinitionSchema(outcomeType),
            holdSeconds: 86400,
          },
        });
      }
      if (definition.outcomeType !== outcomeType) {
        fail(409, "PROGRAM_OUTCOME_MISMATCH", "The selected outcome definition does not match the Growth Program objective.");
      }

      let integration: SafeIntegration | null = null;
      let integrationApiKey: string | null = null;
      if (input.integrationId != null && input.integrationId !== "") {
        integration = await integrationFor(input.workspaceId, safeString(input.integrationId, "integrationId", 120));
      } else if (input.integrationName != null && String(input.integrationName).trim()) {
        const created = await deps.outcomeApi.createIntegration({
          workspaceId: input.workspaceId,
          name: safeString(input.integrationName, "integrationName", 120),
          actorId: input.actorId,
        });
        integration = created.integration;
        integrationApiKey = created.apiKey;
      }

      const row = await deps.repository.insert({
        id: newId(),
        campaignId: newId(),
        policyVersionId: newId(),
        workspaceId: input.workspaceId,
        createdByUserId: input.actorId,
        name,
        slug,
        objectiveOutcomeType: outcomeType,
        targetOutcomeCount,
        budgetMicroUsdc,
        maxVerifiedCacMicroUsdc,
        rewardStructure,
        rewardCeilingMicroUsdc,
        participantTypes: allowedParticipants,
        operatorMode,
        status: "DRAFT",
        participationStatus: "CLOSED",
        attributionStatus: "NOT_CONFIGURED",
        outcomeDefinitionId: definition.id,
        integrationId: integration?.id ?? null,
        holdSeconds: definition.holdSeconds,
        intentText: `${name}: acquire ${targetOutcomeCount} verified ${outcomeType.toLowerCase().replaceAll("_", " ")} outcomes.`,
      });
      await deps.audit({
        actorType: "USER",
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        action: "developer.growth_program.created",
        targetType: "developer_growth_program",
        targetId: row.id,
        metadata: {
          programId: row.id,
          campaignId: row.campaignId,
          policyVersionId: row.policyVersionId,
          outcomeDefinitionId: row.outcomeDefinitionId,
          integrationId: row.integrationId,
          objectiveOutcomeType: row.objectiveOutcomeType,
          targetOutcomeCount: row.targetOutcomeCount,
          budgetMicroUsdc: row.budgetMicroUsdc.toString(),
          maxVerifiedCacMicroUsdc: row.maxVerifiedCacMicroUsdc.toString(),
          rewardCeilingMicroUsdc: row.rewardCeilingMicroUsdc.toString(),
          participantTypes: row.participantTypes,
          operatorMode: row.operatorMode,
          fundingStatus: "NOT_FUNDED",
        },
      });
      return { program: await hydrate(row), integrationApiKey };
    },

    async getProgram(params: { workspaceId: string; id: string }): Promise<SafeGrowthProgram> {
      const row = await deps.repository.get(params.workspaceId, params.id);
      if (!row) fail(404, "PROGRAM_NOT_FOUND", "Growth Program not found.");
      return hydrate(row);
    },

    async listPrograms(workspaceId: string): Promise<SafeGrowthProgram[]> {
      const rows = await deps.repository.list(workspaceId);
      return Promise.all(rows.map(hydrate));
    },
  };
}

function toProgramRow(
  row: typeof developerGrowthPrograms.$inferSelect,
  policy: typeof campaignPolicyVersions.$inferSelect,
): GrowthProgramRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    campaignId: row.campaignId,
    policyVersionId: row.policyVersionId,
    integrationId: row.integrationId,
    outcomeDefinitionId: row.outcomeDefinitionId,
    operatorMode: row.operatorMode as GrowthProgramOperatorMode,
    name: row.name,
    slug: row.slug,
    objectiveOutcomeType: row.objectiveOutcomeType as ExternalOutcomeType,
    targetOutcomeCount: policy.targetOutcomeCount ?? 0,
    budgetMicroUsdc: policy.budgetMicroUsdc ?? 0n,
    maxVerifiedCacMicroUsdc: row.maxVerifiedCacMicroUsdc,
    rewardStructure: row.rewardStructure as GrowthProgramRewardStructure,
    rewardCeilingMicroUsdc: policy.bountyCeilingMicroUsdc ?? 0n,
    participantTypes: row.participantTypes as GrowthProgramParticipantType[],
    status: row.status as GrowthProgramStatus,
    participationStatus: row.participationStatus as GrowthProgramParticipationStatus,
    attributionStatus: row.attributionStatus as "NOT_CONFIGURED" | "CONFIGURED",
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleGrowthProgramRepository(db: Db = getDb()): GrowthProgramRepository {
  async function hydrate(row: typeof developerGrowthPrograms.$inferSelect): Promise<GrowthProgramRow> {
    const [policy] = await db.select().from(campaignPolicyVersions).where(eq(campaignPolicyVersions.id, row.policyVersionId)).limit(1);
    if (!policy) fail(500, "INTERNAL", "Growth Program policy is missing.");
    return toProgramRow(row, policy);
  }

  return {
    async get(workspaceId, id) {
      const [row] = await db.select().from(developerGrowthPrograms).where(and(eq(developerGrowthPrograms.workspaceId, workspaceId), eq(developerGrowthPrograms.id, id))).limit(1);
      return row ? hydrate(row) : null;
    },
    async list(workspaceId) {
      const rows = await db.select().from(developerGrowthPrograms).where(eq(developerGrowthPrograms.workspaceId, workspaceId)).orderBy(desc(developerGrowthPrograms.createdAt));
      return Promise.all(rows.map(hydrate));
    },
    async insert(input) {
      const row = await db.transaction(async (tx) => {
        await tx.insert(campaigns).values({
          id: input.campaignId,
          workspaceId: input.workspaceId,
          state: "DRAFT",
          createdByUserId: input.createdByUserId,
        });
        await tx.insert(campaignPolicyVersions).values({
          id: input.policyVersionId,
          campaignId: input.campaignId,
          version: 1,
          intentText: input.intentText,
          targetOutcomeCount: input.targetOutcomeCount,
          budgetMicroUsdc: input.budgetMicroUsdc,
          bountyFloorMicroUsdc: input.rewardCeilingMicroUsdc,
          bountyCeilingMicroUsdc: input.rewardCeilingMicroUsdc,
          marketVisibility: "PRIVATE",
          allowedPartnerRulesJson: { participantTypes: input.participantTypes },
          refundHoldSeconds: input.holdSeconds,
          status: "DRAFT",
        });
        await tx.update(campaigns).set({ currentPolicyVersionId: input.policyVersionId }).where(eq(campaigns.id, input.campaignId));
        const [created] = await tx.insert(developerGrowthPrograms).values({
          id: input.id,
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          policyVersionId: input.policyVersionId,
          integrationId: input.integrationId,
          outcomeDefinitionId: input.outcomeDefinitionId,
          name: input.name,
          slug: input.slug,
          objectiveOutcomeType: input.objectiveOutcomeType,
          maxVerifiedCacMicroUsdc: input.maxVerifiedCacMicroUsdc,
          participantTypes: input.participantTypes,
          rewardStructure: input.rewardStructure,
          operatorMode: input.operatorMode,
          status: input.status,
          participationStatus: input.participationStatus,
          attributionStatus: input.attributionStatus,
          createdByUserId: input.createdByUserId,
        }).returning();
        return created;
      });
      return {
        ...toProgramRow(row, {
          id: input.policyVersionId,
          campaignId: input.campaignId,
          version: 1,
          intentText: input.intentText,
          targetOutcomeCount: input.targetOutcomeCount,
          budgetMicroUsdc: input.budgetMicroUsdc,
          bountyFloorMicroUsdc: input.rewardCeilingMicroUsdc,
          bountyCeilingMicroUsdc: input.rewardCeilingMicroUsdc,
          minQualifyingPurchaseMicroUsdc: null,
          deadline: null,
          marketVisibility: "PRIVATE",
          allowedPartnerRulesJson: { participantTypes: input.participantTypes },
          refundHoldSeconds: input.holdSeconds,
          escalationRulesJson: {},
          status: "DRAFT",
          approvedByUserId: null,
          approvedAt: null,
          createdAt: row.createdAt,
        } as typeof campaignPolicyVersions.$inferSelect),
      };
    },
    async getBinding(workspaceId, id) {
      const [row] = await db.select({
        id: developerGrowthPrograms.id,
        workspaceId: developerGrowthPrograms.workspaceId,
        integrationId: developerGrowthPrograms.integrationId,
        outcomeDefinitionId: developerGrowthPrograms.outcomeDefinitionId,
        operatorMode: developerGrowthPrograms.operatorMode,
      }).from(developerGrowthPrograms).where(and(eq(developerGrowthPrograms.workspaceId, workspaceId), eq(developerGrowthPrograms.id, id))).limit(1);
      return row ? { ...row, operatorMode: row.operatorMode as GrowthProgramOperatorMode } : null;
    },
  };
}

export function createMemoryGrowthProgramRepository(): GrowthProgramRepository & { programs: Map<string, GrowthProgramRow> } {
  const programs = new Map<string, GrowthProgramRow>();
  return {
    programs,
    async get(workspaceId, id) {
      const row = programs.get(id);
      return row?.workspaceId === workspaceId ? row : null;
    },
    async list(workspaceId) {
      return [...programs.values()].filter((row) => row.workspaceId === workspaceId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async insert(input) {
      const at = new Date("2026-01-01T00:00:00.000Z");
      const row: GrowthProgramRow = {
        id: input.id,
        workspaceId: input.workspaceId,
        campaignId: input.campaignId,
        policyVersionId: input.policyVersionId,
        integrationId: input.integrationId,
        outcomeDefinitionId: input.outcomeDefinitionId,
        operatorMode: input.operatorMode,
        name: input.name,
        slug: input.slug,
        objectiveOutcomeType: input.objectiveOutcomeType,
        targetOutcomeCount: input.targetOutcomeCount,
        budgetMicroUsdc: input.budgetMicroUsdc,
        maxVerifiedCacMicroUsdc: input.maxVerifiedCacMicroUsdc,
        rewardStructure: input.rewardStructure,
        rewardCeilingMicroUsdc: input.rewardCeilingMicroUsdc,
        participantTypes: input.participantTypes,
        status: input.status,
        participationStatus: input.participationStatus,
        attributionStatus: input.attributionStatus,
        createdByUserId: input.createdByUserId,
        createdAt: at,
        updatedAt: at,
      };
      if ([...programs.values()].some((candidate) => candidate.workspaceId === input.workspaceId && candidate.slug === input.slug)) {
        fail(409, "PROGRAM_SLUG_CONFLICT", "A Growth Program with this slug already exists in the project.");
      }
      programs.set(row.id, row);
      return row;
    },
    async getBinding(workspaceId, id) {
      const row = await this.get(workspaceId, id);
      return row ? {
        id: row.id,
        workspaceId: row.workspaceId,
        integrationId: row.integrationId,
        outcomeDefinitionId: row.outcomeDefinitionId,
        operatorMode: row.operatorMode,
      } : null;
    },
  };
}

export function createProductionGrowthProgramService() {
  if (!isDbConfigured()) fail(503, "UNCONFIGURED", "Database is not configured.");
  const db = getDb();
  return createGrowthProgramService({
    repository: createDrizzleGrowthProgramRepository(db),
    outcomeApi: createProductionOutcomeApiService(),
    audit: (input) => recordAuditEvent(db, input),
  });
}

export async function getGrowthProgramBindingFromDb(db: Db, workspaceId: string, id: string): Promise<GrowthProgramBinding | null> {
  const [row] = await db.select({
    id: developerGrowthPrograms.id,
    workspaceId: developerGrowthPrograms.workspaceId,
    integrationId: developerGrowthPrograms.integrationId,
    outcomeDefinitionId: developerGrowthPrograms.outcomeDefinitionId,
    operatorMode: developerGrowthPrograms.operatorMode,
  }).from(developerGrowthPrograms).where(and(eq(developerGrowthPrograms.workspaceId, workspaceId), eq(developerGrowthPrograms.id, id))).limit(1);
  return row ? { ...row, operatorMode: row.operatorMode as GrowthProgramOperatorMode } : null;
}

export { EXTERNAL_OUTCOME_TYPES };
