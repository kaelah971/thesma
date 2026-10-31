import { z } from "zod";
import { expectedVersionSchema } from "./campaign";

const txHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "Must be a 0x 32-byte transaction hash");

export const companyWalletChallengeRequestSchema = z.object({});

export const companyWalletProveRequestSchema = z.object({
  /** Server-issued single-use challenge nonce. */
  nonce: z.string().trim().min(1).max(100),
  /** Owner's EIP-712 signature over the workspace-bound challenge typed data (ownership proof, never a tx). */
  signature: z.string().trim().min(1).max(500),
});

export const companyWalletRequestSchema = z.object({
  /** Server-issued single-use nonce of an already-PROVED challenge. The stored recovered signer is registered; the client sends no address. */
  nonce: z.string().trim().min(1).max(100),
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
