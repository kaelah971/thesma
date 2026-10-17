import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createMemoryAuditSink, createMemoryCampaignStore } from "@/server/services/campaignStore";
import type { MarketStore } from "@/server/services/campaignStore";
import { joinCampaign, openMarket } from "@/server/services/markets";
import {
  createCheckoutIntent,
  mintAttributionSession,
  submitCheckoutTx,
  verifyCheckoutIntent,
} from "@/server/services/checkout";
import {
  getPayoutReceipt,
  processEligiblePayouts,
} from "@/server/services/payouts";
import { ViemArcReader, type ArcConfig } from "@/server/chain/arc";
import { campaignKeyFor, policyHashFor } from "@/server/chain/keys";
import { LocalKeyPayoutExecutor, LocalKeyProofSigner } from "@/server/chain/signers";

/**
 * Canonical backend proof loop on a local chain (opt-in):
 * company funds real vault -> Partner joins -> customer MockUSDC transfer
 * to company -> verifier creates VERIFIED outcome -> hold passes -> worker
 * reserves -> verifier EIP-712 signs -> executor calls vault -> Partner
 * balance increases by the exact bounty -> backend reconciles SETTLED ->
 * second worker run pays nothing.
 *
 * Run: ARC_ANVIL_TESTS=1 npm test -- tests/payout.anvil.test.ts
 * Requires: forge build (contracts/out) + anvil. Never mainnet.
 */
const RUN = process.env.ARC_ANVIL_TESTS === "1";
const PORT = 18902;
const RPC = `http://127.0.0.1:${PORT}`;
const CHAIN = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const COMPANY_IX = 0;
const PARTNER_IX = 1;
const CUSTOMER_IX = 2;
const VERIFIER_IX = 3;
const EXECUTOR_IX = 4;

function artifact(name: string): { abi: any; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

describe.runIf(RUN)("anvil: full payout loop fund -> verify -> reserve -> execute -> settle", () => {
  let anvil: ChildProcess | null = null;
  const keys: Hex[] = [];
  let usdc: Address;
  let vault: Address;

  beforeAll(async () => {
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const bin = join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
    anvil = spawn(bin, ["--port", String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    anvil.stdout?.on("data", (d) => {
      logs += d.toString();
    });
    const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await client.getChainId();
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("anvil did not start");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const section = logs.split("Private Keys")[1] ?? logs;
    const found = [...section.matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0] as Hex);
    if (found.length < 5) throw new Error("could not read anvil dev keys");
    keys.push(...found.slice(0, 5));
  }, 90_000);

  afterAll(async () => {
    anvil?.kill("SIGTERM");
  });

  it("settles the exact bounty and never double-pays", async () => {
    const addr = (i: number) => privateKeyToAccount(keys[i]).address;
    const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    const company = createWalletClient({ account: privateKeyToAccount(keys[COMPANY_IX]), chain: CHAIN, transport: http(RPC) });
    const customerW = createWalletClient({ account: privateKeyToAccount(keys[CUSTOMER_IX]), chain: CHAIN, transport: http(RPC) });

    // Deploy MockUSDC + vault; fund company + customer with mock.
    const mock = artifact("MockUSDC");
    const usdcHash = await company.deployContract({ abi: mock.abi, bytecode: mock.bytecode, args: [] });
    usdc = (await client.waitForTransactionReceipt({ hash: usdcHash })).contractAddress!;
    const vaultArtifact = artifact("ThesmaMarketVault");
    const vaultHash = await company.deployContract({ abi: vaultArtifact.abi, bytecode: vaultArtifact.bytecode, args: [usdc] });
    vault = (await client.waitForTransactionReceipt({ hash: vaultHash })).contractAddress!;
    await client.waitForTransactionReceipt({
      hash: await company.writeContract({ abi: mock.abi, address: usdc, functionName: "mint", args: [addr(COMPANY_IX), 50_000_000n] }),
    });
    await client.waitForTransactionReceipt({
      hash: await company.writeContract({ abi: mock.abi, address: usdc, functionName: "mint", args: [addr(CUSTOMER_IX), 50_000_000n] }),
    });

    // Backend bindings computed first; the chain is created to match them.
    const campaignId = "ck-e2e-pay-1";
    const campaignKey = campaignKeyFor(campaignId, 1);
    const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const policyHash = policyHashFor({
      campaignId, policyVersion: 1, targetOutcomeCount: 5,
      budgetMicroUsdc: 15_000_000n, bountyFloorMicroUsdc: 1_000_000n,
      bountyCeilingMicroUsdc: 4_000_000n, minQualifyingPurchaseMicroUsdc: 1_000_000n,
      deadline, marketVisibility: "PUBLIC", refundHoldSeconds: 3,
      allowedPartnerRules: {}, escalationRules: {}, companyWallet: addr(COMPANY_IX),
    });

    // Company registers + funds the real vault (owner flow, explicit wallet).
    const deadlineUnix = BigInt(Math.floor(deadline.getTime() / 1000));
    await client.waitForTransactionReceipt({
      hash: await company.writeContract({
        abi: vaultArtifact.abi, address: vault, functionName: "createCampaign",
        args: [campaignKey, policyHash, 15_000_000n, 4_000_000n, deadlineUnix, addr(EXECUTOR_IX), addr(VERIFIER_IX)],
      }),
    });
    await client.waitForTransactionReceipt({
      hash: await company.writeContract({ abi: mock.abi, address: usdc, functionName: "approve", args: [vault, 15_000_000n] }),
    });
    await client.waitForTransactionReceipt({
      hash: await company.writeContract({
        abi: vaultArtifact.abi, address: vault, functionName: "fundCampaign", args: [campaignKey, 15_000_000n],
      }),
    });

    // Mirror the funded campaign in the backend store.
    const store = createMemoryCampaignStore({
      memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
      workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: addr(COMPANY_IX), category: "media", name: "Acme" }],
      partners: [{ id: "p-1", userId: "partner-1", payoutWallet: addr(PARTNER_IX), rulesJson: {} }],
    }) as MarketStore;
    const { sink } = createMemoryAuditSink();
    const realNow = () => new Date();
    await store.insertCampaign({ id: campaignId, workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
    await store.insertVersion({
      id: "ck-e2e-v1", campaignId, version: 1, intentText: "anvil", status: "APPROVED",
      targetOutcomeCount: 5, budgetMicroUsdc: 15_000_000n, bountyFloorMicroUsdc: 1_000_000n,
      bountyCeilingMicroUsdc: 4_000_000n, minQualifyingPurchaseMicroUsdc: 1_000_000n, deadline,
      marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 3, escalationRulesJson: {},
    });
    await store.updateVersion(campaignId, 1, { approvedByUserId: "owner-1", approvedAt: realNow() });
    await store.updateCampaign(campaignId, { currentPolicyVersionId: "ck-e2e-v1" });
    await store.insertFunding({
      id: "ck-e2e-f1", campaignId, policyVersionId: "ck-e2e-v1", policyVersion: 1,
      campaignKey, policyHash, chainId: 31337, vaultAddress: vault,
      usdcAddress: usdc, ownerAddress: addr(COMPANY_IX), expectedAmountMicroUsdc: 15_000_000n,
    });
    await store.updateFunding(campaignId, 1, { status: "CONFIRMED", observedAmountMicroUsdc: 15_000_000n });
    const marketDeps = { store, audit: sink, now: realNow };
    await openMarket(marketDeps, {
      campaignId, userId: "owner-1", expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000", destinationUrl: "https://acme.example/product",
    });
    const joined = await joinCampaign(marketDeps, { campaignId, userId: "partner-1" });

    const config: ArcConfig = {
      chainId: 31337, rpcUrl: RPC, usdcAddress: usdc, vaultAddress: vault,
      executorAddress: addr(EXECUTOR_IX), verifierAddress: addr(VERIFIER_IX), explorerBaseUrl: null,
    };
    const reader = new ViemArcReader(RPC);
    const checkoutDeps = { store, audit: sink, config, reader, now: realNow };
    const referral = await store.getReferralByCode(joined.referral.code);
    const session = await mintAttributionSession(checkoutDeps, {
      referralId: referral!.id, campaignId, partnerId: "p-1",
      partnerTermsId: joined.terms.id, expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { intent } = await createCheckoutIntent(checkoutDeps, {
      attributionHandle: session.handle,
      payerAddress: addr(CUSTOMER_IX),
      amountMicroUsdc: "10000000",
    });
    const txHash = await customerW.writeContract({
      abi: mock.abi, address: usdc, functionName: "transfer", args: [addr(COMPANY_IX), 10_000_000n],
    });
    await client.waitForTransactionReceipt({ hash: txHash });
    await submitCheckoutTx(checkoutDeps, { intentId: intent.id, txHash });
    const verified = await verifyCheckoutIntent(checkoutDeps, { intentId: intent.id });
    expect(verified.verified).toBe(true);

    // Refund hold is real time here: wait it out (3s policy + margin).
    await new Promise((r) => setTimeout(r, 4500));

    const payoutDeps = {
      store, audit: sink, config, reader,
      signer: new LocalKeyProofSigner(keys[VERIFIER_IX]),
      executor: new LocalKeyPayoutExecutor(RPC, keys[EXECUTOR_IX], 31337),
      now: realNow,
    };
    const before = (await client.readContract({ abi: mock.abi, address: usdc, functionName: "balanceOf", args: [addr(PARTNER_IX)] })) as bigint;
    const first = await processEligiblePayouts(payoutDeps, { limit: 10 });
    expect(first.submitted).toBe(1);
    expect(first.settled).toBe(0); // mining race: honestly ambiguous on first pass
    const submitted = await store.getPayoutByOutcome((await store.getOutcomeByIntent(intent.id))!.id);
    await client.waitForTransactionReceipt({ hash: submitted!.txHash as `0x${string}` });
    const second = await processEligiblePayouts(payoutDeps, { limit: 10 });
    expect(second.settled).toBe(1);
    const after = (await client.readContract({ abi: mock.abi, address: usdc, functionName: "balanceOf", args: [addr(PARTNER_IX)] })) as bigint;
    expect(after - before).toBe(2_000_000n); // exact frozen bounty, nothing more

    const outcome = await store.getOutcomeByIntent(intent.id);
    const payout = await store.getPayoutByOutcome(outcome!.id);
    expect(payout?.state).toBe("SETTLED");
    expect(payout?.txHash).not.toBeNull();
    const receipt = await getPayoutReceipt(store, { payoutId: payout!.id }, {});
    expect(receipt.payout.state).toBe("SETTLED");
    expect(receipt.settledMeansReconciled).toBe(true);

    // Third worker run pays nothing and changes nothing.
    const third = await processEligiblePayouts(payoutDeps, { limit: 10 });
    expect(third.settled).toBe(0);
    expect(third.submitted).toBe(0);
    const after2 = (await client.readContract({ abi: mock.abi, address: usdc, functionName: "balanceOf", args: [addr(PARTNER_IX)] })) as bigint;
    expect(after2).toBe(after);
    expect(third.skipped.some((s) => s.reason === "ALREADY_SETTLED")).toBe(true);
  }, 180_000);
});
