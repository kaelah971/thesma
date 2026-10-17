import { z } from "zod";
import type { CampaignState } from "./enums";
import { microUsdcStringSchema } from "./validation";

/**
 * S1 campaign intent + policy domain.
 *
 * Product rule: the human sets the objective and hard boundaries, the
 * interpreter prepares them, and only the organization owner approves.
 * APPROVED policy versions are immutable — revision creates a new version.
 *
 * All USDC-domain amounts are exact integer micro-USDC (S0 money module):
 * decimal strings on the wire, bigint in domain logic. Never floats.
 */

export const MARKET_VISIBILITIES = ["PUBLIC", "PRIVATE"] as const;
export type MarketVisibility = (typeof MARKET_VISIBILITIES)[number];

export const POLICY_VERSION_STATUSES = ["DRAFT", "REVIEW", "APPROVED"] as const;
export type PolicyVersionStatus = (typeof POLICY_VERSION_STATUSES)[number];

/** Owner-controlled hard fields (PRD section 6). Agents may never change these. */
export const OWNER_CONTROLLED_CAMPAIGN_FIELDS = [
  "targetOutcomeCount",
  "budgetMicroUsdc",
  "bountyFloorMicroUsdc",
  "bountyCeilingMicroUsdc",
  "minQualifyingPurchaseMicroUsdc",
  "deadline",
  "marketVisibility",
  "allowedPartnerRulesJson",
  "refundHoldSeconds",
  "escalationRulesJson",
] as const;

/** Fields that must be present before a draft may enter REVIEW. */
export const REQUIRED_POLICY_FIELDS = [
  "targetOutcomeCount",
  "budgetMicroUsdc",
  "bountyFloorMicroUsdc",
  "bountyCeilingMicroUsdc",
  "minQualifyingPurchaseMicroUsdc",
  "deadline",
] as const;
export type RequiredPolicyField = (typeof REQUIRED_POLICY_FIELDS)[number];

export interface CampaignPolicyFields {
  targetOutcomeCount: number | null;
  budgetMicroUsdc: bigint | null;
  bountyFloorMicroUsdc: bigint | null;
  bountyCeilingMicroUsdc: bigint | null;
  minQualifyingPurchaseMicroUsdc: bigint | null;
  deadline: Date | null;
  marketVisibility: MarketVisibility;
  allowedPartnerRulesJson: Record<string, unknown>;
  refundHoldSeconds: number;
  escalationRulesJson: Record<string, unknown>;
}

export interface CampaignPolicyVersion extends CampaignPolicyFields {
  id: string;
  campaignId: string;
  version: number;
  intentText: string;
  status: PolicyVersionStatus;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface Campaign {
  id: string;
  workspaceId: string;
  /** S1 permits only DRAFT | REVIEW | APPROVED (see assertS1Transition). */
  state: CampaignState;
  currentPolicyVersionId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PolicyIssueCode = "REQUIRED" | "INVALID" | "RANGE" | "UNAFFORDABLE" | "EXPIRED";

export interface PolicyIssue {
  field: string;
  code: PolicyIssueCode;
  message: string;
}

export interface PolicyAnalysis {
  missing: RequiredPolicyField[];
  issues: PolicyIssue[];
}

/**
 * Pure policy analysis. `checkDeadlineFuture` is true only on the approval
 * path — REVIEW requires a deadline to exist, APPROVAL requires it to still
 * be in the future. `now` is injectable for deterministic tests.
 */
export function analyzePolicyFields(
  fields: CampaignPolicyFields,
  opts?: { checkDeadlineFuture?: boolean; now?: Date },
): PolicyAnalysis {
  const missing = (REQUIRED_POLICY_FIELDS as readonly string[]).filter(
    (f) => fields[f as RequiredPolicyField] === null,
  ) as RequiredPolicyField[];
  const issues: PolicyIssue[] = [];
  const now = opts?.now ?? new Date();

  if (fields.targetOutcomeCount !== null) {
    if (!Number.isInteger(fields.targetOutcomeCount) || fields.targetOutcomeCount <= 0) {
      issues.push({ field: "targetOutcomeCount", code: "INVALID", message: "Target outcome count must be a positive integer" });
    }
  }
  if (fields.budgetMicroUsdc !== null && fields.budgetMicroUsdc <= 0n) {
    issues.push({ field: "budgetMicroUsdc", code: "INVALID", message: "Budget must be greater than zero" });
  }
  if (fields.bountyFloorMicroUsdc !== null && fields.bountyFloorMicroUsdc < 0n) {
    issues.push({ field: "bountyFloorMicroUsdc", code: "INVALID", message: "Bounty floor cannot be negative" });
  }
  if (fields.bountyCeilingMicroUsdc !== null && fields.bountyCeilingMicroUsdc <= 0n) {
    issues.push({ field: "bountyCeilingMicroUsdc", code: "INVALID", message: "Bounty ceiling must be greater than zero" });
  }
  if (fields.minQualifyingPurchaseMicroUsdc !== null && fields.minQualifyingPurchaseMicroUsdc < 0n) {
    issues.push({ field: "minQualifyingPurchaseMicroUsdc", code: "INVALID", message: "Minimum qualifying purchase cannot be negative" });
  }
  if (
    fields.bountyFloorMicroUsdc !== null &&
    fields.bountyCeilingMicroUsdc !== null &&
    fields.bountyFloorMicroUsdc > fields.bountyCeilingMicroUsdc
  ) {
    issues.push({ field: "bountyFloorMicroUsdc", code: "RANGE", message: "Bounty floor cannot exceed bounty ceiling" });
  }
  if (
    fields.targetOutcomeCount !== null &&
    Number.isInteger(fields.targetOutcomeCount) &&
    fields.targetOutcomeCount > 0 &&
    fields.budgetMicroUsdc !== null &&
    fields.budgetMicroUsdc > 0n &&
    fields.bountyFloorMicroUsdc !== null &&
    fields.bountyFloorMicroUsdc >= 0n &&
    BigInt(fields.targetOutcomeCount) * fields.bountyFloorMicroUsdc > fields.budgetMicroUsdc
  ) {
    issues.push({
      field: "budgetMicroUsdc",
      code: "UNAFFORDABLE",
      message: "Budget cannot cover target outcomes even at the bounty floor",
    });
  }
  if (opts?.checkDeadlineFuture && fields.deadline !== null && fields.deadline <= now) {
    issues.push({ field: "deadline", code: "EXPIRED", message: "Deadline must be in the future at approval time" });
  }
  if (fields.refundHoldSeconds < 0 || !Number.isInteger(fields.refundHoldSeconds)) {
    issues.push({ field: "refundHoldSeconds", code: "INVALID", message: "Refund hold must be a non-negative integer number of seconds" });
  }
  return { missing, issues };
}

export function isPolicySatisfied(analysis: PolicyAnalysis): boolean {
  return analysis.missing.length === 0 && analysis.issues.length === 0;
}

/**
 * S1 state machine. FUNDING/LIVE/PAUSED/CLOSING/CLOSED exist as enums for
 * later slices but have no legal entry in S1 — any attempt is rejected.
 */
const S1_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ["REVIEW"],
  REVIEW: ["DRAFT", "APPROVED"],
  // APPROVED -> DRAFT happens only via a new revision version, never by
  // editing the approved version in place.
  APPROVED: ["DRAFT"],
};

export function assertS1Transition(from: CampaignState, to: CampaignState): void {
  const allowed = S1_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw Object.assign(new Error(`Illegal S1 campaign transition: ${from} -> ${to}`), {
      status: 400,
      code: "BAD_REQUEST",
    });
  }
}

/* ---------------- Wire schemas (Zod at request boundaries) ---------------- */

const isoDatetime = z.string().datetime({ offset: true });

export const campaignFieldOverridesSchema = z.object({
  targetOutcomeCount: z.number().int().min(1).max(1_000_000).optional(),
  budgetMicroUsdc: microUsdcStringSchema.optional(),
  bountyFloorMicroUsdc: microUsdcStringSchema.optional(),
  bountyCeilingMicroUsdc: microUsdcStringSchema.optional(),
  minQualifyingPurchaseMicroUsdc: microUsdcStringSchema.optional(),
  deadline: isoDatetime.optional(),
  marketVisibility: z.enum(MARKET_VISIBILITIES).optional(),
  allowedPartnerRulesJson: z.record(z.string(), z.unknown()).optional(),
  refundHoldSeconds: z.number().int().min(0).max(31_536_000).optional(),
  escalationRulesJson: z.record(z.string(), z.unknown()).optional(),
});

export type CampaignFieldOverrides = z.infer<typeof campaignFieldOverridesSchema>;

export const createDraftRequestSchema = z.object({
  workspaceId: z.string().min(1).max(100),
  intentText: z.string().trim().min(1).max(2000),
  overrides: campaignFieldOverridesSchema.optional(),
});

export const expectedVersionSchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export const reviseDraftRequestSchema = expectedVersionSchema.extend({
  patch: campaignFieldOverridesSchema,
});

export const listCampaignsQuerySchema = z.object({
  workspaceId: z.string().min(1).max(100),
});

/* ---------------- Serialization (bigint/Date -> JSON-safe) ---------------- */

export interface SerializedPolicyVersion {
  id: string;
  campaignId: string;
  version: number;
  intentText: string;
  status: PolicyVersionStatus;
  targetOutcomeCount: number | null;
  budgetMicroUsdc: string | null;
  bountyFloorMicroUsdc: string | null;
  bountyCeilingMicroUsdc: string | null;
  minQualifyingPurchaseMicroUsdc: string | null;
  deadline: string | null;
  marketVisibility: MarketVisibility;
  allowedPartnerRulesJson: Record<string, unknown>;
  refundHoldSeconds: number;
  escalationRulesJson: Record<string, unknown>;
  approvedByUserId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export function serializePolicyVersion(v: CampaignPolicyVersion): SerializedPolicyVersion {
  return {
    id: v.id,
    campaignId: v.campaignId,
    version: v.version,
    intentText: v.intentText,
    status: v.status,
    targetOutcomeCount: v.targetOutcomeCount,
    budgetMicroUsdc: v.budgetMicroUsdc === null ? null : v.budgetMicroUsdc.toString(),
    bountyFloorMicroUsdc: v.bountyFloorMicroUsdc === null ? null : v.bountyFloorMicroUsdc.toString(),
    bountyCeilingMicroUsdc: v.bountyCeilingMicroUsdc === null ? null : v.bountyCeilingMicroUsdc.toString(),
    minQualifyingPurchaseMicroUsdc:
      v.minQualifyingPurchaseMicroUsdc === null ? null : v.minQualifyingPurchaseMicroUsdc.toString(),
    deadline: v.deadline === null ? null : v.deadline.toISOString(),
    marketVisibility: v.marketVisibility,
    allowedPartnerRulesJson: v.allowedPartnerRulesJson,
    refundHoldSeconds: v.refundHoldSeconds,
    escalationRulesJson: v.escalationRulesJson,
    approvedByUserId: v.approvedByUserId,
    approvedAt: v.approvedAt === null ? null : v.approvedAt.toISOString(),
    createdAt: v.createdAt.toISOString(),
  };
}

export function serializeCampaign(c: Campaign) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    state: c.state,
    currentPolicyVersionId: c.currentPolicyVersionId,
    createdByUserId: c.createdByUserId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
