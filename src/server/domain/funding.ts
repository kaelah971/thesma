import { z } from "zod";
import { expectedVersionSchema } from "./campaign";

const txHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Must be a 0x 32-byte transaction hash");

export const companyWalletChallengeRequestSchema = z.object({
  /** Candidate wallet address; normalized server-side. Nothing is registered yet. */
  address: z.string().trim().min(1).max(100),
});

export const companyWalletRequestSchema = z.object({
  /** Raw address text; normalized + validated server-side (malformed -> 400). */
  address: z.string().trim().min(1).max(100),
  /** Server-issued single-use challenge nonce (binds user + workspace + wallet). */
  nonce: z.string().trim().min(1).max(100),
  /** Owner's EIP-712 signature over the challenge typed data (ownership proof, never a tx). */
  signature: z.string().trim().min(1).max(500),
  /** Address the client passed as the eth_signTypedData_v4 signer (diagnostic echo only, never trusted). */
  signingAccount: z.string().trim().min(1).max(100).optional(),
  /** Required only when replacing an already-registered DIFFERENT wallet. */
  confirmChange: z.boolean().optional(),
});

export const fundingSubmittedRequestSchema = expectedVersionSchema.extend({
  createTxHash: txHashSchema.optional(),
  approveTxHash: txHashSchema.optional(),
  fundingTxHash: txHashSchema.optional(),
}).refine((v) => v.createTxHash ?? v.approveTxHash ?? v.fundingTxHash, {
  message: "At least one transaction hash is required",
});

export const fundingStatusQuerySchema = z.object({
  expectedVersion: z.coerce.number().int().min(1).optional(),
});

export const fundingConfirmRequestSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
});
