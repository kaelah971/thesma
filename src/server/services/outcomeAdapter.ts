import { createHash } from "node:crypto";

export const EXTERNAL_OUTCOME_TYPES = [
  "PURCHASE",
  "ACTIVATED_USER",
  "QUALIFIED_REFERRAL",
  "SUBSCRIPTION_STARTED",
] as const;

export type ExternalOutcomeType = (typeof EXTERNAL_OUTCOME_TYPES)[number];
export type EvidenceFieldType = "string" | "number" | "integer" | "boolean" | "date-time";

export interface EvidenceFieldSchema {
  type: EvidenceFieldType;
}

export interface ExternalEvidenceSchema {
  type: "object";
  properties: Record<string, EvidenceFieldSchema>;
  required: string[];
  additionalProperties: false;
}

export interface OutcomeDefinitionForAdapter {
  outcomeType: ExternalOutcomeType;
  evidenceSchemaVersion: number;
  evidenceSchemaJson: ExternalEvidenceSchema;
  verificationPolicyId: string;
  holdSeconds: number;
}

export interface NormalizedDefinitionInput {
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
}

export interface AdapterDecision {
  normalizedEvidence: Record<string, unknown>;
  evidenceHash: string;
  verificationState: "VERIFIED" | "REVIEW" | "REFUSED";
  reasonCodes: string[];
}

export class OutcomeAdapterError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "OutcomeAdapterError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const REQUIRED_SIGNALS: Record<ExternalOutcomeType, string[]> = {
  ACTIVATED_USER: ["userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt"],
  PURCHASE: ["purchaseId", "amountMicroUsdc", "purchasedAt"],
  QUALIFIED_REFERRAL: ["referrerId", "referredSubjectId", "qualifiedAt"],
  SUBSCRIPTION_STARTED: ["subscriptionId", "startedAt"],
};

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_SCHEMA_FIELDS = 32;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_STRING_LENGTH = 1024;

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new OutcomeAdapterError(status, code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical JSON used for evidence fingerprints and hashes. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asNonEmptyString(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(400, "INVALID_REQUEST", `${field} must be a non-empty safe string.`);
  }
  return value.trim();
}

function asMicroUsdc(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  fail(400, "INVALID_VALUE", "unitValueMicroUsdc must be a non-negative integer string.");
}

function normalizeSchema(input: unknown, fallbackRequired?: unknown): ExternalEvidenceSchema {
  let candidate = input;
  if (candidate === undefined && Array.isArray(fallbackRequired)) {
    const required = fallbackRequired.map((field) => asNonEmptyString(field, "requiredEvidenceFields", 64));
    candidate = {
      type: "object",
      properties: Object.fromEntries(required.map((field) => [field, { type: inferFieldType(field) }])),
      required,
      additionalProperties: false,
    };
  }
  if (!isRecord(candidate) || candidate.type !== "object" || !isRecord(candidate.properties)) {
    fail(400, "INVALID_SCHEMA", "evidenceSchema must be a bounded object schema.");
  }
  const names = Object.keys(candidate.properties);
  if (names.length === 0 || names.length > MAX_SCHEMA_FIELDS) {
    fail(400, "INVALID_SCHEMA", `evidenceSchema must define between 1 and ${MAX_SCHEMA_FIELDS} fields.`);
  }
  const properties: Record<string, EvidenceFieldSchema> = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name)) fail(400, "INVALID_SCHEMA", `Unsupported evidence field name: ${name}.`);
    const field = candidate.properties[name];
    if (!isRecord(field) || !["string", "number", "integer", "boolean", "date-time"].includes(String(field.type))) {
      fail(400, "INVALID_SCHEMA", `Unsupported evidence type for ${name}.`);
    }
    properties[name] = { type: field.type as EvidenceFieldType };
  }
  const requiredValue = candidate.required === undefined ? names : candidate.required;
  if (!Array.isArray(requiredValue) || requiredValue.length > names.length || requiredValue.some((v) => typeof v !== "string" || !names.includes(v))) {
    fail(400, "INVALID_SCHEMA", "evidenceSchema.required must reference declared fields.");
  }
  if (candidate.additionalProperties !== undefined && candidate.additionalProperties !== false) {
    fail(400, "INVALID_SCHEMA", "evidenceSchema must reject unsupported fields.");
  }
  return { type: "object", properties, required: [...requiredValue], additionalProperties: false };
}

function inferFieldType(field: string): EvidenceFieldType {
  if (/At$|Date$/i.test(field)) return "date-time";
  if (/amount|count|total|price|quantity/i.test(field)) return "integer";
  return "string";
}

export function normalizeDefinitionInput(input: unknown): NormalizedDefinitionInput {
  if (!isRecord(input)) fail(400, "INVALID_REQUEST", "Request body must be an object.");
  const slug = asNonEmptyString(input.slug, "slug", 80).toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(slug)) fail(400, "INVALID_REQUEST", "slug must use lowercase letters, numbers and hyphens.");
  const name = asNonEmptyString(input.name, "name", 120);
  const description = input.description == null ? null : asNonEmptyString(input.description, "description", 500);
  const outcomeType = input.outcomeType;
  if (!EXTERNAL_OUTCOME_TYPES.includes(outcomeType as ExternalOutcomeType)) {
    fail(400, "UNSUPPORTED_OUTCOME_TYPE", `Supported outcome types: ${EXTERNAL_OUTCOME_TYPES.join(", ")}.`);
  }
  const evidenceSchemaVersion = input.evidenceSchemaVersion === undefined ? 1 : input.evidenceSchemaVersion;
  if (typeof evidenceSchemaVersion !== "number" || !Number.isSafeInteger(evidenceSchemaVersion) || evidenceSchemaVersion < 1) {
    fail(400, "INVALID_SCHEMA_VERSION", "evidenceSchemaVersion must be a positive integer.");
  }
  const evidenceSchemaJson = normalizeSchema(input.evidenceSchema, input.requiredEvidenceFields);
  const requiredSignals = REQUIRED_SIGNALS[outcomeType as ExternalOutcomeType];
  const missingSignals = requiredSignals.filter((field) => !evidenceSchemaJson.required.includes(field));
  if (missingSignals.length > 0) {
    fail(400, "INVALID_SCHEMA", `Schema is missing required ${outcomeType} signals: ${missingSignals.join(", ")}.`, { missingSignals });
  }
  const unitValueMicroUsdc = asMicroUsdc(input.unitValueMicroUsdc);
  if (unitValueMicroUsdc <= 0n) fail(400, "INVALID_VALUE", "unitValueMicroUsdc must be greater than zero.");
  const asset = (input.asset ?? input.currency ?? "USDC");
  if (typeof asset !== "string" || asset.trim().toUpperCase() !== "USDC") fail(400, "UNSUPPORTED_ASSET", "V1 external outcomes settle in USDC only.");
  const holdSeconds = input.holdSeconds === undefined ? 0 : input.holdSeconds;
  if (typeof holdSeconds !== "number" || !Number.isSafeInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > 30 * 24 * 60 * 60) {
    fail(400, "INVALID_HOLD_POLICY", "holdSeconds must be an integer from 0 to 30 days.");
  }
  const verificationPolicyId = input.verificationPolicyId === undefined ? "external-outcome-v1" : asNonEmptyString(input.verificationPolicyId, "verificationPolicyId", 120);
  return {
    slug,
    name,
    description,
    outcomeType: outcomeType as ExternalOutcomeType,
    unitValueMicroUsdc,
    asset: "USDC",
    evidenceSchemaVersion,
    evidenceSchemaJson,
    verificationPolicyId,
    holdSeconds,
  };
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== "string") fail(400, "INVALID_EVIDENCE", `${field} must be an ISO timestamp.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(400, "INVALID_EVIDENCE", `${field} must be an ISO timestamp.`);
  return date;
}

function validateField(value: unknown, type: EvidenceFieldType, field: string): unknown {
  if (type === "string") {
    if (typeof value !== "string" || value.length > MAX_STRING_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) fail(400, "INVALID_EVIDENCE", `${field} must be a safe string.`);
    return value;
  }
  if (type === "date-time") return parseDate(value, field).toISOString();
  if (type === "boolean") {
    if (typeof value !== "boolean") fail(400, "INVALID_EVIDENCE", `${field} must be a boolean.`);
    return value;
  }
  if (type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(400, "INVALID_EVIDENCE", `${field} must be a safe integer.`);
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) fail(400, "INVALID_EVIDENCE", `${field} must be a finite number.`);
  return value;
}

export function normalizeEvidence(schema: ExternalEvidenceSchema, evidence: unknown): Record<string, unknown> {
  if (!isRecord(evidence)) fail(400, "INVALID_EVIDENCE", "evidence must be a JSON object.");
  if (Buffer.byteLength(stableJson(evidence), "utf8") > MAX_EVIDENCE_BYTES) {
    fail(413, "PAYLOAD_TOO_LARGE", `Evidence must be smaller than ${MAX_EVIDENCE_BYTES} bytes.`);
  }
  const keys = Object.keys(evidence);
  const unknown = keys.filter((key) => !Object.prototype.hasOwnProperty.call(schema.properties, key));
  if (unknown.length > 0) fail(400, "INVALID_EVIDENCE", `Unsupported evidence fields: ${unknown.join(", ")}.`, { unknownFields: unknown });
  const missing = schema.required.filter((key) => evidence[key] === undefined || evidence[key] === null);
  if (missing.length > 0) fail(400, "INVALID_EVIDENCE", `Missing required evidence: ${missing.join(", ")}.`, { missingFields: missing });
  const normalized: Record<string, unknown> = {};
  for (const [field, definition] of Object.entries(schema.properties)) {
    if (evidence[field] !== undefined) normalized[field] = validateField(evidence[field], definition.type, field);
  }
  return JSON.parse(stableJson(normalized)) as Record<string, unknown>;
}

function timelineIsValid(definition: OutcomeDefinitionForAdapter, evidence: Record<string, unknown>, occurredAt: Date): boolean {
  const chronology: string[] = [];
  if (definition.outcomeType === "ACTIVATED_USER") chronology.push("accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt");
  if (definition.outcomeType === "PURCHASE") chronology.push("purchasedAt");
  if (definition.outcomeType === "QUALIFIED_REFERRAL") chronology.push("qualifiedAt");
  if (definition.outcomeType === "SUBSCRIPTION_STARTED") chronology.push("startedAt");
  const times = chronology.map((field) => new Date(String(evidence[field])).getTime());
  if (times.some((time) => !Number.isFinite(time))) return false;
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] < times[index - 1]) return false;
  }
  return times[times.length - 1] <= occurredAt.getTime();
}

/**
 * The adapter only validates and normalizes submitted evidence. The bounded
 * policy decision below is deliberately separate from evidence intake and
 * never authorizes a payment, procurement, or settlement.
 */
export function evaluateOutcomeEvidence(params: {
  definition: OutcomeDefinitionForAdapter;
  evidence: unknown;
  occurredAt: Date;
}): AdapterDecision {
  const normalizedEvidence = normalizeEvidence(params.definition.evidenceSchemaJson, params.evidence);
  const evidenceHash = `0x${sha256Hex(stableJson({ schemaVersion: params.definition.evidenceSchemaVersion, evidence: normalizedEvidence }))}`;
  const timelineValid = timelineIsValid(params.definition, normalizedEvidence, params.occurredAt);
  if (!timelineValid) {
    return {
      normalizedEvidence,
      evidenceHash,
      verificationState: "REVIEW",
      reasonCodes: ["EVIDENCE_TIMELINE_AMBIGUOUS"],
    };
  }
  if (params.definition.outcomeType === "PURCHASE" && Number(normalizedEvidence.amountMicroUsdc) <= 0) {
    return {
      normalizedEvidence,
      evidenceHash,
      verificationState: "REFUSED",
      reasonCodes: ["PURCHASE_AMOUNT_INVALID"],
    };
  }
  if (
    params.definition.outcomeType === "QUALIFIED_REFERRAL"
    && normalizedEvidence.referrerId === normalizedEvidence.referredSubjectId
  ) {
    return {
      normalizedEvidence,
      evidenceHash,
      verificationState: "REFUSED",
      reasonCodes: ["SELF_REFERRAL"],
    };
  }
  return {
    normalizedEvidence,
    evidenceHash,
    verificationState: "VERIFIED",
    reasonCodes: ["SCHEMA_VALID", "DETERMINISTIC_POLICY_SATISFIED"],
  };
}

export function validateExternalIdentity(value: unknown, field: string): string {
  try {
    return asNonEmptyString(value, field, 256);
  } catch (error) {
    if (field === "externalSubjectId" && error instanceof OutcomeAdapterError) {
      throw new OutcomeAdapterError(error.status, "SUBJECT_INVALID", error.message, error.details);
    }
    throw error;
  }
}

export function validateOccurredAt(value: unknown, now = new Date()): Date {
  const date = parseDate(value, "occurredAt");
  if (date.getTime() > now.getTime() + 5 * 60 * 1000) fail(400, "INVALID_TIMESTAMP", "occurredAt cannot be more than five minutes in the future.");
  return date;
}

export function requestFingerprint(input: {
  definitionId: string;
  schemaVersion: number;
  growthProgramId?: string | null;
  attributionId?: string | null;
  externalEventId: string;
  externalSubjectId: string;
  occurredAt: Date;
  evidence: unknown;
}): string {
  const payload: Record<string, unknown> = {
    definitionId: input.definitionId,
    schemaVersion: input.schemaVersion,
    externalEventId: input.externalEventId,
    externalSubjectId: input.externalSubjectId,
    occurredAt: input.occurredAt.toISOString(),
    evidence: input.evidence,
  };
  // Keep the legacy unbound fingerprint byte-for-byte compatible. Program
  // association is part of the fingerprint only for newly bound events.
  if (input.growthProgramId) payload.growthProgramId = input.growthProgramId;
  if (input.attributionId) payload.attributionId = input.attributionId;
  return sha256Hex(stableJson(payload));
}

export function requiredEvidenceFields(schema: ExternalEvidenceSchema): string[] {
  return [...schema.required];
}

export { MAX_EVIDENCE_BYTES };
