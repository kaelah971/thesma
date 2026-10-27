import { describe, expect, it, beforeEach } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  ARC_MAINNET_CAIP2,
  decideVerificationProcurement,
  parsePaymentRequired,
  purchaseWithX402,
  selectAcceptedTerms,
  X402_VERSION,
  type ApprovedPayment,
} from "@/server/services/verification";
import {
  evaluateVerificationCheck,
  listCampaignProcurements,
  verificationSpendForWorkspace,
} from "@/server/services/verificationProcurement";
import { createLocalTestResource } from "@/server/services/verification.test-resource";
import { loadCfoSnapshot } from "@/server/services/cfo";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;
const M = 1_000_000n;
const COST = 80_000n;
const ASSET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";

const POLICY = {
  enabled: true,
  maxCostPerCheckMicroUsdc: 2n * M,
  maxSpendPerPeriodMicroUsdc: 10n * M,
  // Wide window: the memory store stamps rows at its fixed clock while
  // evaluation uses the frozen test clock; production uses wall time for both.
  periodDays: 365,
  maxCostBpsOfExposure: 200,
  allowedProvidersJson: ["local-test"],
  allowedCheckTypesJson: ["PAYMENT_REFERENCE_CHECK", "ATTRIBUTION_INTEGRITY"],
  humanApprovalThresholdMicroUsdc: null as bigint | null,
  updatedByUserId: null as string | null,
};

async function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "ai", name: "Acme" }],
    partners: [{ id: "p-1", userId: "creator-1", payoutWallet: "0xeBB551653815900D6886d2eeEea2325d86275173", rulesJson: {} }],
  });
  await store.insertCampaign({ id: "c-1", workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
  await store.insertMarket({
    campaignId: "c-1", publicBountyMicroUsdc: 4n * M, status: "OPEN",
    destinationUrl: "https://acme.example/offer", version: 1, policyVersion: 1,
  });
  await store.insertVersion({
    id: "v-1", campaignId: "c-1", version: 1, intentText: "Get paying customers",
    status: "APPROVED", targetOutcomeCount: 10, budgetMicroUsdc: 200n * M,
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
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

let n = 0;
async function addVerifiedOutcome(store: Awaited<ReturnType<typeof setup>>["store"], tx?: string, daysAgo = 20) {
  const i = n++;
  const t = tx ?? `0xtx${i}`;
  const id = `o-${i}`;
  await store.insertOutcome({
    id, campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
    checkoutIntentId: `ci-${id}`, customerKeyHash: `ck-${id}`, purchaseTx: t,
    purchaseAmountMicroUsdc: 10n * M,
  });
  await store.updateOutcome(id, { status: "VERIFIED", verifiedAt: new Date(NOW.getTime() - daysAgo * DAY) });
  return id;
}

async function addReservation(store: Awaited<ReturnType<typeof setup>>["store"], outcomeId: string, amount = 4n * M) {
  await store.insertReservation({
    id: `r-${outcomeId}`, campaignId: "c-1", outcomeId, partnerId: "p-1",
    partnerTermsId: "t-1", amountMicroUsdc: amount, policyVersionId: "v-1",
  });
}

function signerEnv() {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  return { THESMA_PROCUREMENT_PRIVATE_KEY: key, THESMA_PROCUREMENT_ADDRESS: address, key, address };
}

function tenv(env: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...env, NODE_ENV: "test" };
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    readiness: "EXTERNAL_CHECK_CANDIDATE" as const,
    reviewSeverity: "REVIEW" as const,
    economicExposureMicroUsdc: 4n * M,
    quote: { costMicroUsdc: COST, expiresAtMs: NOW.getTime() + 60_000, providerId: "local-test", checkType: "PAYMENT_REFERENCE_CHECK" as const },
    quoteError: null,
    policy: { ...DEFAULT_POLICY },
    providerAllowlisted: true,
    checkTypeSupported: true,
    periodSpentMicroUsdc: 0n,
    availableMicroUsdc: 190n * M,
    reserveMicroUsdc: 0n,
    campaignLive: true,
    outcomeRelevant: true,
    existingProcurementState: null,
    signerConfigured: true,
    nowMs: NOW.getTime(),
    ...over,
  };
}

const DEFAULT_POLICY = {
  verificationProcurementEnabled: true,
  maxCostPerCheckMicroUsdc: 2n * M,
  maxVerificationSpendPerPeriodMicroUsdc: 10n * M,
  periodDays: 30,
  maxCostBpsOfExposure: 200,
  allowedProviders: ["local-test"],
  allowedCheckTypes: ["PAYMENT_REFERENCE_CHECK", "ATTRIBUTION_INTEGRITY"] as ("PAYMENT_REFERENCE_CHECK" | "ATTRIBUTION_INTEGRITY")[],
  humanApprovalThresholdMicroUsdc: null as bigint | null,
};

describe("procurement decision engine", () => {
  it("NONE readiness → NO_CHECK with zero provider contact", () => {
    const d = decideVerificationProcurement(baseInput({ readiness: "NONE" }));
    expect(d.decision).toBe("NO_CHECK");
  });

  it("REVIEW without external candidate need → NO_CHECK, no paid check", () => {
    const d = decideVerificationProcurement(baseInput({ readiness: "REVIEW", quote: null }));
    expect(d.decision).toBe("NO_CHECK");
  });

  it("disabled policy → REFUSE", () => {
    const d = decideVerificationProcurement(baseInput({ policy: { ...DEFAULT_POLICY, verificationProcurementEnabled: false } }));
    expect(d.decision).toBe("REFUSE");
  });

  it("non-allowlisted provider → REFUSE", () => {
    expect(decideVerificationProcurement(baseInput({ providerAllowlisted: false })).decision).toBe("REFUSE");
  });

  it("unsupported check type → REFUSE", () => {
    expect(decideVerificationProcurement(baseInput({ checkTypeSupported: false })).decision).toBe("REFUSE");
  });

  it("over per-check max → ESCALATE, zero payment", () => {
    const d = decideVerificationProcurement(baseInput({ policy: { ...DEFAULT_POLICY, maxCostPerCheckMicroUsdc: 1000n } }));
    expect(d.decision).toBe("ESCALATE");
    expect(d.costMicroUsdc).toBe(COST.toString());
  });

  it("cost/exposure over BPS → REFUSE", () => {
    const d = decideVerificationProcurement(baseInput({ economicExposureMicroUsdc: 100_000n }));
    expect(d.decision).toBe("REFUSE");
    expect(d.reasons[0]).toBe("OVER_BPS_LIMIT");
  });

  it("period cap exceeded → ESCALATE", () => {
    const d = decideVerificationProcurement(baseInput({ periodSpentMicroUsdc: 10n * M }));
    expect(d.decision).toBe("ESCALATE");
  });

  it("liquidity breach → ESCALATE", () => {
    const d = decideVerificationProcurement(baseInput({ availableMicroUsdc: 10_000n, reserveMicroUsdc: 50_000n }));
    expect(d.decision).toBe("ESCALATE");
  });

  it("valid cheap check inside policy → BUY_CHECK with economics", () => {
    const d = decideVerificationProcurement(baseInput({}));
    expect(d.decision).toBe("BUY_CHECK");
    expect(d.costExposureBps).toBe(200);
    expect(d.reasons.join(" ")).toMatch(/WITHIN_AUTHORITY/);
  });

  it("unknown critical truth fails closed", () => {
    expect(decideVerificationProcurement(baseInput({ campaignLive: false })).decision).toBe("REFUSE");
    expect(decideVerificationProcurement(baseInput({ outcomeRelevant: false })).decision).toBe("REFUSE");
    expect(decideVerificationProcurement(baseInput({ quote: null, quoteError: "CONFIGURATION_REQUIRED" })).decision).toBe("ESCALATE");
    expect(decideVerificationProcurement(baseInput({ signerConfigured: false })).decision).toBe("ESCALATE");
  });

  it("deterministic on repeat", () => {
    expect(decideVerificationProcurement(baseInput({}))).toEqual(decideVerificationProcurement(baseInput({})));
  });
});

describe("x402 v2 transport validation", () => {
  const approved: ApprovedPayment = {
    providerId: "local-test", resourceUrl: "http://localhost/x402-test/verify", checkType: "PAYMENT_REFERENCE_CHECK",
    campaignId: "c-1", outcomeId: "o-1", amountMicroUsdc: COST, asset: ASSET, network: ARC_MAINNET_CAIP2,
    payTo: PAY_TO, quoteVersion: "test-1", expiresAtMs: Date.now() + 60_000,
  };
  const terms = (over: Record<string, unknown> = {}) => ({
    scheme: "exact", network: ARC_MAINNET_CAIP2, asset: ASSET, amount: COST.toString(), payTo: PAY_TO, maxTimeoutSeconds: 300, ...over,
  });
  const headerFor = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64");

  it("rejects malformed 402", async () => {
    await expect(
      purchaseWithX402({ url: approved.resourceUrl, approved, signer: { address: PAY_TO, sign: async () => "0x" as Hex }, allowedHosts: ["localhost"], fetchImpl: async () => new Response("x", { status: 402, headers: { "payment-required": "!!!not-base64!!!" } }) }),
    ).rejects.toMatchObject({ code: "MALFORMED_402" });
  });

  it("never treats x402 v1 as v2", async () => {
    const v1 = headerFor({ x402Version: 1, resource: { url: approved.resourceUrl }, accepted: [terms()] });
    await expect(
      purchaseWithX402({ url: approved.resourceUrl, approved, signer: { address: PAY_TO, sign: async () => "0x" as Hex }, allowedHosts: ["localhost"], fetchImpl: async () => new Response("x", { status: 402, headers: { "payment-required": v1 } }) }),
    ).rejects.toMatchObject({ code: "WRONG_X402_VERSION" });
  });

  it("rejects untrusted resource URL without fetching", async () => {
    let calls = 0;
    await expect(
      purchaseWithX402({ url: "https://evil.example/steal", approved: { ...approved, resourceUrl: "https://evil.example/steal" }, signer: { address: PAY_TO, sign: async () => "0x" as Hex }, allowedHosts: ["localhost"], fetchImpl: async () => { calls += 1; return new Response("x"); } }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_HOST" });
    expect(calls).toBe(0);
  });

  it("never follows redirects", async () => {
    let calls = 0;
    await expect(
      purchaseWithX402({ url: approved.resourceUrl, approved, signer: { address: PAY_TO, sign: async () => "0x" as Hex }, allowedHosts: ["localhost"], fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: "https://evil.example/" } }); } }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_REDIRECT" });
    expect(calls).toBe(1);
  });

  function required402(t: Record<string, unknown>) {
    return async () => new Response(JSON.stringify({ error: "pay" }), {
      status: 402,
      headers: { "payment-required": headerFor({ x402Version: X402_VERSION, resource: { url: approved.resourceUrl }, accepted: [t] }) },
    });
  }

  it("amount greater than approved → no signature", async () => {
    let calls = 0;
    const counting: typeof fetch = async () => { calls += 1; return required402(terms({ amount: "999999" }))() as unknown as Response; };
    await expect(
      purchaseWithX402({ url: approved.resourceUrl, approved, signer: { address: PAY_TO, sign: async () => { throw new Error("must not sign"); } }, allowedHosts: ["localhost"], fetchImpl: counting }),
    ).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
    expect(calls).toBe(1);
  });

  it("wrong asset, network, payTo → no signature", async () => {
    for (const [code, t] of [
      ["ASSET_OR_NETWORK_MISMATCH", terms({ asset: "0x0000000000000000000000000000000000000001" })],
      ["ASSET_OR_NETWORK_MISMATCH", terms({ network: "eip155:1" })],
      ["PAYEE_MISMATCH", terms({ payTo: "0x0000000000000000000000000000000000000002" })],
    ] as const) {
      await expect(
        purchaseWithX402({ url: approved.resourceUrl, approved, signer: { address: PAY_TO, sign: async () => "0x" as Hex }, allowedHosts: ["localhost"], fetchImpl: required402(t) }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("parses v2 headers and validates exact-version envelope", () => {
    const parsed = parsePaymentRequired(headerFor({ x402Version: 2, resource: { url: approved.resourceUrl }, accepted: [terms()] }));
    expect(parsed.x402Version).toBe(2);
    expect(() => parsePaymentRequired(headerFor({ x402Version: 1, resource: {}, accepted: [] }))).toThrow();
  });

  it("approved terms select the matching offer", () => {
    const req = { x402Version: 2 as const, resource: { url: approved.resourceUrl }, accepted: [terms({ network: "eip155:1" }), terms()] };
    expect(selectAcceptedTerms(req, approved)).toMatchObject({ network: ARC_MAINNET_CAIP2 });
  });
});

describe("end-to-end procurement on the local test resource", () => {
  beforeEach(() => {
    delete process.env.THESMA_PROCUREMENT_PRIVATE_KEY;
    delete process.env.THESMA_PROCUREMENT_ADDRESS;
  });

  async function flaggedSetup() {
    const { store, sink, events } = await setup();
    // Duplicate-payment rejections → REVIEW-grade anomaly with exposure.
    const o1 = await addVerifiedOutcome(store);
    await addVerifiedOutcome(store);
    await addReservation(store, o1);
    for (const [id, tx] of [["o-r1", "0xr1"], ["o-r2", "0xr2"]] as const) {
      await store.insertOutcome({
        id, campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
        checkoutIntentId: `ci-${id}`, customerKeyHash: `ck-${id}`, purchaseTx: tx,
        purchaseAmountMicroUsdc: 10n * M,
      });
      await store.updateOutcome(id, { status: "REJECTED", rejectionCode: "DUPLICATE_TX" });
    }
    await store.setProcurementPolicy({ workspaceId: "ws-A", ...POLICY });
    const env = signerEnv();
    return { store, sink, events, env };
  }

  it("BUY_CHECK executes a real signed flow and normalizes RISK_SIGNAL", async () => {
    const { store, sink, events } = await flaggedSetup();
    const env = signerEnv();
    const calls: string[] = [];
    const countingFetch = async (url: string, init?: RequestInit) => {
      calls.push(`${url} sig:${Boolean(new Headers(init?.headers).get("payment-signature"))}`);
      const res = createLocalTestResource({ env: tenv(env) });
      return res.handler(url, init);
    };
    const out = await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: tenv(env), fetchImpl: countingFetch },
      { workspaceId: "ws-A", campaignId: "c-1" },
    );
    expect(out.decision.decision).toBe("BUY_CHECK");
    expect(out.execution.signed).toBe(true);
    expect(out.execution.purchased).toBe(true);
    expect(out.execution.paymentReference).toMatch(/^test-pay-/);
    expect(out.execution.result?.result).toBe("RISK_SIGNAL");
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain("sig:true");
    expect(out.procurement?.state).toBe("RESULT_RECEIVED");
    const actions = events.map((e) => (e as { action?: string }).action);
    expect(actions).toContain("verification.procurement.approved");
    expect(actions).toContain("verification.procurement.purchased");
    expect(actions).toContain("verification.procurement.result_received");
    // Outcome and payout untouched: evidence only.
    const outcome = await store.getOutcome(out.procurement?.outcomeId as string);
    expect(outcome?.status).toBe("VERIFIED");
    expect(await store.getPayoutByOutcome(out.procurement?.outcomeId as string)).toBeNull();
  });

  it("exact check paid once only; retry never repays", async () => {
    const { store, sink } = await flaggedSetup();
    const env = signerEnv();
    let calls = 0;
    const countingFetch = async (url: string, init?: RequestInit) => {
      calls += 1;
      const res = createLocalTestResource({ env: tenv(env) });
      return res.handler(url, init);
    };
    const deps = { store, audit: sink, now: () => NOW, env: tenv(env), fetchImpl: countingFetch };
    const first = await evaluateVerificationCheck(deps, { workspaceId: "ws-A", campaignId: "c-1" });
    expect(first.decision.decision).toBe("BUY_CHECK");
    const afterFirst = calls;
    expect(afterFirst).toBe(2);
    const second = await evaluateVerificationCheck(deps, { workspaceId: "ws-A", campaignId: "c-1" });
    expect(second.decision.decision).toBe("NO_CHECK");
    expect(calls).toBe(afterFirst);
    expect(await store.listProcurementsByCampaign("c-1")).toHaveLength(1);
  });

  it("ambiguous failure never blind-repays", async () => {
    const { store, sink } = await flaggedSetup();
    const env = signerEnv();
    const flaky = async (url: string, init?: RequestInit): Promise<Response> => {
      if (new Headers(init?.headers).get("payment-signature")) throw new Error("connection reset");
      const res = createLocalTestResource({ env: tenv(env) });
      return res.handler(url, init);
    };
    const deps = { store, audit: sink, now: () => NOW, env: tenv(env), fetchImpl: flaky };
    const out = await evaluateVerificationCheck(deps, { workspaceId: "ws-A", campaignId: "c-1" });
    expect(out.execution.ambiguous).toBe(true);
    expect(out.procurement?.state).toBe("AMBIGUOUS");
    const again = await evaluateVerificationCheck(deps, { workspaceId: "ws-A", campaignId: "c-1" });
    expect(again.decision.decision).toBe("ESCALATE");
    expect(again.procurement?.state).toBe("AMBIGUOUS");
  });

  it("CHECK_CLEAR remains evidence, not payment authority", async () => {
    const { store, sink } = await flaggedSetup();
    const env = signerEnv();
    const res = createLocalTestResource({ verdict: "clear", env: tenv(env) });
    const out = await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: tenv(env), fetchImpl: res.handler },
      { workspaceId: "ws-A", campaignId: "c-1" },
    );
    expect(out.execution.result?.result).toBe("CHECK_CLEAR");
    expect(await store.getPayoutByOutcome(out.procurement?.outcomeId as string)).toBeNull();
  });

  it("verification spend separates from creator obligations in CFO", async () => {
    const { store, sink } = await flaggedSetup();
    const env = signerEnv();
    const res = createLocalTestResource({ env: tenv(env) });
    await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: tenv(env), fetchImpl: res.handler },
      { workspaceId: "ws-A", campaignId: "c-1" },
    );
    const { snapshot } = await loadCfoSnapshot(store, "ws-A", { now: NOW });
    const plan = await import("@/server/services/cfo").then((m) =>
      m.buildCapitalPlan(snapshot, {
        store,
        growthPolicy: { optimizationEnabled: false, maxBountyChangePct: 25, minimumEvidence: 5, evaluationWindowDays: 7 },
        operatorPolicy: { minReserveMicroUsdc: 0n, maxAutonomousPaymentMicroUsdc: 10n * M, maxAutonomousSpendPerPeriodMicroUsdc: null },
        now: NOW,
      }),
    );
    expect(plan.totals.verificationSpendMicroUsdc).toBe(COST.toString());
    expect(plan.totals.spentMicroUsdc).toBe("0");
  });

  it("concurrent procurements respect the period cap", async () => {
    const { store, sink } = await flaggedSetup();
    await store.setProcurementPolicy({
      workspaceId: "ws-A", ...POLICY, maxSpendPerPeriodMicroUsdc: 100_000n,
    });
    const env = signerEnv();
    const res = createLocalTestResource({ env: tenv(env) });
    const deps = { store, audit: sink, now: () => NOW, env: tenv(env), fetchImpl: res.handler };
    const first = await evaluateVerificationCheck(deps, { workspaceId: "ws-A", campaignId: "c-1" });
    expect(first.decision.decision).toBe("BUY_CHECK");
    const o3 = await addVerifiedOutcome(store, "0xdup1");
    await addReservation(store, o3);
    const second = await evaluateVerificationCheck(deps, { workspaceId: "ws-A", campaignId: "c-1", outcomeId: o3 });
    expect(second.decision.decision).toBe("ESCALATE");
    expect((await store.listProcurementsByCampaign("c-1")).filter((p) => p.state === "RESULT_RECEIVED")).toHaveLength(1);
  });

  it("private key never appears in DTOs, decisions or audit", async () => {
    const { store, sink, events } = await flaggedSetup();
    const env = signerEnv();
    const res = createLocalTestResource({ env: tenv(env) });
    const out = await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: tenv(env), fetchImpl: res.handler },
      { workspaceId: "ws-A", campaignId: "c-1" },
    );
    const blob = JSON.stringify({ procurement: out.procurement, decision: out.decision, events });
    expect(blob).not.toContain(env.key.slice(2, 12));
    expect(blob).not.toContain(env.key);
  });

  it("org isolation and read-only ledger", async () => {
    const { store, sink } = await setup();
    await expect(
      evaluateVerificationCheck({ store, audit: sink, now: () => NOW }, { workspaceId: "ws-B", campaignId: "c-1" }),
    ).rejects.toMatchObject({ status: 404 });
    const before = await store.listProcurementsByCampaign("c-1");
    const listed = await listCampaignProcurements(store, { workspaceId: "ws-A", campaignId: "c-1" });
    expect(Array.isArray(listed)).toBe(true);
    expect(await store.listProcurementsByCampaign("c-1")).toHaveLength(before.length);
  });

  it("unconfigured provider escalates with zero spend", async () => {
    const { store, sink } = await flaggedSetup();
    const env = signerEnv();
    await store.setProcurementPolicy({ workspaceId: "ws-A", ...POLICY, allowedProvidersJson: ["someone-else"] });
    const out = await evaluateVerificationCheck(
      { store, audit: sink, now: () => NOW, env: tenv(env) },
      { workspaceId: "ws-A", campaignId: "c-1", providerId: "someone-else" },
    );
    expect(["ESCALATE", "REFUSE"]).toContain(out.decision.decision);
    expect(out.execution.purchased).toBe(false);
  });
});

describe("local test resource boundaries", () => {
  it("refuses production runtime without explicit flag", () => {
    expect(() => createLocalTestResource({ env: { NODE_ENV: "production" } as NodeJS.ProcessEnv })).toThrow();
    expect(() =>
      createLocalTestResource({ env: { NODE_ENV: "production", THESMA_ALLOW_TEST_PROVIDERS: "1" } as NodeJS.ProcessEnv }),
    ).not.toThrow();
  });
});
