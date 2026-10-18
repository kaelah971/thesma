import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";

/**
 * Provider-neutral Arc chain boundary (S2).
 *
 * - The backend PREPARES unsigned transactions; it never holds keys or signs.
 * - Domain code receives plain values from this module, never viem objects.
 * - Chain mismatch fails closed: RPC eth_chainId must equal ARC_CHAIN_ID.
 * - No Gateway, no CCTP, no Circle dependency.
 */

export const ARC_USDC_DEFAULT = "0x3600000000000000000000000000000000000000" as const;

/** Arc Mainnet: production settlement/proof. Always the default. */
export const ARC_MAINNET_CHAIN_ID = 5042;
/** Canteen Arc Testnet: hackathon development/demo/testing only. */
export const ARC_TESTNET_CHAIN_ID = 5042002;

export type ArcNetwork = "mainnet" | "testnet";

export interface ArcConfig {
  chainId: number;
  rpcUrl: string;
  usdcAddress: Address;
  vaultAddress: Address | null;
  executorAddress: Address | null;
  verifierAddress: Address | null;
  explorerBaseUrl: string | null;
  /**
   * Selected Arc environment. Always populated by arcConfigFromEnv;
   * hand-built fixtures (tests, scripts) may omit it.
   */
  network?: ArcNetwork;
  /** Human label: "Arc Mainnet" or "Canteen Arc Testnet". */
  environmentLabel?: string;
}

function optionalAddress(raw: string | undefined, name: string): Address | null {
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    throw new Error(`${name} is not a valid EVM address`);
  }
}

/**
 * Null when chain config is absent (doctor reports NOT CONFIGURED).
 *
 * Dual-environment resolution:
 * - `ARC_NETWORK` unset/"mainnet" → production path, unchanged:
 *   `ARC_RPC_URL` + `ARC_CHAIN_ID` (chain 5042 in production).
 * - `ARC_NETWORK=testnet` → Canteen testnet path: requires
 *   `ARC_TESTNET_RPC_URL`, pins chain to 5042002, and NEVER falls back
 *   to mainnet variables.
 *
 * Cross-contamination fails loudly: testnet config can never report 5042,
 * mainnet config can never report 5042002.
 */
export function arcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArcConfig | null {
  const networkRaw = (env.ARC_NETWORK ?? "mainnet").trim().toLowerCase();
  if (networkRaw !== "mainnet" && networkRaw !== "testnet") {
    throw new Error('ARC_NETWORK must be "mainnet" or "testnet"');
  }
  if (networkRaw === "testnet") return arcTestnetConfigFromEnv(env);
  return arcMainnetConfigFromEnv(env);
}

/** Canteen Arc Testnet (chain 5042002). Hackathon/dev only — never production. */
function arcTestnetConfigFromEnv(env: NodeJS.ProcessEnv): ArcConfig | null {
  const rpcUrl = env.ARC_TESTNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("ARC_NETWORK=testnet requires ARC_TESTNET_RPC_URL (refusing to fall back to mainnet)");
  }
  const chainRaw = env.ARC_TESTNET_CHAIN_ID;
  const chainId = chainRaw ? Number.parseInt(chainRaw, 10) : ARC_TESTNET_CHAIN_ID;
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`Canteen testnet chain must be ${ARC_TESTNET_CHAIN_ID}, got ${chainRaw}`);
  }
  return {
    chainId,
    rpcUrl,
    usdcAddress: optionalAddress(env.ARC_TESTNET_USDC_ADDRESS, "ARC_TESTNET_USDC_ADDRESS") ?? getAddress(ARC_USDC_DEFAULT),
    vaultAddress: optionalAddress(env.ARC_TESTNET_VAULT_ADDRESS, "ARC_TESTNET_VAULT_ADDRESS"),
    executorAddress: optionalAddress(env.ARC_TESTNET_OPERATOR_ADDRESS, "ARC_TESTNET_OPERATOR_ADDRESS"),
    verifierAddress: optionalAddress(env.ARC_TESTNET_VERIFIER_ADDRESS, "ARC_TESTNET_VERIFIER_ADDRESS"),
    explorerBaseUrl: env.ARC_TESTNET_EXPLORER_BASE_URL ?? null,
    network: "testnet",
    environmentLabel: "Canteen Arc Testnet",
  };
}

/** Arc Mainnet (production default). Existing ARC_RPC_URL/ARC_CHAIN_ID contract, unchanged. */
function arcMainnetConfigFromEnv(env: NodeJS.ProcessEnv): ArcConfig | null {
  const rpcUrl = env.ARC_RPC_URL;
  const chainRaw = env.ARC_CHAIN_ID;
  if (!rpcUrl || !chainRaw) return null;
  const chainId = Number.parseInt(chainRaw, 10);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("ARC_CHAIN_ID must be a positive integer");
  if (chainId === ARC_TESTNET_CHAIN_ID) {
    throw new Error("ARC_CHAIN_ID is the Canteen testnet chain; use ARC_NETWORK=testnet with ARC_TESTNET_* instead (refusing to run testnet chain as mainnet)");
  }
  return {
    chainId,
    rpcUrl,
    usdcAddress: optionalAddress(env.ARC_USDC_ADDRESS, "ARC_USDC_ADDRESS") ?? getAddress(ARC_USDC_DEFAULT),
    vaultAddress: optionalAddress(env.THESMA_VAULT_ADDRESS, "THESMA_VAULT_ADDRESS"),
    executorAddress: optionalAddress(env.THESMA_EXECUTOR_ADDRESS, "THESMA_EXECUTOR_ADDRESS"),
    verifierAddress: optionalAddress(env.THESMA_VERIFIER_ADDRESS, "THESMA_VERIFIER_ADDRESS"),
    explorerBaseUrl: env.ARC_EXPLORER_BASE_URL ?? null,
    network: "mainnet",
    environmentLabel: "Arc Mainnet",
  };
}

export function normalizeAddress(raw: string): Address {
  try {
    return getAddress(raw);
  } catch {
    throw Object.assign(new Error("Malformed EVM address"), { status: 400, code: "BAD_REQUEST" });
  }
}

export function isTxHash(raw: unknown): raw is Hex {
  return typeof raw === "string" && /^0x[a-fA-F0-9]{64}$/.test(raw);
}

/* ---------------- Vault ABI (minimal S2 surface) ---------------- */

export const VAULT_ABI = [
  {
    type: "function",
    name: "createCampaign",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignKey", type: "bytes32" },
      { name: "policyHash", type: "bytes32" },
      { name: "budgetCap", type: "uint256" },
      { name: "bountyCeiling", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "executor", type: "address" },
      { name: "verifier", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fundCampaign",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignKey", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getCampaign",
    stateMutability: "view",
    inputs: [{ name: "campaignKey", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          { name: "policyHash", type: "bytes32" },
          { name: "budgetCap", type: "uint256" },
          { name: "bountyCeiling", type: "uint256" },
          { name: "deadline", type: "uint64" },
          { name: "executor", type: "address" },
          { name: "verifier", type: "address" },
          { name: "funded", type: "uint256" },
          { name: "spent", type: "uint256" },
          { name: "paused", type: "bool" },
          { name: "closed", type: "bool" },
          { name: "returned", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "CampaignFunded",
    inputs: [
      { name: "campaignKey", type: "bytes32", indexed: true },
      { name: "funder", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "totalFunded", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "payoutVerifiedOutcome",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignKey", type: "bytes32" },
      { name: "outcomeId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proofHash", type: "bytes32" },
      { name: "occurredAt", type: "uint64" },
      { name: "validUntil", type: "uint64" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "outcomeUsed",
    stateMutability: "view",
    inputs: [{ name: "outcomeId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "event",
    name: "OutcomePaid",
    inputs: [
      { name: "campaignKey", type: "bytes32", indexed: true },
      { name: "policyHash", type: "bytes32", indexed: false },
      { name: "outcomeId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "proofHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Exact unsigned USDC transfer calldata for customer checkout. Never signs. */
export function buildUsdcTransfer(args: { usdc: Address; to: Address; amountMicroUsdc: bigint }): Hex {
  if (args.amountMicroUsdc <= 0n) throw new Error("Transfer amount must be positive");
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [args.to, args.amountMicroUsdc],
  });
}

/* ---------------- Unsigned funding intent ---------------- */

export type IntentPurpose = "create-campaign" | "approve-usdc" | "fund-campaign";

export interface UnsignedAction {
  purpose: IntentPurpose;
  chainId: number;
  /** Contract to call. */
  to: Address;
  /** Exact calldata. No signature, no broadcast. */
  data: Hex;
  /** Always zero: funding moves ERC20, never native value. */
  value: "0";
  /** Wallet that must send this action (owner browser wallet). */
  expectedSender: Address;
  expectedAmountMicroUsdc?: string;
}

/**
 * Build the exact unsigned owner actions for full-budget funding:
 * createCampaign (skipped when already onchain), approve USDC, fundCampaign.
 * Never signs. Never invents amounts: budget comes from the approved policy.
 */
export function buildFundingIntent(args: {
  config: ArcConfig;
  ownerAddress: Address;
  campaignKey: Hex;
  policyHash: Hex;
  budgetMicroUsdc: bigint;
  bountyCeilingMicroUsdc: bigint;
  deadlineUnix: bigint;
  executorAddress: Address | null;
  verifierAddress: Address | null;
  campaignExistsOnchain: boolean;
}): UnsignedAction[] {
  if (!args.config.vaultAddress) throw new Error("THESMA_VAULT_ADDRESS is not configured");
  const actions: UnsignedAction[] = [];
  if (!args.campaignExistsOnchain) {
    if (!args.executorAddress || !args.verifierAddress) {
      throw Object.assign(new Error("Executor/verifier addresses are required to register the campaign onchain"), {
        status: 400,
        code: "BAD_REQUEST",
      });
    }
    actions.push({
      purpose: "create-campaign",
      chainId: args.config.chainId,
      to: args.config.vaultAddress,
      data: encodeFunctionData({
        abi: VAULT_ABI,
        functionName: "createCampaign",
        args: [
          args.campaignKey,
          args.policyHash,
          args.budgetMicroUsdc,
          args.bountyCeilingMicroUsdc,
          args.deadlineUnix,
          args.executorAddress,
          args.verifierAddress,
        ],
      }),
      value: "0",
      expectedSender: args.ownerAddress,
    });
  }
  actions.push({
    purpose: "approve-usdc",
    chainId: args.config.chainId,
    to: args.config.usdcAddress,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [args.config.vaultAddress, args.budgetMicroUsdc],
    }),
    value: "0",
    expectedSender: args.ownerAddress,
    expectedAmountMicroUsdc: args.budgetMicroUsdc.toString(),
  });
  actions.push({
    purpose: "fund-campaign",
    chainId: args.config.chainId,
    to: args.config.vaultAddress,
    data: encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "fundCampaign",
      args: [args.campaignKey, args.budgetMicroUsdc],
    }),
    value: "0",
    expectedSender: args.ownerAddress,
    expectedAmountMicroUsdc: args.budgetMicroUsdc.toString(),
  });
  return actions;
}

/* ---------------- Operator vault (testnet RFB 04 hardening) ---------------- */

/**
 * ThesmaOperatorVault fragment: the two gated payout entrypoints, the
 * owner-only approval/policy writers, and the policy view. The v1
 * VAULT_ABI stays frozen for mainnet; this fragment is used only when the
 * operator executes on the Canteen testnet vault. Payout tuples are
 * identical to v1; the OutcomePaid event is identical so reconciliation
 * needs no changes.
 */
export const OPERATOR_VAULT_ABI = [
  {
    type: "function",
    name: "payoutAutonomous",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignKey", type: "bytes32" },
      { name: "outcomeId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proofHash", type: "bytes32" },
      { name: "occurredAt", type: "uint64" },
      { name: "validUntil", type: "uint64" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "payoutApproved",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignKey", type: "bytes32" },
      { name: "outcomeId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proofHash", type: "bytes32" },
      { name: "occurredAt", type: "uint64" },
      { name: "validUntil", type: "uint64" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "approveObligation",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignKey", type: "bytes32" },
      { name: "outcomeId", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proofHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setOperatorPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "campaignKey", type: "bytes32" },
      { name: "minReserve", type: "uint256" },
      { name: "maxAutonomousPayment", type: "uint256" },
      { name: "periodSpendCap", type: "uint256" },
      { name: "periodDuration", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getOperatorPolicy",
    stateMutability: "view",
    inputs: [{ name: "campaignKey", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "minReserve", type: "uint256" },
          { name: "maxAutonomousPayment", type: "uint256" },
          { name: "periodSpendCap", type: "uint256" },
          { name: "periodDuration", type: "uint64" },
          { name: "periodStart", type: "uint64" },
          { name: "spentInPeriod", type: "uint256" },
          { name: "enabled", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** Exact unsigned approveObligation calldata for the owner to sign. Never signs. */
export function buildApprovalIntent(args: {
  vault: Address;
  campaignKey: Hex;
  outcomeId: Hex;
  recipient: Address;
  amountMicroUsdc: bigint;
  proofHash: Hex;
}): { to: Address; data: Hex; value: "0" } {
  if (args.amountMicroUsdc <= 0n) throw new Error("Approval amount must be positive");
  return {
    to: args.vault,
    data: encodeFunctionData({
      abi: OPERATOR_VAULT_ABI,
      functionName: "approveObligation",
      args: [args.campaignKey, args.outcomeId, args.recipient, args.amountMicroUsdc, args.proofHash],
    }),
    value: "0",
  };
}

/**
 * Best-effort onchain operator-policy read (views only, never signs).
 * Returns null when the vault has no policy for the campaign or the RPC
 * cannot be reached — callers treat null as "unverified", never as
 * permission. Used to display onchain truth next to the DB cache.
 */
export async function readOperatorPolicyState(
  rpcUrl: string,
  vault: Address,
  campaignKey: Hex,
): Promise<{
  minReserve: bigint;
  maxAutonomousPayment: bigint;
  periodSpendCap: bigint;
  periodDuration: bigint;
  periodStart: bigint;
  spentInPeriod: bigint;
  enabled: boolean;
} | null> {
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    const p = await client.readContract({
      address: vault,
      abi: OPERATOR_VAULT_ABI,
      functionName: "getOperatorPolicy",
      args: [campaignKey],
    });
    return {
      minReserve: p.minReserve,
      maxAutonomousPayment: p.maxAutonomousPayment,
      periodSpendCap: p.periodSpendCap,
      periodDuration: p.periodDuration,
      periodStart: p.periodStart,
      spentInPeriod: p.spentInPeriod,
      enabled: p.enabled,
    };
  } catch {
    return null;
  }
}

/* ---------------- Chain reader ---------------- */

export interface VaultCampaignState {
  exists: boolean;
  owner: Address | null;
  policyHash: Hex | null;
  budgetCap: bigint;
  bountyCeiling: bigint;
  deadline: bigint;
  executor: Address | null;
  verifier: Address | null;
  funded: bigint;
  spent: bigint;
  paused: boolean;
  closed: boolean;
  returned: boolean;
}

export interface FundedEventEvidence {
  campaignKey: Hex;
  funder: Address;
  amount: bigint;
  totalFunded: bigint;
}

export interface TxReceiptSummary {
  status: "success" | "reverted";
  to: Address | null;
  blockNumber: bigint;
  fundedEvents: FundedEventEvidence[];
}

export interface ArcChainReader {
  getChainId(): Promise<number>;
  /** Null when the transaction is unknown (still pending or never submitted). */
  getReceipt(txHash: Hex): Promise<TxReceiptSummary | null>;
  readVaultCampaign(vault: Address, campaignKey: Hex): Promise<VaultCampaignState>;
  usdcBalanceOf(usdc: Address, account: Address): Promise<bigint>;
  hasCode(address: Address): Promise<boolean>;
}

export interface ObservedTransfer {
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
}

export interface TransferEvidence {
  /** Canonical transaction sender (tx.from), never client-supplied. */
  sender: Address;
  /** Canonical block timestamp in milliseconds, never client-supplied. */
  blockTimestampMs: number;
  blockNumber: bigint;
  transfers: ObservedTransfer[];
}

/** Extended reader for the S4 purchase verifier. Base reader is untouched. */
export interface VerifierChainReader extends ArcChainReader {
  /** Null when the transaction/block cannot be established (ambiguous). */
  getTransferEvidence(txHash: Hex): Promise<TransferEvidence | null>;
}

export interface PaidEventEvidence {
  campaignKey: Hex;
  policyHash: Hex;
  outcomeId: Hex;
  recipient: Address;
  amount: bigint;
  proofHash: Hex;
}

export interface PayoutEvidence {
  status: "success" | "reverted";
  to: Address | null;
  blockNumber: bigint;
  paid: PaidEventEvidence[];
}

/** Extended reader for the S5 payout reconciler. Prior readers untouched. */
export interface PayoutChainReader extends VerifierChainReader {
  /** Null when the receipt is unknown (ambiguous). Reverted receipts included. */
  getPayoutEvidence(txHash: Hex): Promise<PayoutEvidence | null>;
  isOutcomeConsumed(vault: Address, outcomeId: Hex): Promise<boolean>;
}

export class ViemArcReader implements ArcChainReader {
  private client;
  constructor(rpcUrl: string) {
    this.client = createPublicClient({ transport: http(rpcUrl) });
  }

  async getChainId(): Promise<number> {
    return this.client.getChainId();
  }

  async getReceipt(txHash: Hex): Promise<TxReceiptSummary | null> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch {
      return null; // unknown hash or node error surfaces as AMBIGUOUS upstream
    }
    const fundedEvents: FundedEventEvidence[] = [];
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "CampaignFunded") {
          const a = decoded.args as unknown as {
            campaignKey: Hex;
            funder: Address;
            amount: bigint;
            totalFunded: bigint;
          };
          fundedEvents.push({ campaignKey: a.campaignKey, funder: a.funder, amount: a.amount, totalFunded: a.totalFunded });
        }
      } catch {
        // Unrelated log: ignore.
      }
    }
    return {
      status: receipt.status === "success" ? "success" : "reverted",
      to: (receipt.to ?? null) as Address | null,
      blockNumber: receipt.blockNumber,
      fundedEvents,
    };
  }

  async readVaultCampaign(vault: Address, campaignKey: Hex): Promise<VaultCampaignState> {
    const c = await this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "getCampaign",
      args: [campaignKey],
    });
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    const exists = c.owner !== zero;
    return {
      exists,
      owner: exists ? c.owner : null,
      policyHash: exists ? (c.policyHash as Hex) : null,
      budgetCap: c.budgetCap,
      bountyCeiling: c.bountyCeiling,
      deadline: c.deadline,
      executor: c.executor,
      verifier: c.verifier,
      funded: c.funded,
      spent: c.spent,
      paused: c.paused,
      closed: c.closed,
      returned: c.returned,
    };
  }

  async getTransferEvidence(txHash: Hex): Promise<TransferEvidence | null> {
    let tx: { from: Address; blockNumber: bigint | null } | null = null;
    let receipt: { status: string; logs: Array<{ address: Address; data: Hex; topics: [Hex, ...Hex[]] }> } | null = null;
    try {
      const [t, r] = await Promise.all([
        this.client.getTransaction({ hash: txHash }),
        this.client.getTransactionReceipt({ hash: txHash }),
      ]);
      tx = { from: t.from, blockNumber: t.blockNumber };
      receipt = {
        status: r.status,
        logs: r.logs as Array<{ address: Address; data: Hex; topics: [Hex, ...Hex[]] }>,
      };
    } catch {
      return null;
    }
    if (!tx || tx.blockNumber === null || !receipt || receipt.status !== "success") return null;
    let blockTimestampMs: number;
    try {
      const block = await this.client.getBlock({ blockNumber: tx.blockNumber });
      blockTimestampMs = Number(block.timestamp) * 1000;
    } catch {
      return null;
    }
    const transfers: ObservedTransfer[] = [];
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "Transfer") {
          const a = decoded.args as unknown as { from: Address; to: Address; value: bigint };
          transfers.push({ token: log.address, from: a.from, to: a.to, amount: a.value });
        }
      } catch {
        // Not an ERC20 Transfer log: ignore.
      }
    }
    return { sender: tx.from, blockTimestampMs, blockNumber: tx.blockNumber, transfers };
  }

  async getPayoutEvidence(txHash: Hex): Promise<PayoutEvidence | null> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch {
      return null;
    }
    const paid: PaidEventEvidence[] = [];
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "OutcomePaid") {
          const a = decoded.args as unknown as {
            campaignKey: Hex;
            policyHash: Hex;
            outcomeId: Hex;
            recipient: Address;
            amount: bigint;
            proofHash: Hex;
          };
          paid.push({
            campaignKey: a.campaignKey,
            policyHash: a.policyHash,
            outcomeId: a.outcomeId,
            recipient: a.recipient,
            amount: a.amount,
            proofHash: a.proofHash,
          });
        }
      } catch {
        // Unrelated log: ignore.
      }
    }
    return {
      status: receipt.status === "success" ? "success" : "reverted",
      to: (receipt.to ?? null) as Address | null,
      blockNumber: receipt.blockNumber,
      paid,
    };
  }

  async isOutcomeConsumed(vault: Address, outcomeId: Hex): Promise<boolean> {
    return this.client.readContract({
      address: vault,
      abi: VAULT_ABI,
      functionName: "outcomeUsed",
      args: [outcomeId],
    });
  }

  async usdcBalanceOf(usdc: Address, account: Address): Promise<bigint> {
    return this.client.readContract({
      address: usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async hasCode(address: Address): Promise<boolean> {
    const code = await this.client.getCode({ address });
    return !!code && code !== "0x";
  }
}

/** Fail closed: RPC chain must equal configured chain. */
export async function assertChainMatches(reader: ArcChainReader, expectedChainId: number): Promise<void> {
  const actual = await reader.getChainId();
  if (actual !== expectedChainId) {
    throw Object.assign(new Error(`Chain mismatch: RPC reports ${actual}, expected ${expectedChainId}`), {
      status: 502,
      code: "CHAIN_MISMATCH",
    });
  }
}
