import { describe, expect, it } from "vitest";
import {
  buildOperatorDecisionAudit,
  buildOperatorSnapshot,
  decideObligation,
  executeOperatorDecision,
  HeuristicOperatorPlanner,
  MICRO_USDC_PER_USDC,
  OPERATOR_DECISION_ACTION,
  sumAutonomousSpentToday,
  summarizeOperatorMetrics,
  type Obligation,
  type OperatorPolicy,
} from "@/server/services/operator";

const U = MICRO_USDC_PER_USDC;
const NOW = new Date("2026-06-01T12:00:00.000Z");
const HOLD_FUTURE = new Date("2026-06-02T12:00:00.000Z");
const HOLD_PAST = new Date("2026-05-01T12:00:00.000Z");

const POLICY: OperatorPolicy = {
  minReserveMicroUsdc: 20n * U,
  maxAutonomousPaymentMicroUsdc: 10n * U,
  maxAutonomousSpendPerPeriodMicroUsdc: null,
};

function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    outcomeId: "o-1",
    campaignId: "c-1",
    partnerId: "p-1",
    amountMicroUsdc: 4n * U,
    status: "VERIFIED",
    holdUntil: HOLD_PAST,
    campaignState: "LIVE",
    ...over,
  };
}

function snapshotFor(amounts: { funded: bigint; committed: bigint; obligations: Obligation[] }) {
  return buildOperatorSnapshot(
    { fundedMicroUsdc: amounts.funded, committedMicroUsdc: amounts.committed, settledMicroUsdc: 0n, obligations: amounts.obligations, now: NOW },
    POLICY,
  );
}

describe("operator liquidity kernel", () => {
  it("computes AVAILABLE = cash − committed − reserve without double-counting holds", () => {
    const snap = snapshotFor({
      funded: 100n * U,
      committed: 40n * U,
      obligations: [obligation({ amountMicroUsdc: 4n * U, holdUntil: HOLD_FUTURE })],
    });
    // 100 − 40 − 20 = 40 available. The held 4 USDC is reported, not added.
    expect(snap.availableToDeployMicroUsdc).toBe((40n * U).toString());
    expect(snap.heldMicroUsdc).toBe((4n * U).toString());
    expect(snap.verifiedUnpaidMicroUsdc).toBe((4n * U).toString());
    expect(snap.eligibleMicroUsdc).toBe("0");
  });

  it("floors availability at zero instead of going negative", () => {
    const snap = snapshotFor({ funded: 10n * U, committed: 5n * U, obligations: [] });
    expect(snap.availableToDeployMicroUsdc).toBe("0");
  });

  it("carries per-campaign target progress without touching money math", () => {
    const snap = buildOperatorSnapshot(
      {
        fundedMicroUsdc: 100n * U,
        committedMicroUsdc: 0n,
        settledMicroUsdc: 0n,
        obligations: [],
        campaignProgress: [{ campaignId: "c-1", targetOutcomeCount: 5, verifiedCount: 2 }],
        now: NOW,
      },
      POLICY,
    );
    expect(snap.campaignProgress).toEqual([{ campaignId: "c-1", targetOutcomeCount: 5, verifiedCount: 2 }]);
    expect(snap.availableToDeployMicroUsdc).toBe((80n * U).toString());
    expect(snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [] }).campaignProgress).toEqual([]);
  });
});

describe("deterministic authority validator", () => {
  it("PAY_NOW inside authority (spec example: 4 USDC vs 40 available, 20 reserve, 10 cap)", () => {
    const snap = snapshotFor({ funded: 100n * U, committed: 40n * U, obligations: [obligation()] });
    const [priced] = snap.obligations;
    const d = decideObligation(snap, priced, POLICY);
    expect(d.decision).toBe("PAY_NOW");
    expect(d.autonomous).toBe(true);
    expect(d.rule).toBe("WITHIN_AUTHORITY");
    expect(d.liquidityBeforeMicroUsdc).toBe((40n * U).toString());
    expect(d.liquidityAfterMicroUsdc).toBe((36n * U).toString());
  });

  it("WAIT_FOR_HOLD while the safety hold is active", () => {
    const snap = snapshotFor({ funded: 100n * U, committed: 40n * U, obligations: [obligation({ holdUntil: HOLD_FUTURE })] });
    // Held obligations are not eligible, so the validator sees no payable row…
    expect(snap.obligations[0].state).toBe("HELD");
    const d = decideObligation(snap, snap.obligations[0], POLICY);
    expect(d.decision).toBe("WAIT_FOR_HOLD");
    expect(d.rule).toBe("SAFETY_HOLD");
    expect(d.autonomous).toBe(true);
  });

  it("HOLD_FOR_LIQUIDITY when payment would breach the reserve", () => {
    const snap = snapshotFor({ funded: 30n * U, committed: 5n * U, obligations: [obligation({ amountMicroUsdc: 8n * U })] });
    // 30 − 5 − 20 = 5 available < 8 obligation.
    const d = decideObligation(snap, snap.obligations[0], POLICY);
    expect(d.decision).toBe("HOLD_FOR_LIQUIDITY");
    expect(d.rule).toBe("MIN_RESERVE");
  });

  it("ESCALATE_APPROVAL above the autonomous cap (spec example: 14 vs 10)", () => {
    const snap = snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [obligation({ amountMicroUsdc: 14n * U })] });
    const d = decideObligation(snap, snap.obligations[0], POLICY);
    expect(d.decision).toBe("ESCALATE_APPROVAL");
    expect(d.autonomous).toBe(false);
    expect(d.rule).toBe("MAX_AUTONOMOUS_PAYMENT");
  });

  it("ESCALATE_APPROVAL when the period spend cap would break", () => {
    const capped: OperatorPolicy = { ...POLICY, maxAutonomousSpendPerPeriodMicroUsdc: 5n * U };
    const snap = snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [obligation({ amountMicroUsdc: 4n * U })] });
    const d = decideObligation(snap, snap.obligations[0], capped, 2n * U);
    expect(d.decision).toBe("ESCALATE_APPROVAL");
    expect(d.rule).toBe("MAX_AUTONOMOUS_SPEND_PER_PERIOD");
  });

  it("NO_ACTION when nothing is due or the outcome is not verified", () => {
    const snap = snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [] });
    expect(decideObligation(snap, null, POLICY).decision).toBe("NO_ACTION");
    const pending = snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [obligation({ status: "PENDING" })] });
    const d = decideObligation(pending, pending.obligations[0], POLICY);
    expect(d.decision).toBe("NO_ACTION");
    expect(d.rule).toBe("NOT_VERIFIED");
  });

  it("never mutates the obligation: PAY_NOW is advice, VERIFIED is not PAID", () => {
    const o = obligation();
    const snap = snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [o] });
    const before = `${o.status}|${o.amountMicroUsdc}|${o.outcomeId}`;
    const d = decideObligation(snap, snap.obligations[0], POLICY);
    expect(d.decision).toBe("PAY_NOW");
    expect(`${o.status}|${o.amountMicroUsdc}|${o.outcomeId}`).toBe(before);
    expect(o.status).toBe("VERIFIED");
  });
});

describe("planner cannot bypass policy", () => {
  it("a rogue nomination for a held outcome still validates to WAIT_FOR_HOLD", async () => {
    const snap = snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [obligation({ outcomeId: "o-held", holdUntil: HOLD_FUTURE })] });
    // Rogue planner nominates the held outcome for immediate payment.
    const nominated = snap.obligations.find((o) => o.outcomeId === "o-held") ?? null;
    const d = decideObligation(snap, nominated, POLICY);
    expect(d.decision).not.toBe("PAY_NOW");
    expect(d.decision).toBe("WAIT_FOR_HOLD");
  });

  it("a rogue nomination above the cap still validates to ESCALATE_APPROVAL", async () => {
    const snap = snapshotFor({ funded: 100n * U, committed: 0n * U, obligations: [obligation({ outcomeId: "o-big", amountMicroUsdc: 50n * U })] });
    const nominated = snap.obligations.find((o) => o.outcomeId === "o-big") ?? null;
    const d = decideObligation(snap, nominated, POLICY);
    expect(d.decision).toBe("ESCALATE_APPROVAL");
    expect(d.autonomous).toBe(false);
  });

  it("the shipped heuristic nominates oldest-eligible and stays advisory", async () => {
    const planner = new HeuristicOperatorPlanner();
    const snap = snapshotFor({
      funded: 100n * U,
      committed: 0n * U,
      obligations: [obligation({ outcomeId: "o-new" }), obligation({ outcomeId: "o-old", holdUntil: null })],
    });
    const rec = await planner.plan(snap, POLICY);
    // holdUntil null = longest overdue → nominated first. Still advisory.
    expect(rec.outcomeId).toBe("o-old");
    expect(rec.rationale).toContain("Validator decides");
  });
});

describe("testnet-only execution guard", () => {
  const decision = {
    decision: "PAY_NOW" as const,
    outcomeId: "o-1",
    amountMicroUsdc: String(4n * U),
    reason: "test",
    rule: "WITHIN_AUTHORITY",
    liquidityBeforeMicroUsdc: String(40n * U),
    liquidityAfterMicroUsdc: String(36n * U),
    autonomous: true,
  };

  it("refuses mainnet configs before any store or chain access", async () => {
    const mainnet = { network: "mainnet", chainId: 5042 } as never;
    await expect(executeOperatorDecision({ config: mainnet } as never, decision)).rejects.toMatchObject({
      code: "MAINNET_FORBIDDEN",
    });
  });

  it("refuses unconfigured or network-less configs", async () => {
    await expect(executeOperatorDecision({ config: null } as never, decision)).rejects.toMatchObject({
      code: "MAINNET_FORBIDDEN",
    });
    const legacy = { chainId: 5042 } as never;
    await expect(executeOperatorDecision({ config: legacy } as never, decision)).rejects.toMatchObject({
      code: "MAINNET_FORBIDDEN",
    });
  });

  it("refuses wrong-chain testnet configs", async () => {
    const wrong = { network: "testnet", chainId: 5042 } as never;
    await expect(executeOperatorDecision({ config: wrong } as never, decision)).rejects.toMatchObject({
      code: "MAINNET_FORBIDDEN",
    });
  });

  it("does not execute non-PAY_NOW decisions", async () => {
    const wait = { ...decision, decision: "WAIT_FOR_HOLD" as const };
    const res = await executeOperatorDecision({ config: { network: "testnet", chainId: 5042002 } } as never, wait);
    expect(res.executed).toBe(false);
  });
});

describe("decision ledger + RFB metrics", () => {
  it("preserves WHAT/WHY/COST/ALLOWED/PROOF in one immutable row", () => {
    const row = buildOperatorDecisionAudit({
      id: "audit-1",
      actorType: "AGENT",
      workspaceId: "ws-1",
      action: OPERATOR_DECISION_ACTION,
      targetType: "outcome",
      targetId: "o-1",
      metadata: {
        decision: "PAY_NOW",
        reason: "inside authority",
        rule: "WITHIN_AUTHORITY",
        amountMicroUsdc: String(4n * U),
        autonomous: true,
        execution: { status: "EXECUTED", settled: true },
      },
    });
    expect(row.metadata.decision).toBe("PAY_NOW");
    expect(row.metadata.rule).toBe("WITHIN_AUTHORITY");
    expect(row.actorType).toBe("AGENT");
  });

  it("derives honest metrics with no fabrication", () => {
    const m = summarizeOperatorMetrics([
      { action: OPERATOR_DECISION_ACTION, metadata: { autonomous: true, amountMicroUsdc: String(2n * U), execution: { status: "EXECUTED", settled: true } } },
      { action: OPERATOR_DECISION_ACTION, metadata: { autonomous: true, amountMicroUsdc: String(1n * U), execution: { status: "EXECUTED", settled: false } } },
      { action: "operator.escalation", metadata: {} },
      { action: "operator.escalation.decision", metadata: { approved: true } },
      { action: "operator.escalation.decision", metadata: { approved: false } },
    ]);
    expect(m.decisions).toBe(2);
    expect(m.autonomousDecisions).toBe(2);
    expect(m.escalated).toBe(1);
    expect(m.approved).toBe(1);
    expect(m.rejected).toBe(1);
    expect(m.autonomousPaidMicroUsdc).toBe(String(3n * U));
    expect(m.obligationsSettledAutonomously).toBe(1);
    expect(m.autonomousSettlementRate).toBe(1);
  });

  it("sums only today's autonomous executions for the period cap", () => {
    const sum = sumAutonomousSpentToday(
      [
        { action: OPERATOR_DECISION_ACTION, createdAt: NOW, metadata: { autonomous: true, amountMicroUsdc: String(2n * U), execution: { status: "EXECUTED" } } },
        { action: OPERATOR_DECISION_ACTION, createdAt: new Date("2026-05-01T12:00:00.000Z"), metadata: { autonomous: true, amountMicroUsdc: String(9n * U), execution: { status: "EXECUTED" } } },
        { action: OPERATOR_DECISION_ACTION, createdAt: NOW, metadata: { autonomous: false, amountMicroUsdc: String(7n * U), execution: { status: "EXECUTED" } } },
      ],
      NOW,
    );
    expect(sum).toBe(2n * U);
  });
});
