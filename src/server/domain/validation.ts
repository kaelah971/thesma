import { z } from "zod";
import { WORKSPACE_ROLES } from "./enums";

const evmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a 0x EVM address")
  .nullable()
  .optional();

export const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100).nullish(),
});

export const signinSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  category: z.string().trim().max(100).nullish(),
});

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);

/** Exact-integer micro-USDC as decimal string (no floats over the wire). */
export const microUsdcStringSchema = z
  .string()
  .regex(/^\d+$/, "Must be an exact integer micro-USDC string");

export const partnerRulesSchema = z.object({
  minBountyMicroUSDC: microUsdcStringSchema.nullish(),
  allowedCategories: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  blockedCategories: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  maxActiveCampaigns: z.number().int().min(1).max(100).nullish(),
  autoJoin: z.boolean().default(false),
  autoNegotiate: z.boolean().default(false),
  maxAllocation: z.number().int().min(1).max(10_000).nullish(),
});

export const createPartnerSchema = z.object({
  payoutWallet: evmAddress,
  categories: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  rulesJson: partnerRulesSchema.default({
    allowedCategories: [],
    blockedCategories: [],
    autoJoin: false,
    autoNegotiate: false,
  }),
});

export const updatePartnerSchema = z
  .object({
    payoutWallet: evmAddress,
    categories: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    rulesJson: partnerRulesSchema.partial().optional(),
  })
  .refine((v) => v.payoutWallet !== undefined || v.categories !== undefined || v.rulesJson !== undefined, {
    message: "At least one field must be provided",
  });

export type SignupInput = z.infer<typeof signupSchema>;
export type SigninInput = z.infer<typeof signinSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type CreatePartnerInput = z.infer<typeof createPartnerSchema>;
export type UpdatePartnerInput = z.infer<typeof updatePartnerSchema>;
