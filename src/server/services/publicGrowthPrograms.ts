import { createProductionGrowthProgramService, type SafeGrowthProgram } from "./growthPrograms";

export interface PublicGrowthProgram {
  id: string;
  slug: string;
  name: string;
  objectiveOutcomeType: SafeGrowthProgram["objectiveOutcomeType"];
  outcomeSlug: string;
  targetOutcomeCount: number;
  participantTypes: SafeGrowthProgram["participantTypes"];
  rewardStructure: SafeGrowthProgram["rewardStructure"];
  rewardCeilingMicroUsdc: string;
  participationStatus: SafeGrowthProgram["participationStatus"];
  status: SafeGrowthProgram["status"];
  operatorMode: SafeGrowthProgram["operatorMode"];
  productUrl: string | null;
  participationUrl: string;
  attribution: { enabled: true; parameter: "ref" };
  verification: {
    outcomeName: string;
    outcomeType: SafeGrowthProgram["objectiveOutcomeType"];
    evidenceFields: string[];
    holdSeconds: number;
  };
  settlement: {
    status: "SHADOW_NOT_FUNDED";
    execution: "NOT_EXECUTED";
  };
  joinable: boolean;
}

export interface PublicAttributionResult {
  status: "ATTRIBUTED";
  programId: string;
  programSlug: string;
  attributionId: string;
  capturedAt: string;
  participant: {
    displayName: string;
    handle: string | null;
    participantType: "CREATOR" | "REFERRAL_PARTNER";
  };
}

function originBase(origin: string): string {
  try {
    const parsed = new URL(origin);
    return parsed.origin;
  } catch {
    return "https://thesma.vercel.app";
  }
}

export function toPublicGrowthProgram(program: SafeGrowthProgram, origin: string): PublicGrowthProgram {
  const base = originBase(origin);
  return {
    id: program.id,
    slug: program.slug,
    name: program.name,
    objectiveOutcomeType: program.objectiveOutcomeType,
    outcomeSlug: program.outcomeDefinition.slug,
    targetOutcomeCount: program.targetOutcomeCount,
    participantTypes: program.participantTypes,
    rewardStructure: program.rewardStructure,
    rewardCeilingMicroUsdc: program.rewardCeilingMicroUsdc,
    participationStatus: program.participationStatus,
    status: program.status,
    operatorMode: program.operatorMode,
    productUrl: program.productUrl,
    participationUrl: `${base}/g/${encodeURIComponent(program.slug)}`,
    attribution: { enabled: true, parameter: "ref" },
    verification: {
      outcomeName: program.outcomeDefinition.name,
      outcomeType: program.outcomeDefinition.outcomeType,
      evidenceFields: program.outcomeDefinition.requiredEvidenceFields,
      holdSeconds: program.outcomeDefinition.holdSeconds,
    },
    settlement: { status: "SHADOW_NOT_FUNDED", execution: "NOT_EXECUTED" },
    joinable: program.participationStatus === "OPEN" && !["PAUSED", "COMPLETED"].includes(program.status),
  };
}

export function createProductionPublicGrowthProgramService() {
  const programs = createProductionGrowthProgramService();
  return {
    async getProgramBySlug(slug: string, origin: string): Promise<PublicGrowthProgram> {
      return toPublicGrowthProgram(await programs.getProgramBySlug({ slug }), origin);
    },
    async getPrivateProgramBySlug(slug: string) {
      return programs.getProgramBySlug({ slug });
    },
  };
}
