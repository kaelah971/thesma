import { describe, expect, it } from "vitest";
import type { MarketStore } from "@/server/services/campaignStore";
import { createMemoryAuditSink } from "@/server/services/campaignStore";
import {
  evaluateOutcomePortfolio,
  loadOutcomePortfolioPlan,
  recordOutcomePortfolioDecision,
  type OutcomePortfolioMember,
  type OutcomePortfolioObjective,
} from "@/server/services/outcomePortfolio";
import type { CfoSnapshot } from "@/server/services/cfo";

const M = 1_000_000n;
const NOW = new Date("2026-11-03T12:00:00.000Z");

const OBJECTIVE: OutcomePortfolioObjective = {
  organizationId: "org-1",
  targetOutcomeType: "ACTIVATED_USERS",
  targetOutcomeCount: 50,
  maxVerifiedCacMicro: (10n * M).toString(),
  totalBudgetMicro: (500n * M).toString(),
  reserveFloorBps: 2_000,
  maxAllocationPerChannelBps: 5_000,
  minimumEvidenceSample: 5,
  deadline: null,
  retentionRequirement: null,
  qualityThreshold: null,
};

function member(overrides: Partial<OutcomePortfolioMember> = {}): OutcomePortfolioMember {
  return {
    memberId: "campaign-alpha",
    memberType: "CAMPAIGN",
    label: "Campaign Alpha",
    capitalAllocatedMicro: (100n * M).toString(),
    capitalCommittedMicro: "0",
    capitalSpentMicro: (50n * M).toString(),
    verifiedOutcomeCount: 10,
    verifiedOutcomeValueMicro: (100n * M).toString(),
    verificationSpendMicro: "0",
    verificationSpendExcludedMicro: "0",
    availableCapacityMicro: (100n * M).toString(),
    grossVerifiedAcquisitionCostMicro: (5n * M).toString(),
    verifiedAcquisitionCostMicro: (5n * M).toString(),
    allInVerifiedAcquisitionCostMicro: (5n * M).toString(),
    retainedAllInVerifiedAcquisitionCostMicro: null,
    reliabilityScore: 85,
    reliability: "STRONG_EVIDENCE",
    reliabilityConfidence: "HIGH",
    sampleSize: 10,
    sampleConfidence: "ESTABLISHED",
    retainedOutcomeCount: null,
    retentionRateBps: null,
    retentionDataAvailable: false,
    status: "ELIGIBLE",
    statusReason: null,
    conflictingEvidence: false,
    unresolvedVerification: false,
    unverifiedOutcomeCount: 0,
    ...overrides,
  };
}

function plan(
  members: OutcomePortfolioMember[],
  overrides: Partial<Parameters<typeof evaluateOutcomePortfolio>[0]> = {},
) {
  return evaluateOutcomePortfolio({
    workspaceId: "org-1",
    generatedAt: NOW.toISOString(),
    objective: OBJECTIVE,
    members,
    availableCapitalMicro: (500n * M).toString(),
    minimumReserveMicro: "0",
    ...overrides,
  });
}

describe("outcome portfolio deterministic policy kernel", () => {
  it("strong verified economics recommend INCREASE", () => {
    const result = plan([member()]);
    const alpha = result.members[0]!;
    expect(alpha.recommendation).toBe("INCREASE");
    expect(BigInt(alpha.recommendedNextAllocationMicro)).toBe(100n * M);
    expect(alpha.reasonCodes).toContain("VERIFIED_CAC_BELOW_CEILING");
  });

  it("established CAC above the ceiling recommends PAUSE", () => {
    const result = plan([member({ allInVerifiedAcquisitionCostMicro: (11n * M).toString() })]);
    expect(result.members[0]!.recommendation).toBe("PAUSE");
    expect(result.members[0]!.reasonCodes).toContain("CAC_ABOVE_CEILING");
    expect(result.members[0]!.recommendedNextAllocationMicro).toBe("0");
  });

  it("insufficient sample recommends REVIEW, never blind funding", () => {
    const result = plan([member({ verifiedOutcomeCount: 0, sampleSize: 0, allInVerifiedAcquisitionCostMicro: null, verifiedAcquisitionCostMicro: null })]);
    expect(result.members[0]!.recommendation).toBe("REVIEW");
    expect(result.members[0]!.confidence).toBe("INSUFFICIENT");
  });

  it("inside-target economics without a strong edge recommend HOLD", () => {
    const result = plan([member({ allInVerifiedAcquisitionCostMicro: "9200000" })]);
    expect(result.members[0]!.recommendation).toBe("HOLD");
  });

  it("near-ceiling economics recommend REDUCE without moving existing funds", () => {
    const inputMember = member({ allInVerifiedAcquisitionCostMicro: "9500000" });
    const result = plan([inputMember]);
    expect(result.members[0]!.recommendation).toBe("REDUCE");
    expect(result.members[0]!.recommendedNextAllocationMicro).toBe("0");
    expect(inputMember.capitalSpentMicro).toBe((50n * M).toString());
    expect(result.accounting.availableMicro).toBe((500n * M).toString());
  });

  it("committed and verified-unpaid money never becomes allocatable", () => {
    const result = plan([member({ capitalCommittedMicro: (450n * M).toString() })], {
      availableCapitalMicro: (50n * M).toString(),
      protectedCapitalMicro: (450n * M).toString(),
      accounting: {
        fundedMicro: (500n * M).toString(),
        spentMicro: "0",
        committedMicro: (400n * M).toString(),
        verifiedUnpaidMicro: (50n * M).toString(),
        hybridCommittedMicro: "0",
        availableMicro: (50n * M).toString(),
        protectedFromProspectiveAllocationMicro: (450n * M).toString(),
        identityBalanced: true,
      },
    });
    expect(BigInt(result.recommendedCapitalMicro)).toBeLessThanOrEqual(50n * M);
    expect(BigInt(result.recommendedCapitalMicro) + BigInt(result.reserveMicro) + BigInt(result.unallocatedMicro)).toBeLessThanOrEqual(50n * M);
  });

  it("reserve floor is first-class and preserved", () => {
    const result = plan([member({ availableCapacityMicro: (500n * M).toString() })]);
    expect(result.reserveMicro).toBe((100n * M).toString());
    expect(BigInt(result.recommendedCapitalMicro) + BigInt(result.reserveMicro) + BigInt(result.unallocatedMicro)).toBe(500n * M);
  });

  it("accounting identity is carried into the portfolio decision", () => {
    const result = plan([member()], {
      accounting: {
        fundedMicro: (500n * M).toString(),
        spentMicro: (100n * M).toString(),
        committedMicro: (50n * M).toString(),
        verifiedUnpaidMicro: (50n * M).toString(),
        hybridCommittedMicro: "0",
        availableMicro: (300n * M).toString(),
        protectedFromProspectiveAllocationMicro: (100n * M).toString(),
        identityBalanced: true,
      },
    });
    expect(result.accounting.identityBalanced).toBe(true);
    expect(BigInt(result.accounting.fundedMicro)).toBe(
      BigInt(result.accounting.spentMicro) + BigInt(result.accounting.committedMicro) +
      BigInt(result.accounting.verifiedUnpaidMicro) + BigInt(result.accounting.availableMicro),
    );
  });

  it("unresolved verification states force REVIEW", () => {
    const result = plan([member({ unresolvedVerification: true })]);
    expect(result.members[0]!.recommendation).toBe("REVIEW");
    expect(result.members[0]!.reasonCodes).toContain("VERIFICATION_UNRESOLVED");
  });

  it("max-member concentration is enforced", () => {
    const result = plan([member({ availableCapacityMicro: (500n * M).toString() })]);
    expect(BigInt(result.members[0]!.recommendedNextAllocationMicro)).toBe(200n * M);
  });

  it("member capacity is enforced", () => {
    const result = plan([member({ availableCapacityMicro: (7n * M).toString() })]);
    expect(BigInt(result.members[0]!.recommendedNextAllocationMicro)).toBe(7n * M);
  });

  it("total recommendations never exceed allocatable capital", () => {
    const result = plan([
      member({ memberId: "a", availableCapacityMicro: (500n * M).toString() }),
      member({ memberId: "b", availableCapacityMicro: (500n * M).toString() }),
      member({ memberId: "c", availableCapacityMicro: (500n * M).toString() }),
    ]);
    const allocated = result.members.reduce((sum, row) => sum + BigInt(row.recommendedNextAllocationMicro), 0n);
    expect(allocated).toBeLessThanOrEqual(BigInt(result.allocatableCapitalMicro));
  });

  it("verification costs are included in all-in CAC", () => {
    const result = plan([member({ capitalSpentMicro: (80n * M).toString(), allInVerifiedAcquisitionCostMicro: "8200000", verificationSpendMicro: "200000" })]);
    expect(result.members[0]!.allInVerifiedAcquisitionCostMicro).toBe("8200000");
    expect(result.verificationSpendMicro).toBe("200000");
  });

  it("Arc-Testnet x402 proof spend is excluded from production economics", () => {
    const result = plan([member({ verificationSpendMicro: "0", verificationSpendExcludedMicro: "2000", allInVerifiedAcquisitionCostMicro: "8000000" })]);
    expect(result.verificationSpendMicro).toBe("0");
    expect(result.arcTestnetVerificationSpendExcludedMicro).toBe("2000");
    expect(result.members[0]!.allInVerifiedAcquisitionCostMicro).toBe("8000000");
  });

  it("unverified outcomes do not enter verified economics", () => {
    const result = plan([member({ verifiedOutcomeCount: 2, sampleSize: 2, sampleConfidence: "PROVISIONAL", unverifiedOutcomeCount: 30, allInVerifiedAcquisitionCostMicro: "5000000" })]);
    expect(result.members[0]!.verifiedOutcomeCount).toBe(2);
    expect(result.members[0]!.unverifiedOutcomeCount).toBe(30);
    expect(result.members[0]!.allInVerifiedAcquisitionCostMicro).toBe("5000000");
    expect(result.members[0]!.recommendation).toBe("REVIEW");
  });

  it("no-history creators or channels remain provisional/insufficient", () => {
    const result = plan([member({ verifiedOutcomeCount: 0, sampleSize: 0, allInVerifiedAcquisitionCostMicro: null, reliability: "PROVISIONAL" })]);
    expect(result.members[0]!.confidence).toBe("INSUFFICIENT");
    expect(result.members[0]!.recommendation).toBe("REVIEW");
  });

  it("conflicting evidence fails closed to REVIEW", () => {
    const result = plan([member({ conflictingEvidence: true })]);
    expect(result.members[0]!.recommendation).toBe("REVIEW");
    expect(result.members[0]!.reasonCodes).toContain("CONFLICTING_EVIDENCE");
  });

  it("ineligible member is PAUSED/refused new allocation", () => {
    const result = plan([member({ status: "INELIGIBLE", statusReason: "Campaign is CLOSED." })]);
    expect(result.members[0]!.recommendation).toBe("PAUSE");
    expect(result.members[0]!.recommendedNextAllocationMicro).toBe("0");
  });

  it("retention requirement reviews when real retention data is unavailable", () => {
    const result = plan([member()], { objective: { ...OBJECTIVE, retentionRequirement: 7000 } });
    expect(result.members[0]!.recommendation).toBe("REVIEW");
    expect(result.members[0]!.reasonCodes).toContain("RETENTION_DATA_UNAVAILABLE");
  });

  it("same input produces the same recommendation and exact bigint amounts", () => {
    const input = [member({ availableCapacityMicro: "123456789" }), member({ memberId: "beta", availableCapacityMicro: "987654321" })];
    const first = plan(input);
    const second = plan(input.slice().reverse());
    expect(second).toEqual(first);
    expect(first.members.every((row) => /^\d+$/.test(row.recommendedNextAllocationMicro))).toBe(true);
  });

  it("zero outcomes never divides by zero", () => {
    expect(() => plan([member({ verifiedOutcomeCount: 0, sampleSize: 0, allInVerifiedAcquisitionCostMicro: null })])).not.toThrow();
  });

  it("chain movement remains UNAVAILABLE and execution remains RECOMMENDED", () => {
    const result = plan([member()]);
    expect(result.chainMovement).toBe("UNAVAILABLE");
    expect(result.executionStatus).toBe("RECOMMENDED");
  });

  it("ledger records objective, reasons, allocations and snapshot hash", async () => {
    const { sink, events } = createMemoryAuditSink();
    const result = plan([member()]);
    await recordOutcomePortfolioDecision(sink, result);
    expect(events.map((event) => event.action)).toContain("cfo.portfolio.plan.generated");
    expect(events.map((event) => event.action)).toContain("cfo.portfolio.member.decision");
    const generated = events.find((event) => event.action === "cfo.portfolio.plan.generated")!;
    expect(generated.metadata).toMatchObject({ portfolioSnapshotHash: result.portfolioSnapshotHash, objective: OBJECTIVE });
    expect(JSON.stringify(generated.metadata)).toContain("VERIFIED_CAC_BELOW_CEILING");
  });

  it("preview is read-only", () => {
    const original = member();
    const before = JSON.stringify(original);
    evaluateOutcomePortfolio({
      workspaceId: "org-1",
      generatedAt: NOW.toISOString(),
      objective: { ...OBJECTIVE, reserveFloorBps: 3_000 },
      members: [original],
      availableCapitalMicro: (500n * M).toString(),
    });
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe("outcome portfolio composes existing settlement truth", () => {
  it("counts only SETTLED payouts and excludes HELD/SUBMITTED from spent economics", async () => {
    const outcomes = [
      { id: "o-settled", status: "VERIFIED", partnerId: "p-1", campaignId: "c-1", customerKeyHash: "a", verifiedAt: NOW },
      { id: "o-held", status: "VERIFIED", partnerId: "p-1", campaignId: "c-1", customerKeyHash: "b", verifiedAt: NOW },
      { id: "o-submitted", status: "VERIFIED", partnerId: "p-1", campaignId: "c-1", customerKeyHash: "c", verifiedAt: NOW },
    ];
    const payouts = new Map([
      ["o-settled", { amountMicroUsdc: 4n * M, state: "SETTLED" }],
      ["o-held", { amountMicroUsdc: 4n * M, state: "HELD" }],
      ["o-submitted", { amountMicroUsdc: 4n * M, state: "SUBMITTED" }],
    ]);
    const store = {
      listOutcomesByStatus: async (status: string) => status === "VERIFIED" ? outcomes : [],
      listProcurementsByWorkspace: async () => [],
      listCheckoutIntentsByCampaign: async () => [],
      listReservationsByCampaign: async () => [],
      getPayoutByOutcome: async (id: string) => payouts.get(id) ?? null,
    } as unknown as MarketStore;
    const snapshot: CfoSnapshot = {
      workspaceId: "org-1",
      generatedAt: NOW.toISOString(),
      campaigns: [{
        campaignId: "c-1", objective: "ACTIVATED_USERS", state: "LIVE", marketStatus: "OPEN", publicBountyMicroUsdc: (4n * M).toString(),
        targetOutcomeCount: 10, budgetMicroUsdc: (100n * M).toString(), maxVerifiedCacMicroUsdc: (10n * M).toString(),
        financials: { fundedMicroUsdc: (100n * M).toString(), spentMicroUsdc: (4n * M).toString(), committedMicroUsdc: "0", reservedMicroUsdc: "0", verifiedUnpaidMicroUsdc: "0", hybridCommittedMicroUsdc: "0", hybridContingentMicroUsdc: "0", availableMicroUsdc: (96n * M).toString(), frozenTermsExposureMicroUsdc: (4n * M).toString() },
        pace: { status: "BEHIND", targetProgressPct: 30, timeProgressPct: 50, projectedOutcomes: 6 },
        evidence: { verifiedOutcomes: 3, totalActions: 3, realizedCostPerVerifiedMicroUsdc: (4n * M).toString(), confidence: "LOW", topLabel: null },
        estimatedFundingRequiredMicroUsdc: (28n * M).toString(), budgetHeadroomMicroUsdc: "0", nextDueMicroUsdc: "0", hardConflict: null, ambiguous: null, retentionD7Rate: null, retainedD7: 0, hasMilestoneDeals: false,
      }],
      totals: { fundedMicroUsdc: (100n * M).toString(), spentMicroUsdc: (4n * M).toString(), committedMicroUsdc: "0", reservedMicroUsdc: "0", verifiedUnpaidMicroUsdc: "0", hybridCommittedMicroUsdc: "0", hybridContingentMicroUsdc: "0", availableMicroUsdc: (96n * M).toString() },
    };
    const result = await loadOutcomePortfolioPlan(snapshot, { store, operatorPolicy: { minReserveMicroUsdc: 0n, maxAutonomousPaymentMicroUsdc: 0n, maxAutonomousSpendPerPeriodMicroUsdc: null }, now: NOW });
    expect(result.members[0]!.capitalSpentMicro).toBe((4n * M).toString());
    expect(result.members[0]!.allInVerifiedAcquisitionCostMicro).toBe((4n * M / 3n).toString());
    expect(result.accounting.identityBalanced).toBe(true);
  });
});
