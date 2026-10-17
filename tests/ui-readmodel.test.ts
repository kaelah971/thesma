import { describe, expect, it } from "vitest";
import { campaignName, formatDuration, formatUsdc } from "@/lib/format";
import { answerOperator, classifyIntent, DRAFT_EXAMPLE } from "@/lib/operator";
import {
  campaignFinancials,
  outcomeRows,
  outcomeStage,
  stageCounts,
  type OutcomeView,
  type WorkspaceSnapshot,
} from "@/lib/readmodel";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function outcome(id: string, over: Partial<OutcomeView> = {}): OutcomeView {
  return {
    id,
    campaignId: "c1",
    partnerId: "p1",
    status: "VERIFIED",
    purchaseAmountMicro: "45000000",
    purchaseTx: `0x${id}`,
    proofHash: `0xproof${id}`,
    occurredAt: iso(-7_200_000),
    verifiedAt: iso(-3_600_000),
    holdUntil: iso(-60_000),
    rejectionCode: null,
    createdAt: iso(-7_200_000),
    ...over,
  };
}

function snapshot(): WorkspaceSnapshot {
  return {
    workspace: { id: "w1", name: "Acme", role: "ORGANIZATION_OWNER", companyWallet: null, category: null },
    campaigns: [
      {
        id: "c1",
        state: "LIVE",
        intentText: "Acquire 50 paying customers with a budget of 5000 USDC. More text.",
        version: 1,
        policyStatus: "APPROVED",
        targetOutcomeCount: 50,
        budgetMicro: "5000000000",
        floorMicro: "40000000",
        ceilingMicro: "80000000",
        minPurchaseMicro: "30000000",
        deadline: iso(86_400_000 * 30),
        refundHoldSeconds: 3600,
        visibility: "PUBLIC",
        createdAt: iso(-86_400_000),
        updatedAt: iso(-86_400_000),
        funding: {
          status: "CONFIRMED",
          policyVersion: 1,
          expectedMicro: "5000000000",
          observedMicro: "5000000000",
          fundingTxHash: "0xfund",
          confirmedAt: iso(-86_000_000),
          failureCode: null,
        },
        market: { status: "OPEN", bountyMicro: "60000000", version: 1, openedAt: iso(-80_000_000) },
      },
    ],
    outcomes: [
      outcome("o1"),
      outcome("o2", { holdUntil: iso(42 * 60_000) }),
      outcome("o3", { status: "PENDING", verifiedAt: null, holdUntil: null, proofHash: null }),
      outcome("o4", { status: "REJECTED", rejectionCode: "AMOUNT_MISMATCH" }),
      outcome("o5"),
    ],
    reservations: [
      { id: "r1", campaignId: "c1", outcomeId: "o1", amountMicro: "60000000", state: "SETTLED" },
      { id: "r5", campaignId: "c1", outcomeId: "o5", amountMicro: "60000000", state: "RESERVED" },
    ],
    payouts: [
      {
        id: "pay1",
        campaignId: "c1",
        outcomeId: "o1",
        partnerId: "p1",
        recipient: "0x1111111111111111111111111111111111111111",
        amountMicro: "60000000",
        state: "SETTLED",
        txHash: "0xtx1",
        submittedAt: iso(-1_000_000),
        settledAt: iso(-900_000),
        reconciledAt: iso(-900_000),
        failureCode: null,
        createdAt: iso(-1_100_000),
      },
    ],
    activeCommitments: [{ campaignId: "c1", amountMicro: "55000000" }],
    activity: [],
    generatedAt: iso(0),
  };
}

describe("format helpers", () => {
  it("formats exact USDC with grouping and no rounding", () => {
    expect(formatUsdc("5000000000")).toBe("5,000");
    expect(formatUsdc("1234567")).toBe("1.234567");
    expect(formatUsdc(0n)).toBe("0");
    expect(formatUsdc(null)).toBe("—");
  });

  it("formats durations compactly", () => {
    expect(formatDuration(42 * 60_000)).toBe("42m");
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatDuration(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
  });

  it("derives campaign names from intent text", () => {
    expect(campaignName("acquire 50 paying customers. Budget 10 USDC.")).toBe("Acquire 50 paying customers");
    expect(campaignName("")).toBe("Untitled campaign");
  });
});

describe("read model", () => {
  it("mirrors backend budget definitions (committed includes settled + reservations + commitments)", () => {
    const f = campaignFinancials("c1", snapshot());
    expect(f.funded).toBe(5_000_000_000n);
    expect(f.settled).toBe(60_000_000n);
    expect(f.committed).toBe(60_000_000n + 60_000_000n + 55_000_000n);
    expect(f.available).toBe(5_000_000_000n - 175_000_000n);
  });

  it("treats unconfirmed funding as zero funded", () => {
    const snap = snapshot();
    snap.campaigns[0].funding!.status = "SUBMITTED";
    expect(campaignFinancials("c1", snap).funded).toBe(0n);
    expect(campaignFinancials("c1", snap).available).toBe(0n);
  });

  it("places outcomes on the settlement rail truthfully", () => {
    const rows = outcomeRows(snapshot(), NOW);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.o1.stage).toBe("SETTLED");
    expect(byId.o2.stage).toBe("SAFETY_HOLD");
    expect(byId.o2.holdRemainingMs).toBe(42 * 60_000);
    expect(byId.o3.stage).toBe("AWAITING_VERIFICATION");
    expect(byId.o4.stage).toBe("REJECTED");
    expect(byId.o5.stage).toBe("RESERVED");
    expect(stageCounts(rows).SETTLED).toBe(1);
  });

  it("never reports a verified outcome without a payout as paid", () => {
    expect(outcomeStage(outcome("x", { holdUntil: iso(-1) }), undefined, undefined, NOW)).toBe("ELIGIBLE");
  });
});

describe("operator", () => {
  it("classifies the suggested prompts", () => {
    expect(classifyIntent("Show campaign status")).toBe("status");
    expect(classifyIntent("What is awaiting verification?")).toBe("awaiting");
    expect(classifyIntent("Explain this payout")).toBe("explain");
    expect(classifyIntent("Why hasn't it paid?")).toBe("explain");
    expect(classifyIntent("Show available budget")).toBe("budget");
    expect(classifyIntent("List verified outcomes")).toBe("verified");
    expect(classifyIntent("Draft a campaign")).toBe("draft");
  });

  it("reports safety holds with an exact countdown from live state", () => {
    const reply = answerOperator("Show me campaign status.", snapshot(), NOW);
    expect(reply.text).toContain("1 verified outcome is currently in its safety hold.");
    expect(reply.text).toContain("Payout becomes eligible in 42 minutes.");
  });

  it("explains a held payout without implying it was paid", () => {
    const reply = answerOperator("Why hasn't it paid?", snapshot(), NOW);
    expect(reply.text).toContain("settlement is intentionally blocked until the campaign hold expires");
  });

  it("hands real draft descriptions to the draft API and guides short requests", () => {
    expect(answerOperator(DRAFT_EXAMPLE, snapshot(), NOW).draftIntent).toMatch(/^Acquire 50 paying customers/);
    expect(answerOperator("Draft a campaign", snapshot(), NOW).draftIntent).toBeUndefined();
  });

  it("does not fabricate status for an empty workspace", () => {
    const snap = { ...snapshot(), campaigns: [], outcomes: [], reservations: [], payouts: [], activeCommitments: [] };
    expect(answerOperator("Show campaign status", snap, NOW).text).toContain("no campaigns yet");
  });
});
