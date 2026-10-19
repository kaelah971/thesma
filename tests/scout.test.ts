import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import {
  approvePolicy,
  createDraft,
  moveToReview,
  type CampaignDeps,
} from "@/server/services/campaigns";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
  type MarketStore,
} from "@/server/services/campaignStore";
import {
  confirmFunding,
  prepareFundingIntent,
  recordFundingSubmitted,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import type { ArcChainReader, ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import { joinCampaign } from "@/server/services/markets";
import {
  buildScoutPlan,
  checkScoutEligibility,
  decideScoutCandidate,
  detectScoutAlerts,
  diagnoseFunnel,
  estimateEarnings,
  loadScoutSnapshot,
  scoreCandidate,
  type ScoredCandidate,
} from "@/server/services/scout";

const DAY = 86_400_000;
const NOW = new Date("2026-06-01T12:00:00.000Z");

function scored(over: Partial<ScoredCandidate> & { campaignId?: string } = {}): ScoredCandidate {
  const { campaignId, ...rest } = over;
  const base: ScoredCandidate = {
    facts: {
      campaignId: "c-1", workspaceName: "Acme", objective: "Get customers", category: "media",
      bountyMicroUsdc: "2000000", targetOutcomeCount: 10, verifiedOutcomes: 2, deadline: new Date(NOW.getTime() + 10 * DAY),
      campaignState: "LIVE", marketStatus: "OPEN", minQualifyingMicroUsdc: "500000", holdSeconds: 3600,
      alreadyJoined: false, referralPath: null, creatorVerifiedTotal: 4, creatorVerifiedRecent: 2,
      creatorActions: 12, creatorSettledTotalMicroUsdc: "4000000", paceStatus: "BEHIND",
    },
    eligibility: "ELIGIBLE",
    eligibilityReason: "ok",
    score: 70,
    rank: 1,
    decision: "RECOMMEND",
    reason: "Strong match",
    confidence: "MEDIUM",
    evidenceUsed: ["4-verified/12-actions"],
    earningsEstimateMicroUsdc: null,
    earningsNote: "",
  };
  if (campaignId) base.facts.campaignId = campaignId;
  return { ...base, ...rest };
}

describe("eligibility first", () => {
  const base = {
    alreadyJoined: false, marketStatus: "OPEN", campaignLive: true,
    deadline: new Date(NOW.getTime() + 10 * DAY), visibility: "PUBLIC", targetSettled: false,
    rules: { minimumBountyMicroUsdc: 0n, allowedCategories: [], blockedCategories: [], maxActiveCampaigns: null, maxAllocationCount: null, autoJoin: false, autoNegotiate: false, minScoutConfidence: "MEDIUM" as const, maxAutoJoinsPerDay: null },
    campaignCategory: "media", activeTermsCount: 0, payoutWallet: "0x0000000000000000000000000000000000000001",
    bountyMicroUsdc: 2_000_000n, now: NOW,
  };

  it("eligible campaigns pass with an explicit reason", () => {
    expect(checkScoutEligibility(base).eligibility).toBe("ELIGIBLE");
  });

  it("joined, settled, private, expired and blocked campaigns never rank as opportunities", () => {
    expect(checkScoutEligibility({ ...base, alreadyJoined: true }).eligibility).toBe("ALREADY_JOINED");
    expect(checkScoutEligibility({ ...base, targetSettled: true }).eligibility).toBe("NOT_ELIGIBLE");
    expect(checkScoutEligibility({ ...base, visibility: "PRIVATE" }).eligibility).toBe("NOT_ELIGIBLE");
    expect(checkScoutEligibility({ ...base, deadline: new Date(NOW.getTime() - DAY) }).eligibility).toBe("NOT_ELIGIBLE");
    expect(checkScoutEligibility({ ...base, campaignLive: false }).eligibility).toBe("NOT_ELIGIBLE");
    expect(checkScoutEligibility({ ...base, payoutWallet: null }).eligibility).toBe("NOT_ELIGIBLE");
    expect(checkScoutEligibility({ ...base, rules: null }).eligibility).toBe("UNKNOWN");
  });

  it("ineligible candidates never land in top opportunities", () => {
    const plan = buildScoutPlan([
      scored({ campaignId: "bad", eligibility: "NOT_ELIGIBLE", decision: "NOT_ELIGIBLE", score: 99 }),
      scored({ campaignId: "good", score: 60 }),
    ]);
    expect(plan.topOpportunities.map((c) => c.facts.campaignId)).toEqual(["good"]);
    expect(plan.notEligible.map((c) => c.facts.campaignId)).toEqual(["bad"]);
  });
});

describe("ranking engine", () => {
  it("rewards fit + evidence + economics without fake precision", () => {
    const r = scoreCandidate({
      nicheFit: true, categoryBlocked: false, verifiedTotal: 4, verifiedRecent: 2,
      actions: 12, verificationRate: 0.33, bountyMicroUsdc: 2_000_000n,
      minBountyMicroUsdc: 1_000_000n, remainingTarget: 8,
      msUntilDeadline: 10 * DAY, paceStatus: "BEHIND",
    });
    expect(r.score).toBeGreaterThan(55);
    expect(r.confidence).toBe("HIGH");
    expect(r.evidenceUsed).toContain("niche-match");
  });

  it("high bounty alone does not outrank evidence", () => {
    const strong = scoreCandidate({
      nicheFit: true, categoryBlocked: false, verifiedTotal: 10, verifiedRecent: 4,
      actions: 40, verificationRate: 0.25, bountyMicroUsdc: 1_000_000n,
      minBountyMicroUsdc: null, remainingTarget: 8, msUntilDeadline: 10 * DAY, paceStatus: "BEHIND",
    });
    const flashy = scoreCandidate({
      nicheFit: false, categoryBlocked: false, verifiedTotal: 0, verifiedRecent: 0,
      actions: 0, verificationRate: 0, bountyMicroUsdc: 9_000_000n,
      minBountyMicroUsdc: null, remainingTarget: 8, msUntilDeadline: 10 * DAY, paceStatus: null,
    });
    expect(strong.score).toBeGreaterThan(flashy.score);
  });

  it("uses no follower-count input anywhere", () => {
    const src = readFileSync(join(process.cwd(), "src/server/services/scout.ts"), "utf8");
    expect(src).not.toMatch(/followerCount|followers\s*[:=(]|follower_count|followerScore/i);
  });
});

describe("cold-start fairness", () => {
  it("new creators with profile fit still get WATCH opportunities at LOW confidence", () => {
    const r = scoreCandidate({
      nicheFit: true, categoryBlocked: false, verifiedTotal: 0, verifiedRecent: 0,
      actions: 0, verificationRate: 0, bountyMicroUsdc: 2_000_000n,
      minBountyMicroUsdc: null, remainingTarget: 8, msUntilDeadline: 10 * DAY, paceStatus: null,
    });
    expect(r.confidence).toBe("LOW");
    const d = decideScoutCandidate({ eligibility: "ELIGIBLE", score: r.score, rank: 1, total: 3, confidence: "LOW", hasEvidence: false });
    expect(d.decision).toBe("WATCH");
    expect(d.reason).toMatch(/cold-start/i);
  });

  it("unknown eligibility watches instead of assuming", () => {
    const d = decideScoutCandidate({ eligibility: "UNKNOWN", score: 80, rank: 1, total: 1, confidence: "LOW", hasEvidence: false });
    expect(d.decision).toBe("WATCH");
  });
});

describe("economics honesty", () => {
  it("estimates earnings only with real history, labeled ESTIMATE", () => {
    const ready = estimateEarnings({ bountyMicroUsdc: 2_000_000n, actions: 12, verifiedTotal: 4 });
    expect(ready.estimate).not.toBeNull();
    expect(ready.note).toMatch(/ESTIMATE/);
    expect(ready.note).toMatch(/never guaranteed|not promises|projection/i);
    const thin = estimateEarnings({ bountyMicroUsdc: 2_000_000n, actions: 2, verifiedTotal: 1 });
    expect(thin.estimate).toBeNull();
    expect(thin.note).toMatch(/Not enough history/);
  });
});

describe("funnel diagnosis states only observables", () => {
  it("names the largest drop-off without inventing causes", () => {
    expect(diagnoseFunnel({ clicks: 10, actions: 2, verified: 1, inHold: 0, settled: 0 }).stage).toBe("visit-to-action");
    expect(diagnoseFunnel({ clicks: 5, actions: 5, verified: 1, inHold: 0, settled: 0 }).stage).toBe("action-to-verified");
    expect(diagnoseFunnel({ clicks: 5, actions: 5, verified: 5, inHold: 4, settled: 0 }).stage).toBe("verified-to-hold");
    expect(diagnoseFunnel({ clicks: 0, actions: 0, verified: 0, inHold: 0, settled: 0 }).stage).toBe("empty");
    const d = diagnoseFunnel({ clicks: 10, actions: 2, verified: 1, inHold: 0, settled: 0 });
    expect(`${d.stage} ${d.sentence}`.toLowerCase()).not.toMatch(/dislike|content|audience|boring|because/);
  });

  it("keeps CLICKED, CONVERTED, VERIFIED and PAID conceptually separate", () => {
    // clicks=10/actions=0/verified=0 must not leak into verified counts.
    const d = diagnoseFunnel({ clicks: 10, actions: 0, verified: 0, inHold: 0, settled: 0 });
    expect(d.stage).toBe("visit-to-action");
  });
});

describe("alert candidates are pure events without delivery", () => {
  it("detects new matches, bounty moves, closing windows, drops and settlements", () => {
    const alerts = detectScoutAlerts({
      candidates: [
        { campaignId: "c-new", decision: "RECOMMEND", bountyMicroUsdc: "2500000", msUntilDeadline: 10 * DAY },
        { campaignId: "c-close", decision: "WATCH", bountyMicroUsdc: "1000000", msUntilDeadline: 40 * 3_600_000 },
      ],
      seenCampaignIds: ["c-close"],
      previousBountyByCampaign: { "c-new": "2000000", "c-close": "1000000" },
      recentVerificationRate: 0.05,
      historicalVerificationRate: 0.3,
      newSettledPayouts: [{ campaignId: "c-old", payoutId: "payout-12345678" }],
    });
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain("NEW_MATCH");
    expect(kinds).toContain("BOUNTY_CHANGED");
    expect(kinds).toContain("CAMPAIGN_CLOSING_SOON");
    expect(kinds).toContain("VERIFICATION_DROP");
    expect(kinds).toContain("PAYOUT_SETTLED");
    for (const a of alerts) expect(a.reason.length).toBeGreaterThan(0);
  });
});

// ---------- Loader integration (memory store, real services) ----------

const OWNER_W = "0x1111111111111111111111111111111111111111" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL = "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Media niche. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEST = "https://acme.example/product";

const CONFIG: ArcConfig = {
  chainId: 31337, rpcUrl: "http://localhost:8545", usdcAddress: USDC,
  vaultAddress: VAULT, executorAddress: EXECUTOR, verifierAddress: VERIFIER, explorerBaseUrl: null,
};

class FakeReader implements ArcChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  vaultStates = new Map<string, VaultCampaignState>();
  async getChainId() {
    return 31337;
  }
  async getReceipt(txHash: Hex) {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async readVaultCampaign(_v: Address, key: Hex) {
    const s = this.vaultStates.get(key.toLowerCase());
    if (!s) {
      return {
        exists: false, owner: null, policyHash: null, budgetCap: 0n, bountyCeiling: 0n,
        deadline: 0n, executor: null, verifier: null, funded: 0n, spent: 0n,
        paused: false, closed: false, returned: false,
      };
    }
    return s;
  }
  async usdcBalanceOf() {
    return 0n;
  }
  async hasCode() {
    return true;
  }
}

const txFor = (n: number) => (`0x${String(n).repeat(64)}` as Hex);

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
  }) as MarketStore;
  const { sink } = createMemoryAuditSink();
  const deps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, deps, fundingDeps, reader };
}

async function liveCampaignId(ctx: ReturnType<typeof setup>, tag = 3) {
  const deps = { store: ctx.store, audit: ctx.deps.audit, now: () => FIXED_NOW };
  const d = await createDraft(deps as CampaignDeps, {
    workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE } as never,
  });
  await moveToReview(deps as CampaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(deps as CampaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerCompanyWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: txFor(tag) });
  ctx.reader.receipts.set(txFor(tag).toLowerCase(), {
    status: "success", to: VAULT, blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 15_000_000n, totalFunded: 15_000_000n }],
  });
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
    funded: 15_000_000n, spent: 0n, paused: false, closed: false, returned: false,
  });
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
  return d.campaign.id;
}

describe("scout loader", () => {
  it("surfaces the live public campaign as eligible, then ALREADY_JOINED after join", async () => {
    const ctx = setup();
    const id = await liveCampaignId(ctx);
    const { openMarket } = await import("@/server/services/markets");
    await openMarket(ctx.deps as never, {
      campaignId: id, userId: "owner-1", expectedPolicyVersion: 1,
      openingBountyMicroUsdc: "2000000", destinationUrl: DEST,
    });
    const before = await loadScoutSnapshot(ctx.store, "partner-1", FIXED_NOW);
    expect(before.candidates).toHaveLength(1);
    expect(before.candidates[0].eligibility).toBe("ELIGIBLE");
    expect(["RECOMMEND", "WATCH"]).toContain(before.candidates[0].decision);

    const joined = await joinCampaign(ctx.deps as never, { campaignId: id, userId: "partner-1" });
    expect(joined.referral.code.length).toBeGreaterThan(0);
    const after = await loadScoutSnapshot(ctx.store, "partner-1", FIXED_NOW);
    expect(after.candidates).toHaveLength(1);
    expect(after.candidates[0].eligibility).toBe("ALREADY_JOINED");
    expect(after.candidates[0].decision).toBe("ALREADY_JOINED");
    expect(after.candidates[0].facts.referralPath).toBe(`/r/${joined.referral.code}`);
    expect(after.plan.joined).toHaveLength(1);
    expect(after.plan.topOpportunities).toHaveLength(0);
  });
});
