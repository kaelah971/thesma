import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  evaluateValueOfInformation,
  stableIdempotencyKey,
} from "@/server/services/verification";
import { evaluateVerificationCheck } from "@/server/services/verificationProcurement";
import { createLocalTestResource } from "@/server/services/verification.test-resource";

/**
 * VALUE-OF-INFORMATION KERNEL + GATE.
 *
 * Exact integer math over the task formula:
 *   uncertainty = max(0, required − current)
 *   risk       = payoutAtRisk × uncertainty / 10_000
 *   cap        = risk × shareBps / 10_000
 *   maxSpend   = min(cap, remainingBudget, maxPerCheck)
 *
 * Fixture anchor: 20 USDC at risk, confidence 6200→8000, budget 0.10 USDC,
 * max/check 0.01 USDC, price 0.002 USDC (2000 micro) → BUY.
 */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const M = 1_000_000n;
const DAY = 86_400_000;
const BASE = {
  payoutAtRiskMicroUsdc: 20n * M,
  currentConfidenceBps: 6200,
  requiredConfidenceBps: 8000,
  providerPriceMicroUsdc: 2_000n,
  remainingVerificationBudgetMicroUsdc: 100_000n,
  maxPerCheckMicroUsdc: 10_000n,
  maxEvidenceCostShareBps: 200,
  humanApprovalThresholdMicroUsdc: null as bigint | null,
};

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" }],
    partners: [{ id: "p-1", userId: "creator-1", payoutWallet: "0xeBB55165381500D6886d2eEea2325d86275173", rulesJson: {} }],
  });
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

function tenv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env, NODE_ENV: "test" };
}

describe("value-of-information kernel", () => {
  it("1. already-confident exposure needs no check", () => {
    const r = evaluateValueOfInformation({ ...BASE, currentConfidenceBps: 8000 });
    expect(r.decision).toBe("NOT_NEEDED");
    expect(r.uncertaintyBps).toBe(0);
    expect(r.maxJustifiableSpendMicroUsdc).toBe(0n);
  });

  it("2. tiny price + high risk → BUY with stated ceiling", () => {
    const r = evaluateValueOfInformation(BASE);
    expect(r.decision).toBe("BUY");
    expect(r.uncertaintyBps).toBe(1800);
    // risk = 20M × 1800/10000 = 3.6M; cap = 3.6M × 200/10000 = 72,000.
    expect(r.riskExposureMicroUsdc).toBe(3_600_000n);
    expect(r.economicEvidenceCapMicroUsdc).toBe(72_000n);
    // max(72k cap, 100k budget, 10k per-check) → 10k ceiling.
    expect(r.maxJustifiableSpendMicroUsdc).toBe(10_000n);
    expect(r.reasons.join(" ")).toMatch(/below the 10000 micro-USDC value-of-information ceiling/);
  });

  it("3. price above remaining budget → REFUSED", () => {
    const r = evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: 200_000n });
    expect(r.decision).toBe("REFUSED");
    expect(r.reasons[0]).toBe("OVER_BUDGET");
  });

  it("4. price above max per check → REFUSED", () => {
    const r = evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: 50_000n });
    expect(r.decision).toBe("REFUSED");
    expect(r.reasons[0]).toBe("OVER_PER_CHECK_LIMIT");
  });

  it("5. price above economic value ceiling → REFUSED, or REVIEW with a human threshold", () => {
    // Raise the other ceilings so only the value ceiling binds: 80k > 72k.
    const base = { ...BASE, maxPerCheckMicroUsdc: 1_000_000n, remainingVerificationBudgetMicroUsdc: 1_000_000n };
    const refused = evaluateValueOfInformation({ ...base, providerPriceMicroUsdc: 80_000n });
    expect(refused.decision).toBe("REFUSED");
    expect(refused.reasons[0]).toBe("OVER_VALUE_CEILING");
    // Same economics with a human-approval threshold → REVIEW for a human.
    const review = evaluateValueOfInformation({
      ...base, providerPriceMicroUsdc: 80_000n, humanApprovalThresholdMicroUsdc: 50_000n,
    });
    expect(review.decision).toBe("REVIEW");
  });

  it("6. exact ceiling boundary is deterministic (equal buys, plus-one refuses)", () => {
    expect(evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: 10_000n }).decision).toBe("BUY");
    expect(evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: 10_001n }).decision).toBe("REFUSED");
  });

  it("7. bigint exactness — a 1-micro dust shortfall still counts", () => {
    const ceiling = evaluateValueOfInformation(BASE).maxJustifiableSpendMicroUsdc;
    expect(evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: ceiling - 1n }).decision).toBe("BUY");
    expect(evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: ceiling }).decision).toBe("BUY");
    expect(evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: ceiling + 1n }).decision).toBe("REFUSED");
  });

  it("8. zero/negative/invalid inputs fail closed", () => {
    // Zero price is a refused quote, not a crash.
    const zero = evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: 0n });
    expect(zero.decision).toBe("REFUSED");
    expect(zero.reasons[0]).toBe("BAD_QUOTE");
    // Negative and out-of-range inputs throw.
    expect(() => evaluateValueOfInformation({ ...BASE, providerPriceMicroUsdc: -1n })).toThrow();
    expect(() => evaluateValueOfInformation({ ...BASE, currentConfidenceBps: 10_001 })).toThrow();
    expect(() => evaluateValueOfInformation({ ...BASE, requiredConfidenceBps: -1 })).toThrow();
    expect(() => evaluateValueOfInformation({ ...BASE, maxEvidenceCostShareBps: 10_001 })).toThrow();
  });

  it("idempotency keys are stable per fingerprint and UUID-shaped", () => {
    const a = stableIdempotencyKey("prov|url|CHECK|ws|c|o|100|asset|net|pay|v1");
    const b = stableIdempotencyKey("prov|url|CHECK|ws|c|o|100|asset|net|pay|v1");
    const c = stableIdempotencyKey("prov|url|CHECK|ws|c|o|101|asset|net|pay|v1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("value-of-information gate in orchestration", () => {
  async function flaggedFixture() {
    const { store, sink, events } = setup();
    await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
    await store.insertMarket({
      campaignId: "c-1", publicBountyMicroUsdc: 4n * M, status: "OPEN",
      destinationUrl: "https://acme.example/offer", version: 1, policyVersion: 1,
    });
    await store.insertVersion({
      id: "v-1", campaignId: "c-1", version: 1, intentText: "x", status: "APPROVED",
      targetOutcomeCount: 10, budgetMicroUsdc: 200n * M,
      bountyFloorMicroUsdc: 1n * M, bountyCeilingMicroUsdc: 8n * M,
      minQualifyingPurchaseMicroUsdc: 1n * M, deadline: new Date(NOW.getTime() + 30 * DAY),
      marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3600, escalationRulesJson: {},
    });
    await store.insertFunding({
      id: "f-1", campaignId: "c-1", policyVersionId: "v-1", policyVersion: 1,
      campaignKey: "0xk", policyHash: "0xh", chainId: 1, vaultAddress: "0xv",
      usdcAddress: "0xu", ownerAddress: "0xo", expectedAmountMicroUsdc: 200n * M,
    });
    await store.updateFunding("c-1", 1, { status: "CONFIRMED", observedAmountMicroUsdc: 200n * M });
    await store.insertTerms({
      id: "t-1", campaignId: "c-1", partnerId: "p-1", priceMicroUsdc: 4n * M,
      allocationCount: 10, source: "PUBLIC", expiresAt: new Date(NOW.getTime() + 30 * DAY),
      policyVersion: 1, marketVersion: 1,
    });
    const o1 = "o-1";
    await store.insertOutcome({
      id: o1, campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
      checkoutIntentId: "ci-o-1", customerKeyHash: "ck-o-1", purchaseTx: "0xt1",
      purchaseAmountMicroUsdc: 10n * M,
    });
    await store.updateOutcome(o1, { status: "VERIFIED", verifiedAt: new Date(NOW.getTime() - 20 * DAY) });
    await store.insertReservation({
      id: "r-o-1", campaignId: "c-1", outcomeId: o1, partnerId: "p-1",
      partnerTermsId: "t-1", amountMicroUsdc: 4n * M, policyVersionId: "v-1",
    });
    // Review-grade anomaly → EXTERNAL_CHECK_CANDIDATE readiness.
    await store.insertOutcome({
      id: "o-r1", campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
      checkoutIntentId: "ci-r1", customerKeyHash: "ck-r1", purchaseTx: "0xr1",
      purchaseAmountMicroUsdc: 10n * M,
    });
    await store.updateOutcome("o-r1", { status: "REJECTED", rejectionCode: "DUPLICATE_TX" });
    await store.setProcurementPolicy({
      workspaceId: "ws-A", enabled: true,
      maxCostPerCheckMicroUsdc: 2n * M, maxSpendPerPeriodMicroUsdc: 10n * M,
      periodDays: 365, maxCostBpsOfExposure: 200,
      allowedProvidersJson: ["local-test"], allowedCheckTypesJson: ["PAYMENT_REFERENCE_CHECK"],
      humanApprovalThresholdMicroUsdc: null, updatedByUserId: null,
    });
    const key = generatePrivateKey();
    return { store, sink, events, env: tenv({ THESMA_PROCUREMENT_PRIVATE_KEY: key }) };
  }

  it("already-confident confidence skips purchase entirely (NOT_NEEDED)", async () => {
    const { store, sink } = await flaggedFixture();
    const res = createLocalTestResource({ env: { ...process.env, NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv });
    const out = await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: { ...process.env, NODE_ENV: "test", THESMA_PROCUREMENT_PRIVATE_KEY: generatePrivateKey() }, fetchImpl: res.handler },
      {
        workspaceId: "ws-A", campaignId: "c-1",
        confidenceBps: { current: 9000, required: 8000 },
      },
    );
    expect(out.decision.decision).toBe("NO_CHECK");
    expect(out.decision.reasons[0]).toBe("ALREADY_CONFIDENT");
    expect(out.execution.signed).toBe(false);
    expect(out.execution.purchased).toBe(false);
    expect(await store.listProcurementsByCampaign("c-1")).toHaveLength(0);
  });

  it("uneconomic confidence-gated check refuses without signing (local-test quote)", async () => {
    const { store, sink } = await flaggedFixture();
    const key = generatePrivateKey();
    const res = createLocalTestResource({ env: tenv({ THESMA_PROCUREMENT_PRIVATE_KEY: key }) });
    const out = await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: tenv({ THESMA_PROCUREMENT_PRIVATE_KEY: key }), fetchImpl: res.handler },
      {
        workspaceId: "ws-A", campaignId: "c-1",
        confidenceBps: { current: 6200, required: 8000 },
      },
    );
    // Local-test quote 80,000 vs VoI ceiling min(4M×0.18×0.02=14,400, …) → REFUSE.
    expect(out.decision.decision).toBe("REFUSE");
    expect(out.execution.signed).toBe(false);
    expect(out.execution.purchased).toBe(false);
    const rows = await store.listProcurementsByCampaign("c-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("REFUSED");
  });

  it("absent confidence defers to the legacy engine (back-compat)", async () => {
    const { store, sink } = await flaggedFixture();
    const key = generatePrivateKey();
    const res = createLocalTestResource({ env: tenv({ THESMA_PROCUREMENT_PRIVATE_KEY: key }) });
    const out = await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: tenv({ THESMA_PROCUREMENT_PRIVATE_KEY: key }), fetchImpl: res.handler },
      { workspaceId: "ws-A", campaignId: "c-1" },
    );
    // Same economics the VoI gate would refuse — but without confidence
    // inputs the legacy policy engine decides alone.
    expect(out.decision.decision).toBe("BUY_CHECK");
    expect(out.execution.purchased).toBe(true);
  });
});
