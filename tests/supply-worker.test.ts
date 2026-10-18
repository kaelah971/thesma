import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  approvePolicy,
  createDraft,
  moveToReview,
} from "@/server/services/campaigns";
import type { CampaignDeps } from "@/server/services/campaigns";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
} from "@/server/services/campaignStore";
import type { MarketStore } from "@/server/services/campaignStore";
import {
  confirmFunding,
  prepareFundingIntent,
  recordFundingSubmitted,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import type { ArcChainReader, ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import {
  joinCampaign,
  openMarket,
  updatePartnerRules,
  type MarketDeps,
} from "@/server/services/markets";
import { runSupplyAgentWorker } from "@/server/services/supplyAgent";

const OWNER_W = "0x1111111111111111111111111111111111111111" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEST = "https://acme.example/product";

const CONFIG: ArcConfig = {
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR,
  verifierAddress: VERIFIER,
  explorerBaseUrl: null,
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
    partners: [
      { id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} },
      { id: "p-9", userId: "partner-9", payoutWallet: null, rulesJson: {} },
    ],
  }) as MarketStore;
  const { sink } = createMemoryAuditSink();
  const marketDeps: MarketDeps = { store, audit: sink, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, marketDeps, campaignDeps, fundingDeps, reader };
}

async function liveCampaign(ctx: ReturnType<typeof setup>, tag = 1, overrides: Record<string, unknown> = {}) {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, ...overrides } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerCompanyWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: txFor(tag) });
  ctx.reader.receipts.set(txFor(tag).toLowerCase(), {
    status: "success",
    to: VAULT,
    blockNumber: 1n,
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

async function openedCampaign(ctx: ReturnType<typeof setup>, tag = 1, bounty = "2000000", overrides: Record<string, unknown> = {}) {
  const id = await liveCampaign(ctx, tag, overrides);
  await openMarket(ctx.marketDeps, {
    campaignId: id,
    userId: "owner-1",
    expectedPolicyVersion: 1,
    openingBountyMicroUsdc: bounty,
    destinationUrl: DEST,
  });
  return id;
}

const AUTOJOIN_RULES = {
  minimumBountyMicroUsdc: "200000",
  allowedCategories: ["media"],
  blockedCategories: [],
  maxActiveCampaigns: 5,
  autoJoin: true,
  autoNegotiate: false,
  maxAllocationCount: 1,
};

describe("background supply agent worker", () => {
  it("ignores Partners with autoJoin=false", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { ...AUTOJOIN_RULES, autoJoin: false } });
    const summary = await runSupplyAgentWorker(ctx.marketDeps);
    expect(summary.partnersEvaluated).toBe(0);
    expect(summary.joined).toEqual([]);
  });

  it("joins a valid match through the existing join path", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: AUTOJOIN_RULES });
    const summary = await runSupplyAgentWorker(ctx.marketDeps);
    expect(summary.partnersEvaluated).toBe(1);
    expect(summary.marketsEvaluated).toBe(1);
    expect(summary.joined.map((j) => j.campaignId)).toEqual([id]);
    expect(summary.joined[0].alreadyJoined).toBe(false);
    expect(summary.joined[0].referralCode).toBeTruthy();
    const terms = await ctx.store.getTerms(id, "p-1");
    expect(terms).not.toBeNull();
    expect(await ctx.store.getReferralByTerms(terms!.id)).not.toBeNull();
  });

  it("respects minimum bounty with truthful reason codes", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, {
      userId: "partner-1",
      rules: { ...AUTOJOIN_RULES, minimumBountyMicroUsdc: "2500000" },
    });
    const summary = await runSupplyAgentWorker(ctx.marketDeps);
    expect(summary.joined).toEqual([]);
    expect(summary.skipped).toEqual([
      expect.objectContaining({ partnerId: "p-1", campaignId: id, reason: "MIN_BOUNTY" }),
    ]);
  });

  it("respects allow/block categories, wallet, caps and existing joins", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, {
      userId: "partner-1",
      rules: { ...AUTOJOIN_RULES, blockedCategories: ["media"] },
    });
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-9", rules: AUTOJOIN_RULES });
    const summary = await runSupplyAgentWorker(ctx.marketDeps);
    expect(summary.joined).toEqual([]);
    const reasons = summary.skipped.map((s) => `${s.partnerId}:${s.reason}`);
    expect(reasons).toContain(`p-1:CATEGORY_BLOCKED`);
    expect(reasons).toContain(`p-9:WALLET_REQUIRED`);

    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { ...AUTOJOIN_RULES, maxActiveCampaigns: 1 } });
    await openedCampaign(ctx, 2, "2000000");
    await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" });
    const capped = await runSupplyAgentWorker(ctx.marketDeps);
    expect(capped.joined).toEqual([]);
    expect(capped.skipped.map((s) => s.reason)).toContain("ALREADY_JOINED");
    expect(capped.skipped.map((s) => s.reason)).toContain("MAX_ACTIVE");
  });

  it("ignores private, expired and closed campaigns", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1, "2000000", { marketVisibility: "PRIVATE" });
    const closedId = await openedCampaign(ctx, 2, "2000000");
    await ctx.store.updateCampaign(closedId, { state: "CLOSED" });
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: AUTOJOIN_RULES });
    const summary = await runSupplyAgentWorker(ctx.marketDeps);
    expect(summary.marketsEvaluated).toBe(0);
    expect(summary.joined).toEqual([]);
  });

  it("repeated and concurrent runs never duplicate a join", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: AUTOJOIN_RULES });
    const [a, b] = await Promise.all([runSupplyAgentWorker(ctx.marketDeps), runSupplyAgentWorker(ctx.marketDeps)]);
    const freshJoins = [...a.joined, ...b.joined].filter((j) => !j.alreadyJoined);
    expect(freshJoins).toHaveLength(1);
    const third = await runSupplyAgentWorker(ctx.marketDeps);
    expect(third.joined).toEqual([]);
    expect(third.skipped.map((s) => s.reason)).toContain("ALREADY_JOINED");
    const terms = await ctx.store.listPartnerTerms("p-1");
    expect(terms.filter((t) => t.campaignId === id)).toHaveLength(1);
    // Cross-process serialization relies on lockPartnerRow (SELECT FOR UPDATE in Drizzle);
    // the unique (campaign, partner) pair remains authoritative everywhere.
  });

  it("one Partner failure does not abort the run", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: AUTOJOIN_RULES });
    // p-9 claims autoJoin but stores unparseable rules -> failed, p-1 still joins.
    await ctx.store.updatePartnerRules("p-9", { autoJoin: true, minimumBountyMicroUsdc: "abc" });
    const summary = await runSupplyAgentWorker(ctx.marketDeps);
    expect(summary.failed.map((f) => f.partnerId)).toContain("p-9");
    expect(summary.joined.map((j) => j.partnerId)).toContain("p-1");
  });

  it("stale market versions cannot silently create wrong terms", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: AUTOJOIN_RULES });
    await expect(
      joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1", expectedMarketVersion: 999 }),
    ).rejects.toMatchObject({ status: 409, code: "STALE_MARKET" });
    expect(await ctx.store.getTerms(id, "p-1")).toBeNull();
  });
});

describe("supply worker endpoint gating", () => {
  const SECRET = "test-supply-secret-0123456789abcdef";
  const CRON = "test-cron-secret-0123456789abcdef";
  let saved: Record<string, string | undefined>;
  let route: any;

  beforeAll(async () => {
    saved = {
      SUPPLY_AGENT_WORKER_SECRET: process.env.SUPPLY_AGENT_WORKER_SECRET,
      CRON_SECRET: process.env.CRON_SECRET,
      DATABASE_URL: process.env.DATABASE_URL,
    };
    process.env.SUPPLY_AGENT_WORKER_SECRET = SECRET;
    process.env.CRON_SECRET = CRON;
    delete process.env.DATABASE_URL;
    route = await import("@/app/internal/agents/supply/run/route");
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("rejects missing and wrong secrets without leaking", async () => {
    const noAuth = await route.POST(new Request("http://x/internal/agents/supply/run", { method: "POST" }));
    expect(noAuth.status).toBe(401);
    const wrong = await route.POST(
      new Request("http://x/internal/agents/supply/run", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret-value-0000" },
      }),
    );
    expect(wrong.status).toBe(401);
    for (const res of [noAuth, wrong]) {
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(CRON);
    }
  });

  it("accepts the worker secret (POST) and CRON_SECRET (GET)", async () => {
    const okPost = await route.POST(
      new Request("http://x/internal/agents/supply/run", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    // No DATABASE_URL in test env: passes auth, then reports unconfigured deps.
    expect(okPost.status).toBe(503);
    expect(JSON.stringify(await okPost.json())).not.toContain(SECRET);
    const okGet = await route.GET(
      new Request("http://x/internal/agents/supply/run", {
        method: "GET",
        headers: { authorization: `Bearer ${CRON}` },
      }),
    );
    expect(okGet.status).toBe(503);
  });
});
