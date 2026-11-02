import { describe, expect, it } from "vitest";
import { createMemoryAuditSink, createMemoryCampaignStore } from "@/server/services/campaignStore";
import {
  buildShadowDecision,
  recordShadowDecision,
  recordShadowResponse,
  runShadowOperator,
  summarizeShadowTelemetry,
  toShadowJson,
  type ShadowDecisionRecord,
} from "@/server/services/shadowOperator";
import {
  assertExecutionAllowed,
  operatorModeFromAuditRows,
  shadowBoundary,
  type ShadowBlockedOperation,
} from "@/server/services/operatorMode";

const NOW = "2026-06-01T12:00:00.000Z";

function decision(over: Partial<ShadowDecisionRecord> = {}): ShadowDecisionRecord {
  return buildShadowDecision({
    id: over.id ?? "sd-1",
    runId: "run-1",
    workspaceId: "ws-1",
    family: "OUTCOME_PORTFOLIO",
    targetId: "campaign-1",
    recommendation: "INCREASE",
    amountMicroUsdc: "50000000",
    confidence: "ESTABLISHED",
    reasons: ["Verified CAC is inside policy."],
    inputSnapshot: { availableMicroUsdc: 100000000n },
    policySnapshot: { reserveFloorBps: 2000 },
    generatedAt: NOW,
    ...over,
  });
}

async function shadowFixture() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner", workspaceId: "ws-1", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-1", ownerUserId: "owner", companyWallet: null, category: "saas", name: "Acme" }],
    partners: [{ id: "partner-1", userId: "creator", payoutWallet: "0xeBB55165381500D6886d2eEea2325d86275173", rulesJson: {} }],
  });
  await store.insertCampaign({ id: "campaign-1", workspaceId: "ws-1", state: "LIVE", createdByUserId: "owner" });
  await store.insertMarket({ campaignId: "campaign-1", publicBountyMicroUsdc: 4_000_000n, status: "OPEN", destinationUrl: "https://acme.example", version: 1, policyVersion: 1 });
  await store.insertVersion({
    id: "version-1", campaignId: "campaign-1", version: 1, intentText: "Acquire customers", status: "APPROVED",
    targetOutcomeCount: 100, budgetMicroUsdc: 206_000_000n, bountyFloorMicroUsdc: 1_000_000n, bountyCeilingMicroUsdc: 8_000_000n,
    minQualifyingPurchaseMicroUsdc: 1_000_000n, deadline: new Date("2026-12-01T00:00:00.000Z"), marketVisibility: "PUBLIC",
    allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
  });
  await store.insertFunding({
    id: "funding-1", campaignId: "campaign-1", policyVersionId: "version-1", policyVersion: 1,
    campaignKey: "0xkey", policyHash: "0xhash", chainId: 1, vaultAddress: "0xvault", usdcAddress: "0xusdc", ownerAddress: "0xowner",
    expectedAmountMicroUsdc: 106_000_000n,
  });
  await store.updateFunding("campaign-1", 1, { status: "CONFIRMED", observedAmountMicroUsdc: 106_000_000n });
  await store.insertTerms({
    id: "terms-1", campaignId: "campaign-1", partnerId: "partner-1", priceMicroUsdc: 1_000_000n, allocationCount: 10,
    source: "PUBLIC", expiresAt: new Date("2026-12-01T00:00:00.000Z"), policyVersion: 1, marketVersion: 1,
  });
  for (let i = 1; i <= 5; i += 1) {
    const outcomeId = `outcome-${i}`;
    const checkoutIntentId = `checkout-${i}`;
    await store.insertCheckoutIntent({
      id: checkoutIntentId, orderId: `order-${i}`, campaignId: "campaign-1", policyVersionId: "version-1", partnerId: "partner-1",
      partnerTermsId: "terms-1", attributionSessionId: null, payerAddress: "0xpayer", merchantAddress: "0xmerchant", amountMicroUsdc: 1_000_000n,
      chainId: 1, usdcAddress: "0xusdc", expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    await store.insertOutcome({
      id: outcomeId, campaignId: "campaign-1", partnerId: "partner-1", partnerTermsId: "terms-1", checkoutIntentId,
      customerKeyHash: `customer-${i}`, purchaseTx: `0xtx-${i}`, purchaseAmountMicroUsdc: 10_000_000n,
    });
    await store.updateOutcome(outcomeId, { status: "VERIFIED", verifiedAt: new Date("2026-05-20T00:00:00.000Z") });
    await store.insertReservation({ id: `reservation-${i}`, campaignId: "campaign-1", outcomeId, partnerId: "partner-1", partnerTermsId: "terms-1", amountMicroUsdc: 1_000_000n, policyVersionId: "version-1" });
    await store.updateReservation(`reservation-${i}`, { state: "SETTLED" });
    await store.insertPayout({ id: `payout-${i}`, reservationId: `reservation-${i}`, outcomeId, campaignId: "campaign-1", partnerId: "partner-1", recipient: "0xeBB55165381500D6886d2eEea2325d86275173", amountMicroUsdc: 1_000_000n, proofHash: `0xproof-${i}` });
    await store.updatePayout(`payout-${i}`, { state: "SETTLED", settledAt: new Date("2026-05-20T00:00:00.000Z") });
  }
  await store.insertCheckoutIntent({
    id: "checkout-hold", orderId: "order-hold", campaignId: "campaign-1", policyVersionId: "version-1", partnerId: "partner-1",
    partnerTermsId: "terms-1", attributionSessionId: null, payerAddress: "0xpayer", merchantAddress: "0xmerchant", amountMicroUsdc: 1_000_000n,
    chainId: 1, usdcAddress: "0xusdc", expiresAt: new Date("2026-12-01T00:00:00.000Z"),
  });
  await store.insertOutcome({
    id: "outcome-hold", campaignId: "campaign-1", partnerId: "partner-1", partnerTermsId: "terms-1", checkoutIntentId: "checkout-hold",
    customerKeyHash: "customer-hold", purchaseTx: "0xtx-hold", purchaseAmountMicroUsdc: 10_000_000n,
  });
  await store.updateOutcome("outcome-hold", { status: "VERIFIED", verifiedAt: new Date("2026-05-20T00:00:00.000Z"), holdUntil: new Date("2026-06-02T00:00:00.000Z") });
  return store;
}

describe("shadow operator telemetry", () => {
  it("runs portfolio, verification, and settlement kernels without creating payment/procurement rows", async () => {
    const store = await shadowFixture();
    const { sink, events } = createMemoryAuditSink();
    const result = await runShadowOperator({
      store,
      audit: sink,
      workspaceId: "ws-1",
      now: new Date(NOW),
      verificationChecks: [{ campaignId: "campaign-1" }],
      evaluateVerification: async () => ({
        procurement: null,
        decision: { decision: "BUY_CHECK", costMicroUsdc: "2000", reasons: ["Quoted cost is inside policy."] },
        execution: { evaluated: true, signed: false, purchased: false, ambiguous: false, result: null, paymentReference: null, route: "local-test" },
      } as never),
    });
    expect(result.decisions).toHaveLength(3);
    expect(result.decisions.map((item) => item.family)).toEqual(["OUTCOME_PORTFOLIO", "VERIFICATION_PROCUREMENT", "FINANCIAL_SETTLEMENT"]);
    expect(result.decisions.map((item) => [item.recommendation, item.amountMicroUsdc])).toEqual([
      ["INCREASE", "50000000"],
      ["WOULD_BUY", "2000"],
      ["HOLD", "1000000"],
    ]);
    expect(result.decisions.every((item) => item.executionStatus === "NOT_EXECUTED")).toBe(true);
    expect(events.filter((event) => event.action === "shadow.decision.generated")).toHaveLength(3);
    expect(await store.listProcurementsByCampaign("campaign-1")).toHaveLength(0);
    expect(await store.listReservationsByCampaign("campaign-1")).toHaveLength(5);
  });

  it("matches the deterministic three-decision fixture", () => {
    const portfolio = decision({ id: "portfolio", family: "OUTCOME_PORTFOLIO", recommendation: "INCREASE", amountMicroUsdc: "50000000" });
    const verification = decision({ id: "verification", family: "VERIFICATION_PROCUREMENT", recommendation: "WOULD_BUY", amountMicroUsdc: "2000", confidence: null });
    const settlement = decision({ id: "settlement", family: "FINANCIAL_SETTLEMENT", recommendation: "HOLD", amountMicroUsdc: "4000000", confidence: null });
    const reviewed = [
      { ...portfolio, response: { response: "AGREE" as const, reason: null, respondedAt: NOW, respondedByUserId: "owner" } },
      { ...verification, response: { response: "AGREE" as const, reason: null, respondedAt: NOW, respondedByUserId: "owner" } },
      { ...settlement, response: { response: "OVERRIDE" as const, reason: "BUSINESS_CONTEXT_MISSING", respondedAt: NOW, respondedByUserId: "owner" } },
    ];
    const telemetry = summarizeShadowTelemetry(reviewed);
    expect(telemetry.generated).toBe(3);
    expect(telemetry.reviewed).toBe(3);
    expect(telemetry.agreements).toBe(2);
    expect(telemetry.overrides).toBe(1);
    expect(telemetry.agreementRateBps).toBe(6667);
    expect(telemetry.byFamily.FINANCIAL_SETTLEMENT.overrides).toBe(1);
    expect(telemetry.byConfidence.ESTABLISHED.agreementRateBps).toBe(10000);
    expect(telemetry.byConfidence.UNKNOWN.generated).toBe(2);
  });

  it("records immutable input and policy snapshots without an execution state", async () => {
    const { sink, events } = createMemoryAuditSink();
    const item = decision();
    await recordShadowDecision(sink, item);
    expect(events[0]).toMatchObject({
      action: "shadow.decision.generated",
      metadata: {
        decisionId: "sd-1",
        executionStatus: "NOT_EXECUTED",
        inputSnapshot: { availableMicroUsdc: "100000000" },
        policySnapshot: { reserveFloorBps: 2000 },
      },
    });
  });

  it("requires a business reason for an override and keeps responses append-only", async () => {
    const { sink, events } = createMemoryAuditSink();
    const item = decision();
    await expect(recordShadowResponse(sink, item, { response: "OVERRIDE", userId: "owner" })).rejects.toMatchObject({ code: "OVERRIDE_REASON_REQUIRED" });
    const response = await recordShadowResponse(sink, item, {
      response: "OVERRIDE",
      reason: "BUSINESS_CONTEXT_MISSING",
      userId: "owner",
      respondedAt: new Date(NOW),
    });
    expect(response.reason).toBe("BUSINESS_CONTEXT_MISSING");
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("shadow.decision.responded");
  });
});

describe("shadow execution boundary", () => {
  it("blocks every money-moving operator surface", () => {
    const operations: ShadowBlockedOperation[] = ["PAYMENT", "X402_PURCHASE", "CAPITAL_MOVEMENT", "CREATOR_INVITE", "SETTLEMENT"];
    for (const operation of operations) {
      expect(() => assertExecutionAllowed("SHADOW", operation)).toThrowError(/Shadow mode blocks/);
      expect(shadowBoundary("SHADOW", operation)).toMatchObject({ executionAllowed: false, status: "NOT_EXECUTED" });
    }
    expect(shadowBoundary("AUTONOMOUS", "PAYMENT").executionAllowed).toBe(true);
  });

  it("uses the latest valid organization mode event", () => {
    expect(operatorModeFromAuditRows([
      { metadata: { mode: "SHADOW" }, createdAt: "2026-06-01T00:00:00.000Z" },
      { metadata: { mode: "AUTONOMOUS" }, createdAt: "2026-06-02T00:00:00.000Z" },
    ])).toBe("AUTONOMOUS");
    expect(operatorModeFromAuditRows([{ metadata: { mode: "SHADOW" }, createdAt: "2026-06-02T00:00:00.000Z" }])).toBe("SHADOW");
  });

  it("serializes bigint evidence exactly for snapshots", () => {
    expect(toShadowJson({ amount: 2000n, nested: [3n] })).toEqual({ amount: "2000", nested: ["3"] });
  });
});
