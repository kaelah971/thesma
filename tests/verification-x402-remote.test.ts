import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import {
  ARC_TESTNET_CAIP2,
  ARC_TESTNET_USDC,
  parsePaymentRequired,
  selectAcceptedTerms,
  purchaseWithX402,
  type ApprovedPayment,
} from "@/server/services/verification";
import { evaluateVerificationCheck } from "@/server/services/verificationProcurement";
import { createLocalTestResource } from "@/server/services/verification.test-resource";

/**
 * REMOTE x402 (Arc Testnet) — challenge parsing, term validation, and the
 * guarded purchase path. The 402 wire shape below mirrors the live
 * AuraGate challenge observed 2026-11-01 (note `accepts`, NOT `accepted`,
 * and a path-only resource): the parser must handle the real world.
 *
 * All network is mocked fetch; no payment, no chain, no secrets.
 */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const M = 1_000_000n;
const DAY = 86_400_000;

const PROVIDER_URL = "https://auragate.app/api/premium/github-repo?repo=kaelah971/thesma";
const PROVIDER_ID = "auragate-github";
const PAY_TO = "0xB52D1D41DAf8c87c8709bc79be41C4c424aD36F1";

const AURA_ACCEPTS = [
  {
    scheme: "exact",
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    amount: "2000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 604900,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7eba4688bdfe311b846f25870a19b9",
    },
  },
];

function headerFor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `THREW:${(e as Error).message}`;
  }
  return "NO_THROW";
}

function challenge402(accepts: unknown, resourceUrl = "/api/premium/github-repo"): Response {
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": headerFor({ x402Version: 2, resource: { url: resourceUrl }, accepts }) },
  });
}

function approved(over: Record<string, unknown> = {}): ApprovedPayment {
  return {
    providerId: PROVIDER_ID,
    resourceUrl: PROVIDER_URL,
    checkType: "OUTCOME_ENRICHMENT",
    campaignId: "c-1",
    outcomeId: "o-1",
    amountMicroUsdc: 2000n,
    asset: ARC_TESTNET_USDC,
    network: ARC_TESTNET_CAIP2,
    payTo: PAY_TO,
    quoteVersion: "v1",
    expiresAtMs: NOW.getTime() + 60_000,
    ...over,
  } as ApprovedPayment;
}

function remoteEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    THESMA_EXTERNAL_VERIFICATION_ENABLED: "true",
    THESMA_EXTERNAL_VERIFICATION_PROVIDER_URL: PROVIDER_URL,
    THESMA_EXTERNAL_VERIFICATION_PROVIDER_ID: PROVIDER_ID,
    THESMA_EXTERNAL_VERIFICATION_NETWORK: "eip155:5042002",
    THESMA_EXTERNAL_VERIFICATION_MAX_PER_CHECK_MICRO: "10000",
    THESMA_EXTERNAL_VERIFICATION_BUDGET_MICRO: "100000",
    THESMA_EXTERNAL_VERIFICATION_MAX_TIMEOUT_SEC: "691200",
    ...extra,
  };
}

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" }],
    partners: [{ id: "p-1", userId: "creator-1", payoutWallet: "0xeBB55165381500D6886d2eEea2325d86275173", rulesJson: {} }],
  });
  const { sink, events } = createMemoryAuditSink();
  return { store, sink, events };
}

async function liveFixture() {
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
    id: "t-1", campaignId: "c-1", partnerId: "p-1", priceMicroUsdc: 20n * M,
    allocationCount: 10, source: "PUBLIC", expiresAt: new Date(NOW.getTime() + 30 * DAY),
    policyVersion: 1, marketVersion: 1,
  });
  await store.insertOutcome({
    id: "o-1", campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
    checkoutIntentId: "ci-o-1", customerKeyHash: "ck-o-1", purchaseTx: "0xt1",
    purchaseAmountMicroUsdc: 20n * M,
  });
  await store.updateOutcome("o-1", { status: "VERIFIED", verifiedAt: new Date(NOW.getTime() - 20 * DAY) });
  await store.insertReservation({
    id: "r-o-1", campaignId: "c-1", outcomeId: "o-1", partnerId: "p-1",
    partnerTermsId: "t-1", amountMicroUsdc: 20n * M, policyVersionId: "v-1",
  });
  // Review-grade anomaly signal → EXTERNAL_CHECK_CANDIDATE readiness.
  for (const [id, tx] of [["o-r1", "0xr1"], ["o-r2", "0xr2"]] as const) {
    await store.insertOutcome({
      id, campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
      checkoutIntentId: `ci-${id}`, customerKeyHash: `ck-${id}`, purchaseTx: tx,
      purchaseAmountMicroUsdc: 10n * M,
    });
    await store.updateOutcome(id, { status: "REJECTED", rejectionCode: "DUPLICATE_TX" });
  }
  await store.setProcurementPolicy({
    workspaceId: "ws-A", enabled: true,
    maxCostPerCheckMicroUsdc: 2n * M, maxSpendPerPeriodMicroUsdc: 10n * M,
    periodDays: 365, maxCostBpsOfExposure: 200,
    allowedProvidersJson: [PROVIDER_ID], allowedCheckTypesJson: ["OUTCOME_ENRICHMENT"],
    humanApprovalThresholdMicroUsdc: null, updatedByUserId: null,
  });
  return { store, sink, events };
}

const REPO_JSON = {
  full_name: "kaelah971/thesma",
  stargazers_count: 7,
  language: "TypeScript",
  updated_at: "2026-11-01T00:00:00Z",
};

function mockProviderFetch(calls: string[]) {
  return async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const signed = Boolean(headers.get("payment-signature"));
    calls.push(`${url} sig:${signed}`);
    if (!signed) return challenge402(AURA_ACCEPTS);
    return new Response(JSON.stringify(REPO_JSON), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "payment-response": headerFor({ reference: "auragate-rcpt-1" }),
      },
    });
  };
}

describe("live 402 challenge parsing", () => {
  it("9. first request can receive a valid 402 (accepts shape)", () => {
    const parsed = parsePaymentRequired(headerFor({ x402Version: 2, resource: { url: "/api/x" }, accepts: AURA_ACCEPTS }));
    expect(parsed.x402Version).toBe(2);
    expect(parsed.accepted).toHaveLength(1);
    expect(parsed.accepted[0].network).toBe("eip155:5042002");
  });

  it("legacy accepted shape still parses", () => {
    const parsed = parsePaymentRequired(
      headerFor({ x402Version: 2, resource: { url: "http://localhost/x" }, accepted: [{ ...AURA_ACCEPTS[0], maxTimeoutSeconds: 60 }] }),
    );
    expect(parsed.accepted).toHaveLength(1);
  });

  it("10/11. network must be eip155:5042002 and asset canonical testnet USDC", () => {
    const terms = selectAcceptedTerms(
      { x402Version: 2, resource: { url: PROVIDER_URL }, accepted: AURA_ACCEPTS as never },
      approved(),
      NOW.getTime(),
      { timeoutCapSec: 1_000_000, baseUrlForRelativeResource: PROVIDER_URL },
    );
    expect(terms.network).toBe("eip155:5042002");
    expect(terms.asset.toLowerCase()).toBe(ARC_TESTNET_USDC.toLowerCase());
  });

  it("12. unexpected network is refused", async () => {
    const bad = [{ ...AURA_ACCEPTS[0], network: "eip155:1" }];
    expect(
      await codeOf(() =>
        selectAcceptedTerms(
          { x402Version: 2, resource: { url: PROVIDER_URL }, accepted: bad as never },
          approved(),
          NOW.getTime(),
          { baseUrlForRelativeResource: PROVIDER_URL },
        ),
      ),
    ).toBe("ASSET_OR_NETWORK_MISMATCH");
  });

  it("13. unexpected asset is refused", async () => {
    const bad = [{ ...AURA_ACCEPTS[0], asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }];
    expect(
      await codeOf(() =>
        selectAcceptedTerms(
          { x402Version: 2, resource: { url: PROVIDER_URL }, accepted: bad as never },
          approved(),
          NOW.getTime(),
          { baseUrlForRelativeResource: PROVIDER_URL },
        ),
      ),
    ).toBe("ASSET_OR_NETWORK_MISMATCH");
  });

  it("14. price is not trusted until parsed and exactly matched", async () => {
    // Challenge quotes 2000 but approval is for 1999 → refuse.
    expect(
      await codeOf(() =>
        selectAcceptedTerms(
          { x402Version: 2, resource: { url: PROVIDER_URL }, accepted: AURA_ACCEPTS as never },
          approved({ amountMicroUsdc: 1999n }),
          NOW.getTime(),
          { timeoutCapSec: 1_000_000, baseUrlForRelativeResource: PROVIDER_URL },
        ),
      ),
    ).toBe("AMOUNT_MISMATCH");
    // Payee substitution is refused.
    expect(
      await codeOf(() =>
        selectAcceptedTerms(
          { x402Version: 2, resource: { url: PROVIDER_URL }, accepted: AURA_ACCEPTS as never },
          approved({ payTo: "0x000000000000000000000000000000000000dEaD" }),
          NOW.getTime(),
          { timeoutCapSec: 1_000_000, baseUrlForRelativeResource: PROVIDER_URL },
        ),
      ),
    ).toBe("PAYEE_MISMATCH");
  });

  it("19. malformed 402 fails closed", async () => {
    expect(await codeOf(() => parsePaymentRequired(null))).toBe("NO_PAYMENT_HEADER");
    expect(await codeOf(() => parsePaymentRequired("!!!not-base64!!!"))).toBe("MALFORMED_402");
    expect(await codeOf(() => parsePaymentRequired(headerFor({ x402Version: 1, resource: { url: "x" }, accepts: [] })))).toBe(
      "WRONG_X402_VERSION",
    );
    expect(await codeOf(() => parsePaymentRequired(headerFor({ x402Version: 2, resource: {}, accepts: AURA_ACCEPTS })))).toBe(
      "MALFORMED_402",
    );
    expect(await codeOf(() => parsePaymentRequired(headerFor({ x402Version: 2, resource: { url: "x" }, accepts: [] })))).toBe(
      "MALFORMED_402",
    );
  });

  it("20. seller URL validation: insecure or unlisted hosts rejected", async () => {
    const signer = { address: "0x1111111111111111111111111111111111111111", sign: async () => "0x1234" as Hex };
    expect(
      await codeOf(() =>
        purchaseWithX402({ url: "http://evil.example/x", approved: approved(), signer, allowedHosts: ["auragate.app"], nowMs: NOW.getTime() }),
      ),
    ).toBe("INSECURE_URL");
    expect(
      await codeOf(() =>
        purchaseWithX402({ url: PROVIDER_URL, approved: approved(), signer, allowedHosts: ["other.example"], nowMs: NOW.getTime() }),
      ),
    ).toBe("UNTRUSTED_HOST");
  });

  it("provider timeout defaults to the strict cap, raised only by explicit override", async () => {
    const req = { x402Version: 2, resource: { url: PROVIDER_URL }, accepted: AURA_ACCEPTS as never };
    // AuraGate advertises 604900s > default 3600s → refused without override.
    expect(
      await codeOf(() => selectAcceptedTerms(req, approved(), NOW.getTime(), { baseUrlForRelativeResource: PROVIDER_URL })),
    ).toBe("BAD_TIMEOUT");
    // Explicit remote ceiling accepts it.
    const terms = selectAcceptedTerms(req, approved(), NOW.getTime(), {
      timeoutCapSec: 1_000_000,
      baseUrlForRelativeResource: PROVIDER_URL,
    });
    expect(terms.maxTimeoutSeconds).toBe(604900);
  });
});

describe("guarded remote purchase (mocked provider, fake Circle signer)", () => {
  const circleAddress = "0xC1eC13000000000000000000000000000000000001";

  function circleBuyer(signCalls: string[]) {
    return {
      address: circleAddress,
      sign: async (message: string) => {
        signCalls.push(message);
        return "0xabcdef" as Hex;
      },
    };
  }

  async function remoteFixture() {
    const { store, sink, events } = await liveFixture();
    const signCalls: string[] = [];
    const fetchCalls: string[] = [];
    const deps = {
      store,
      audit: sink,
      now: () => NOW,
      env: remoteEnv(),
      fetchImpl: mockProviderFetch(fetchCalls),
      circleBuyer: circleBuyer(signCalls),
    };
    const params = {
      workspaceId: "ws-A",
      campaignId: "c-1",
      outcomeId: "o-1",
      providerId: PROVIDER_ID,
      checkType: "OUTCOME_ENRICHMENT" as const,
      confidenceBps: { current: 6200, required: 8000 },
    };
    return { store, sink, events, deps, params, signCalls, fetchCalls };
  }

  it("15. payment happens only after BUY (signed retry follows unsigned 402)", async () => {
    const { deps, params, signCalls, fetchCalls } = await remoteFixture();
    const out = await evaluateVerificationCheck(deps, params);
    expect(out.decision.decision).toBe("BUY_CHECK");
    expect(out.execution.signed).toBe(true);
    expect(out.execution.purchased).toBe(true);
    expect(out.execution.route).toBe("real");
    // Quote read (unsigned) + purchase pair (unsigned 402, then signed retry).
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[1]).toContain("sig:false");
    expect(fetchCalls[2]).toContain("sig:true");
    expect(signCalls).toHaveLength(1);
    expect(out.procurement?.state).toBe("RESULT_RECEIVED");
  });

  it("16/17/18. NOT_NEEDED, REFUSED and REVIEW make zero signing calls", async () => {
    // NOT_NEEDED: already confident.
    {
      const { deps, params, signCalls, fetchCalls } = await remoteFixture();
      const out = await evaluateVerificationCheck(deps, {
        ...params,
        confidenceBps: { current: 8000, required: 8000 },
      });
      expect(out.decision.decision).toBe("NO_CHECK");
      expect(signCalls).toHaveLength(0);
      expect(fetchCalls.filter((c) => c.includes("sig:true"))).toHaveLength(0);
    }
    // REFUSED: price far above the value ceiling (tiny exposure fixture).
    {
      const { store, sink } = await liveFixture();
      await store.insertOutcome({
        id: "o-small", campaignId: "c-1", partnerId: "p-1", partnerTermsId: "t-1",
        checkoutIntentId: "ci-small", customerKeyHash: "ck-small", purchaseTx: "0xsmall",
        purchaseAmountMicroUsdc: 100n,
      });
      await store.updateOutcome("o-small", { status: "VERIFIED", verifiedAt: NOW });
      await store.insertReservation({
        id: "r-small", campaignId: "c-1", outcomeId: "o-small", partnerId: "p-1",
        partnerTermsId: "t-1", amountMicroUsdc: 100n, policyVersionId: "v-1",
      });
      const signCalls: string[] = [];
      const out = await evaluateVerificationCheck(
        {
          store, audit: sink, now: () => NOW, env: remoteEnv(), fetchImpl: mockProviderFetch([]),
          circleBuyer: circleBuyer(signCalls),
        },
        {
          workspaceId: "ws-A", campaignId: "c-1", outcomeId: "o-small",
          providerId: PROVIDER_ID, checkType: "OUTCOME_ENRICHMENT",
          confidenceBps: { current: 1000, required: 9000 },
        },
      );
      // exposure 100 micro → ceiling tiny → 2000 quote refused.
      expect(out.decision.decision).toBe("REFUSE");
      expect(signCalls).toHaveLength(0);
      expect(out.execution.purchased).toBe(false);
    }
    // REVIEW: human threshold set, remote budget shrunk below the price.
    {
      const { store, sink } = await liveFixture();
      await store.setProcurementPolicy({
        workspaceId: "ws-A", enabled: true,
        maxCostPerCheckMicroUsdc: 2n * M, maxSpendPerPeriodMicroUsdc: 10n * M,
        periodDays: 365, maxCostBpsOfExposure: 200,
        allowedProvidersJson: [PROVIDER_ID], allowedCheckTypesJson: ["OUTCOME_ENRICHMENT"],
        humanApprovalThresholdMicroUsdc: 500n, updatedByUserId: null,
      });
      const signCalls: string[] = [];
      const out = await evaluateVerificationCheck(
        {
          store, audit: sink, now: () => NOW,
          env: remoteEnv({ THESMA_EXTERNAL_VERIFICATION_BUDGET_MICRO: "1000" }),
          fetchImpl: mockProviderFetch([]),
          circleBuyer: circleBuyer(signCalls),
        },
        {
          workspaceId: "ws-A", campaignId: "c-1", outcomeId: "o-1",
          providerId: PROVIDER_ID, checkType: "OUTCOME_ENRICHMENT",
          confidenceBps: { current: 6200, required: 8000 },
        },
      );
      // Price 2000 > remaining 1000 → human review, never auto-spend.
      expect(out.decision.decision).toBe("ESCALATE");
      expect(signCalls).toHaveLength(0);
      expect(out.execution.purchased).toBe(false);
    }
  });

  it("evidence stays scoped: repo JSON normalizes without forcing VERIFIED", async () => {
    const { deps, params, store } = await remoteFixture();
    const out = await evaluateVerificationCheck(deps, params);
    expect(out.execution.result?.result).toBe("INCONCLUSIVE");
    // The outcome row is untouched: evidence never flips verification state.
    const outcome = await store.getOutcome("o-1");
    expect(outcome?.status).toBe("VERIFIED");
    expect(await store.getPayoutByOutcome("o-1")).toBeNull();
  });
});
