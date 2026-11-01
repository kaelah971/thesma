/**
 * LIVE Arc Testnet x402 verification purchase — guarded, exactly-once.
 *
 * Executes ONE paid testnet evidence purchase through the real provider
 * challenge using the dedicated Circle buyer wallet. Hard guards:
 * testnet-only terms, env allowlisted provider, Circle configured,
 * quoted price within the per-check ceiling, idempotent proof key.
 *
 * Uses an IN-MEMORY store with a deterministic fixture — never touches
 * production data. Re-running re-evaluates to NO_CHECK (no double pay).
 *
 * No real money moves: Arc Testnet USDC only.
 *
 * Usage: npm run verification:x402:proof
 * Exit 0 on PROVEN, exit 2 on BLOCKED (with the exact missing setup).
 */
import { getAddress } from "viem";
import { createMemoryAuditSink, createMemoryCampaignStore } from "../src/server/services/campaignStore";
import type { CampaignDeps } from "../src/server/services/campaigns";
import { evaluateVerificationCheck, verificationSpendForWorkspace } from "../src/server/services/verificationProcurement";
import { createMemoryCompanyWalletChallengeStore } from "../src/server/services/companyWalletChallenges";
import { normalizeGithubRepoEvidence, GITHUB_REPO_EVIDENCE_CAPABILITY, GITHUB_REPO_EVIDENCE_DOES_NOT_PROVE } from "../src/server/services/verificationRemote";
import { getRemoteX402Config, ARC_TESTNET_CAIP2 } from "../src/server/services/verification";
import { getCircleVerificationConfig } from "../src/server/chain/circle";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;
const M = 1_000_000n;
const PAYOUT_AT_RISK = 20n * M;

function blocked(reason: string): never {
  console.log("LIVE PROOF BLOCKED: " + reason);
  process.exit(2);
}

async function main() {
  console.log("THESMA x402 VERIFICATION PROOF (Arc Testnet only, exactly one purchase)");
  console.log("=".repeat(64));

  // --- Hard guards first: testnet-only, configured, allowlisted ---
  const remote = getRemoteX402Config(process.env);
  if (!remote) blocked("external verification not enabled/configured (THESMA_EXTERNAL_VERIFICATION_ENABLED + THESMA_EXTERNAL_VERIFICATION_PROVIDER_URL)");
  const r = remote!;
  if (r.network !== ARC_TESTNET_CAIP2) blocked(`refusing non-testnet network ${r.network}`);
  const circleCfg = getCircleVerificationConfig(process.env);
  if (!circleCfg) blocked("Circle buyer not configured (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_VERIFICATION_WALLET_ID)");
  console.log(`Provider : ${r.providerId} ${r.providerUrl}`);
  console.log(`Network  : ${r.network} (testnet-only invariant holds)`);
  console.log(`Ceilings : max/check ${r.maxPerCheckMicroUsdc.toString()} / budget ${r.budgetMicroUsdc.toString()} micro-USDC`);

  // --- Buyer wallet identity + testnet funds (read-only) ---
  const { createCircleVerificationBuyer } = await import("../src/server/chain/circle");
  const buyer = await createCircleVerificationBuyer(process.env).catch((e) => blocked(`Circle buyer unavailable: ${(e as Error).message}`));
  console.log(`Buyer    : ${buyer.address} (${buyer.blockchain})`);
  const usdc = (process.env.THESMA_EXTERNAL_VERIFICATION_USDC ?? "").trim() || "0x3600000000000000000000000000000000000000";
  const balance = await buyer.usdcBalanceMicro(usdc).catch((e) => blocked(`balance unreadable: ${(e as Error).message}`));
  console.log(`USDC bal : ${balance.toString()} micro-USDC`);

  // --- Fixture store (memory only — never production) ---
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-proof", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-proof", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Proof" }],
    partners: [{ id: "p-1", userId: "creator-1", payoutWallet: getAddress("0xeBB55165381500D6886d2eEea2325d86275173"), rulesJson: {} }],
  }) as unknown as Parameters<typeof evaluateVerificationCheck>[0]["store"];
  const { sink, events } = createMemoryAuditSink();
  const deps = {
    store, audit: sink, config: null, reader: null, now: () => NOW,
    challenges: createMemoryCompanyWalletChallengeStore(),
  };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => NOW };
  const { createDraft, moveToReview, approvePolicy } = await import("../src/server/services/campaigns");
  const d = await createDraft(campaignDeps, {
    workspaceId: "ws-proof", userId: "owner-1",
    intentText: "Get 5 paying customers by Sunday. Budget 50 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.",
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: "2026-12-31T23:59:59.999Z" },
  });
  await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await store.updateCampaign(d.campaign.id, { state: "LIVE" });
  // Market OPEN so the campaign is a live funding candidate.
  await store.insertMarket({
    campaignId: d.campaign.id, publicBountyMicroUsdc: 4n * M, status: "OPEN",
    destinationUrl: "https://example.com/offer", version: 1, policyVersion: 1,
  });
  await store.setProcurementPolicy({
    workspaceId: "ws-proof", enabled: true,
    maxCostPerCheckMicroUsdc: r.maxPerCheckMicroUsdc, maxSpendPerPeriodMicroUsdc: r.budgetMicroUsdc,
    periodDays: 365, maxCostBpsOfExposure: 200,
    allowedProvidersJson: [r.providerId], allowedCheckTypesJson: ["OUTCOME_ENRICHMENT"],
    humanApprovalThresholdMicroUsdc: null, updatedByUserId: null,
  });
  const outcomeId = "o-proof-1";
  await store.insertOutcome({
    id: outcomeId, campaignId: d.campaign.id, partnerId: "p-1", partnerTermsId: "t-1",
    checkoutIntentId: "ci-proof", customerKeyHash: "ck-proof", purchaseTx: "0xtest",
    purchaseAmountMicroUsdc: PAYOUT_AT_RISK,
  });
  await store.updateOutcome(outcomeId, { status: "VERIFIED", verifiedAt: new Date(NOW.getTime() - DAY) });
  await store.insertReservation({
    id: `r-${outcomeId}`, campaignId: d.campaign.id, outcomeId, partnerId: "p-1",
    partnerTermsId: "t-1", amountMicroUsdc: PAYOUT_AT_RISK, policyVersionId: "v-1",
  });

  // --- Evaluate with explicit value-of-information confidence (fixture) ---
  const first = await evaluateVerificationCheck(
    { store, audit: sink, now: () => NOW, env: process.env },
    {
      workspaceId: "ws-proof", campaignId: d.campaign.id, outcomeId,
      providerId: r.providerId, checkType: "OUTCOME_ENRICHMENT",
      confidenceBps: { current: 6200, required: 8000 },
    },
  );
  console.log(`Decision : ${first.decision.decision}`);
  for (const reason of first.decision.reasons) console.log(`  - ${reason}`);
  if (first.decision.decision !== "BUY_CHECK") {
    blocked(`kernel refused the fixture (decision=${first.decision.decision}); no purchase attempted`);
  }
  if (!first.execution.purchased) {
    blocked(`purchase did not complete (ambiguous=${first.execution.ambiguous}); no retry attempted blindly`);
  }
  const paymentRef = first.execution.paymentReference ?? "<none>";
  console.log(`Paid     : receipt ${paymentRef}`);
  console.log(`Evidence : ${first.execution.result?.result ?? "<none>"} (hash ${first.execution.result?.rawResponseHash ?? "<none>"})`);

  // --- Scoped evidence read (identity only — never a verdict override) ---
  // The stored normalized result is the pipeline truth; the repo-identity
  // lens below only explains what this evidence class may (not) prove.
  const repoParam = (() => { try { return new URL(r.providerUrl).searchParams.get("repo"); } catch { return null; } })();
  if (repoParam) {
    console.log(`Evidence : ${GITHUB_REPO_EVIDENCE_CAPABILITY} for ${repoParam}`);
    console.log(`Proves NOT: ${GITHUB_REPO_EVIDENCE_DOES_NOT_PROVE.join("; ")}`);
  }

  // --- Idempotency: re-evaluate must NOT pay again ---
  const second = await evaluateVerificationCheck(
    { store, audit: sink, now: () => NOW, env: process.env },
    {
      workspaceId: "ws-proof", campaignId: d.campaign.id, outcomeId,
      providerId: r.providerId, checkType: "OUTCOME_ENRICHMENT",
      confidenceBps: { current: 6200, required: 8000 },
    },
  );
  if (second.execution.purchased || second.execution.signed) {
    console.log("DOUBLE SPEND GUARD FAILED: re-evaluation purchased again");
    process.exit(1);
  }
  console.log("Idempotent: re-evaluation paid nothing (existing RESULT_RECEIVED wins)");

  const { spentMicroUsdc } = await verificationSpendForWorkspace(store, "ws-proof", NOW.getTime());
  console.log(`Spend    : ${spentMicroUsdc.toString()} micro-USDC recorded exactly once`);
  console.log("=".repeat(64));
  console.log("LIVE PROOF PROVEN: one paid testnet evidence purchase, receipt above.");
  void events;
}

main().catch((e) => {
  console.error(`PROOF FAILED: ${(e as Error).message}`);
  process.exit(1);
});
