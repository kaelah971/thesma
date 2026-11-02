import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, isDbConfigured, type Db } from "../db/client";
import {
  auditEvents,
  developerIntegrations,
  externalOutcomeDefinitions,
  externalOutcomeEvents,
} from "../db/schema";
import { newId } from "../auth/session";
import { getOrganizationOperatorMode, type OrganizationOperatorMode } from "./operatorMode";
import type { AuditSink } from "./campaignStore";
import { recordAuditEvent } from "./audit";
import { evaluateValueOfInformation } from "./verification";
import {
  EXTERNAL_OUTCOME_TYPES,
  OutcomeAdapterError,
  evaluateOutcomeEvidence,
  normalizeDefinitionInput,
  requestFingerprint,
  requiredEvidenceFields,
  sha256Hex,
  stableJson,
  validateExternalIdentity,
  validateOccurredAt,
  type ExternalEvidenceSchema,
  type ExternalOutcomeType,
  type NormalizedDefinitionInput,
} from "./outcomeAdapter";

export interface DeveloperIntegrationRow {
  id: string;
  workspaceId: string;
  name: string;
  status: "ACTIVE" | "REVOKED";
  apiKeyId: string;
  apiKeyPrefix: string;
  apiKeyDigest: string;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface ExternalOutcomeDefinitionRow {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  outcomeType: ExternalOutcomeType;
  unitValueMicroUsdc: bigint;
  asset: string;
  evidenceSchemaVersion: number;
  evidenceSchemaJson: ExternalEvidenceSchema;
  verificationPolicyId: string;
  holdSeconds: number;
  active: boolean;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ExternalVerificationState = "SUBMITTED" | "REVIEW" | "VERIFIED" | "REFUSED";
export type ExternalHoldState = "NOT_HELD" | "HELD" | "RELEASED";
export type ExternalSettlementState = "NOT_ELIGIBLE" | "HELD" | "ELIGIBLE_NOT_REQUESTED" | "SHADOW_BLOCKED" | "SETTLED";

export interface ExternalOutcomeEventRow {
  id: string;
  receiptId: string;
  workspaceId: string;
  integrationId: string;
  definitionId: string;
  externalEventId: string;
  externalSubjectId: string;
  occurredAt: Date;
  schemaVersion: number;
  evidenceJson: Record<string, unknown>;
  normalizedEvidenceJson: Record<string, unknown>;
  evidenceHash: string;
  idempotencyKey: string;
  requestFingerprint: string;
  verificationState: ExternalVerificationState;
  holdState: ExternalHoldState;
  settlementState: ExternalSettlementState;
  executionState: "NOT_REQUESTED" | "NOT_EXECUTED";
  decisionReasonsJson: string[];
  policySnapshotJson: Record<string, unknown>;
  procurementRecommendation: string;
  rejectionCode: string | null;
  holdUntil: Date | null;
  verifiedAt: Date | null;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutcomeLedgerRow {
  id: string;
  action: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: Date;
}

export interface OutcomeApiRepository {
  getIntegrationByDigest(digest: string): Promise<DeveloperIntegrationRow | null>;
  getIntegration(workspaceId: string, integrationId: string): Promise<DeveloperIntegrationRow | null>;
  listIntegrations(workspaceId: string): Promise<DeveloperIntegrationRow[]>;
  insertIntegration(input: Omit<DeveloperIntegrationRow, "createdAt" | "revokedAt" | "lastUsedAt">): Promise<DeveloperIntegrationRow>;
  revokeIntegration(workspaceId: string, integrationId: string, at: Date): Promise<DeveloperIntegrationRow | null>;
  touchIntegration(integrationId: string, at: Date): Promise<void>;
  listDefinitionVersions(workspaceId: string, slug: string): Promise<ExternalOutcomeDefinitionRow[]>;
  listDefinitions(workspaceId: string): Promise<ExternalOutcomeDefinitionRow[]>;
  getDefinitionById(workspaceId: string, id: string): Promise<ExternalOutcomeDefinitionRow | null>;
  insertDefinition(input: Omit<ExternalOutcomeDefinitionRow, "createdAt" | "updatedAt" | "usedAt">): Promise<ExternalOutcomeDefinitionRow>;
  deactivateDefinitions(workspaceId: string, slug: string, exceptId: string): Promise<void>;
  markDefinitionUsed(id: string, at: Date): Promise<void>;
  getEventById(id: string, workspaceId: string): Promise<ExternalOutcomeEventRow | null>;
  getEventByIdempotency(workspaceId: string, definitionId: string, key: string): Promise<ExternalOutcomeEventRow | null>;
  getEventByExternalId(workspaceId: string, externalEventId: string): Promise<ExternalOutcomeEventRow | null>;
  insertEvent(input: Omit<ExternalOutcomeEventRow, "createdAt" | "updatedAt">): Promise<ExternalOutcomeEventRow>;
  listEventsByIntegration(workspaceId: string, integrationId: string): Promise<ExternalOutcomeEventRow[]>;
  listEvents(workspaceId: string): Promise<ExternalOutcomeEventRow[]>;
  listLedger(workspaceId: string, eventId: string): Promise<OutcomeLedgerRow[]>;
  appendMemoryLedger?(row: OutcomeLedgerRow): void;
}

export interface OutcomeApiPrincipal {
  integration: DeveloperIntegrationRow;
  workspaceId: string;
}

export interface CreateIntegrationResult {
  integration: SafeIntegration;
  apiKey: string;
}

export interface SafeIntegration {
  id: string;
  projectId: string;
  /** Deprecated response alias retained for existing API clients. */
  workspaceId: string;
  name: string;
  status: "ACTIVE" | "REVOKED";
  apiKeyId: string;
  apiKeyPrefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface SafeDefinition {
  id: string;
  projectId: string;
  /** Deprecated response alias retained for existing API clients. */
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  outcomeType: ExternalOutcomeType;
  unitValueMicroUsdc: string;
  asset: string;
  evidenceSchemaVersion: number;
  requiredEvidenceFields: string[];
  evidenceSchema: ExternalEvidenceSchema;
  verificationPolicyId: string;
  holdSeconds: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SafeOutcomeEvent {
  id: string;
  receiptId: string;
  definition: Pick<SafeDefinition, "id" | "slug" | "name" | "outcomeType" | "unitValueMicroUsdc" | "asset">;
  integrationId: string;
  externalEventId: string;
  externalSubjectId: string;
  submittedAt: string;
  occurredAt: string;
  schemaVersion: number;
  verificationState: ExternalVerificationState;
  holdState: ExternalHoldState;
  settlementState: ExternalSettlementState;
  executionState: "NOT_REQUESTED" | "NOT_EXECUTED";
  reasons: string[];
  evidenceHash: string;
  holdUntil: string | null;
  verifiedAt: string | null;
  settledAt: string | null;
  procurementRecommendation: string;
}

export interface SafeOutcomeReceipt {
  id: string;
  eventId: string;
  outcome: SafeOutcomeEvent["definition"];
  submittedByIntegrationId: string;
  externalEventId: string;
  externalSubjectId: string;
  schemaVersion: number;
  evidenceHash: string;
  verificationDecision: ExternalVerificationState;
  reasons: string[];
  policySnapshot: { verificationPolicyId: string; schemaVersion: number; holdSeconds: number };
  holdState: ExternalHoldState;
  holdUntil: string | null;
  settlementState: ExternalSettlementState;
  executionState: "NOT_REQUESTED" | "NOT_EXECUTED";
  procurementRecommendation: string;
  submittedAt: string;
  verifiedAt: string | null;
  settledAt: string | null;
}

export interface SafeOutcomeStatus {
  event: SafeOutcomeEvent;
  receipt: SafeOutcomeReceipt;
  decisionTrail: Array<{ action: string; createdAt: string; metadata: unknown }>;
}

export interface OutcomeTelemetry {
  integrationId: string;
  submitted: number;
  verified: number;
  review: number;
  refused: number;
  held: number;
  settled: number;
}

export interface OutcomeApiDependencies {
  repository: OutcomeApiRepository;
  audit: AuditSink;
  getMode?: (workspaceId: string) => Promise<OrganizationOperatorMode>;
  now?: () => Date;
}

const submissionWindows = new Map<string, { startedAtMs: number; count: number }>();

function enforceSubmissionRateLimit(integrationId: string, at: Date): void {
  const windowMs = 60_000;
  const current = submissionWindows.get(integrationId);
  if (!current || at.getTime() - current.startedAtMs >= windowMs) {
    submissionWindows.set(integrationId, { startedAtMs: at.getTime(), count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > 120) fail(429, "RATE_LIMITED", "Submission rate limit exceeded; retry after one minute.");
}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new OutcomeAdapterError(status, code, message, details);
}

function asSafeName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(400, "INVALID_REQUEST", "name must be a non-empty safe string.");
  }
  return value.trim();
}

function asIdempotencyKey(value: string | null): string {
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required and must be a safe string.");
  }
  return value;
}

function toIntegration(row: DeveloperIntegrationRow): SafeIntegration {
  return {
    id: row.id,
    projectId: row.workspaceId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    apiKeyId: row.apiKeyId,
    apiKeyPrefix: row.apiKeyPrefix,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

function toDefinition(row: ExternalOutcomeDefinitionRow): SafeDefinition {
  return {
    id: row.id,
    projectId: row.workspaceId,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    outcomeType: row.outcomeType,
    unitValueMicroUsdc: row.unitValueMicroUsdc.toString(),
    asset: row.asset,
    evidenceSchemaVersion: row.evidenceSchemaVersion,
    requiredEvidenceFields: requiredEvidenceFields(row.evidenceSchemaJson),
    evidenceSchema: row.evidenceSchemaJson,
    verificationPolicyId: row.verificationPolicyId,
    holdSeconds: row.holdSeconds,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvent(row: ExternalOutcomeEventRow, definition: ExternalOutcomeDefinitionRow): SafeOutcomeEvent {
  return {
    id: row.id,
    receiptId: row.receiptId,
    definition: {
      id: definition.id,
      slug: definition.slug,
      name: definition.name,
      outcomeType: definition.outcomeType,
      unitValueMicroUsdc: definition.unitValueMicroUsdc.toString(),
      asset: definition.asset,
    },
    integrationId: row.integrationId,
    externalEventId: row.externalEventId,
    externalSubjectId: row.externalSubjectId,
    submittedAt: row.createdAt.toISOString(),
    occurredAt: row.occurredAt.toISOString(),
    schemaVersion: row.schemaVersion,
    verificationState: row.verificationState,
    holdState: row.holdState,
    settlementState: row.settlementState,
    executionState: row.executionState,
    reasons: row.decisionReasonsJson,
    evidenceHash: row.evidenceHash,
    holdUntil: row.holdUntil?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    procurementRecommendation: row.procurementRecommendation,
  };
}

function toReceipt(row: ExternalOutcomeEventRow, definition: ExternalOutcomeDefinitionRow): SafeOutcomeReceipt {
  return {
    id: row.receiptId,
    eventId: row.id,
    outcome: toEvent(row, definition).definition,
    submittedByIntegrationId: row.integrationId,
    externalEventId: row.externalEventId,
    externalSubjectId: row.externalSubjectId,
    schemaVersion: row.schemaVersion,
    evidenceHash: row.evidenceHash,
    verificationDecision: row.verificationState,
    reasons: row.decisionReasonsJson,
    policySnapshot: {
      verificationPolicyId: definition.verificationPolicyId,
      schemaVersion: row.schemaVersion,
      holdSeconds: definition.holdSeconds,
    },
    holdState: row.holdState,
    holdUntil: row.holdUntil?.toISOString() ?? null,
    settlementState: row.settlementState,
    executionState: row.executionState,
    procurementRecommendation: row.procurementRecommendation,
    submittedAt: row.createdAt.toISOString(),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}

async function recordOutcomeAudit(
  deps: OutcomeApiDependencies,
  input: Parameters<AuditSink>[0],
): Promise<void> {
  await deps.audit(input);
  deps.repository.appendMemoryLedger?.({
    id: newId(),
    action: input.action,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? {},
    createdAt: deps.now?.() ?? new Date(),
  });
}

export function createOutcomeApiService(deps: OutcomeApiDependencies) {
  const now = () => deps.now?.() ?? new Date();
  const getMode = deps.getMode ?? getOrganizationOperatorMode;

  return {
    async createIntegration(params: { workspaceId: string; name: string; actorId: string }): Promise<CreateIntegrationResult> {
      const name = asSafeName(params.name);
      const token = `ths_api_${randomBytes(32).toString("base64url")}`;
      const apiKeyId = `key_${newId()}`;
      const row = await deps.repository.insertIntegration({
        id: newId(),
        workspaceId: params.workspaceId,
        name,
        status: "ACTIVE",
        apiKeyId,
        apiKeyPrefix: `${token.slice(0, 16)}…`,
        apiKeyDigest: sha256Hex(token),
      });
      await recordOutcomeAudit(deps, {
        actorType: "USER",
        actorId: params.actorId,
        workspaceId: params.workspaceId,
        action: "developer.integration.created",
        targetType: "developer_integration",
        targetId: row.id,
        metadata: { integrationId: row.id, apiKeyId: row.apiKeyId, apiKeyPrefix: row.apiKeyPrefix, name },
      });
      return { integration: toIntegration(row), apiKey: token };
    },

    async listIntegrations(workspaceId: string): Promise<SafeIntegration[]> {
      return (await deps.repository.listIntegrations(workspaceId)).map(toIntegration);
    },

    async revokeIntegration(params: { workspaceId: string; integrationId: string; actorId: string }): Promise<SafeIntegration> {
      const row = await deps.repository.revokeIntegration(params.workspaceId, params.integrationId, now());
      if (!row) fail(404, "INTEGRATION_NOT_FOUND", "Integration not found.");
      await recordOutcomeAudit(deps, {
        actorType: "USER",
        actorId: params.actorId,
        workspaceId: params.workspaceId,
        action: "developer.integration.revoked",
        targetType: "developer_integration",
        targetId: row.id,
        metadata: { integrationId: row.id, apiKeyId: row.apiKeyId },
      });
      return toIntegration(row);
    },

    async createDefinition(params: { workspaceId: string; input: unknown; actorId?: string | null }): Promise<SafeDefinition> {
      const normalized = normalizeDefinitionInput(params.input);
      const versions = await deps.repository.listDefinitionVersions(params.workspaceId, normalized.slug);
      const existing = versions.find((row) => row.evidenceSchemaVersion === normalized.evidenceSchemaVersion);
      if (existing) {
        const same = existing.name === normalized.name
          && existing.description === normalized.description
          && existing.outcomeType === normalized.outcomeType
          && existing.unitValueMicroUsdc === normalized.unitValueMicroUsdc
          && existing.asset === normalized.asset
          && existing.verificationPolicyId === normalized.verificationPolicyId
          && existing.holdSeconds === normalized.holdSeconds
          && stableJson(existing.evidenceSchemaJson) === stableJson(normalized.evidenceSchemaJson);
        if (same) return toDefinition(existing);
        fail(409, "SCHEMA_VERSION_IMMUTABLE", "A used or existing schema version cannot be changed. Create the next version instead.");
      }
      const latest = versions.reduce((max, row) => Math.max(max, row.evidenceSchemaVersion), 0);
      if (latest > 0 && normalized.evidenceSchemaVersion !== latest + 1) {
        fail(409, "SCHEMA_VERSION_MISMATCH", `Next schema version must be ${latest + 1}.`);
      }
      const row = await deps.repository.insertDefinition({
        id: newId(),
        workspaceId: params.workspaceId,
        slug: normalized.slug,
        name: normalized.name,
        description: normalized.description,
        outcomeType: normalized.outcomeType,
        unitValueMicroUsdc: normalized.unitValueMicroUsdc,
        asset: normalized.asset,
        evidenceSchemaVersion: normalized.evidenceSchemaVersion,
        evidenceSchemaJson: normalized.evidenceSchemaJson,
        verificationPolicyId: normalized.verificationPolicyId,
        holdSeconds: normalized.holdSeconds,
        active: true,
      });
      await deps.repository.deactivateDefinitions(params.workspaceId, normalized.slug, row.id);
      await recordOutcomeAudit(deps, {
        actorType: params.actorId ? "USER" : "SYSTEM",
        actorId: params.actorId ?? null,
        workspaceId: params.workspaceId,
        action: "developer.outcome.definition.created",
        targetType: "external_outcome_definition",
        targetId: row.id,
        metadata: {
          definitionId: row.id,
          slug: row.slug,
          outcomeType: row.outcomeType,
          schemaVersion: row.evidenceSchemaVersion,
          requiredEvidenceFields: requiredEvidenceFields(row.evidenceSchemaJson),
          unitValueMicroUsdc: row.unitValueMicroUsdc.toString(),
        },
      });
      return toDefinition(row);
    },

    async getDefinition(params: { workspaceId: string; slug: string; schemaVersion?: number }): Promise<SafeDefinition> {
      const versions = await deps.repository.listDefinitionVersions(params.workspaceId, params.slug.toLowerCase());
      if (versions.length === 0) fail(404, "OUTCOME_NOT_FOUND", "Outcome definition not found.");
      const row = params.schemaVersion === undefined
        ? versions.find((candidate) => candidate.active) ?? versions[0]
        : versions.find((candidate) => candidate.evidenceSchemaVersion === params.schemaVersion);
      if (!row) fail(409, "SCHEMA_VERSION_MISMATCH", "Requested schema version is not registered.");
      return toDefinition(row);
    },

    async listDefinitions(workspaceId: string): Promise<SafeDefinition[]> {
      return (await deps.repository.listDefinitions(workspaceId)).map(toDefinition);
    },

    async authenticate(request: Request): Promise<OutcomeApiPrincipal> {
      const header = request.headers.get("authorization") ?? "";
      const match = /^Bearer\s+([^\s]+)$/i.exec(header);
      if (!match) fail(401, "INVALID_API_KEY", "A Bearer API key is required.");
      const row = await deps.repository.getIntegrationByDigest(sha256Hex(match[1]));
      if (!row) fail(401, "INVALID_API_KEY", "The API key is invalid.");
      if (row.status !== "ACTIVE") fail(401, "INTEGRATION_REVOKED", "The integration has been revoked.");
      await deps.repository.touchIntegration(row.id, now());
      return { integration: row, workspaceId: row.workspaceId };
    },

    async submitEvent(params: {
      principal: OutcomeApiPrincipal;
      slug: string;
      idempotencyKey: string | null;
      input: unknown;
    }): Promise<{ event: SafeOutcomeEvent; receipt: SafeOutcomeReceipt; idempotent: boolean; mode: OrganizationOperatorMode }> {
      const idempotencyKey = asIdempotencyKey(params.idempotencyKey);
      enforceSubmissionRateLimit(params.principal.integration.id, now());
      if (!params.input || typeof params.input !== "object" || Array.isArray(params.input)) fail(400, "INVALID_REQUEST", "Request body must be an object.");
      const body = params.input as Record<string, unknown>;
      const unsupported = Object.keys(body).filter((key) => !["externalEventId", "externalSubjectId", "occurredAt", "evidence", "schemaVersion"].includes(key));
      if (unsupported.length > 0) fail(400, "INVALID_REQUEST", `Unsupported request fields: ${unsupported.join(", ")}.`);
      const externalEventId = validateExternalIdentity(body.externalEventId, "externalEventId");
      const externalSubjectId = validateExternalIdentity(body.externalSubjectId, "externalSubjectId");
      const schemaVersion = body.schemaVersion === undefined ? undefined : body.schemaVersion;
      if (schemaVersion !== undefined && (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1)) {
        fail(400, "SCHEMA_VERSION_MISMATCH", "schemaVersion must be a positive integer.");
      }
      const definitionRows = await deps.repository.listDefinitionVersions(params.principal.workspaceId, params.slug.toLowerCase());
      if (definitionRows.length === 0) fail(404, "OUTCOME_NOT_FOUND", "Outcome definition not found.");
      const definition = schemaVersion === undefined
        ? definitionRows.find((candidate) => candidate.active) ?? definitionRows[0]
        : definitionRows.find((candidate) => candidate.evidenceSchemaVersion === schemaVersion);
      if (!definition) fail(409, "SCHEMA_VERSION_MISMATCH", "Requested schema version is not registered.");
      if (!definition.active) fail(409, "OUTCOME_INACTIVE", "This outcome definition is inactive and cannot receive new events.");
      const occurredAt = validateOccurredAt(body.occurredAt, now());
      const decision = evaluateOutcomeEvidence({
        definition,
        evidence: body.evidence,
        occurredAt,
      });
      const fingerprint = requestFingerprint({
        definitionId: definition.id,
        schemaVersion: definition.evidenceSchemaVersion,
        externalEventId,
        externalSubjectId,
        occurredAt,
        evidence: decision.normalizedEvidence,
      });
      const prior = await deps.repository.getEventByIdempotency(params.principal.workspaceId, definition.id, idempotencyKey);
      if (prior) {
        if (prior.integrationId !== params.principal.integration.id) fail(409, "REPLAY_DETECTED", "Idempotency-Key is already bound to another integration.");
        if (prior.requestFingerprint !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different payload.");
        return this.getEventResult(prior, definition, true);
      }
      const replay = await deps.repository.getEventByExternalId(params.principal.workspaceId, externalEventId);
      if (replay) fail(409, "REPLAY_DETECTED", "externalEventId has already been submitted for this project.");

      const mode = await getMode(params.principal.workspaceId);
      const at = now();
      const verified = decision.verificationState === "VERIFIED";
      const held = verified && definition.holdSeconds > 0;
      const holdUntil = held ? new Date(at.getTime() + definition.holdSeconds * 1000) : null;
      const voi = decision.verificationState === "REVIEW"
        ? evaluateValueOfInformation({
            payoutAtRiskMicroUsdc: definition.unitValueMicroUsdc,
            currentConfidenceBps: 5_000,
            requiredConfidenceBps: 9_000,
            providerPriceMicroUsdc: 2_000n,
            remainingVerificationBudgetMicroUsdc: 10_000_000n,
            maxPerCheckMicroUsdc: 2_000_000n,
            maxEvidenceCostShareBps: 200,
          })
        : null;
      const procurementRecommendation = decision.verificationState === "REVIEW"
        ? mode === "SHADOW"
          ? voi?.decision === "BUY" ? "WOULD_BUY" : "REVIEW"
          : voi?.decision ?? "REVIEW"
        : "NOT_NEEDED";
      const reasons = [
        ...decision.reasonCodes,
        ...(voi?.reasons.slice(0, 1) ?? []),
        ...(mode === "SHADOW" ? ["SHADOW_MODE_EVALUATED"] : []),
      ];
      const eventInput: Omit<ExternalOutcomeEventRow, "createdAt" | "updatedAt"> = {
        id: newId(),
        receiptId: `receipt_${newId()}`,
        workspaceId: params.principal.workspaceId,
        integrationId: params.principal.integration.id,
        definitionId: definition.id,
        externalEventId,
        externalSubjectId,
        occurredAt,
        schemaVersion: definition.evidenceSchemaVersion,
        evidenceJson: body.evidence as Record<string, unknown>,
        normalizedEvidenceJson: decision.normalizedEvidence,
        evidenceHash: decision.evidenceHash,
        idempotencyKey,
        requestFingerprint: fingerprint,
        verificationState: decision.verificationState,
        holdState: held ? "HELD" : verified ? "RELEASED" : "NOT_HELD",
        settlementState: !verified ? "NOT_ELIGIBLE" : mode === "SHADOW" ? "SHADOW_BLOCKED" : held ? "HELD" : "ELIGIBLE_NOT_REQUESTED",
        executionState: mode === "SHADOW" ? "NOT_EXECUTED" : "NOT_REQUESTED",
        decisionReasonsJson: reasons,
        policySnapshotJson: {
          verificationPolicyId: definition.verificationPolicyId,
          schemaVersion: definition.evidenceSchemaVersion,
          holdSeconds: definition.holdSeconds,
          outcomeType: definition.outcomeType,
        },
        procurementRecommendation,
        rejectionCode: decision.verificationState === "REFUSED" ? decision.reasonCodes[0] ?? "POLICY_REFUSED" : null,
        holdUntil,
        verifiedAt: verified ? at : null,
        settledAt: null,
      };
      let row: ExternalOutcomeEventRow;
      try {
        row = await deps.repository.insertEvent(eventInput);
      } catch (error) {
        const existing = await deps.repository.getEventByIdempotency(params.principal.workspaceId, definition.id, idempotencyKey);
        if (existing) {
          if (existing.integrationId !== params.principal.integration.id) fail(409, "REPLAY_DETECTED", "Idempotency-Key is already bound to another integration.");
          if (existing.requestFingerprint !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different payload.");
          return this.getEventResult(existing, definition, true);
        }
        const duplicate = await deps.repository.getEventByExternalId(params.principal.workspaceId, externalEventId);
        if (duplicate) fail(409, "REPLAY_DETECTED", "externalEventId has already been submitted for this project.");
        throw error;
      }
      await deps.repository.markDefinitionUsed(definition.id, at);
      await recordOutcomeAudit(deps, {
        actorType: "SYSTEM",
        actorId: null,
        workspaceId: params.principal.workspaceId,
        action: "developer.outcome.submitted",
        targetType: "external_outcome_event",
        targetId: row.id,
        metadata: {
          integrationId: row.integrationId,
          definitionId: row.definitionId,
          externalEventIdHash: sha256Hex(row.externalEventId),
          externalSubjectIdHash: sha256Hex(row.externalSubjectId),
          schemaVersion: row.schemaVersion,
          evidenceHash: row.evidenceHash,
        },
      });
      await recordOutcomeAudit(deps, {
        actorType: "SYSTEM",
        actorId: null,
        workspaceId: params.principal.workspaceId,
        action: "developer.outcome.decision",
        targetType: "external_outcome_event",
        targetId: row.id,
        metadata: {
          verificationState: row.verificationState,
          reasons: row.decisionReasonsJson,
          policySnapshot: row.policySnapshotJson,
          holdState: row.holdState,
          settlementState: row.settlementState,
          executionState: row.executionState,
          procurementRecommendation: row.procurementRecommendation,
        },
      });
      return this.getEventResult(row, definition, false, mode);
    },

    async getEventResult(row: ExternalOutcomeEventRow, definition?: ExternalOutcomeDefinitionRow, idempotent = false, mode?: OrganizationOperatorMode) {
      const resolvedDefinition = definition ?? await deps.repository.getDefinitionById(row.workspaceId, row.definitionId);
      if (!resolvedDefinition) fail(404, "OUTCOME_NOT_FOUND", "Outcome definition not found.");
      return {
        event: toEvent(row, resolvedDefinition),
        receipt: toReceipt(row, resolvedDefinition),
        idempotent,
        mode: mode ?? (row.executionState === "NOT_EXECUTED" ? "SHADOW" : "AUTONOMOUS"),
      } as const;
    },

    async getStatus(params: { workspaceId: string; eventId: string }): Promise<SafeOutcomeStatus> {
      const row = await deps.repository.getEventById(params.eventId, params.workspaceId);
      if (!row) fail(404, "EVENT_NOT_FOUND", "Outcome event not found.");
      const definition = await deps.repository.getDefinitionById(params.workspaceId, row.definitionId);
      if (!definition) fail(404, "OUTCOME_NOT_FOUND", "Outcome definition not found.");
      const trail = await deps.repository.listLedger(params.workspaceId, row.id);
      return {
        event: toEvent(row, definition),
        receipt: toReceipt(row, definition),
        decisionTrail: trail.map((item) => ({ action: item.action, createdAt: item.createdAt.toISOString(), metadata: item.metadata })),
      };
    },

    async listEventStatuses(workspaceId: string): Promise<SafeOutcomeStatus[]> {
      const rows = await deps.repository.listEvents(workspaceId);
      return Promise.all(rows.map(async (row) => {
        const definition = await deps.repository.getDefinitionById(workspaceId, row.definitionId);
        if (!definition) return null;
        const trail = await deps.repository.listLedger(workspaceId, row.id);
        return {
          event: toEvent(row, definition),
          receipt: toReceipt(row, definition),
          decisionTrail: trail.map((item) => ({ action: item.action, createdAt: item.createdAt.toISOString(), metadata: item.metadata })),
        } satisfies SafeOutcomeStatus;
      })).then((items) => items.filter((item): item is SafeOutcomeStatus => item !== null));
    },

    async telemetry(params: { workspaceId: string; integrationId: string }): Promise<OutcomeTelemetry> {
      const integration = await deps.repository.getIntegration(params.workspaceId, params.integrationId);
      if (!integration) fail(404, "INTEGRATION_NOT_FOUND", "Integration not found.");
      const rows = await deps.repository.listEventsByIntegration(params.workspaceId, params.integrationId);
      return {
        integrationId: params.integrationId,
        submitted: rows.length,
        verified: rows.filter((row) => row.verificationState === "VERIFIED").length,
        review: rows.filter((row) => row.verificationState === "REVIEW").length,
        refused: rows.filter((row) => row.verificationState === "REFUSED").length,
        held: rows.filter((row) => row.holdState === "HELD").length,
        settled: rows.filter((row) => row.settlementState === "SETTLED").length,
      };
    },
  };
}

export function createDrizzleOutcomeApiRepository(db: Db = getDb()): OutcomeApiRepository {
  return {
    async getIntegrationByDigest(digest) {
      const [row] = await db.select().from(developerIntegrations).where(eq(developerIntegrations.apiKeyDigest, digest)).limit(1);
      return row ? mapIntegration(row) : null;
    },
    async getIntegration(workspaceId, integrationId) {
      const [row] = await db.select().from(developerIntegrations).where(and(eq(developerIntegrations.workspaceId, workspaceId), eq(developerIntegrations.id, integrationId))).limit(1);
      return row ? mapIntegration(row) : null;
    },
    async listIntegrations(workspaceId) {
      const rows = await db.select().from(developerIntegrations).where(eq(developerIntegrations.workspaceId, workspaceId)).orderBy(desc(developerIntegrations.createdAt));
      return rows.map(mapIntegration);
    },
    async insertIntegration(input) {
      const [row] = await db.insert(developerIntegrations).values(input).returning();
      return mapIntegration(row);
    },
    async revokeIntegration(workspaceId, integrationId, at) {
      const [row] = await db.update(developerIntegrations).set({ status: "REVOKED", revokedAt: at }).where(and(eq(developerIntegrations.workspaceId, workspaceId), eq(developerIntegrations.id, integrationId))).returning();
      return row ? mapIntegration(row) : null;
    },
    async touchIntegration(integrationId, at) {
      await db.update(developerIntegrations).set({ lastUsedAt: at }).where(eq(developerIntegrations.id, integrationId));
    },
    async listDefinitionVersions(workspaceId, slug) {
      const rows = await db.select().from(externalOutcomeDefinitions).where(and(eq(externalOutcomeDefinitions.workspaceId, workspaceId), eq(externalOutcomeDefinitions.slug, slug))).orderBy(desc(externalOutcomeDefinitions.evidenceSchemaVersion));
      return rows.map(mapDefinition);
    },
    async listDefinitions(workspaceId) {
      const rows = await db.select().from(externalOutcomeDefinitions).where(eq(externalOutcomeDefinitions.workspaceId, workspaceId)).orderBy(desc(externalOutcomeDefinitions.updatedAt));
      return rows.map(mapDefinition);
    },
    async getDefinitionById(workspaceId, id) {
      const [row] = await db.select().from(externalOutcomeDefinitions).where(and(eq(externalOutcomeDefinitions.workspaceId, workspaceId), eq(externalOutcomeDefinitions.id, id))).limit(1);
      return row ? mapDefinition(row) : null;
    },
    async insertDefinition(input) {
      const [row] = await db.insert(externalOutcomeDefinitions).values(input).returning();
      return mapDefinition(row);
    },
    async deactivateDefinitions(workspaceId, slug, exceptId) {
      await db.update(externalOutcomeDefinitions).set({ active: false, updatedAt: new Date() }).where(and(eq(externalOutcomeDefinitions.workspaceId, workspaceId), eq(externalOutcomeDefinitions.slug, slug)));
      await db.update(externalOutcomeDefinitions).set({ active: true, updatedAt: new Date() }).where(eq(externalOutcomeDefinitions.id, exceptId));
    },
    async markDefinitionUsed(id, at) {
      await db.update(externalOutcomeDefinitions).set({ usedAt: at, updatedAt: at }).where(eq(externalOutcomeDefinitions.id, id));
    },
    async getEventById(id, workspaceId) {
      const [row] = await db.select().from(externalOutcomeEvents).where(and(eq(externalOutcomeEvents.id, id), eq(externalOutcomeEvents.workspaceId, workspaceId))).limit(1);
      return row ? mapEvent(row) : null;
    },
    async getEventByIdempotency(workspaceId, definitionId, key) {
      const [row] = await db.select().from(externalOutcomeEvents).where(and(eq(externalOutcomeEvents.workspaceId, workspaceId), eq(externalOutcomeEvents.definitionId, definitionId), eq(externalOutcomeEvents.idempotencyKey, key))).limit(1);
      return row ? mapEvent(row) : null;
    },
    async getEventByExternalId(workspaceId, externalEventId) {
      const [row] = await db.select().from(externalOutcomeEvents).where(and(eq(externalOutcomeEvents.workspaceId, workspaceId), eq(externalOutcomeEvents.externalEventId, externalEventId))).limit(1);
      return row ? mapEvent(row) : null;
    },
    async insertEvent(input) {
      const [row] = await db.insert(externalOutcomeEvents).values(input).returning();
      return mapEvent(row);
    },
    async listEventsByIntegration(workspaceId, integrationId) {
      const rows = await db.select().from(externalOutcomeEvents).where(and(eq(externalOutcomeEvents.workspaceId, workspaceId), eq(externalOutcomeEvents.integrationId, integrationId))).orderBy(desc(externalOutcomeEvents.createdAt));
      return rows.map(mapEvent);
    },
    async listEvents(workspaceId) {
      const rows = await db.select().from(externalOutcomeEvents).where(eq(externalOutcomeEvents.workspaceId, workspaceId)).orderBy(desc(externalOutcomeEvents.createdAt));
      return rows.map(mapEvent);
    },
    async listLedger(workspaceId, eventId) {
      const rows = await db.select({ id: auditEvents.id, action: auditEvents.action, targetId: auditEvents.targetId, metadata: auditEvents.metadata, createdAt: auditEvents.createdAt })
        .from(auditEvents)
        .where(and(eq(auditEvents.workspaceId, workspaceId), eq(auditEvents.targetId, eventId)))
        .orderBy(asc(auditEvents.createdAt));
      return rows;
    },
  };
}

function mapIntegration(row: typeof developerIntegrations.$inferSelect): DeveloperIntegrationRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status as "ACTIVE" | "REVOKED",
    apiKeyId: row.apiKeyId,
    apiKeyPrefix: row.apiKeyPrefix,
    apiKeyDigest: row.apiKeyDigest,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function mapDefinition(row: typeof externalOutcomeDefinitions.$inferSelect): ExternalOutcomeDefinitionRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    outcomeType: row.outcomeType as ExternalOutcomeType,
    unitValueMicroUsdc: row.unitValueMicroUsdc,
    asset: row.asset,
    evidenceSchemaVersion: row.evidenceSchemaVersion,
    evidenceSchemaJson: row.evidenceSchemaJson as ExternalEvidenceSchema,
    verificationPolicyId: row.verificationPolicyId,
    holdSeconds: row.holdSeconds,
    active: row.active,
    usedAt: row.usedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapEvent(row: typeof externalOutcomeEvents.$inferSelect): ExternalOutcomeEventRow {
  return {
    id: row.id,
    receiptId: row.receiptId,
    workspaceId: row.workspaceId,
    integrationId: row.integrationId,
    definitionId: row.definitionId,
    externalEventId: row.externalEventId,
    externalSubjectId: row.externalSubjectId,
    occurredAt: row.occurredAt,
    schemaVersion: row.schemaVersion,
    evidenceJson: row.evidenceJson as Record<string, unknown>,
    normalizedEvidenceJson: row.normalizedEvidenceJson as Record<string, unknown>,
    evidenceHash: row.evidenceHash,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    verificationState: row.verificationState as ExternalVerificationState,
    holdState: row.holdState as ExternalHoldState,
    settlementState: row.settlementState as ExternalSettlementState,
    executionState: row.executionState as "NOT_REQUESTED" | "NOT_EXECUTED",
    decisionReasonsJson: row.decisionReasonsJson as string[],
    policySnapshotJson: row.policySnapshotJson as Record<string, unknown>,
    procurementRecommendation: row.procurementRecommendation,
    rejectionCode: row.rejectionCode,
    holdUntil: row.holdUntil,
    verifiedAt: row.verifiedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createMemoryOutcomeApiRepository(): OutcomeApiRepository & {
  integrations: Map<string, DeveloperIntegrationRow>;
  definitions: Map<string, ExternalOutcomeDefinitionRow>;
  events: Map<string, ExternalOutcomeEventRow>;
  ledger: OutcomeLedgerRow[];
} {
  const integrations = new Map<string, DeveloperIntegrationRow>();
  const definitions = new Map<string, ExternalOutcomeDefinitionRow>();
  const events = new Map<string, ExternalOutcomeEventRow>();
  const ledger: OutcomeLedgerRow[] = [];
  const repo: OutcomeApiRepository & { integrations: Map<string, DeveloperIntegrationRow>; definitions: Map<string, ExternalOutcomeDefinitionRow>; events: Map<string, ExternalOutcomeEventRow>; ledger: OutcomeLedgerRow[] } = {
    integrations,
    definitions,
    events,
    ledger,
    async getIntegrationByDigest(digest) { return [...integrations.values()].find((row) => row.apiKeyDigest === digest) ?? null; },
    async getIntegration(workspaceId, integrationId) { const row = integrations.get(integrationId); return row?.workspaceId === workspaceId ? row : null; },
    async listIntegrations(workspaceId) { return [...integrations.values()].filter((row) => row.workspaceId === workspaceId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); },
    async insertIntegration(input) { const row = { ...input, createdAt: new Date("2026-01-01T00:00:00.000Z"), revokedAt: null, lastUsedAt: null }; integrations.set(row.id, row); return row; },
    async revokeIntegration(workspaceId, integrationId, at) { const row = await this.getIntegration(workspaceId, integrationId); if (!row) return null; const next = { ...row, status: "REVOKED" as const, revokedAt: at }; integrations.set(row.id, next); return next; },
    async touchIntegration(integrationId, at) { const row = integrations.get(integrationId); if (row) integrations.set(integrationId, { ...row, lastUsedAt: at }); },
    async listDefinitionVersions(workspaceId, slug) { return [...definitions.values()].filter((row) => row.workspaceId === workspaceId && row.slug === slug).sort((a, b) => b.evidenceSchemaVersion - a.evidenceSchemaVersion); },
    async listDefinitions(workspaceId) { return [...definitions.values()].filter((row) => row.workspaceId === workspaceId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()); },
    async getDefinitionById(workspaceId, id) { const row = definitions.get(id); return row?.workspaceId === workspaceId ? row : null; },
    async insertDefinition(input) { const at = new Date("2026-01-01T00:00:00.000Z"); const row = { ...input, usedAt: null, createdAt: at, updatedAt: at }; definitions.set(row.id, row); return row; },
    async deactivateDefinitions(workspaceId, slug, exceptId) { for (const [id, row] of definitions) if (row.workspaceId === workspaceId && row.slug === slug) definitions.set(id, { ...row, active: id === exceptId }); },
    async markDefinitionUsed(id, at) { const row = definitions.get(id); if (row) definitions.set(id, { ...row, usedAt: at, updatedAt: at }); },
    async getEventById(id, workspaceId) { const row = events.get(id); return row?.workspaceId === workspaceId ? row : null; },
    async getEventByIdempotency(workspaceId, definitionId, key) { return [...events.values()].find((row) => row.workspaceId === workspaceId && row.definitionId === definitionId && row.idempotencyKey === key) ?? null; },
    async getEventByExternalId(workspaceId, externalEventId) { return [...events.values()].find((row) => row.workspaceId === workspaceId && row.externalEventId === externalEventId) ?? null; },
    async insertEvent(input) { const at = new Date("2026-01-01T00:00:00.000Z"); const row = { ...input, createdAt: at, updatedAt: at }; events.set(row.id, row); return row; },
    async listEventsByIntegration(workspaceId, integrationId) { return [...events.values()].filter((row) => row.workspaceId === workspaceId && row.integrationId === integrationId); },
    async listEvents(workspaceId) { return [...events.values()].filter((row) => row.workspaceId === workspaceId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); },
    async listLedger(workspaceId, eventId) { return ledger.filter((row) => row.targetId === eventId); },
    appendMemoryLedger(row) { ledger.push(row); },
  };
  return repo;
}

export function createProductionOutcomeApiService() {
  if (!isDbConfigured()) throw new OutcomeAdapterError(503, "UNCONFIGURED", "Database is not configured.");
  const db = getDb();
  return createOutcomeApiService({
    repository: createDrizzleOutcomeApiRepository(db),
    audit: (input) => recordAuditEvent(db, input),
    getMode: getOrganizationOperatorMode,
  });
}

export function apiKeyDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export { EXTERNAL_OUTCOME_TYPES, isDbConfigured, normalizeDefinitionInput };
export type { NormalizedDefinitionInput };
