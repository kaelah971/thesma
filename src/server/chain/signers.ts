import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { outcomeProofDomain, OUTCOME_PROOF_TYPES, type OutcomeProofMessage } from "../domain/payout";
import { OPERATOR_VAULT_ABI, VAULT_ABI } from "./arc";

/** Shared 8-field payout tuple: identical across v1 + operator entrypoints. */
function payoutArgsTuple(args: PayoutSubmitArgs) {
  return [
    args.campaignKey,
    args.outcomeId,
    args.recipient,
    args.amount,
    args.proofHash,
    args.occurredAt,
    args.validUntil,
    args.signature,
  ] as const;
}

/**
 * Signer/executor boundaries (S5). The model, the client, and route handlers
 * never see signing material: private keys enter only through server-only env
 * into these adapters, and derived addresses must match the configured
 * campaign identities or construction fails closed.
 *
 * A Circle-controlled signer/wallet adapter replaces these classes later
 * without touching domain or service logic. Circle support is NOT required
 * for S5 (local-key path is the exercised one).
 */

export interface OutcomeProofSigner {
  /** Verifier identity that must equal the campaign's onchain verifier. */
  readonly address: Address;
  signVerifiedOutcomeProof(args: {
    chainId: number;
    vault: Address;
    message: OutcomeProofMessage;
  }): Promise<Hex>;
  proofDigest(args: { chainId: number; vault: Address; message: OutcomeProofMessage }): Hex;
}

export interface PayoutSubmitArgs extends OutcomeProofMessage {
  vault: Address;
  signature: Hex;
}

export interface PayoutExecutor {
  /** Executor identity that must equal the campaign's onchain executor. */
  readonly address: Address;
  submitVerifiedOutcomePayout(args: PayoutSubmitArgs): Promise<Hex>;
  /**
   * ThesmaOperatorVault (testnet) entrypoints. Optional so existing
   * executors keep compiling; the operator path fails closed when absent.
   */
  submitAutonomousPayout?(args: PayoutSubmitArgs): Promise<Hex>;
  submitApprovedPayout?(args: PayoutSubmitArgs): Promise<Hex>;
}

function parsePrivateKey(raw: string | undefined, name: string): Hex {
  if (!raw || !/^0x[a-fA-F0-9]{64}$/.test(raw)) {
    throw Object.assign(new Error(`${name} must be a 0x 32-byte key`), { status: 503, code: "SIGNER_UNCONFIGURED" });
  }
  return raw as Hex;
}

export class LocalKeyProofSigner implements OutcomeProofSigner {
  readonly address: Address;
  private account;
  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }
  proofDigest(args: { chainId: number; vault: Address; message: OutcomeProofMessage }): Hex {
    return hashTypedData({
      domain: { ...outcomeProofDomain(args.chainId, args.vault) },
      types: { ...OUTCOME_PROOF_TYPES },
      primaryType: "OutcomeProof",
      message: { ...args.message },
    });
  }
  async signVerifiedOutcomeProof(args: {
    chainId: number;
    vault: Address;
    message: OutcomeProofMessage;
  }): Promise<Hex> {
    // Pure local EIP-712 signing: nothing is broadcast and no RPC is needed.
    return this.account.signTypedData({
      domain: { ...outcomeProofDomain(args.chainId, args.vault) },
      types: { ...OUTCOME_PROOF_TYPES },
      primaryType: "OutcomeProof",
      message: { ...args.message },
    });
  }
}

export class LocalKeyPayoutExecutor implements PayoutExecutor {
  readonly address: Address;
  private wallet;
  private chain;
  constructor(
    rpcUrl: string,
    privateKey: Hex,
    chainId: number,
  ) {
    const account = privateKeyToAccount(privateKey);
    this.address = account.address;
    this.chain = {
      id: chainId,
      name: "thesma-target",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    } as const;
    this.wallet = createWalletClient({ account, chain: this.chain, transport: http(rpcUrl) });
  }
  async submitVerifiedOutcomePayout(args: PayoutSubmitArgs): Promise<Hex> {
    const data = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "payoutVerifiedOutcome",
      args: payoutArgsTuple(args),
    });
    return this.wallet.sendTransaction({ to: args.vault, data, value: 0n });
  }
  async submitAutonomousPayout(args: PayoutSubmitArgs): Promise<Hex> {
    const data = encodeFunctionData({
      abi: OPERATOR_VAULT_ABI,
      functionName: "payoutAutonomous",
      args: payoutArgsTuple(args),
    });
    return this.wallet.sendTransaction({ to: args.vault, data, value: 0n });
  }
  async submitApprovedPayout(args: PayoutSubmitArgs): Promise<Hex> {
    const data = encodeFunctionData({
      abi: OPERATOR_VAULT_ABI,
      functionName: "payoutApproved",
      args: payoutArgsTuple(args),
    });
    return this.wallet.sendTransaction({ to: args.vault, data, value: 0n });
  }
}

/** Null when unconfigured; throws (fail closed) on address mismatch. Never logs keys. */
export function proofSignerFromEnv(env: NodeJS.ProcessEnv = process.env): OutcomeProofSigner | null {
  if (!env.THESMA_VERIFIER_PRIVATE_KEY) return null;
  const signer = new LocalKeyProofSigner(parsePrivateKey(env.THESMA_VERIFIER_PRIVATE_KEY, "THESMA_VERIFIER_PRIVATE_KEY"));
  if (env.THESMA_VERIFIER_ADDRESS && getAddress(env.THESMA_VERIFIER_ADDRESS) !== signer.address) {
    throw Object.assign(new Error("Derived verifier address does not match THESMA_VERIFIER_ADDRESS"), {
      status: 503,
      code: "SIGNER_MISMATCH",
    });
  }
  return signer;
}

export function payoutExecutorFromEnv(
  rpcUrl: string,
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): PayoutExecutor | null {
  if (!env.THESMA_EXECUTOR_PRIVATE_KEY) return null;
  const executor = new LocalKeyPayoutExecutor(rpcUrl, parsePrivateKey(env.THESMA_EXECUTOR_PRIVATE_KEY, "THESMA_EXECUTOR_PRIVATE_KEY"), chainId);
  if (env.THESMA_EXECUTOR_ADDRESS && getAddress(env.THESMA_EXECUTOR_ADDRESS) !== executor.address) {
    throw Object.assign(new Error("Derived executor address does not match THESMA_EXECUTOR_ADDRESS"), {
      status: 503,
      code: "EXECUTOR_MISMATCH",
    });
  }
  return executor;
}

export function publicClientFor(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl) });
}
