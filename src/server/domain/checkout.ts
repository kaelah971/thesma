import { createHash } from "node:crypto";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { z } from "zod";
import { microUsdcStringSchema } from "./validation";

/**
 * S4 customer purchase + outcome domain.
 *
 * Money rule: customer revenue goes DIRECTLY to the company wallet
 * (USDC transfer customer -> company). No Partner money moves in S4.
 *
 * Critical vocabulary: VERIFIED means purchase evidence passed. It does NOT
 * mean the Partner was paid. S5 must additionally respect holdUntil.
 */

export const CHECKOUT_STATUSES = ["PREPARED", "SUBMITTED", "CONFIRMED", "REJECTED", "AMBIGUOUS"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const OUTCOME_STATUSES = ["PENDING", "VERIFIED", "REJECTED"] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** Explicit verification reason codes — never a bare boolean. */
export const VERIFY_FAILURE_CODES = [
  "CHAIN_MISMATCH",
  "RECEIPT_UNKNOWN",
  "TX_REVERTED",
  "WRONG_TOKEN",
  "NO_TRANSFER",
  "WRONG_PAYER",
  "WRONG_MERCHANT",
  "WRONG_AMOUNT",
  "BELOW_MINIMUM",
  "LATE_TRANSACTION",
  "INTENT_EXPIRED",
  "TERMS_EXPIRED",
  "SELF_REFERRAL",
  "SELF_PURCHASE",
  "DUPLICATE_TX",
  "DUPLICATE_CUSTOMER",
  "POLICY_SUPERSEDED",
  "ATTRIBUTION_INVALID",
] as const;
export type VerifyFailureCode = (typeof VERIFY_FAILURE_CODES)[number];

const txHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Must be a 0x 32-byte transaction hash");

export const createCheckoutIntentSchema = z.object({
  /** Portable opaque handle from the referral redirect (?thesma_attribution=...). */
  attributionHandle: z.string().trim().min(1).max(200),
  payerAddress: z.string().trim().min(1).max(100),
  amountMicroUsdc: microUsdcStringSchema,
});

export const submitCheckoutSchema = z.object({
  txHash: txHashSchema,
});

/**
 * Privacy-safe customer key: salted hash of canonical payer + campaign scope.
 * Never a raw wallet string. One VERIFIED outcome per (campaign, key).
 */
export function customerKeyFor(chainId: number, payerAddress: string, campaignId: string): string {
  return createHash("sha256")
    .update(`thesma:customer:v1:${chainId}:${payerAddress.toLowerCase()}:${campaignId}`, "utf8")
    .digest("hex");
}

/**
 * Deterministic outcome proof binding (S4 verification evidence).
 * S5 reuses this proofHash as the payout proof scope under verifier signature.
 *
 *   proofHash = keccak256(abi.encode(
 *     "thesma:outcome:v1", chainId, purchaseTx, campaignId,
 *     partnerId, payer, amountMicroUsdc, blockNumber, occurredAtMs
 *   ))
 */
export function outcomeProofFor(args: {
  chainId: number;
  purchaseTx: Hex;
  campaignId: string;
  partnerId: string;
  payer: string;
  amountMicroUsdc: bigint;
  blockNumber: bigint;
  occurredAtMs: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "string" },
        { type: "string" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        "thesma:outcome:v1",
        BigInt(args.chainId),
        args.purchaseTx,
        args.campaignId,
        args.partnerId,
        args.payer as Hex,
        args.amountMicroUsdc,
        args.blockNumber,
        BigInt(args.occurredAtMs),
      ],
    ),
  );
}

export function serializeCheckoutIntent<T extends {
  id: string;
  orderId: string;
  campaignId: string;
  amountMicroUsdc: bigint;
  merchantAddress: string;
  payerAddress: string;
  chainId: number;
  usdcAddress: string;
  status: string;
  txHash: string | null;
  expiresAt: Date;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}>(i: T) {
  return {
    ...i,
    amountMicroUsdc: i.amountMicroUsdc.toString(),
    expiresAt: i.expiresAt.toISOString(),
    submittedAt: i.submittedAt?.toISOString() ?? null,
    confirmedAt: i.confirmedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

export function serializeOutcome<T extends {
  id: string;
  campaignId: string;
  purchaseAmountMicroUsdc: bigint;
  status: string;
  proofHash: string | null;
  blockNumber: number | null;
  occurredAt: Date | null;
  verifiedAt: Date | null;
  holdUntil: Date | null;
  rejectionCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}>(o: T) {
  return {
    ...o,
    purchaseAmountMicroUsdc: o.purchaseAmountMicroUsdc.toString(),
    occurredAt: o.occurredAt?.toISOString() ?? null,
    verifiedAt: o.verifiedAt?.toISOString() ?? null,
    holdUntil: o.holdUntil?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}
