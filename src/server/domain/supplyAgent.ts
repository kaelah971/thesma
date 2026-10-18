import { checkJoinEligibility, type PartnerRules } from "./market";
import { microToUsdcString, usdcToMicro } from "./money";

/** Negotiation automation is stored-only; the agent must say so honestly. */
export const NEGOTIATION_AUTOMATION_UNAVAILABLE =
  "Negotiation automation is not available in the current build.";

/* ---------------- Onboarding interpretation (chat -> typed rules) ---------------- */

export interface OnboardingAnswers {
  categoriesText?: string;
  blockedCategoriesText?: string;
  minBountyText?: string;
  maxActiveText?: string;
  maxAllocationText?: string;
  autoJoinText?: string;
  autoNegotiateText?: string;
}

export interface ParsedOnboarding {
  rules: {
    minimumBountyMicroUsdc: string;
    allowedCategories: string[];
    blockedCategories: string[];
    maxActiveCampaigns: number | null;
    autoJoin: boolean;
    autoNegotiate: boolean;
    maxAllocationCount: number | null;
  };
  /** Keys still missing before a confirmation card may be shown. */
  missing: string[];
}

function splitCategories(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]|\band\b/gi)
    .map((c) => c.trim().replace(/\s+/g, " "))
    .filter((c) => c.length > 0)
    .slice(0, 50);
}

function parseAmountUsdc(raw: string | undefined): bigint | null {
  if (!raw) return null;
  const m = /(\d+(?:\.\d{1,6})?)/.exec(raw);
  if (!m) return null;
  try {
    return usdcToMicro(m[1]);
  } catch {
    return null;
  }
}

function parseCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /(\d+)/.exec(raw);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function parseYesNo(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (/^(y|yes|yeah|yep|sure|ok|okay|true|on|allow|enable|do it|please)/.test(t)) return true;
  if (/^(n|no|nope|never|false|off|disable|don't|not)/.test(t)) return false;
  return null;
}

/**
 * Interpret free-text onboarding answers into typed rule values.
 * Never guesses: unparseable or absent answers are reported in `missing`.
 */
export function parseOnboardingAnswers(answers: OnboardingAnswers): ParsedOnboarding {
  const missing: string[] = [];
  const allowed = splitCategories(answers.categoriesText);
  if (allowed.length === 0) missing.push("categories");
  const minimum = parseAmountUsdc(answers.minBountyText);
  if (minimum === null) missing.push("minBounty");
  const autoJoin = parseYesNo(answers.autoJoinText);
  if (autoJoin === null) missing.push("autoJoin");
  const autoNegotiate = parseYesNo(answers.autoNegotiateText);
  if (autoNegotiate === null) missing.push("autoNegotiate");
  return {
    rules: {
      minimumBountyMicroUsdc: (minimum ?? 0n).toString(),
      allowedCategories: allowed,
      blockedCategories: splitCategories(answers.blockedCategoriesText),
      maxActiveCampaigns: parseCount(answers.maxActiveText),
      autoJoin: autoJoin ?? false,
      autoNegotiate: autoNegotiate ?? false,
      maxAllocationCount: parseCount(answers.maxAllocationText),
    },
    missing,
  };
}

export interface OnboardStep {
  key: string;
  question: string;
}

/** Progressive onboarding order: watch -> minimum -> auto-join -> auto-negotiate -> caps. */
export function nextOnboardingQuestion(parsed: ParsedOnboarding): OnboardStep | null {
  if (parsed.missing.includes("categories")) {
    return { key: "categories", question: "What kinds of outcome markets should I watch for you?" };
  }
  if (parsed.missing.includes("minBounty")) {
    return { key: "minBounty", question: "What's the minimum you'd accept for one verified customer?" };
  }
  if (parsed.missing.includes("autoJoin")) {
    return { key: "autoJoin", question: "Should I automatically join matching markets when they meet your rules?" };
  }
  if (parsed.missing.includes("autoNegotiate")) {
    return {
      key: "autoNegotiate",
      question: "If a strong-fit market is below your minimum, should I negotiate?",
    };
  }
  return null;
}

/** Confirmation card model. Shown before anything becomes active. */
export function onboardingSummary(rules: ParsedOnboarding["rules"]): string[] {
  return [
    `Watching: ${rules.allowedCategories.join(", ") || "—"}`,
    `Minimum bounty: ${microToUsdcString(BigInt(rules.minimumBountyMicroUsdc))} USDC`,
    `Maximum active markets: ${rules.maxActiveCampaigns ?? "no cap"}`,
    `Auto-join: ${rules.autoJoin ? "ON" : "OFF"}`,
    `Auto-negotiate: ${rules.autoNegotiate ? "ON" : "OFF"}`,
    `Maximum allocation: ${rules.maxAllocationCount ?? "default"} outcome${(rules.maxAllocationCount ?? 1) === 1 ? "" : "s"}`,
  ];
}

/* ---------------- Market fit ranking (real data in, ranked data out) ---------------- */

export type FitVerdict = "join" | "consider" | "skip";

export interface MarketFitInput {
  campaignId: string;
  marketStatus: "OPEN" | "THIN_SUPPLY" | "ON_PACE" | "BEHIND_PACE" | "BUDGET_PRESSURE" | "TARGET_REACHED" | "PAUSED" | "CLOSED";
  campaignLive: boolean;
  deadline: Date | null;
  publicBountyMicroUsdc: bigint;
  campaignCategory: string | null;
  alreadyJoined: boolean;
  now: Date;
}

export interface MarketFit {
  campaignId: string;
  verdict: FitVerdict;
  score: number;
  reasons: string[];
  skipReason: string | null;
}

/**
 * Rank one market against stored rules. Hard gates reuse the join kernel, so
 * the agent can never recommend what the join path would reject.
 */
export function rankMarketFit(
  market: MarketFitInput,
  rules: PartnerRules & { maxAllocationCount: number | null },
  ctx: { activeTermsCount: number; payoutWallet: string | null },
): MarketFit {
  const requested = rules.maxAllocationCount ?? 1;
  const gate = checkJoinEligibility({
    marketStatus: market.marketStatus,
    campaignLive: market.campaignLive,
    deadline: market.deadline,
    publicBountyMicroUsdc: market.publicBountyMicroUsdc,
    rules,
    campaignCategory: market.campaignCategory,
    activeTermsCount: ctx.activeTermsCount,
    requestedAllocation: requested,
    payoutWallet: ctx.payoutWallet,
    now: market.now,
  });
  if (!gate.ok) {
    return { campaignId: market.campaignId, verdict: "skip", score: 0, reasons: [gate.message], skipReason: gate.reason };
  }
  if (market.alreadyJoined) {
    return {
      campaignId: market.campaignId,
      verdict: "consider",
      score: 60,
      reasons: ["Already joined: track this campaign, no second join needed."],
      skipReason: null,
    };
  }
  const reasons: string[] = [];
  let score = 40;
  const category = (market.campaignCategory ?? "").trim();
  if (category && rules.allowedCategories.some((c) => c.toLowerCase() === category.toLowerCase())) {
    score += 30;
    reasons.push(`Category "${category}" is on your watch list.`);
  } else {
    reasons.push("Open category: no allow-list restriction hit.");
  }
  if (market.publicBountyMicroUsdc >= rules.minimumBountyMicroUsdc * 2n && rules.minimumBountyMicroUsdc > 0n) {
    score += 20;
    reasons.push(`Bounty ${microToUsdcString(market.publicBountyMicroUsdc)} USDC is at least 2x your minimum.`);
  } else if (market.publicBountyMicroUsdc >= rules.minimumBountyMicroUsdc) {
    score += 10;
    reasons.push(`Bounty ${microToUsdcString(market.publicBountyMicroUsdc)} USDC meets your minimum.`);
  }
  if (market.deadline && market.deadline.getTime() - market.now.getTime() > 7 * 24 * 3600 * 1000) {
    score += 10;
    reasons.push("More than 7 days remain before the deadline.");
  }
  return {
    campaignId: market.campaignId,
    verdict: rules.autoJoin ? "join" : "consider",
    score: Math.min(100, score),
    reasons,
    skipReason: null,
  };
}
