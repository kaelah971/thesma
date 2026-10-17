import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { MarketState } from "./enums";
import { microUsdcStringSchema } from "./validation";

export type { MarketState };

/**
 * S3 market domain. Pace is NOT calculated in S3 (S6 pricing kernel owns it);
 * opened markets start at OPEN. No floats anywhere: micro-USDC decimal
 * strings on the wire, bigint in logic.
 */

export const TERMS_SOURCE_PUBLIC = "PUBLIC" as const;
export const TERMS_SOURCE_NEGOTIATED = "NEGOTIATED" as const;
export type TermsSource = typeof TERMS_SOURCE_PUBLIC | typeof TERMS_SOURCE_NEGOTIATED;

export const TERMS_STATUSES = ["ACTIVE", "EXPIRED", "REVOKED"] as const;
export type TermsStatus = (typeof TERMS_STATUSES)[number];

export const REFERRAL_EVENT_CLICK = "CLICK" as const;

/* ---------------- Partner rules (strict, canonical S3 names) ---------------- */

export interface PartnerRules {
  minimumBountyMicroUsdc: bigint;
  allowedCategories: string[];
  blockedCategories: string[];
  maxActiveCampaigns: number | null;
  autoJoin: boolean;
  autoNegotiate: boolean;
  maxAllocationCount: number | null;
}

export const DEFAULT_PARTNER_RULES: PartnerRules = {
  minimumBountyMicroUsdc: 0n,
  allowedCategories: [],
  blockedCategories: [],
  maxActiveCampaigns: null,
  autoJoin: false,
  autoNegotiate: false,
  maxAllocationCount: null,
};

export const partnerRulesWireSchema = z.object({
  minimumBountyMicroUsdc: microUsdcStringSchema.default("0"),
  allowedCategories: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  blockedCategories: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  maxActiveCampaigns: z.number().int().min(1).max(1000).nullish(),
  autoJoin: z.boolean().default(false),
  autoNegotiate: z.boolean().default(false),
  maxAllocationCount: z.number().int().min(1).max(100_000).nullish(),
});

/**
 * Normalize stored rulesJson into canonical rules. Accepts the provisional
 * S0 key names (minBountyMicroUSDC, maxAllocation) as legacy aliases so
 * existing Partner profiles keep working; canonical S3 names win on conflict.
 */
export function parsePartnerRules(raw: unknown): { ok: true; rules: PartnerRules } | { ok: false; issues: string[] } {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const mapped: Record<string, unknown> = { ...obj };
  if (mapped.minimumBountyMicroUsdc === undefined && mapped.minBountyMicroUSDC !== undefined) {
    mapped.minimumBountyMicroUsdc = mapped.minBountyMicroUSDC;
  }
  if (mapped.maxAllocationCount === undefined && mapped.maxAllocation !== undefined) {
    mapped.maxAllocationCount = mapped.maxAllocation;
  }
  const parsed = partnerRulesWireSchema.safeParse(mapped);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "rules"}: ${i.message}`) };
  }
  const r = parsed.data;
  return {
    ok: true,
    rules: {
      minimumBountyMicroUsdc: BigInt(r.minimumBountyMicroUsdc),
      allowedCategories: r.allowedCategories,
      blockedCategories: r.blockedCategories,
      maxActiveCampaigns: r.maxActiveCampaigns ?? null,
      autoJoin: r.autoJoin,
      autoNegotiate: r.autoNegotiate,
      maxAllocationCount: r.maxAllocationCount ?? null,
    },
  };
}

export function serializePartnerRules(r: PartnerRules) {
  return {
    minimumBountyMicroUsdc: r.minimumBountyMicroUsdc.toString(),
    allowedCategories: r.allowedCategories,
    blockedCategories: r.blockedCategories,
    maxActiveCampaigns: r.maxActiveCampaigns,
    autoJoin: r.autoJoin,
    autoNegotiate: r.autoNegotiate,
    maxAllocationCount: r.maxAllocationCount,
  };
}

/* ---------------- Join eligibility (pure, deterministic) ---------------- */

export type EligibilityFailure =
  | "MARKET_NOT_OPEN"
  | "CAMPAIGN_NOT_LIVE"
  | "EXPIRED"
  | "MIN_BOUNTY"
  | "CATEGORY_BLOCKED"
  | "CATEGORY_NOT_ALLOWED"
  | "MAX_ACTIVE"
  | "MAX_ALLOCATION"
  | "WALLET_REQUIRED";

export function checkJoinEligibility(args: {
  marketStatus: MarketState;
  campaignLive: boolean;
  deadline: Date | null;
  publicBountyMicroUsdc: bigint;
  rules: PartnerRules;
  campaignCategory: string | null;
  activeTermsCount: number;
  requestedAllocation: number;
  payoutWallet: string | null;
  now: Date;
}): { ok: true } | { ok: false; reason: EligibilityFailure; message: string } {
  const a = args;
  if (a.marketStatus !== "OPEN") {
    return { ok: false, reason: "MARKET_NOT_OPEN", message: "Market is not open" };
  }
  if (!a.campaignLive) {
    return { ok: false, reason: "CAMPAIGN_NOT_LIVE", message: "Campaign is not live" };
  }
  if (!a.deadline || a.deadline <= a.now) {
    return { ok: false, reason: "EXPIRED", message: "Campaign deadline has passed" };
  }
  if (!a.payoutWallet) {
    return { ok: false, reason: "WALLET_REQUIRED", message: "Partner payout wallet is required before joining" };
  }
  if (a.publicBountyMicroUsdc < a.rules.minimumBountyMicroUsdc) {
    return { ok: false, reason: "MIN_BOUNTY", message: "Public bounty is below the Partner minimum" };
  }
  const category = (a.campaignCategory ?? "").trim().toLowerCase();
  const blocked = a.rules.blockedCategories.map((c) => c.toLowerCase());
  if (category && blocked.includes(category)) {
    return { ok: false, reason: "CATEGORY_BLOCKED", message: "Campaign category is blocked by Partner rules" };
  }
  const allowed = a.rules.allowedCategories.map((c) => c.toLowerCase());
  if (allowed.length > 0 && (!category || !allowed.includes(category))) {
    return { ok: false, reason: "CATEGORY_NOT_ALLOWED", message: "Campaign category is not in Partner allowed list" };
  }
  if (a.rules.maxActiveCampaigns !== null && a.activeTermsCount >= a.rules.maxActiveCampaigns) {
    return { ok: false, reason: "MAX_ACTIVE", message: "Partner active campaign limit reached" };
  }
  if (
    !Number.isInteger(a.requestedAllocation) ||
    a.requestedAllocation < 1 ||
    (a.rules.maxAllocationCount !== null && a.requestedAllocation > a.rules.maxAllocationCount)
  ) {
    return { ok: false, reason: "MAX_ALLOCATION", message: "Requested allocation exceeds Partner maximum" };
  }
  return { ok: true };
}

/* ---------------- Destination URL safety (anti-open-redirect) ---------------- */

export function assertSafeDestinationUrl(raw: string, opts?: { allowLocalhost?: boolean }): string {
  const text = (raw ?? "").trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw Object.assign(new Error("Destination URL is malformed"), { status: 400, code: "BAD_REQUEST" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("Destination URL must use http or https"), { status: 400, code: "BAD_REQUEST" });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error("Destination URL must not embed credentials"), { status: 400, code: "BAD_REQUEST" });
  }
  if (!url.hostname) {
    throw Object.assign(new Error("Destination URL needs a hostname"), { status: 400, code: "BAD_REQUEST" });
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (local && !opts?.allowLocalhost) {
    throw Object.assign(new Error("Localhost destinations are development-only"), { status: 400, code: "BAD_REQUEST" });
  }
  return url.href;
}

/* ---------------- Opaque identifiers ---------------- */

/** Opaque, random referral codes — never sequential IDs. */
export function newReferralCode(): string {
  return randomBytes(9).toString("base64url");
}

/* ---------------- Wire schemas ---------------- */

export const openMarketRequestSchema = z.object({
  expectedPolicyVersion: z.number().int().min(1),
  openingBountyMicroUsdc: microUsdcStringSchema,
  destinationUrl: z.string().trim().min(1).max(2000),
});

export const joinCampaignRequestSchema = z.object({
  allocationCount: z.number().int().min(1).max(100_000).optional(),
  expectedMarketVersion: z.number().int().min(1).optional(),
  inviteToken: z.string().trim().min(1).max(200).optional(),
});

export const createInviteRequestSchema = z.object({
  expiresAt: z.string().datetime({ offset: true }).optional(),
  maxUses: z.number().int().min(1).max(10_000).optional(),
});
