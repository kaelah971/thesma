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
import { parsePartnerRules } from "@/server/domain/market";
import { joinCampaign } from "@/server/services/markets";
import {
  alertsForAutoJoinRun,
  evaluateAutoJoinAuthority,
  loadScoutSnapshot,
  meetsConfidence,
  runScoutAutoJoin,
  type AutoJoinAuthorityInput,
} from "@/server/services/scout";

const NOW = new Date("2026-06-01T12:00:00.000Z");

function authority(over: Partial<AutoJoinAuthorityInput> = {}) {
  return evaluateAutoJoinAuthority({
    autoJoinEnabled: true,
    scoutDecision: "RECOMMEND",
    eligibility: "ELIGIBLE",
    confidence: "HIGH",
    confidenceThreshold: "MEDIUM",
    bountyMicroUsdc: 2_000_000n,
    minBountyMicroUsdc: 500_000n,
    categoryBlocked: false,
    categoryAllowed: true,
    activeTermsCount: 0,
    maxActiveCampaigns: 3,
    campaignLive: true,
    visibilityPublic: true,
    deadlineOk: true,
    targetSettled: false,
    alreadyJoined: false,
    joinsToday: 0,
    maxJoinsPerDay: 5,
    ...over,
  });
}

describe("auto-join defaults and gates", () => {
  it("defaults OFF: stored legacy rules without new keys stay manual", () => {
    const parsed = parsePartnerRules({ autoJoin: false });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rules.minScoutConfidence).toBe("MEDIUM");
      expect(parsed.rules.maxAutoJoinsPerDay).toBeNull();
    }
    expect(authority({ autoJoinEnabled: false }).verdict).toBe("RECOMMEND_ONLY");
  });

  it("RECOMMEND + eligible + within rules → AUTO_JOIN", () => {
    const r = authority();
    expect(r.verdict).toBe("AUTO_JOIN");
    expect(r.rule).toBe("WITHIN_CREATOR_AUTHORITY");
  });

  it("WATCH, UNKNOWN and non-recommended never auto-join", () => {
    expect(authority({ scoutDecision: "WATCH" }).verdict).toBe("RECOMMEND_ONLY");
    expect(authority({ scoutDecision: "SKIP" }).verdict).toBe("RECOMMEND_ONLY");
    expect(authority({ eligibility: "UNKNOWN" }).verdict).toBe("REFUSE");
    expect(authority({ eligibility: "NOT_ELIGIBLE" }).verdict).toBe("REFUSE");
  });

  it("blocked category refuses regardless of score", () => {
    expect(authority({ categoryBlocked: true }).verdict).toBe("REFUSE");
    expect(authority({ categoryBlocked: true }).rule).toBe("CATEGORY_BLOCKED");
    expect(authority({ categoryAllowed: false }).rule).toBe("CATEGORY_NOT_ALLOWED");
  });

  it("below-minimum bounty refuses; high bounty never bypasses policy", () => {
    expect(authority({ bountyMicroUsdc: 100_000n }).rule).toBe("MIN_BOUNTY");
    // 100x bounty with a blocked category still refuses.
    expect(authority({ bountyMicroUsdc: 500_000_000n, categoryBlocked: true }).verdict).toBe("REFUSE");
  });

  it("confidence below threshold recommends review instead of joining", () => {
    expect(authority({ confidence: "LOW", confidenceThreshold: "HIGH" }).verdict).toBe("RECOMMEND_ONLY");
    expect(meetsConfidence("HIGH", "HIGH")).toBe(true);
    expect(meetsConfidence("MEDIUM", "HIGH")).toBe(false);
    expect(meetsConfidence("LOW", "LOW")).toBe(true);
  });

  it("max active campaigns and daily rate limits refuse", () => {
    expect(authority({ activeTermsCount: 3, maxActiveCampaigns: 3 }).rule).toBe("MAX_ACTIVE");
    expect(authority({ joinsToday: 5, maxJoinsPerDay: 5 }).rule).toBe("RATE_LIMITED");
    expect(authority({ joinsToday: 4, maxJoinsPerDay: 5 }).verdict).toBe("AUTO_JOIN");
  });

  it("dead states refuse: joined, settled, offline, expired, private", () => {
    expect(authority({ alreadyJoined: true }).rule).toBe("ALREADY_JOINED");
    expect(authority({ targetSettled: true }).rule).toBe("TARGET_SETTLED");
    expect(authority({ campaignLive: false }).rule).toBe("CAMPAIGN_NOT_LIVE");
    expect(authority({ visibilityPublic: false }).rule).toBe("NOT_PUBLIC");
    expect(authority({ deadlineOk: false }).rule).toBe("EXPIRED");
  });
});

describe("alert candidates", () => {
  it("exposes AUTO_JOINED, REFUSED and REVIEW candidates without delivery", () => {
    const alerts = alertsForAutoJoinRun({
      evaluated: 3,
      joined: [{ campaignId: "c-a", referralCode: "abc", alreadyJoined: false }],
      refused: [{ campaignId: "c-b", rule: "MIN_BOUNTY", reason: "too low" }],
      recommendedOnly: [{ campaignId: "c-c", rule: "AUTOJOIN_DISABLED", reason: "off" }],
    });
    expect(alerts.map((a) => a.kind)).toEqual(["AUTO_JOINED", "AUTO_JOIN_REFUSED", "NEW_MATCH_REQUIRES_REVIEW"]);
    for (const a of alerts) expect(a.reason.length).toBeGreaterThan(0);
  });
});

// ---------- Run-level integration (memory store, real join path) ----------

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
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

const txFor = (n: number) => (`0x${String(n).repeat(64).slice(0, 64)}` as Hex);

function setup(rulesJson: Record<string, unknown> = {}) {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson }],
  }) as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const deps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, deps, fundingDeps, reader, events };
}

async function liveCampaignId(ctx: ReturnType<typeof setup>, tag = 11) {
  const deps = { store: ctx.store, audit: ctx.deps.audit, now: () => FIXED_NOW };
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

describe("runScoutAutoJoin", () => {
  it("auto-joins once inside rules and never duplicates on repeat runs", async () => {
    const ctx = setup({
      autoJoin: true,
      minimumBountyMicroUsdc: "500000",
      allowedCategories: ["media"],
      blockedCategories: [],
      maxActiveCampaigns: 3,
      minScoutConfidence: "LOW",
      maxAutoJoinsPerDay: 5,
    });
    const id = await liveCampaignId(ctx);
    // Real snapshot, then simulate an evidenced creator (history lives in
    // the DB in production; the join mechanics under test are identical).
    const live = await loadScoutSnapshot(ctx.store, "partner-1", FIXED_NOW);
    expect(live.candidates).toHaveLength(1);
    const evidenced = {
      ...live,
      candidates: live.candidates.map((c) => ({ ...c, decision: "RECOMMEND" as const, confidence: "HIGH" as const })),
    };
    const first = await runScoutAutoJoin(ctx.deps as never, "partner-1", {
      joinsTodayByPartner: async () => 0,
      snapshot: evidenced,
    });
    expect(first.evaluated).toBe(1);
    expect(first.joined).toHaveLength(1);
    expect(first.joined[0].campaignId).toBe(id);
    expect(first.joined[0].alreadyJoined).toBe(false);
    expect(first.refused).toHaveLength(0);

    const second = await runScoutAutoJoin(ctx.deps as never, "partner-1", {
      joinsTodayByPartner: async () => 1,
    });
    expect(second.joined).toHaveLength(0);
    const terms = await ctx.store.listPartnerTerms("p-1");
    expect(terms.filter((t) => t.campaignId === id)).toHaveLength(1);

    // Ledger: evaluated summaries + one executed row, no render spam.
    const actions = ctx.events.map((e) => (e as { action?: string }).action ?? (e as { type?: string }).type);
    expect(actions.filter((a) => a === "creator.autojoin.evaluated")).toHaveLength(2);
    expect(actions.filter((a) => a === "creator.autojoin.executed")).toHaveLength(1);
  });

  it("refuses blocked categories without joining", async () => {
    const ctx = setup({
      autoJoin: true,
      minimumBountyMicroUsdc: "0",
      allowedCategories: [],
      blockedCategories: ["media"],
      minScoutConfidence: "LOW",
      maxAutoJoinsPerDay: null,
    });
    await liveCampaignId(ctx, 12);
    const res = await runScoutAutoJoin(ctx.deps as never, "partner-1", { joinsTodayByPartner: async () => 0 });
    expect(res.joined).toHaveLength(0);
    expect(res.refused.length).toBeGreaterThan(0);
    expect(res.refused[0].rule).toBe("INELIGIBLE");
    expect(res.refused[0].reason).toMatch(/blocked/i);
    const terms = await ctx.store.listPartnerTerms("p-1");
    expect(terms).toHaveLength(0);
  });

  it("cold-start creators get opportunities surfaced, never silent joins", async () => {
    const ctx = setup({
      autoJoin: true,
      minimumBountyMicroUsdc: "0",
      allowedCategories: [],
      blockedCategories: [],
      minScoutConfidence: "LOW",
      maxAutoJoinsPerDay: null,
    });
    await liveCampaignId(ctx, 14);
    const res = await runScoutAutoJoin(ctx.deps as never, "partner-1", { joinsTodayByPartner: async () => 0 });
    expect(res.joined).toHaveLength(0);
    expect(res.recommendedOnly.length).toBeGreaterThan(0);
    const terms = await ctx.store.listPartnerTerms("p-1");
    expect(terms).toHaveLength(0);
  });

  it("requires an enabled flag: same campaign recommends only when OFF", async () => {
    const ctx = setup({
      autoJoin: false,
      minimumBountyMicroUsdc: "0",
      allowedCategories: [],
      blockedCategories: [],
      minScoutConfidence: "LOW",
      maxAutoJoinsPerDay: null,
    });
    await liveCampaignId(ctx, 13);
    const res = await runScoutAutoJoin(ctx.deps as never, "partner-1", { joinsTodayByPartner: async () => 0 });
    expect(res.joined).toHaveLength(0);
    expect(res.recommendedOnly.length).toBeGreaterThan(0);
    expect(res.recommendedOnly[0].rule).toBe("AUTOJOIN_DISABLED");
  });
});
