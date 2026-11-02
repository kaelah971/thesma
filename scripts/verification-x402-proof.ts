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
import { createRequire } from "node:module";
import { parseUnits, type Address } from "viem";
import { createMemoryAuditSink, createMemoryCampaignStore } from "../src/server/services/campaignStore";
import type { CampaignDeps } from "../src/server/services/campaigns";
import { evaluateVerificationCheck, verificationSpendForWorkspace } from "../src/server/services/verificationProcurement";
import { createMemoryCompanyWalletChallengeStore } from "../src/server/services/companyWalletChallenges";
import { normalizeGithubRepoEvidence, GITHUB_REPO_EVIDENCE_CAPABILITY, GITHUB_REPO_EVIDENCE_DOES_NOT_PROVE } from "../src/server/services/verificationRemote";
import { getRemoteX402Config, ARC_TESTNET_CAIP2 } from "../src/server/services/verification";
import { getCircleVerificationConfig } from "../src/server/chain/circle";

// Live proof must use wall-clock time so the EIP-3009 validBefore derived
// from the provider timeout is not already expired. Unit fixtures remain
// frozen; this script is explicitly a live testnet operation.
const NOW = new Date();
const DAY = 86_400_000;
const M = 1_000_000n;
const PAYOUT_AT_RISK = 20n * M;
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as Address;
const TESTNET_USDC = "0x3600000000000000000000000000000000000000" as Address;
const GATEWAY_DOMAIN = 26;
const PROOF_COST_MICRO = 2_000n;
// Fixed UUIDv4 keys make the two bootstrap mutations exactly-once if this
// command is interrupted after Circle accepts either request.
const GATEWAY_APPROVAL_IDEMPOTENCY = "8f46c3a5-0d2d-4b8d-9f6a-6b36f3b1e8d1";
const GATEWAY_DEPOSIT_IDEMPOTENCY = "6a3f0f90-2c7a-4db7-a8e8-9f7a5c2d4b61";

function blocked(reason: string): never {
  console.log("LIVE PROOF BLOCKED: " + reason);
  process.exit(2);
}

function envValue(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) blocked(`${name} is missing`);
  return v;
}

async function gatewayBalance(depositor: string): Promise<bigint> {
  const response = await fetch("https://gateway-api-testnet.circle.com/v1/balances", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: [{ depositor, domain: GATEWAY_DOMAIN }] }),
  });
  const body = (await response.json().catch(() => null)) as { balances?: Array<{ balance?: string }> } | null;
  if (!response.ok || !body?.balances?.[0] || typeof body.balances[0].balance !== "string") {
    throw new Error(`Gateway balance API failed (${response.status})`);
  }
  return parseUnits(body.balances[0].balance, 6);
}

/**
 * Circle Gateway is a depositor-balance rail: faucet USDC in the wallet is
 * not spendable by the x402 Gateway until deposited. This explicit proof
 * command deposits only the exact 0.002 USDC shortfall, reuses an existing
 * Gateway balance, and never touches mainnet.
 *
 * Circle's current SDK supports contract execution for the EOA buyer; use
 * that official mutating surface instead of manually assembling/broadcasting
 * raw transactions.
 */
async function ensureGatewayBalance(params: { wallet: { address: string }; circle: any }): Promise<{ gatewayBefore: bigint; deposited: bigint; approvalTx: string | null; depositTx: string | null; gatewayAfter: bigint }> {
  const before = await gatewayBalance(params.wallet.address);
  if (before >= PROOF_COST_MICRO) return { gatewayBefore: before, deposited: 0n, approvalTx: null, depositTx: null, gatewayAfter: before };
  const needed = PROOF_COST_MICRO - before;
  const execute = async (contractAddress: Address, signature: string, args: unknown[], idempotencyKey: string): Promise<string> => {
    const created = await params.circle.createContractExecutionTransaction({
      // Circle's Gateway deposit guide requires the wallet address + explicit
      // Arc chain. Using walletId here makes the API reject ARC-TESTNET.
      walletAddress: params.wallet.address,
      blockchain: "ARC-TESTNET",
      contractAddress,
      abiFunctionSignature: signature,
      abiParameters: args,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey,
    });
    const txId = created?.data?.id;
    if (typeof txId !== "string") throw new Error("Circle returned no transaction id");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const current = await params.circle.getTransaction({ id: txId });
      const tx = current?.data?.transaction;
      if (tx?.state === "COMPLETE" || tx?.state === "CONFIRMED") {
        if (typeof tx.txHash !== "string" || !tx.txHash.startsWith("0x")) throw new Error("Circle returned no Arc Testnet transaction hash");
        return tx.txHash;
      }
      if (["FAILED", "DENIED", "CANCELLED", "STUCK"].includes(String(tx?.state))) {
        throw new Error(`Circle transaction ${tx.state.toLowerCase()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error("Circle Gateway transaction confirmation timed out; reconcile before retrying");
  };
  const approvalTx = await execute(TESTNET_USDC, "approve(address,uint256)", [GATEWAY_WALLET, needed.toString()], GATEWAY_APPROVAL_IDEMPOTENCY);
  const depositTx = await execute(GATEWAY_WALLET, "deposit(address,uint256)", [TESTNET_USDC, needed.toString()], GATEWAY_DEPOSIT_IDEMPOTENCY);
  const after = await gatewayBalance(params.wallet.address);
  if (after < PROOF_COST_MICRO) throw new Error(`Gateway balance did not reconcile after deposit (have ${after}, need ${PROOF_COST_MICRO})`);
  return { gatewayBefore: before, deposited: needed, approvalTx, depositTx, gatewayAfter: after };
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
  const rpcUrl = (process.env.ARC_TESTNET_RPC_URL ?? "").trim();
  const balance = await buyer.usdcBalanceMicro(usdc, { rpcUrl: rpcUrl || undefined }).catch((e) => blocked(`balance unreadable: ${(e as Error).message}`));
  console.log(`USDC bal : ${balance.toString()} micro-USDC`);
  const circleRequire = createRequire(import.meta.url);
  const { CircleDeveloperControlledWalletsClient } = circleRequire("@circle-fin/developer-controlled-wallets") as { CircleDeveloperControlledWalletsClient: new (config: { apiKey: string; entitySecret: string }) => any };
  const circleClient = new CircleDeveloperControlledWalletsClient({ apiKey: envValue("CIRCLE_API_KEY"), entitySecret: envValue("CIRCLE_ENTITY_SECRET") });
  const gateway = await ensureGatewayBalance({ wallet: buyer, circle: circleClient }).catch((e) => blocked(`Gateway deposit failed: ${(e as Error).message}`));
  console.log(`Gateway : before=${gateway.gatewayBefore.toString()} deposited=${gateway.deposited.toString()} after=${gateway.gatewayAfter.toString()} micro-USDC`);
  if (gateway.approvalTx) console.log(`Gateway approval testnet tx: ${gateway.approvalTx}`);
  if (gateway.depositTx) console.log(`Gateway deposit testnet tx: ${gateway.depositTx}`);

  // --- Fixture store (memory only — never production) ---
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-proof", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-proof", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Proof" }],
    partners: [{ id: "p-1", userId: "creator-1", payoutWallet: "0xeBB551653815900D6886d2eeEea2325d86275173", rulesJson: {} }],
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
  // Funded fixture liquidity (in-memory only): CONFIRMED funding covers the
  // reservation so the liquidity gate can pass; no real money anywhere.
  await store.insertFunding({
    id: "f-proof", campaignId: d.campaign.id, policyVersionId: "v-proof", policyVersion: 1,
    campaignKey: "0xk", policyHash: "0xh", chainId: 5042002, vaultAddress: "0xv",
    usdcAddress: "0xu", ownerAddress: "0xo", expectedAmountMicroUsdc: 200n * M,
  });
  await store.updateFunding(d.campaign.id, 1, { status: "CONFIRMED", observedAmountMicroUsdc: 200n * M });
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
  // Review-grade anomaly signals → EXTERNAL_CHECK_CANDIDATE readiness.
  // (Without these the engine correctly answers NO_CHECK: no signal, no spend.)
  for (const [id, tx] of [["o-proof-r1", "0xr1"], ["o-proof-r2", "0xr2"]] as const) {
    await store.insertOutcome({
      id, campaignId: d.campaign.id, partnerId: "p-1", partnerTermsId: "t-1",
      checkoutIntentId: `ci-${id}`, customerKeyHash: `ck-${id}`, purchaseTx: tx,
      purchaseAmountMicroUsdc: 10n * M,
    });
    await store.updateOutcome(id, { status: "REJECTED", rejectionCode: "DUPLICATE_TX" });
  }
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
    // Safe failure evidence for diagnosis: provider/error code only, never
    // signature, secret, raw response, or customer data.
    const failureEvents = events
      .filter((e) => String(e.action).includes("verification.procurement"))
      .slice(-4)
      .map((e) => ({ action: e.action, metadata: e.metadata }));
    console.log(JSON.stringify({
      purchaseCompleted: false,
      signed: first.execution.signed,
      ambiguous: first.execution.ambiguous,
      procurement: first.procurement ? {
        state: first.procurement.state,
        decision: first.procurement.decision,
        paymentReference: first.procurement.paymentReference,
      } : null,
      failureEvents,
    }, null, 1));
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
