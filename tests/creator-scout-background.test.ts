import { describe, expect, it } from "vitest";
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
  type FundingDeps,
} from "@/server/services/fundings";
import { registerTestWallet } from "./wallet-fixtures";
import type { ArcChainReader, ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import {
  buildBackgroundAlerts,
  loadScoutSnapshot,
  runBackgroundScout,
  runScoutAutoJoin,
  type BackgroundScoutDeps,
  type ScoredCandidate,
  type ScoutRunSummary,
} from "@/server/services/scout";
import {
  createMemoryNotificationStore,
  dedupeKeyFor,
  isUsefulRefusal,
  type StoredCreatorNotification,
} from "@/server/services/creatorNotifications";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;

/* ---------- live-campaign harness (same funded path as autojoin tests) ---------- */

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL = "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Media niche. Purchases below 10 USDC should not count.";
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEST = "https://acme.example/product";

const CONFIG: ArcConfig = {
  chainId: 31337, rpcUrl: "http://localhost:8545", usdcAddress: USDC,
  vaultAddress: VAULT, executorAddress: EXECUTOR, verifierAddress: VERIFIER, explorerBaseUrl: null,
};

class FakeReader implements ArcChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  vaultStates = new Map<string, VaultCampaignState>();
  async getChainId() { return 31337; }
  async getReceipt(txHash: Hex) { return this.receipts.get(txHash.toLowerCase()) ?? null; }
  async readVaultCampaign(_v: Address, key: Hex) {
    return (
      this.vaultStates.get(key.toLowerCase()) ?? {
        exists: false, owner: null, policyHash: null, budgetCap: 0n, bountyCeiling: 0n,
        deadline: 0n, executor: null, verifier: null, funded: 0n, spent: 0n,
        paused: false, closed: false, returned: false,
      }
    );
  }
  async usdcBalanceOf() { return 0n; }
  async hasCode() { return true; }
}

const txFor = (n: number) => (`0x${String(n).repeat(64).slice(0, 64)}` as Hex);

function setup(partners: Array<{ id: string; userId: string; rulesJson: Record<string, unknown> }>) {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: partners.map((p) => ({ ...p, payoutWallet: PARTNER_W })),
  }) as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const deps = { store, audit: sink, now: () => NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => NOW };
  return { store, deps, fundingDeps, reader, events };
}

async function liveCampaignId(ctx: ReturnType<typeof setup>, tag = 11) {
  const deps = { store: ctx.store, audit: ctx.deps.audit, now: () => NOW };
  const d = await createDraft(deps as CampaignDeps, {
    workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE } as never,
  });
  await moveToReview(deps as CampaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(deps as CampaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerTestWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
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
  const { openMarket } = await import("@/server/services/markets");
  await openMarket(ctx.deps as never, {
    campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1,
    openingBountyMicroUsdc: "2000000", destinationUrl: DEST,
  });
  return d.campaign.id;
}

const ON = {
  autoJoin: true, minimumBountyMicroUsdc: "500000", allowedCategories: ["media"],
  blockedCategories: [], maxActiveCampaigns: 3, minScoutConfidence: "LOW", maxAutoJoinsPerDay: 5,
};

function bgDeps(
  ctx: ReturnType<typeof setup>,
  notifications: ReturnType<typeof createMemoryNotificationStore>,
  over: Partial<BackgroundScoutDeps> = {},
): BackgroundScoutDeps {
  return {
    store: ctx.store,
    audit: ctx.deps.audit,
    now: () => NOW,
    notifications,
    onboardingCompleted: async () => true,
    joinsTodayByPartner: async () => 0,
    settledPayoutsByPartner: async () => [],
    funnelRatesByPartner: async () => null,
    ...over,
  };
}

function toExisting(
  items: ReturnType<typeof buildBackgroundAlerts>,
  creatorUserId: string,
): StoredCreatorNotification[] {
  return items.map((n, i) => ({
    id: `n-${i}`,
    creatorUserId,
    type: n.type,
    campaignId: n.campaignId,
    title: n.title,
    message: n.message,
    dedupeKey: n.dedupeKey,
    metadataJson: n.metadataJson ?? {},
    createdAt: new Date(NOW.getTime() + i * 1000),
    readAt: null,
  }));
}

function candidate(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    facts: {
      campaignId: "c-1", workspaceName: "Acme", objective: "Get customers", category: "media",
      bountyMicroUsdc: "2000000", targetOutcomeCount: 10, verifiedOutcomes: 2,
      deadline: new Date(NOW.getTime() + 10 * DAY),
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
    ...over,
  };
}

/* ---------- pure: dedupe keys + refusal quality ---------- */

describe("dedupe keys", () => {
  it("are stable per event truth and distinct across events", () => {
    expect(dedupeKeyFor.autoJoined("c1", "abc")).toBe(dedupeKeyFor.autoJoined("c1", "abc"));
    expect(dedupeKeyFor.autoJoined("c1", "abc")).not.toBe(dedupeKeyFor.autoJoined("c1", "abd"));
    expect(dedupeKeyFor.bountyChanged("c1", "3000000")).not.toBe(dedupeKeyFor.bountyChanged("c1", "2000000"));
    expect(dedupeKeyFor.closingSoon("c1", "72h")).not.toBe(dedupeKeyFor.closingSoon("c1", "24h"));
    expect(dedupeKeyFor.payoutSettled("p1")).not.toBe(dedupeKeyFor.payoutSettled("p2"));
    expect(dedupeKeyFor.newMatch("c1")).not.toBe(dedupeKeyFor.review("c1", "NOT_RECOMMENDED"));
  });
});

describe("refusal quality", () => {
  it("surfaces recommended-but-blocked policies, never blanket rejections", () => {
    expect(isUsefulRefusal("RECOMMEND", "MIN_BOUNTY")).toBe(true);
    expect(isUsefulRefusal("RECOMMEND", "MAX_ACTIVE")).toBe(true);
    expect(isUsefulRefusal("RECOMMEND", "RATE_LIMITED")).toBe(true);
    expect(isUsefulRefusal("RECOMMEND", "CATEGORY_BLOCKED")).toBe(false);
    expect(isUsefulRefusal("RECOMMEND", "INELIGIBLE")).toBe(false);
    expect(isUsefulRefusal("RECOMMEND", "JOIN_FAILED")).toBe(false);
    expect(isUsefulRefusal("WATCH", "MIN_BOUNTY")).toBe(false);
    expect(isUsefulRefusal("SKIP", "MIN_BOUNTY")).toBe(false);
  });
});

/* ---------- pure: alert builder ---------- */

function runSummary(over: Partial<ScoutRunSummary> = {}): ScoutRunSummary {
  return { evaluated: 1, joined: [], refused: [], recommendedOnly: [], ...over };
}

describe("buildBackgroundAlerts", () => {
  it("repeat runs create no duplicate alerts", () => {
    const c = candidate();
    const first = buildBackgroundAlerts({
      candidates: [c],
      runSummary: runSummary({ joined: [{ campaignId: "c-1", referralCode: "abc", alreadyJoined: false }] }),
      existing: [],
      settled: [],
      funnel: null,
      rules: { minBountyMicroUsdc: "500000", maxActiveCampaigns: 3, maxJoinsPerDay: 5 },
      now: NOW,
    });
    expect(first).toHaveLength(1);
    expect(first[0].type).toBe("AUTO_JOINED");
    const second = buildBackgroundAlerts({
      candidates: [c],
      runSummary: runSummary({ joined: [{ campaignId: "c-1", referralCode: "abc", alreadyJoined: true }] }),
      existing: toExisting(first, "u-1"),
      settled: [],
      funnel: null,
      rules: { minBountyMicroUsdc: "500000", maxActiveCampaigns: 3, maxJoinsPerDay: 5 },
      now: NOW,
    });
    expect(second).toHaveLength(0);
  });

  it("bounty change triggers one fresh alert, then stays quiet", () => {
    const old = candidate();
    const joined: ScoutRunSummary = { evaluated: 1, joined: [{ campaignId: "c-1", referralCode: "abc", alreadyJoined: false }], refused: [], recommendedOnly: [] };
    const base = buildBackgroundAlerts({
      candidates: [old], runSummary: joined, existing: [], settled: [],
      funnel: null, rules: null, now: NOW,
    });
    const existing = toExisting(base, "u-1");
    const fresh = candidate({ facts: { ...old.facts, bountyMicroUsdc: "3000000" } });
    const changed = buildBackgroundAlerts({
      candidates: [fresh],
      runSummary: { evaluated: 1, joined: [], refused: [], recommendedOnly: [] },
      existing, settled: [], funnel: null, rules: null, now: NOW,
    });
    expect(changed.filter((a) => a.type === "BOUNTY_CHANGED")).toHaveLength(1);
    expect(changed[0].dedupeKey).toBe(dedupeKeyFor.bountyChanged("c-1", "3000000"));
    const quiet = buildBackgroundAlerts({
      candidates: [fresh],
      runSummary: { evaluated: 1, joined: [], refused: [], recommendedOnly: [] },
      existing: [...existing, ...toExisting(changed, "u-1")],
      settled: [], funnel: null, rules: null, now: NOW,
    });
    expect(quiet.filter((a) => a.type === "BOUNTY_CHANGED")).toHaveLength(0);
  });

  it("settlement triggers one payout alert; empty settlement list triggers none", () => {
    const withSettled = buildBackgroundAlerts({
      candidates: [candidate()],
      runSummary: runSummary(),
      existing: [],
      settled: [{ payoutId: "p-1", campaignId: "c-1", amountMicroUsdc: "2000000", workspaceName: "Acme" }],
      funnel: null, rules: null, now: NOW,
    });
    expect(withSettled.filter((a) => a.type === "PAYOUT_SETTLED")).toHaveLength(1);
    // A SUBMITTED (unsettled) payout never reaches the builder — the runner
    // only forwards SETTLED truth — so nothing fires.
    const without = buildBackgroundAlerts({
      candidates: [candidate()],
      runSummary: runSummary(),
      existing: [],
      settled: [],
      funnel: null, rules: null, now: NOW,
    });
    expect(without.filter((a) => a.type === "PAYOUT_SETTLED")).toHaveLength(0);
  });

  it("closing-soon dedupes by threshold bucket", () => {
    const soon72 = candidate({ facts: { ...candidate().facts, deadline: new Date(NOW.getTime() + 70 * 3_600_000) } });
    const first = buildBackgroundAlerts({
      candidates: [soon72], runSummary: runSummary(), existing: [], settled: [],
      funnel: null, rules: null, now: NOW,
    });
    expect(first.filter((a) => a.type === "CAMPAIGN_CLOSING_SOON")).toHaveLength(1);
    const repeat = buildBackgroundAlerts({
      candidates: [soon72], runSummary: runSummary(), existing: toExisting(first, "u-1"), settled: [],
      funnel: null, rules: null, now: NOW,
    });
    expect(repeat.filter((a) => a.type === "CAMPAIGN_CLOSING_SOON")).toHaveLength(0);
    const soon24 = candidate({ facts: { ...candidate().facts, deadline: new Date(NOW.getTime() + 20 * 3_600_000) } });
    const escalated = buildBackgroundAlerts({
      candidates: [soon24], runSummary: runSummary(), existing: toExisting(first, "u-1"), settled: [],
      funnel: null, rules: null, now: NOW,
    });
    expect(escalated.filter((a) => a.type === "CAMPAIGN_CLOSING_SOON")).toHaveLength(1);
  });
});

/* ---------- memory inbox: ownership ---------- */

describe("notification store ownership", () => {
  it("creators read only their own notifications; mark-read is ownership-checked", async () => {
    const store = createMemoryNotificationStore();
    await store.insertIfAbsent("user-a", {
      type: "AUTO_JOINED", campaignId: "c-1", title: "t", message: "m", dedupeKey: "aj:c-1:abc",
    });
    expect(await store.listForCreator("user-b")).toHaveLength(0);
    expect(await store.unreadCount("user-b")).toBe(0);
    expect(await store.listForCreator("user-a")).toHaveLength(1);
    const [row] = await store.listForCreator("user-a");
    // Another creator cannot mark it read; unknown ids fail closed.
    expect(await store.markRead("user-b", row.id)).toBe(false);
    expect(await store.markRead("user-a", "missing")).toBe(false);
    expect(await store.markAllRead("user-b")).toBe(0);
    expect(await store.unreadCount("user-a")).toBe(1);
    expect(await store.markRead("user-a", row.id)).toBe(true);
    expect(await store.markRead("user-a", row.id)).toBe(false);
    expect(await store.unreadCount("user-a")).toBe(0);
    // Repeat runs never duplicate: same dedupe key is a no-op.
    expect((await store.insertIfAbsent("user-a", {
      type: "AUTO_JOINED", campaignId: "c-1", title: "t", message: "m", dedupeKey: "aj:c-1:abc",
    })).inserted).toBe(false);
  });
});

/* ---------- background runner integration ---------- */

describe("runBackgroundScout", () => {
  it("autoJoin OFF means the background never joins", async () => {
    const ctx = setup([{ id: "p-1", userId: "partner-1", rulesJson: { ...ON, autoJoin: false } }]);
    await liveCampaignId(ctx);
    const notifications = createMemoryNotificationStore();
    const summary = await runBackgroundScout(bgDeps(ctx, notifications));
    expect(summary.creatorsEvaluated).toBe(0);
    expect(summary.autoJoins).toBe(0);
    expect(notifications.size()).toBe(0);
    expect(await ctx.store.listPartnerTerms("p-1")).toHaveLength(0);
  });

  it("skips creators without finished onboarding", async () => {
    const ctx = setup([{ id: "p-1", userId: "partner-1", rulesJson: ON }]);
    await liveCampaignId(ctx);
    const notifications = createMemoryNotificationStore();
    const summary = await runBackgroundScout(
      bgDeps(ctx, notifications, { onboardingCompleted: async () => false }),
    );
    expect(summary.creatorsEvaluated).toBe(0);
    expect(summary.creatorsSkipped).toBe(1);
    expect(summary.autoJoins).toBe(0);
    expect(await ctx.store.listPartnerTerms("p-1")).toHaveLength(0);
  });

  it("valid AUTO_JOIN joins without a click; repeats create nothing new", async () => {
    const ctx = setup([{ id: "p-1", userId: "partner-1", rulesJson: ON }]);
    const campaignId = await liveCampaignId(ctx);
    const notifications = createMemoryNotificationStore();
    // Evidence lives in the DB in production; simulate an evidenced creator
    // while keeping the real authority + join + alert path.
    const evidencedSnapshot = async (store: MarketStore, userId: string, now: Date) => {
      const live = await loadScoutSnapshot(store, userId, now);
      return {
        ...live,
        candidates: live.candidates.map((c) => ({
          ...c, decision: "RECOMMEND" as const, confidence: "HIGH" as const,
        })),
      };
    };
    const first = await runBackgroundScout(bgDeps(ctx, notifications, { loadSnapshot: evidencedSnapshot }));
    expect(first.creatorsEvaluated).toBe(1);
    expect(first.campaignsEvaluated).toBe(1);
    expect(first.autoJoins).toBe(1);
    const terms = await ctx.store.listPartnerTerms("p-1");
    expect(terms.filter((t) => t.campaignId === campaignId)).toHaveLength(1);
    const items = await notifications.listForCreator("partner-1");
    const joined = items.filter((n) => n.type === "AUTO_JOINED");
    expect(joined).toHaveLength(1);
    expect(joined[0].metadataJson.referralPath).toMatch(/^\/r\//);
    expect(joined[0].metadataJson.rule).toBe("WITHIN_CREATOR_AUTHORITY");
    // Repeat run: no duplicate participation, referral, or alerts.
    const second = await runBackgroundScout(bgDeps(ctx, notifications, { loadSnapshot: evidencedSnapshot }));
    expect(second.autoJoins).toBe(0);
    expect(second.alertsCreated).toBe(0);
    expect((await ctx.store.listPartnerTerms("p-1")).filter((t) => t.campaignId === campaignId)).toHaveLength(1);
    expect((await notifications.listForCreator("partner-1")).filter((n) => n.type === "AUTO_JOINED")).toHaveLength(1);
  });

  it("cold-start creators surface REVIEW alerts, never silent joins", async () => {
    const ctx = setup([{ id: "p-1", userId: "partner-1", rulesJson: ON }]);
    await liveCampaignId(ctx);
    const notifications = createMemoryNotificationStore();
    const first = await runBackgroundScout(bgDeps(ctx, notifications));
    expect(first.creatorsEvaluated).toBe(1);
    expect(first.autoJoins).toBe(0);
    expect(first.recommendedOnly).toBeGreaterThan(0);
    const items = await notifications.listForCreator("partner-1");
    expect(items.filter((n) => n.type === "NEW_MATCH_REQUIRES_REVIEW").length).toBeGreaterThan(0);
    expect(items.filter((n) => n.type === "AUTO_JOIN_REFUSED").length).toBe(0);
    expect(await ctx.store.listPartnerTerms("p-1")).toHaveLength(0);
    const second = await runBackgroundScout(bgDeps(ctx, notifications));
    expect(second.alertsCreated).toBe(0);
  });

  it("blocked creator rules never join and never spam refusals", async () => {
    const ctx = setup([{
      id: "p-1", userId: "partner-1",
      rulesJson: { ...ON, blockedCategories: ["media"] },
    }]);
    await liveCampaignId(ctx);
    const notifications = createMemoryNotificationStore();
    const summary = await runBackgroundScout(bgDeps(ctx, notifications));
    expect(summary.autoJoins).toBe(0);
    expect(await ctx.store.listPartnerTerms("p-1")).toHaveLength(0);
    const items = await notifications.listForCreator("partner-1");
    expect(items.filter((n) => n.type === "AUTO_JOIN_REFUSED")).toHaveLength(0);
  });

  it("unknown eligibility never joins", async () => {
    const ctx = setup([{ id: "p-1", userId: "partner-1", rulesJson: ON }]);
    await liveCampaignId(ctx);
    const snapshot = await loadScoutSnapshot(ctx.store, "partner-1", NOW);
    const unknown = {
      ...snapshot,
      candidates: snapshot.candidates.map((c) => ({
        ...c, eligibility: "UNKNOWN" as const, decision: "WATCH" as const,
      })),
    };
    const res = await runScoutAutoJoin(ctx.deps as never, "partner-1", {
      joinsTodayByPartner: async () => 0,
      snapshot: unknown,
    });
    expect(res.joined).toHaveLength(0);
    expect(await ctx.store.listPartnerTerms("p-1")).toHaveLength(0);
  });

  it("one creator failure never aborts the batch", async () => {
    const ctx = setup([
      { id: "p-bad", userId: "partner-bad", rulesJson: { autoJoin: true, minimumBountyMicroUsdc: "not-a-number" } },
      { id: "p-1", userId: "partner-1", rulesJson: ON },
    ]);
    await liveCampaignId(ctx);
    const notifications = createMemoryNotificationStore();
    const summary = await runBackgroundScout(bgDeps(ctx, notifications));
    expect(summary.errors.length).toBeGreaterThan(0);
    expect(summary.creatorsEvaluated).toBe(1);
  });

  it("bounty change triggers one fresh alert; historical terms stay frozen", async () => {
    const ctx = setup([{ id: "p-1", userId: "partner-1", rulesJson: ON }]);
    const campaignId = await liveCampaignId(ctx);
    // Join at the original bounty through the shared path.
    const snapshot = await loadScoutSnapshot(ctx.store, "partner-1", NOW);
    const evidenced = {
      ...snapshot,
      candidates: snapshot.candidates.map((c) => ({ ...c, decision: "RECOMMEND" as const, confidence: "HIGH" as const })),
    };
    const manual = await runScoutAutoJoin(ctx.deps as never, "partner-1", {
      joinsTodayByPartner: async () => 0,
      snapshot: evidenced,
      trigger: "background",
    });
    expect(manual.joined).toHaveLength(1);
    const termsBefore = await ctx.store.listPartnerTerms("p-1");
    expect(termsBefore).toHaveLength(1);
    expect(termsBefore[0].priceMicroUsdc).toBe(2_000_000n);

    // Reprice the live market (org-side autonomous repricing analogue).
    const market = await ctx.store.getMarket(campaignId);
    await ctx.store.updateMarket(campaignId, market!.version, {
      publicBountyMicroUsdc: 3_000_000n,
      version: market!.version + 1,
    });

    const notifications = createMemoryNotificationStore();
    await notifications.insertIfAbsent("partner-1", {
      type: "AUTO_JOINED", campaignId, title: "prior", message: "prior",
      dedupeKey: dedupeKeyFor.autoJoined(campaignId, manual.joined[0].referralCode),
      metadataJson: { bountyMicroUsdc: "2000000", referralCode: manual.joined[0].referralCode },
    });
    const summary = await runBackgroundScout(bgDeps(ctx, notifications));
    const items = await notifications.listForCreator("partner-1");
    const bounty = items.filter((n) => n.type === "BOUNTY_CHANGED");
    expect(bounty).toHaveLength(1);
    expect(bounty[0].message).toMatch(/2 → 3 USDC/);
    expect(bounty[0].metadataJson.bountyMicroUsdc).toBe("3000000");
    expect(bounty[0].metadataJson.previousBountyMicroUsdc).toBe("2000000");
    // Historical attribution frozen: the original terms price is untouched,
    // and the already-joined campaign is not re-joined.
    const termsAfter = await ctx.store.listPartnerTerms("p-1");
    expect(termsAfter).toHaveLength(1);
    expect(termsAfter[0].priceMicroUsdc).toBe(2_000_000n);
    expect(summary.autoJoins).toBe(0);
    // A repeat run stays quiet.
    const again = await runBackgroundScout(bgDeps(ctx, notifications));
    expect(again.alertsCreated).toBe(0);
  });

  it("settlement triggers one payout alert; SUBMITTED never does", async () => {
    const ctx = setup([{ id: "p-1", userId: "partner-1", rulesJson: ON }]);
    const campaignId = await liveCampaignId(ctx);
    const snapshot = await loadScoutSnapshot(ctx.store, "partner-1", NOW);
    const evidenced = {
      ...snapshot,
      candidates: snapshot.candidates.map((c) => ({ ...c, decision: "RECOMMEND" as const, confidence: "HIGH" as const })),
    };
    const manual = await runScoutAutoJoin(ctx.deps as never, "partner-1", {
      joinsTodayByPartner: async () => 0,
      snapshot: evidenced,
    });
    expect(manual.joined).toHaveLength(1);
    const terms = (await ctx.store.listPartnerTerms("p-1"))[0];
    const outcome = await ctx.store.insertOutcome({
      id: "o-1", campaignId, partnerId: "p-1", partnerTermsId: terms.id,
      checkoutIntentId: "ci-1", customerKeyHash: "k", purchaseTx: txFor(21), purchaseAmountMicroUsdc: 12_000_000n,
    });
    await ctx.store.updateOutcome(outcome.id, { status: "VERIFIED", verifiedAt: NOW });
    const payout = await ctx.store.insertPayout({
      id: "pay-1", reservationId: "res-1", outcomeId: outcome.id, campaignId,
      partnerId: "p-1", recipient: PARTNER_W, amountMicroUsdc: 2_000_000n, proofHash: "0xproof",
    });
    // Mirrors the production seam: only SETTLED truth is forwarded.
    const settledSeam = async (partnerId: string) => {
      const row = await ctx.store.getPayoutByOutcome(outcome.id);
      if (!row || row.partnerId !== partnerId || row.state !== "SETTLED") return [];
      return [{ payoutId: row.id, campaignId: row.campaignId, amountMicroUsdc: row.amountMicroUsdc.toString(), workspaceName: "Acme" }];
    };
    const notifications = createMemoryNotificationStore();
    const submitted = await runBackgroundScout(bgDeps(ctx, notifications, { settledPayoutsByPartner: settledSeam }));
    expect(submitted.alertsCreated).toBe(0);
    expect((await notifications.listForCreator("partner-1")).filter((n) => n.type === "PAYOUT_SETTLED")).toHaveLength(0);

    await ctx.store.updatePayout(payout.id, { state: "SETTLED", settledAt: NOW });
    const settled = await runBackgroundScout(bgDeps(ctx, notifications, { settledPayoutsByPartner: settledSeam }));
    expect(settled.alertsCreated).toBeGreaterThan(0);
    const items = await notifications.listForCreator("partner-1");
    expect(items.filter((n) => n.type === "PAYOUT_SETTLED")).toHaveLength(1);
    // Repeat runs dedupe on the payout.
    const quiet = await runBackgroundScout(bgDeps(ctx, notifications, { settledPayoutsByPartner: settledSeam }));
    expect(quiet.alertsCreated).toBe(0);
  });
});
