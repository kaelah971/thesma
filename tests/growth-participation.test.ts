import { describe, expect, it } from "vitest";
import {
  createGrowthProgramParticipationService,
  createMemoryGrowthProgramParticipantRepository,
} from "@/server/services/growthProgramParticipation";
import { createGrowthProgramService, createMemoryGrowthProgramRepository } from "@/server/services/growthPrograms";
import { createOutcomeApiService, createMemoryOutcomeApiRepository } from "@/server/services/buildWithThesma";

const NOW = new Date("2026-01-15T12:00:00.000Z");

function setup() {
  const programRepository = createMemoryGrowthProgramRepository();
  const outcomeRepository = createMemoryOutcomeApiRepository();
  const audits: unknown[] = [];
  let participation: ReturnType<typeof createGrowthProgramParticipationService>;
  const outcomeApi = createOutcomeApiService({
    repository: outcomeRepository,
    now: () => NOW,
    getMode: async () => "AUTONOMOUS",
    getGrowthProgramBinding: (workspaceId, id) => programRepository.getBinding!(workspaceId, id),
    resolveGrowthAttribution: (workspaceId, growthProgramId, reference) => participation.resolveAttributionForEvent(workspaceId, growthProgramId, reference),
    audit: async (row) => { audits.push(row); },
  });
  const programs = createGrowthProgramService({
    repository: programRepository,
    outcomeApi,
    now: () => NOW,
    audit: async (row) => { audits.push(row); },
  });
  const participantRepository = createMemoryGrowthProgramParticipantRepository();
  participation = createGrowthProgramParticipationService({
    repository: participantRepository,
    getProgram: (workspaceId, growthProgramId) => programs.getProgram({ workspaceId, id: growthProgramId }),
    setParticipationStatus: (params) => programs.setParticipationStatus({ workspaceId: params.workspaceId, id: params.id, status: params.status, actorId: params.actorId }),
    getCreator: async (creatorUserId) => ({ userId: creatorUserId, displayName: "Maya Creator", handle: "maya", creatorType: "EDUCATOR" }),
    audit: async (row) => { audits.push(row); },
    now: () => NOW,
  });
  return { outcomeApi, programs, participation, audits };
}

async function createProgram(setupValue: ReturnType<typeof setup>, operatorMode: "SHADOW" | "AUTONOMOUS" = "SHADOW") {
  const result = await setupValue.programs.createProgram({
    workspaceId: "project-proofpilot",
    actorId: "owner-proofpilot",
    name: "ProofPilot Growth",
    objectiveOutcomeType: "ACTIVATED_USER",
    targetOutcomeCount: 100,
    budgetMicroUsdc: "500000000",
    maxVerifiedCacMicroUsdc: "10000000",
    rewardCeilingMicroUsdc: "8000000",
    participantTypes: ["CREATORS", "REFERRAL_PARTNERS"],
    operatorMode,
    integrationName: "ProofPilot sandbox",
  });
  await setupValue.participation.setParticipationMode({ workspaceId: "project-proofpilot", growthProgramId: result.program.id, participationStatus: "OPEN", actorId: "owner-proofpilot" });
  return result;
}

describe("Growth Program participation and attribution", () => {
  it("enrolls creators and referral partners with a frozen reward snapshot", async () => {
    const value = setup();
    const program = await createProgram(value, "AUTONOMOUS");
    const creator = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "owner-proofpilot", participantType: "CREATOR", creatorUserId: "creator-1", participationSource: "INVITE", initialStatus: "INVITED" });
    const partner = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "owner-proofpilot", participantType: "REFERRAL_PARTNER", externalPartnerId: "partner-1", displayName: "ProofPilot Alumni", participationSource: "OPEN_JOIN" });
    const external = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "owner-proofpilot", participantType: "REFERRAL_PARTNER", externalPartnerId: "partner-external", displayName: "External Partner", participationSource: "EXTERNAL" });
    expect(creator.status).toBe("INVITED");
    expect(creator.attribution).toBeNull();
    expect(creator.rewardPolicySnapshot.rewardCeilingMicroUsdc).toBe("8000000");
    expect(partner.status).toBe("APPLIED");
    expect(external.status).toBe("APPLIED");
    const active = await value.participation.transitionParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, participantId: creator.id, action: "APPROVE", actorId: "owner-proofpilot" });
    expect(active.status).toBe("ACTIVE");
    expect(active.attribution?.code).toMatch(/^ref_/);
  });

  it("blocks creator invitations while a program remains in Shadow Mode", async () => {
    const value = setup();
    const program = await createProgram(value);
    await expect(value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "owner-proofpilot", participantType: "CREATOR", creatorUserId: "creator-shadow", participationSource: "INVITE" })).rejects.toMatchObject({ code: "SHADOW_EXECUTION_BLOCKED" });
    const request = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "creator-shadow", participantType: "CREATOR", creatorUserId: "creator-shadow", participationSource: "OPEN_JOIN" });
    expect(request.status).toBe("APPLIED");
  });

  it("resolves active attribution and rejects revoked or cross-program identities", async () => {
    const value = setup();
    const first = await createProgram(value);
    const participant = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: first.program.id, actorId: "owner-proofpilot", participantType: "REFERRAL_PARTNER", externalPartnerId: "partner-1", displayName: "Partner", initialStatus: "ACTIVE" });
    const code = participant.attribution!.code;
    const resolved = await value.participation.resolveAttribution({ workspaceId: "project-proofpilot", growthProgramId: first.program.id, reference: code });
    expect(resolved.participant.id).toBe(participant.id);
    await value.participation.transitionParticipant({ workspaceId: "project-proofpilot", growthProgramId: first.program.id, participantId: participant.id, action: "PAUSE", actorId: "owner-proofpilot" });
    await expect(value.participation.resolveAttribution({ workspaceId: "project-proofpilot", growthProgramId: first.program.id, reference: code })).rejects.toMatchObject({ code: "ATTRIBUTION_REVOKED" });

    const second = await value.programs.createProgram({
      workspaceId: "project-proofpilot", actorId: "owner-proofpilot", name: "Second Growth", objectiveOutcomeType: "ACTIVATED_USER", targetOutcomeCount: 10,
      budgetMicroUsdc: "10000000", maxVerifiedCacMicroUsdc: "1000000", rewardCeilingMicroUsdc: "500000", participantTypes: ["REFERRAL_PARTNERS"],
    });
    await expect(value.participation.resolveAttribution({ workspaceId: "project-proofpilot", growthProgramId: second.program.id, reference: code })).rejects.toMatchObject({ code: "INVALID_ATTRIBUTION" });
  });

  it("binds direct attribution to the existing Outcome API without authorizing spend", async () => {
    const value = setup();
    const program = await createProgram(value);
    const participant = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "owner-proofpilot", participantType: "REFERRAL_PARTNER", externalPartnerId: "partner-1", displayName: "Partner", initialStatus: "ACTIVE" });
    const apiKey = program.integrationApiKey!;
    const principal = await value.outcomeApi.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${apiKey}` } }));
    const evidence = { userId: "user-1", accountCreatedAt: "2026-01-15T10:00:00Z", onboardingCompletedAt: "2026-01-15T10:30:00Z", firstMeaningfulActionAt: "2026-01-15T11:00:00Z" };
    const result = await value.outcomeApi.submitEvent({ principal, slug: program.program.outcomeDefinition.slug, idempotencyKey: "attributed-1", input: { growthProgramId: program.program.id, attributionId: participant.attribution!.code, externalEventId: "attributed-1", externalSubjectId: "user-1", occurredAt: "2026-01-15T11:00:00Z", evidence } });
    expect(result.event.attributionStatus).toBe("DIRECT_ATTRIBUTION");
    expect(result.event.verificationState).toBe("VERIFIED");
    expect(result.event.executionState).toBe("NOT_EXECUTED");
    expect(result.event.settlementState).toBe("SHADOW_BLOCKED");
  });

  it("refuses invalid attribution and records the conflict boundary on replay", async () => {
    const value = setup();
    const program = await createProgram(value);
    const firstParticipant = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "owner-proofpilot", participantType: "REFERRAL_PARTNER", externalPartnerId: "partner-first", displayName: "First Partner", initialStatus: "ACTIVE" });
    const secondParticipant = await value.participation.createParticipant({ workspaceId: "project-proofpilot", growthProgramId: program.program.id, actorId: "owner-proofpilot", participantType: "REFERRAL_PARTNER", externalPartnerId: "partner-second", displayName: "Second Partner", initialStatus: "ACTIVE" });
    const apiKey = program.integrationApiKey!;
    const principal = await value.outcomeApi.authenticate(new Request("https://thesma.test", { headers: { Authorization: `Bearer ${apiKey}` } }));
    const evidence = { userId: "user-2", accountCreatedAt: "2026-01-15T10:00:00Z", onboardingCompletedAt: "2026-01-15T10:30:00Z", firstMeaningfulActionAt: "2026-01-15T11:00:00Z" };
    const invalid = await value.outcomeApi.submitEvent({ principal, slug: program.program.outcomeDefinition.slug, idempotencyKey: "invalid-1", input: { growthProgramId: program.program.id, attributionId: "ref_missing", externalEventId: "invalid-1", externalSubjectId: "user-2", occurredAt: "2026-01-15T11:00:00Z", evidence } });
    expect(invalid.event.attributionStatus).toBe("INVALID_ATTRIBUTION");
    expect(invalid.event.verificationState).toBe("REFUSED");

    const direct = await value.outcomeApi.submitEvent({ principal, slug: program.program.outcomeDefinition.slug, idempotencyKey: "conflict-1", input: { growthProgramId: program.program.id, attributionId: firstParticipant.attribution!.code, externalEventId: "conflict-event", externalSubjectId: "user-2", occurredAt: "2026-01-15T11:00:00Z", evidence } });
    expect(direct.event.attributionStatus).toBe("DIRECT_ATTRIBUTION");
    await expect(value.outcomeApi.submitEvent({ principal, slug: program.program.outcomeDefinition.slug, idempotencyKey: "conflict-2", input: { growthProgramId: program.program.id, attributionId: secondParticipant.attribution!.code, externalEventId: "conflict-event", externalSubjectId: "user-2", occurredAt: "2026-01-15T11:00:00Z", evidence } })).rejects.toMatchObject({ code: "ATTRIBUTION_CONFLICT" });
  });
});
