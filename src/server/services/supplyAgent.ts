import { NEGOTIATION_AUTOMATION_UNAVAILABLE, rankMarketFit } from "../domain/supplyAgent";
import { parsePartnerRules, type PartnerRules } from "../domain/market";
import { joinCampaign, type MarketDeps } from "./markets";
import type { StoredMarket } from "./campaignStore";

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { status, code, details });
}

async function profileAndRules(deps: MarketDeps, userId: string) {
  const profile = await deps.store.getPartnerByUserId(userId);
  if (!profile) fail(404, "PARTNER_PROFILE_REQUIRED", "Create a Partner profile first");
  const parsed = parsePartnerRules(profile.rulesJson);
  if (!parsed.ok) fail(500, "INTERNAL", "Stored Partner rules are invalid", parsed.issues);
  return { profile, rules: (parsed as { ok: true; rules: PartnerRules }).rules };
}

interface LiveMarketCtx {
  market: StoredMarket;
  campaignId: string;
  workspaceName: string;
  category: string | null;
  deadline: string;
  publicBountyMicroUsdc: string;
}

export interface SupplyWorkerSkip {
  partnerId: string;
  campaignId: string | null;
  reason: string;
  message: string;
  recommendation?: string;
}

export interface SupplyWorkerSummary {
  partnersEvaluated: number;
  marketsEvaluated: number;
  joined: Array<{ partnerId: string; campaignId: string; referralCode: string; alreadyJoined: boolean }>;
  skipped: SupplyWorkerSkip[];
  failed: Array<{ partnerId: string; error: string }>;
}

/**
 * Background Supply Agent worker. Loads every autoJoin Partner and evaluates
 * live PUBLIC markets through the SAME deterministic rules + joinCampaign
 * path as manual joins (same gates, same audit, same idempotency).
 * One Partner's failure never aborts the rest. Read-only until a join passes.
 */
export async function runSupplyAgentWorker(deps: MarketDeps): Promise<SupplyWorkerSummary> {
  const now = deps.now?.() ?? new Date();
  const summary: SupplyWorkerSummary = {
    partnersEvaluated: 0,
    marketsEvaluated: 0,
    joined: [],
    skipped: [],
    failed: [],
  };
  const markets = await livePublicMarkets(deps);
  summary.marketsEvaluated = markets.length;
  const partners = await deps.store.listAutoJoinPartners();
  for (const profile of partners) {
    try {
      summary.partnersEvaluated += 1;
      const parsed = parsePartnerRules(profile.rulesJson);
      if (!parsed.ok) {
        summary.failed.push({ partnerId: profile.id, error: "INVALID_RULES" });
        continue;
      }
      const rules = (parsed as { ok: true; rules: PartnerRules }).rules;
      if (rules.autoJoin !== true) continue;
      const terms = await deps.store.listPartnerTerms(profile.id);
      const active = terms.filter((t) => t.status === "ACTIVE");
      const joinedIds = new Set(terms.map((t) => t.campaignId));
      let joinedThisRun = 0;
      const runSkips: SupplyWorkerSkip[] = [];
      for (const m of markets) {
        if (joinedIds.has(m.campaignId)) {
          runSkips.push({
            partnerId: profile.id,
            campaignId: m.campaignId,
            reason: "ALREADY_JOINED",
            message: "Already joined: the unique (campaign, partner) terms stand, no second join.",
          });
          continue;
        }
        const fit = rankMarketFit(
          {
            campaignId: m.campaignId,
            marketStatus: m.market.status,
            campaignLive: true,
            deadline: new Date(m.deadline),
            publicBountyMicroUsdc: BigInt(m.publicBountyMicroUsdc),
            campaignCategory: m.category,
            alreadyJoined: joinedIds.has(m.campaignId),
            now,
          },
          rules,
          { activeTermsCount: active.length + joinedThisRun, payoutWallet: profile.payoutWallet },
        );
        if (fit.verdict !== "join") {
          const skip: SupplyWorkerSkip = {
            partnerId: profile.id,
            campaignId: m.campaignId,
            reason: fit.skipReason ?? "INELIGIBLE",
            message: fit.reasons[0] ?? "Skipped",
          };
          if (fit.skipReason === "MIN_BOUNTY" && rules.autoNegotiate) {
            skip.recommendation = `Consider proposing private terms manually; ${NEGOTIATION_AUTOMATION_UNAVAILABLE}`;
          }
          runSkips.push(skip);
          continue;
        }
        try {
          const res = await joinCampaign(deps, {
            campaignId: m.campaignId,
            userId: profile.userId,
            allocationCount: rules.maxAllocationCount ?? 1,
            expectedMarketVersion: m.market.version,
          });
          joinedThisRun += res.alreadyJoined ? 0 : 1;
          if (!res.alreadyJoined) joinedIds.add(m.campaignId);
          summary.joined.push({
            partnerId: profile.id,
            campaignId: m.campaignId,
            referralCode: res.referral.code,
            alreadyJoined: res.alreadyJoined,
          });
        } catch (e) {
          runSkips.push({
            partnerId: profile.id,
            campaignId: m.campaignId,
            reason: (e as { code?: string }).code ?? "JOIN_FAILED",
            message: (e as Error).message,
          });
        }
      }
      summary.skipped.push(...runSkips);
      await deps.audit({
        actorType: "SYSTEM",
        actorId: null,
        workspaceId: null,
        partnerId: profile.id,
        action: "supply_agent.run",
        targetType: "partner",
        targetId: profile.id,
        metadata: {
          partnerId: profile.id,
          joined: summary.joined.filter((j) => j.partnerId === profile.id).map((j) => j.campaignId),
          skipped: runSkips.length,
          reasons: [...new Set(runSkips.map((s) => s.reason))],
        },
      });
    } catch (e) {
      summary.failed.push({ partnerId: profile.id, error: (e as Error).message });
    }
  }
  return summary;
}

async function livePublicMarkets(deps: MarketDeps): Promise<LiveMarketCtx[]> {
  const now = deps.now?.() ?? new Date();
  const out: LiveMarketCtx[] = [];
  for (const m of await deps.store.listMarkets()) {
    if (m.status !== "OPEN") continue;
    const campaign = await deps.store.getCampaign(m.campaignId);
    if (!campaign || campaign.state !== "LIVE") continue;
    const version = await deps.store.getVersion(m.campaignId, m.policyVersion);
    if (!version || version.status !== "APPROVED") continue;
    if (version.marketVisibility !== "PUBLIC") continue;
    if (!version.deadline || version.deadline <= now) continue;
    const workspace = await deps.store.getWorkspace(campaign.workspaceId);
    out.push({
      market: m,
      campaignId: m.campaignId,
      workspaceName: workspace?.name ?? "Workspace",
      category: workspace?.category ?? null,
      deadline: version.deadline.toISOString(),
      publicBountyMicroUsdc: m.publicBountyMicroUsdc.toString(),
    });
  }
  return out;
}

/** Real automation state: watching, matches, joins, skips with reasons. */
export async function getAgentStatus(deps: MarketDeps, params: { userId: string }) {
  const now = deps.now?.() ?? new Date();
  const { profile, rules } = await profileAndRules(deps, params.userId);
  const terms = await deps.store.listPartnerTerms(profile.id);
  const activeTerms = terms.filter((t) => t.status === "ACTIVE");
  const joinedIds = new Set(terms.map((t) => t.campaignId));
  const markets = await livePublicMarkets(deps);
  const matches: Array<{ campaignId: string; workspaceName: string; score: number; reasons: string[] }> = [];
  const joined: string[] = [];
  const skipped: Array<{ campaignId: string; reason: string; code: string }> = [];
  let blocked = 0;
  for (const m of markets) {
    const fit = rankMarketFit(
      {
        campaignId: m.campaignId,
        marketStatus: m.market.status,
        campaignLive: true,
        deadline: new Date(m.deadline),
        publicBountyMicroUsdc: BigInt(m.publicBountyMicroUsdc),
        campaignCategory: m.category,
        alreadyJoined: joinedIds.has(m.campaignId),
        now,
      },
      rules,
      { activeTermsCount: activeTerms.length, payoutWallet: profile.payoutWallet },
    );
    if (fit.verdict === "skip") {
      if (fit.skipReason === "CATEGORY_BLOCKED") blocked += 1;
      skipped.push({ campaignId: m.campaignId, reason: fit.reasons[0] ?? "Skipped", code: fit.skipReason ?? "SKIPPED" });
    } else if (joinedIds.has(m.campaignId)) {
      joined.push(m.campaignId);
    } else {
      matches.push({ campaignId: m.campaignId, workspaceName: m.workspaceName, score: fit.score, reasons: fit.reasons });
    }
  }
  let negotiationsPending = 0;
  for (const t of activeTerms) {
    const active = await deps.store.getActiveNegotiation(t.campaignId, profile.id);
    if (active) negotiationsPending += 1;
  }
  return {
    status: "watching" as const,
    watching: markets.length,
    matches: matches.sort((a, b) => b.score - a.score),
    joined,
    joinedCount: joined.length,
    skipped,
    blockedCategoryCount: blocked,
    negotiationsPending,
    autoJoin: rules.autoJoin,
    autoNegotiate: rules.autoNegotiate,
    autoNegotiateNote: rules.autoNegotiate ? NEGOTIATION_AUTOMATION_UNAVAILABLE : null,
  };
}

/** Ranked matching markets with fit explanations (read-only). */
export async function findMatches(deps: MarketDeps, params: { userId: string }) {
  const status = await getAgentStatus(deps, params);
  return { matches: status.matches, watched: status.watching };
}

/**
 * Execute eligible auto-joins through the existing join path (same policy,
 * same audit, same idempotency). Explicit invocation only: there is no
 * background daemon in this build.
 */
export async function runAgent(deps: MarketDeps, params: { userId: string }) {
  const now = deps.now?.() ?? new Date();
  const { profile, rules } = await profileAndRules(deps, params.userId);
  if (!rules.autoJoin) {
    fail(400, "AUTOJOIN_DISABLED", "Auto-join is OFF: the agent recommends only. Enable auto-join in your rules or join manually.");
  }
  const terms = await deps.store.listPartnerTerms(profile.id);
  const activeCount = terms.filter((t) => t.status === "ACTIVE").length;
  const joinedIds = new Set(terms.map((t) => t.campaignId));
  const markets = await livePublicMarkets(deps);
  const joined: Array<{ campaignId: string; referralCode: string; alreadyJoined: boolean }> = [];
  const skipped: Array<{ campaignId: string; reason: string }> = [];
  for (const m of markets) {
    if (joinedIds.has(m.campaignId)) continue;
    const fit = rankMarketFit(
      {
        campaignId: m.campaignId,
        marketStatus: m.market.status,
        campaignLive: true,
        deadline: new Date(m.deadline),
        publicBountyMicroUsdc: BigInt(m.publicBountyMicroUsdc),
        campaignCategory: m.category,
        alreadyJoined: false,
        now,
      },
      rules,
      { activeTermsCount: activeCount + joined.length, payoutWallet: profile.payoutWallet },
    );
    if (fit.verdict !== "join") {
      skipped.push({ campaignId: m.campaignId, reason: fit.reasons[0] ?? "Skipped" });
      continue;
    }
    try {
      const res = await joinCampaign(deps, {
        campaignId: m.campaignId,
        userId: params.userId,
        allocationCount: rules.maxAllocationCount ?? 1,
      });
      joined.push({ campaignId: m.campaignId, referralCode: res.referral.code, alreadyJoined: res.alreadyJoined });
    } catch (e) {
      skipped.push({ campaignId: m.campaignId, reason: (e as Error).message });
    }
  }
  return { joined, skipped };
}

/** Persist drafted rules only with explicit confirmation. Chat never writes. */
export async function confirmOnboarding(
  deps: MarketDeps,
  params: { userId: string; rules: Record<string, unknown>; confirmed: boolean },
) {
  if (params.confirmed !== true) {
    fail(400, "CONFIRMATION_REQUIRED", "Review the rules card and confirm before anything becomes active.");
  }
  const parsed = parsePartnerRules(params.rules);
  if (!parsed.ok) fail(400, "BAD_REQUEST", "Invalid Partner rules", parsed.issues);
  const profile = await deps.store.getPartnerByUserId(params.userId);
  if (!profile) fail(404, "PARTNER_PROFILE_REQUIRED", "Create a Partner profile first");
  const { updatePartnerRules } = await import("./markets");
  return updatePartnerRules(deps, { userId: params.userId, rules: params.rules });
}

const SUGGESTED = [
  "What live campaigns match my preferences?",
  "Why did you skip this campaign?",
  "Which market currently has the best fit?",
  "Show my active campaigns.",
  "What are my campaign preferences?",
  "Should we negotiate this campaign?",
];

/** Deterministic agent answers over real state. Read-only; never mutates rules. */
export async function answerAgentQuestion(deps: MarketDeps, params: { userId: string; question: string }) {
  const q = params.question.toLowerCase();
  const status = await getAgentStatus(deps, params);
  const { rules } = await profileAndRules(deps, params.userId);
  const matchLines = status.matches.map((m) => `${m.workspaceName} (${m.campaignId.slice(0, 8)}…): score ${m.score} — ${m.reasons.join(" ")}`);
  if (/(negotiat)/.test(q)) {
    return {
      answer: `${NEGOTIATION_AUTOMATION_UNAVAILABLE} You can still propose terms manually from a market. Say which market and I will point you at the propose flow.`,
      suggestedQuestions: SUGGESTED,
    };
  }
  if (/(match|fit|rank|recommend|suggest)/.test(q)) {
    return {
      answer:
        status.matches.length === 0
          ? `I am watching ${status.watching} live markets and none match your rules right now. ${status.skipped.length} skipped with reasons on your dashboard.`
          : `Top matches:\n${matchLines.join("\n")}`,
      suggestedQuestions: SUGGESTED,
    };
  }
  if (/(best fit|best market)/.test(q)) {
    const top = status.matches[0];
    return {
      answer: top
        ? `Best fit: ${top.workspaceName} (${top.campaignId.slice(0, 8)}…) at score ${top.score}. ${top.reasons.join(" ")}`
        : `No matching market right now across ${status.watching} watched.`,
      suggestedQuestions: SUGGESTED,
    };
  }
  if (/(why.*skip|skipped|skip this)/.test(q)) {
    return {
      answer:
        status.skipped.length === 0
          ? "Nothing skipped: every watched market currently passes your rules."
          : `Skipped:\n${status.skipped.map((s) => `${s.campaignId.slice(0, 8)}… — ${s.reason}`).join("\n")}`,
      suggestedQuestions: SUGGESTED,
    };
  }
  if (/(why.*join|joined)/.test(q) && !/(auto-?join)/.test(q)) {
    return {
      answer:
        status.joined.length === 0
          ? "Not joined anywhere yet. Every join goes through the standard eligibility policy and is idempotent per campaign."
          : `Joined ${status.joined.length} campaign(s) through the standard join path (unique referral + frozen terms snapshot).`,
      suggestedQuestions: SUGGESTED,
    };
  }
  if (/(active|my campaigns|joined)/.test(q)) {
    return {
      answer:
        status.joined.length === 0
          ? "No active campaigns yet."
          : `Active campaigns: ${status.joined.join(", ")}`,
      suggestedQuestions: SUGGESTED,
    };
  }
  if (/(preference|my rules|minimum|watching)/.test(q)) {
    return {
      answer:
        `Watching: ${rules.allowedCategories.join(", ") || "anything"}; ` +
        `minimum ${rules.minimumBountyMicroUsdc.toString()} micro-USDC; ` +
        `auto-join ${rules.autoJoin ? "ON" : "OFF"}; auto-negotiate ${rules.autoNegotiate ? "ON" : "OFF"}.`,
      suggestedQuestions: SUGGESTED,
    };
  }
  if (/(change|update|set|minimum.*to|bounty.*to)/.test(q)) {
    return {
      answer: "I cannot change rules from chat. Open the rules card, edit the values, and press Confirm — only confirmed rules become active.",
      suggestedQuestions: SUGGESTED,
    };
  }
  return {
    answer: `Watching ${status.watching} live markets: ${status.matches.length} match, ${status.joinedCount} joined, ${status.skipped.length} skipped, ${status.negotiationsPending} negotiation(s) pending. Ask me what matches, or why I skipped something.`,
    suggestedQuestions: SUGGESTED,
  };
}
