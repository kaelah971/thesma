import { describe, expect, it } from "vitest";
import {
  createMemoryOutcomeApiRepository,
  createOutcomeApiService,
  apiKeyDigest,
} from "@/server/services/buildWithThesma";
import { normalizeEvidence, stableJson } from "@/server/services/outcomeAdapter";

const NOW = new Date("2026-01-15T12:00:00.000Z");

function definitionInput(version = 1) {
  return {
    slug: "activated-user",
    name: "Activated user",
    description: "Account created, onboarding complete, first project created.",
    outcomeType: "ACTIVATED_USER",
    unitValueMicroUsdc: "8000000",
    evidenceSchemaVersion: version,
    evidenceSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        accountCreatedAt: { type: "date-time" },
        onboardingCompletedAt: { type: "date-time" },
        firstMeaningfulActionAt: { type: "date-time" },
      },
      required: ["userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt"],
      additionalProperties: false,
    },
    holdSeconds: 3600,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user_123",
    accountCreatedAt: "2026-01-15T10:00:00Z",
    onboardingCompletedAt: "2026-01-15T10:30:00Z",
    firstMeaningfulActionAt: "2026-01-15T11:00:00Z",
    ...overrides,
  };
}

function setup(mode: "AUTONOMOUS" | "SHADOW" = "AUTONOMOUS") {
  const repository = createMemoryOutcomeApiRepository();
  const auditRows: unknown[] = [];
  const service = createOutcomeApiService({
    repository,
    now: () => NOW,
    getMode: async () => mode,
    audit: async (row) => { auditRows.push(row); },
  });
  return { repository, service, auditRows };
}

async function makeIntegration(mode: "AUTONOMOUS" | "SHADOW" = "AUTONOMOUS") {
  const context = setup(mode);
  const created = await context.service.createIntegration({ workspaceId: "org-a", name: "Acme Productivity", actorId: "owner-a" });
  await context.service.createDefinition({ workspaceId: "org-a", input: definitionInput(), actorId: "owner-a" });
  const principal = await context.service.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${created.apiKey}` } }));
  return { ...context, created, principal };
}

describe("Build with Thesma outcome adapter", () => {
  it("creates a scoped integration and never stores the plaintext key", async () => {
    const { repository, service } = setup();
    const result = await service.createIntegration({ workspaceId: "org-a", name: "Acme", actorId: "owner-a" });
    const row = [...repository.integrations.values()][0]!;
    expect(result.apiKey).toMatch(/^ths_api_/);
    expect(row.apiKeyDigest).toBe(apiKeyDigest(result.apiKey));
    expect(row.apiKeyDigest).not.toBe(result.apiKey);
  });

  it("accepts valid keys and rejects invalid or revoked keys", async () => {
    const { service } = setup();
    const created = await service.createIntegration({ workspaceId: "org-a", name: "Acme", actorId: "owner-a" });
    const principal = await service.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${created.apiKey}` } }));
    expect(principal.workspaceId).toBe("org-a");
    await expect(service.authenticate(new Request("https://thesma.test", { headers: { Authorization: "Bearer ths_api_invalid" } }))).rejects.toMatchObject({ code: "INVALID_API_KEY" });
    await service.revokeIntegration({ workspaceId: "org-a", integrationId: created.integration.id, actorId: "owner-a" });
    await expect(service.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${created.apiKey}` } }))).rejects.toMatchObject({ code: "INTEGRATION_REVOKED" });
  });

  it("creates immutable versioned definitions with bounded supported types", async () => {
    const { service } = setup();
    const v1 = await service.createDefinition({ workspaceId: "org-a", input: definitionInput(), actorId: "owner-a" });
    expect(v1.requiredEvidenceFields).toContain("firstMeaningfulActionAt");
    await expect(service.createDefinition({ workspaceId: "org-a", input: { ...definitionInput(), name: "Changed" }, actorId: "owner-a" })).rejects.toMatchObject({ code: "SCHEMA_VERSION_IMMUTABLE" });
    const v2 = await service.createDefinition({ workspaceId: "org-a", input: definitionInput(2), actorId: "owner-a" });
    expect(v2.evidenceSchemaVersion).toBe(2);
    expect((await service.getDefinition({ workspaceId: "org-a", slug: "activated-user" })).evidenceSchemaVersion).toBe(2);
    await expect(service.createDefinition({ workspaceId: "org-a", input: { ...definitionInput(4) }, actorId: "owner-a" })).rejects.toMatchObject({ code: "SCHEMA_VERSION_MISMATCH" });
  });

  it("validates required evidence and rejects unsupported fields", () => {
    const schema = definitionInput().evidenceSchema as never;
    expect(() => normalizeEvidence(schema, { userId: "x" })).toThrow(/Missing required evidence/);
    expect(() => normalizeEvidence(schema, { ...evidence(), extra: true })).toThrow(/Unsupported evidence fields/);
  });

  it("submits, normalizes, verifies and holds an external event", async () => {
    const { service, principal } = await makeIntegration();
    const result = await service.submitEvent({
      principal,
      slug: "activated-user",
      idempotencyKey: "activation_001_v1",
      input: { externalEventId: "activation_001", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence: evidence() },
    });
    expect(result.event.verificationState).toBe("VERIFIED");
    expect(result.event.holdState).toBe("HELD");
    expect(result.event.settlementState).toBe("HELD");
    expect(result.event.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.receipt.evidenceHash).toBe(result.event.evidenceHash);
    expect(result.receipt.submittedByIntegrationId).toBe(principal.integration.id);
  });

  it("returns the original event for an idempotent retry", async () => {
    const { service, principal } = await makeIntegration();
    const input = { externalEventId: "activation_001", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence: evidence() };
    const first = await service.submitEvent({ principal, slug: "activated-user", idempotencyKey: "same-key", input });
    const second = await service.submitEvent({ principal, slug: "activated-user", idempotencyKey: "same-key", input });
    expect(second.idempotent).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    await expect(service.submitEvent({ principal, slug: "activated-user", idempotencyKey: "same-key", input: { ...input, evidence: evidence({ userId: "other" }) } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("blocks external event replay across definitions and isolates organizations", async () => {
    const { service, principal } = await makeIntegration();
    const input = { externalEventId: "activation_001", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence: evidence() };
    await service.submitEvent({ principal, slug: "activated-user", idempotencyKey: "key-1", input });
    await expect(service.submitEvent({ principal, slug: "activated-user", idempotencyKey: "key-2", input })).rejects.toMatchObject({ code: "REPLAY_DETECTED" });
    const other = setup();
    const otherIntegration = await other.service.createIntegration({ workspaceId: "org-b", name: "Other", actorId: "owner-b" });
    await other.service.createDefinition({ workspaceId: "org-b", input: definitionInput(), actorId: "owner-b" });
    const otherPrincipal = await other.service.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${otherIntegration.apiKey}` } }));
    const accepted = await other.service.submitEvent({ principal: otherPrincipal, slug: "activated-user", idempotencyKey: "key-1", input });
    expect(accepted.event.id).not.toBe(input.externalEventId);
  });

  it("routes ambiguous evidence to review without forcing verification", async () => {
    const { service, principal } = await makeIntegration();
    const result = await service.submitEvent({
      principal,
      slug: "activated-user",
      idempotencyKey: "ambiguous-1",
      input: { externalEventId: "ambiguous-1", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence: evidence({ onboardingCompletedAt: "2026-01-15T12:30:00Z" }) },
    });
    expect(result.event.verificationState).toBe("REVIEW");
    expect(result.event.settlementState).toBe("NOT_ELIGIBLE");
    expect(result.event.procurementRecommendation).toBe("BUY");
  });

  it("shadow mode evaluates but blocks execution and recommends WOULD_BUY for review", async () => {
    const { service, principal } = await makeIntegration("SHADOW");
    const result = await service.submitEvent({
      principal,
      slug: "activated-user",
      idempotencyKey: "shadow-1",
      input: { externalEventId: "shadow-1", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence: evidence({ onboardingCompletedAt: "2026-01-15T12:30:00Z" }) },
    });
    expect(result.mode).toBe("SHADOW");
    expect(result.event.executionState).toBe("NOT_EXECUTED");
    expect(result.event.settlementState).toBe("NOT_ELIGIBLE");
    expect(result.event.procurementRecommendation).toBe("WOULD_BUY");
  });

  it("refuses a deterministic self-referral policy violation", async () => {
    const { service } = setup();
    await service.createDefinition({
      workspaceId: "org-a",
      actorId: "owner-a",
      input: {
        slug: "qualified-referral",
        name: "Qualified referral",
        outcomeType: "QUALIFIED_REFERRAL",
        unitValueMicroUsdc: "8000000",
        evidenceSchemaVersion: 1,
        evidenceSchema: {
          type: "object",
          properties: { referrerId: { type: "string" }, referredSubjectId: { type: "string" }, qualifiedAt: { type: "date-time" } },
          required: ["referrerId", "referredSubjectId", "qualifiedAt"],
          additionalProperties: false,
        },
      },
    });
    const integration = await service.createIntegration({ workspaceId: "org-a", name: "Acme", actorId: "owner-a" });
    const principal = await service.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${integration.apiKey}` } }));
    const result = await service.submitEvent({
      principal,
      slug: "qualified-referral",
      idempotencyKey: "self-referral-1",
      input: { externalEventId: "self-referral-1", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence: { referrerId: "user_123", referredSubjectId: "user_123", qualifiedAt: "2026-01-15T10:00:00Z" } },
    });
    expect(result.event.verificationState).toBe("REFUSED");
    expect(result.event.reasons).toContain("SELF_REFERRAL");
    expect(result.event.settlementState).toBe("NOT_ELIGIBLE");
  });

  it("returns a safe status and immutable decision trail without raw secrets", async () => {
    const { service, principal, created } = await makeIntegration();
    const result = await service.submitEvent({ principal, slug: "activated-user", idempotencyKey: "status-1", input: { externalEventId: "status-1", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence: evidence() } });
    const status = await service.getStatus({ workspaceId: "org-a", eventId: result.event.id });
    expect(status.decisionTrail.map((row) => row.action)).toEqual(["developer.outcome.submitted", "developer.outcome.decision"]);
    expect(JSON.stringify(status)).not.toContain(created.apiKey);
    expect(status.receipt.evidenceHash).toBe(result.event.evidenceHash);
  });

  it("keeps evidence hashes stable for equivalent JSON key order", () => {
    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }));
  });
});
