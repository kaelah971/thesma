import { describe, expect, it } from "vitest";
import {
  createGrowthProgramService,
  createMemoryGrowthProgramRepository,
} from "@/server/services/growthPrograms";
import {
  createMemoryOutcomeApiRepository,
  createOutcomeApiService,
} from "@/server/services/buildWithThesma";

const NOW = new Date("2026-01-15T12:00:00.000Z");

function setup() {
  const outcomeRepository = createMemoryOutcomeApiRepository();
  const programRepository = createMemoryGrowthProgramRepository();
  const audits: unknown[] = [];
  const outcomeApi = createOutcomeApiService({
    repository: outcomeRepository,
    now: () => NOW,
    getMode: async () => "AUTONOMOUS",
    getGrowthProgramBinding: (workspaceId, id) => programRepository.getBinding!(workspaceId, id),
    audit: async (row) => { audits.push(row); },
  });
  const programs = createGrowthProgramService({
    repository: programRepository,
    outcomeApi,
    now: () => NOW,
    audit: async (row) => { audits.push(row); },
  });
  return { outcomeRepository, programRepository, outcomeApi, programs, audits };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "project-proofpilot",
    actorId: "owner-proofpilot",
    name: "ProofPilot Partner Growth",
    objectiveOutcomeType: "ACTIVATED_USER",
    targetOutcomeCount: 100,
    budgetMicroUsdc: "500000000",
    maxVerifiedCacMicroUsdc: "10000000",
    rewardCeilingMicroUsdc: "8000000",
    participantTypes: ["CREATORS", "REFERRAL_PARTNERS"],
    ...overrides,
  };
}

describe("embedded Growth Programs", () => {
  it("creates from a business objective with no integration or funding requirement", async () => {
    const { programs } = setup();
    const result = await programs.createProgram(input());
    expect(result.program.name).toBe("ProofPilot Partner Growth");
    expect(result.program.objectiveOutcomeType).toBe("ACTIVATED_USER");
    expect(result.program.integrationReadiness).toBe("NOT_CONFIGURED");
    expect(result.program.fundingStatus).toBe("NOT_FUNDED");
    expect(result.program.operatorMode).toBe("SHADOW");
    expect(result.integrationApiKey).toBeNull();
  });

  it("binds a newly created bounded definition and preserves exact bigint economics", async () => {
    const { programs, programRepository } = setup();
    const result = await programs.createProgram(input());
    const row = programRepository.programs.get(result.program.id)!;
    expect(result.program.outcomeDefinition.outcomeType).toBe("ACTIVATED_USER");
    expect(result.program.outcomeDefinition.requiredEvidenceFields).toEqual([
      "userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt",
    ]);
    expect(row.budgetMicroUsdc).toBe(500000000n);
    expect(row.maxVerifiedCacMicroUsdc).toBe(10000000n);
    expect(row.rewardCeilingMicroUsdc).toBe(8000000n);
    expect(result.program.participantTypes).toEqual(["CREATORS", "REFERRAL_PARTNERS"]);
  });

  it("binds an existing outcome definition and existing or new integration", async () => {
    const first = setup();
    const definition = await first.outcomeApi.createDefinition({
      workspaceId: "project-proofpilot",
      actorId: "owner-proofpilot",
      input: {
        slug: "activated-user",
        name: "Activated user",
        outcomeType: "ACTIVATED_USER",
        unitValueMicroUsdc: "8000000",
        requiredEvidenceFields: ["userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt"],
        holdSeconds: 86400,
      },
    });
    const integration = await first.outcomeApi.createIntegration({ workspaceId: "project-proofpilot", actorId: "owner-proofpilot", name: "ProofPilot backend" });
    const existing = await first.programs.createProgram(input({ outcomeDefinitionId: definition.id, integrationId: integration.integration.id }));
    expect(existing.program.outcomeDefinition.id).toBe(definition.id);
    expect(existing.program.integration?.id).toBe(integration.integration.id);
    expect(existing.program.integrationReadiness).toBe("CONNECTED");

    const second = setup();
    const created = await second.programs.createProgram(input({ integrationName: "ProofPilot sandbox" }));
    expect(created.integrationApiKey).toMatch(/^ths_api_/);
    expect(created.program.integrationReadiness).toBe("CONNECTED");
  });

  it("rejects unsupported participant classes, invalid targets and rewards above CAC", async () => {
    const { programs } = setup();
    await expect(programs.createProgram(input({ participantTypes: ["DEVELOPERS"] }))).rejects.toMatchObject({ code: "UNSUPPORTED_PARTICIPANT_TYPE" });
    await expect(programs.createProgram(input({ targetOutcomeCount: 0 }))).rejects.toMatchObject({ code: "INVALID_VALUE" });
    await expect(programs.createProgram(input({ rewardCeilingMicroUsdc: "11000000" }))).rejects.toMatchObject({ code: "REWARD_EXCEEDS_CAC" });
  });

  it("scopes reads to the developer project and reports attribution honestly", async () => {
    const { programs } = setup();
    const created = await programs.createProgram(input());
    await expect(programs.getProgram({ workspaceId: "another-project", id: created.program.id })).rejects.toMatchObject({ code: "PROGRAM_NOT_FOUND" });
    expect(created.program.attributionStatus).toBe("NOT_CONFIGURED");
    expect(created.program.participationStatus).toBe("CLOSED");
    expect(created.program.settlementStatus).toBe("NOT_CONFIGURED");
  });

  it("keeps legacy events unbound while supporting a shadow-bound event association", async () => {
    const { programs, outcomeApi } = setup();
    const created = await programs.createProgram(input({ integrationName: "ProofPilot events" }));
    const integration = created.program.integration!;
    const apiKey = created.integrationApiKey!;
    const principal = await outcomeApi.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${apiKey}` } }));
    const evidence = {
      userId: "user_123",
      accountCreatedAt: "2026-01-15T10:00:00Z",
      onboardingCompletedAt: "2026-01-15T10:30:00Z",
      firstMeaningfulActionAt: "2026-01-15T11:00:00Z",
    };
    const bound = await outcomeApi.submitEvent({
      principal,
      slug: created.program.outcomeDefinition.slug,
      idempotencyKey: "program-event-1",
      input: { growthProgramId: created.program.id, externalEventId: "program-event-1", externalSubjectId: "user_123", occurredAt: "2026-01-15T11:00:00Z", evidence },
    });
    expect(bound.event.growthProgramId).toBe(created.program.id);
    expect(bound.event.executionState).toBe("NOT_EXECUTED");
    expect(bound.event.settlementState).toBe("SHADOW_BLOCKED");
    expect(bound.receipt.growthProgramId).toBe(created.program.id);
    expect(integration.id).toBe(principal.integration.id);

    const legacy = await outcomeApi.submitEvent({
      principal,
      slug: created.program.outcomeDefinition.slug,
      idempotencyKey: "legacy-event-1",
      input: { externalEventId: "legacy-event-1", externalSubjectId: "user_124", occurredAt: "2026-01-15T11:00:00Z", evidence: { ...evidence, userId: "user_124" } },
    });
    expect(legacy.event.growthProgramId).toBeNull();
  });
});
