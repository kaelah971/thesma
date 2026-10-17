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
  type CheckoutDeps,
} from "@/server/services/checkout";
import { ViemArcReader, type ArcConfig } from "@/server/chain/arc";

/**
 * Local Anvil integration (opt-in): real ERC20 transfer on a local chain,
 * then the unmodified backend verifier reads the receipt and produces
 * exactly one VERIFIED outcome. No mainnet, no real funds.
 *
 * Run: ARC_ANVIL_TESTS=1 npm test -- tests/checkout.anvil.test.ts
 * Requires: forge build (for contracts/out artifacts) + anvil in PATH.
 */
const RUN = process.env.ARC_ANVIL_TESTS === "1";
const PORT = 18901;
const RPC = `http://127.0.0.1:${PORT}`;
// Anvil default dev keys are read from its startup output (public, local-only).
let DEPLOYER_KEY = "0x" as Hex;
let CUSTOMER_KEY = "0x" as Hex;
const COMPANY = "0x1111111111111111111111111111111111111111" as Address;
const CHAIN = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

function artifact(name: string): { abi: any; bytecode: Hex } {
  const json = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

describe.runIf(RUN)("anvil: ERC20 transfer -> receipt -> verifier -> VERIFIED", () => {
  let anvil: ChildProcess | null = null;
  let usdc: Address;
  let vault: Address;
  let customer: Address;
  let reader: ViemArcReader;

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
    const deadline = Date.now() + 120_000;
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
    if (found.length < 2) throw new Error("could not read anvil dev keys from startup output");
    [DEPLOYER_KEY, CUSTOMER_KEY] = found;
    const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: CHAIN, transport: http(RPC) });
    customer = privateKeyToAccount(CUSTOMER_KEY).address;
    const mock = artifact("MockUSDC");
    const usdcHash = await deployer.deployContract({ abi: mock.abi, bytecode: mock.bytecode, args: [] });
    const usdcRc = await client.waitForTransactionReceipt({ hash: usdcHash });
    usdc = usdcRc.contractAddress!;
    const vaultArtifact = artifact("ThesmaMarketVault");
    const vaultHash = await deployer.deployContract({ abi: vaultArtifact.abi, bytecode: vaultArtifact.bytecode, args: [usdc] });
    const vaultRc = await client.waitForTransactionReceipt({ hash: vaultHash });
    vault = vaultRc.contractAddress!;
    const customerWallet = createWalletClient({ account: privateKeyToAccount(CUSTOMER_KEY), chain: CHAIN, transport: http(RPC) });
    const mintHash = await deployer.writeContract({ abi: mock.abi, address: usdc, functionName: "mint", args: [customer, 50_000_000n] });
    await client.waitForTransactionReceipt({ hash: mintHash });
    void customerWallet;
    reader = new ViemArcReader(RPC);
  }, 90_000);

  afterAll(async () => {
    anvil?.kill("SIGTERM");
  });

  it("verifies a real local transfer into VERIFIED with company settlement", async () => {
    const store = createMemoryCampaignStore({
      memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
      workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: COMPANY, category: "media", name: "Acme" }],
      partners: [{ id: "p-1", userId: "partner-1", payoutWallet: "0x2222222222222222222222222222222222222222", rulesJson: {} }],
    }) as MarketStore;
    const { sink } = createMemoryAuditSink();
    const realNow = () => new Date();
    const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const campaignId = "ck-anvil-1";
    await store.insertCampaign({ id: campaignId, workspaceId: "ws-A", state: "LIVE", createdByUserId: "owner-1" });
    await store.insertVersion({
      id: "ck-anvil-v1", campaignId, version: 1, intentText: "anvil", status: "APPROVED",
      targetOutcomeCount: 5, budgetMicroUsdc: 15_000_000n, bountyFloorMicroUsdc: 1_000_000n,
      bountyCeilingMicroUsdc: 4_000_000n, minQualifyingPurchaseMicroUsdc: 1_000_000n, deadline,
      marketVisibility: "PUBLIC", allowedPartnerRulesJson: {}, refundHoldSeconds: 0, escalationRulesJson: {},
    });
    await store.updateVersion(campaignId, 1, { approvedByUserId: "owner-1", approvedAt: realNow() });
    await store.updateCampaign(campaignId, { currentPolicyVersionId: "ck-anvil-v1" });
    await store.insertFunding({
      id: "ck-anvil-f1", campaignId, policyVersionId: "ck-anvil-v1", policyVersion: 1,
      campaignKey: "0x00", policyHash: "0x00", chainId: 31337,
      vaultAddress: vault, usdcAddress: usdc, ownerAddress: COMPANY, expectedAmountMicroUsdc: 15_000_000n,
    });
    await store.updateFunding(campaignId, 1, { status: "CONFIRMED", observedAmountMicroUsdc: 15_000_000n });
    const marketDeps = { store, audit: sink, now: realNow };
    await openMarket(marketDeps, {
      campaignId, userId: "owner-1", expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000", destinationUrl: "https://acme.example/product",
    });
    const joined = await joinCampaign(marketDeps, { campaignId, userId: "partner-1" });
    const referral = await store.getReferralByCode(joined.referral.code);

    const config: ArcConfig = {
      chainId: 31337, rpcUrl: RPC, usdcAddress: usdc, vaultAddress: vault,
      executorAddress: null, verifierAddress: null, explorerBaseUrl: null,
    };
    const deps: CheckoutDeps = { store, audit: sink, config, reader, now: realNow };
    const session = await mintAttributionSession(deps, {
      referralId: referral!.id, campaignId, partnerId: "p-1", partnerTermsId: joined.terms.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { intent, payment } = await createCheckoutIntent(deps, {
      attributionHandle: session.handle,
      payerAddress: customer,
      amountMicroUsdc: "10000000",
    });
    expect(payment.token.toLowerCase()).toBe(usdc.toLowerCase());

    // Real customer transfer on the local chain.
    const customerWallet = createWalletClient({ account: privateKeyToAccount(CUSTOMER_KEY), chain: CHAIN, transport: http(RPC) });
    const mock = artifact("MockUSDC");
    const txHash = await customerWallet.writeContract({
      abi: mock.abi, address: usdc, functionName: "transfer", args: [COMPANY, 10_000_000n],
    });
    const publicClient0 = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    await publicClient0.waitForTransactionReceipt({ hash: txHash });
    await submitCheckoutTx(deps, { intentId: intent.id, txHash });
    const result = await verifyCheckoutIntent(deps, { intentId: intent.id });
    expect(result.verified).toBe(true);
    expect(result.outcome?.status).toBe("VERIFIED");
    expect(result.outcome?.purchaseAmountMicroUsdc).toBe("10000000");

    // Company wallet actually received the revenue onchain.
    const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    const balance = await publicClient.readContract({ abi: mock.abi, address: usdc, functionName: "balanceOf", args: [COMPANY] });
    expect(balance).toBe(10_000_000n);
  }, 120_000);
});
