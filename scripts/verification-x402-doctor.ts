/**
 * READ-ONLY doctor for testnet x402 verification procurement.
 *
 * Reports: Circle configuration, buyer wallet, Arc Testnet network,
 * testnet USDC balance, provider challenge reachability/validity,
 * quoted price, policy caps, and the value-of-information decision.
 *
 * NEVER pays, signs, or mutates anything. Secrets are never printed.
 *
 * Usage: npm run verification:x402:doctor
 */
import { createPublicClient, http, getAddress, type Hex } from "viem";
import { ARC_MAINNET_CAIP2, ARC_TESTNET_CAIP2, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_USDC, getRemoteX402Config } from "../src/server/services/verification";
import { getCircleVerificationConfig } from "../src/server/chain/circle";

const BALANCE_OF_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

function line(label: string, value: string) {
  console.log(`${label.padEnd(22)} ${value}`);
}

function redact(v: string | undefined): string {
  if (!v) return "<absent>";
  return v.length <= 8 ? "<set>" : `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

async function main() {
  console.log("THESMA x402 VERIFICATION DOCTOR (read-only, Arc Testnet only)");
  console.log("=".repeat(64));

  // --- Circle configuration (presence only; values never printed) ---
  const circle = getCircleVerificationConfig(process.env);
  line("Circle configured:", circle ? "YES" : "NO (NOT_CONFIGURED)");
  if (circle) {
    line("Circle API key:", redact(process.env.CIRCLE_API_KEY));
    line("Circle entity secret:", redact(process.env.CIRCLE_ENTITY_SECRET));
    line("Circle wallet id:", circle.walletId);
  }

  // --- Buyer wallet identity + network (read-only) ---
  let walletAddress: string | null = null;
  if (circle) {
    try {
      const { CircleDeveloperControlledWalletsClient } = await import("@circle-fin/developer-controlled-wallets");
      const client = new CircleDeveloperControlledWalletsClient({ apiKey: circle.apiKey, entitySecret: circle.entitySecret });
      const res = await client.getWallet({ id: circle.walletId });
      const w = (res?.data as { wallet?: { address?: string; blockchain?: string } }).wallet ?? {};
      walletAddress = w.address ?? null;
      line("Wallet address:", walletAddress ?? "<unknown>");
      line("Wallet blockchain:", String(w.blockchain ?? "<unknown>"));
      if (String(w.blockchain ?? "").toUpperCase() !== "ARC-TESTNET") {
        line("Network verdict:", "REFUSE — wallet is not on ARC-TESTNET");
      }
    } catch (e) {
      line("Wallet lookup:", `FAILED (${(e as Error).message})`);
    }
  }

  // --- Arc Testnet chain + USDC balance (read-only eth_call) ---
  const rpcUrl = (process.env.ARC_TESTNET_RPC_URL ?? "").trim();
  line("Testnet RPC:", rpcUrl ? "configured" : "<absent> (balance unreadable)");
  if (rpcUrl && walletAddress) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl) });
      const chainId = await client.getChainId();
      line("Chain id:", `${chainId}${chainId === ARC_TESTNET_CHAIN_ID ? " (eip155:5042002 OK)" : " (MISMATCH — refuse)"}`);
      const bal = (await client.readContract({
        address: getAddress(ARC_TESTNET_USDC),
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [getAddress(walletAddress) as Hex],
      })) as bigint;
      line("USDC balance:", `${bal.toString()} micro-USDC`);
    } catch (e) {
      line("Chain/balance read:", `FAILED (${(e as Error).message})`);
    }
  }

  // --- Provider challenge (live read, no payment) ---
  let remote: ReturnType<typeof getRemoteX402Config> = null;
  try {
    remote = getRemoteX402Config(process.env);
  } catch (e) {
    line("Provider config:", `INVALID (${(e as Error).message})`);
  }
  line("Provider enabled:", remote ? "YES" : "NO (NOT_CONFIGURED)");
  let quoted: string | null = null;
  if (remote) {
    line("Provider URL:", remote.providerUrl);
    line("Provider id:", remote.providerId);
    try {
      const res = await fetch(remote.providerUrl, { method: "GET", redirect: "manual" });
      line("Challenge reachable:", `HTTP ${res.status}${res.status === 402 ? " (payment required — expected)" : ""}`);
      if (res.status === 402) {
        const header = res.headers.get("payment-required");
        if (!header) {
          line("Challenge terms:", "MISSING payment-required header");
        } else {
          const { parsePaymentRequired } = await import("../src/server/services/verification");
          const parsed = parsePaymentRequired(header);
          const term = parsed.accepted.find(
            (t) => t.network === ARC_TESTNET_CAIP2 && t.asset.toLowerCase() === ARC_TESTNET_USDC.toLowerCase(),
          );
          if (!term) {
            line("Challenge terms:", "INVALID — no exact testnet-USDC term");
          } else {
            quoted = term.amount;
            line("Challenge terms:", `OK — ${term.amount} micro-USDC to ${term.payTo} on ${term.network}`);
          }
        }
      }
    } catch (e) {
      line("Challenge reachable:", `NO (${(e as Error).message})`);
    }
    line("Quoted price:", quoted !== null ? `${quoted} micro-USDC` : "<none>");
    line("Policy max/check:", `${remote.maxPerCheckMicroUsdc.toString()} micro-USDC`);
    line("Policy budget:", `${remote.budgetMicroUsdc.toString()} micro-USDC`);
  }

  // --- Value-of-information verdict on the canonical fixture (no spend) ---
  if (!circle || !remote || quoted === null) {
    line("Decision:", "NOT_CONFIGURED");
  } else {
    const { evaluateValueOfInformation } = await import("../src/server/services/verification");
    const voi = evaluateValueOfInformation({
      payoutAtRiskMicroUsdc: 20_000_000n,
      currentConfidenceBps: 6200,
      requiredConfidenceBps: 8000,
      providerPriceMicroUsdc: BigInt(quoted),
      remainingVerificationBudgetMicroUsdc: remote.budgetMicroUsdc,
      maxPerCheckMicroUsdc: remote.maxPerCheckMicroUsdc,
      maxEvidenceCostShareBps: 200,
      humanApprovalThresholdMicroUsdc: null,
    });
    line("Decision:", voi.decision === "BUY" ? "WOULD_BUY" : `WOULD_${voi.decision}`);
    for (const r of voi.reasons) console.log(`  - ${r}`);
    console.log(`  max justifiable: ${voi.maxJustifiableSpendMicroUsdc.toString()} micro-USDC`);
  }

  console.log("=".repeat(64));
  console.log(`Mainnet (${ARC_MAINNET_CAIP2}) spend possible: NO — testnet-only invariant enforced in code.`);
}

main().catch((e) => {
  console.error(`DOCTOR FAILED: ${(e as Error).message}`);
  process.exit(1);
});
