import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { z } from "zod";

/**
 * S5 payout domain. Language discipline is load-bearing here:
 * - SUBMITTED means broadcast, never settled.
 * - SETTLED means chain reconciliation passed on canonical evidence.
 * - VERIFIED (S4) never meant paid, and still doesn't.
 */

export const RESERVATION_STATES = ["RESERVED", "SUBMITTED", "SETTLED", "FAILED", "AMBIGUOUS", "RELEASED"] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const PAYOUT_STATES = ["PREPARED", "SUBMITTED", "SETTLED", "FAILED", "AMBIGUOUS"] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

/** Contract outcome IDs are bytes32; backend outcome rows are UUIDs. */
export function outcomeId32For(outcomeId: string): Hex {
  return keccak256(stringToHex(`thesma:outcome:${outcomeId}`));
}

/**
 * EXACT EIP-712 shape of ThesmaMarketVault.payoutVerifiedOutcome.
 * Domain: name "ThesmaMarketVault", version "1", chainId, verifyingContract.
 * Any deviation reverts onchain — pinned by the Anvil E2E (S5) which submits
 * a backend-signed proof through the real contract.
 */
export const OUTCOME_PROOF_TYPES = {
  OutcomeProof: [
    { name: "campaignKey", type: "bytes32" },
    { name: "policyHash", type: "bytes32" },
    { name: "outcomeId", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "proofHash", type: "bytes32" },
    { name: "occurredAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export interface OutcomeProofMessage {
  campaignKey: Hex;
  policyHash: Hex;
  outcomeId: Hex;
  recipient: Address;
  amount: bigint;
  proofHash: Hex;
  occurredAt: bigint;
  validUntil: bigint;
}

export function outcomeProofDomain(chainId: number, vault: Address) {
  return { name: "ThesmaMarketVault", version: "1", chainId, verifyingContract: vault } as const;
}

/** Short but operational proof lifetime (30 minutes). */
export const PROOF_TTL_MS = 30 * 60 * 1000;

export const processPayoutsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

export function serializeReservation<T extends {
  id: string;
  campaignId: string;
  outcomeId: string;
  partnerId: string;
  amountMicroUsdc: bigint;
  state: string;
  createdAt: Date;
  updatedAt: Date;
}>(r: T) {
  return { ...r, amountMicroUsdc: r.amountMicroUsdc.toString(), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

export function serializePayout<T extends {
  id: string;
  reservationId: string;
  outcomeId: string;
  campaignId: string;
  partnerId: string;
  recipient: string;
  amountMicroUsdc: bigint;
  proofHash: string;
  verifierSignature: string | null;
  txHash: string | null;
  state: string;
  blockNumber: number | null;
  submittedAt: Date | null;
  settledAt: Date | null;
  reconciledAt: Date | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}>(p: T) {
  return {
    ...p,
    amountMicroUsdc: p.amountMicroUsdc.toString(),
    submittedAt: p.submittedAt?.toISOString() ?? null,
    settledAt: p.settledAt?.toISOString() ?? null,
    reconciledAt: p.reconciledAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
