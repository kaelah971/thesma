import { describe, expect, it } from "vitest";
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
  getPartnerRules,
  joinCampaign,
  openMarket,
  updatePartnerRules,
  type MarketDeps,
} from "@/server/services/markets";
import {
  NEGOTIATION_AUTOMATION_UNAVAILABLE,
  nextOnboardingQuestion,
  parseOnboardingAnswers,
} from "@/server/domain/supplyAgent";
import {
  answerAgentQuestion,
  confirmOnboarding,
  findMatches,
  getAgentStatus,
  runAgent,
} from "@/server/services/supplyAgent";

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
  const { sink, events } = createMemoryAuditSink();
  const marketDeps: MarketDeps = { store, audit: sink, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, events, marketDeps, campaignDeps, fundingDeps, reader };
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

async function openedCampaign(ctx: ReturnType<typeof setup>, tag = 1, bounty = "2000000") {
  const id = await liveCampaign(ctx, tag);
  await openMarket(ctx.marketDeps, {
    campaignId: id,
    userId: "owner-1",
    expectedPolicyVersion: 1,
    openingBountyMicroUsdc: bounty,
    destinationUrl: DEST,
  });
  return id;
}

const RULES_WIRE = {
  minimumBountyMicroUsdc: "200000",
  allowedCategories: ["media"],
  blockedCategories: [],
  maxActiveCampaigns: 5,
  autoJoin: true,
  autoNegotiate: false,
  maxAllocationCount: 2,
};

describe("conversational onboarding -> typed rules", () => {
  it("parses free-text answers into exact micro-USDC rules", async () => {
    const parsed = parseOnboardingAnswers({
      categoriesText: "AI, devtools and fintech",
      minBountyText: "0.20 USDC per verified customer",
      autoJoinText: "Yes, join them",
      autoNegotiateText: "No",
    });
    expect(parsed.rules.allowedCategories).toEqual(["AI", "devtools", "fintech"]);
    expect(parsed.rules.minimumBountyMicroUsdc).toBe("200000");
    expect(parsed.rules.autoJoin).toBe(true);
    expect(parsed.rules.autoNegotiate).toBe(false);
    expect(parsed.missing).toEqual([]);
    expect(nextOnboardingQuestion(parsed)).toBeNull();
  });

  it("asks progressively and never persists drafts", async () => {
    const ctx = setup();
    const empty = parseOnboardingAnswers({});
    expect(nextOnboardingQuestion(empty)?.key).toBe("categories");
    const step1 = parseOnboardingAnswers({ categoriesText: "media" });
    expect(nextOnboardingQuestion(step1)?.key).toBe("minBounty");
    const before = await getPartnerRules(ctx.marketDeps, { userId: "partner-1" });
    expect(before.rules.minimumBountyMicroUsdc).toBe("0");
    expect(before.rules.autoJoin).toBe(false);
  });

  it("requires explicit confirmation before activation", async () => {
    const ctx = setup();
    await expect(
      confirmOnboarding(ctx.marketDeps, { userId: "partner-1", rules: RULES_WIRE, confirmed: false as never }),
    ).rejects.toMatchObject({ status: 400, code: "CONFIRMATION_REQUIRED" });
    const untouched = await getPartnerRules(ctx.marketDeps, { userId: "partner-1" });
    expect(untouched.rules.autoJoin).toBe(false);
    const res = await confirmOnboarding(ctx.marketDeps, { userId: "partner-1", rules: RULES_WIRE, confirmed: true });
    expect(res.rules.autoJoin).toBe(true);
    expect(res.rules.minimumBountyMicroUsdc).toBe("200000");
    expect(res.rules.allowedCategories).toEqual(["media"]);
    expect(res.rules.maxAllocationCount).toBe(2);
  });
});

describe("supply agent on real market data", () => {
  it("matches eligible markets with explanations and skips blocked ones", async () => {
    const ctx = setup();
    const id = await openedCampaign(ctx, 1);
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: RULES_WIRE });
    const matches = await findMatches(ctx.marketDeps, { userId: "partner-1" });
    expect(matches.matches.map((m) => m.campaignId)).toEqual([id]);
    expect(matches.matches[0].reasons.length).toBeGreaterThan(0);

    const blocked = await updatePartnerRules(ctx.marketDeps, {
      userId: "partner-1",
      rules: { ...RULES_WIRE, blockedCategories: ["media"] },
    });
    expect(blocked.rules.blockedCategories).toEqual(["media"]);
    const status = await getAgentStatus(ctx.marketDeps, { userId: "partner-1" });
    expect(status.matches).toEqual([]);
    expect(status.blockedCategoryCount).toBe(1);
    expect(status.skipped[0].code).toBe("CATEGORY_BLOCKED");
  });

  it("auto-join executes only inside rules via the existing join path", async () => {
    const ctx = setup();
    const rich = await openedCampaign(ctx, 1, "3000000");
    const poor = await openedCampaign(ctx, 2, "2000000");
    await updatePartnerRules(ctx.marketDeps, {
      userId: "partner-1",
      rules: { ...RULES_WIRE, minimumBountyMicroUsdc: "2500000" },
    });
    const res = await runAgent(ctx.marketDeps, { userId: "partner-1" });
    expect(res.joined.map((j) => j.campaignId)).toEqual([rich]);
    expect(res.joined[0].referralCode).toBeTruthy();
    expect(res.skipped.map((s) => s.campaignId)).toEqual([poor]);
    expect(Object.keys(res).sort()).toEqual(["joined", "skipped"]);
  });

  it("refuses auto-join without a payout wallet and beyond the active cap", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-9", rules: RULES_WIRE });
    const noWallet = await runAgent(ctx.marketDeps, { userId: "partner-9" });
    expect(noWallet.joined).toEqual([]);
    expect(noWallet.skipped[0].reason).toMatch(/payout wallet/i);

    await updatePartnerRules(ctx.marketDeps, {
      userId: "partner-1",
      rules: { ...RULES_WIRE, maxActiveCampaigns: 1 },
    });
    await openedCampaign(ctx, 2, "2000000");
    await openedCampaign(ctx, 3, "2000000");
    await joinCampaign(ctx.marketDeps, { campaignId: (await ctx.store.listMarkets())[0].campaignId, userId: "partner-1" });
    const capped = await runAgent(ctx.marketDeps, { userId: "partner-1" });
    expect(capped.joined).toEqual([]);
    expect(capped.skipped.every((s) => /limit|maximum/i.test(s.reason))).toBe(true);
  });

  it("recommends only when auto-join is OFF", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { ...RULES_WIRE, autoJoin: false } });
    await expect(runAgent(ctx.marketDeps, { userId: "partner-1" })).rejects.toMatchObject({
      status: 400,
      code: "AUTOJOIN_DISABLED",
    });
    const matches = await findMatches(ctx.marketDeps, { userId: "partner-1" });
    expect(matches.matches.length).toBe(1);
  });

  it("chat answers from state, refuses chat mutation, and never auto-negotiates", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1, "2000000");
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: RULES_WIRE });
    const q = await answerAgentQuestion(ctx.marketDeps, { userId: "partner-1", question: "What live campaigns match my preferences?" });
    expect(q.answer).toContain("Top matches");
    const neg = await answerAgentQuestion(ctx.marketDeps, { userId: "partner-1", question: "Should we negotiate this campaign?" });
    expect(neg.answer).toContain(NEGOTIATION_AUTOMATION_UNAVAILABLE);
    const before = await getPartnerRules(ctx.marketDeps, { userId: "partner-1" });
    await answerAgentQuestion(ctx.marketDeps, { userId: "partner-1", question: "Change my minimum bounty to 5 USDC" });
    const after = await getPartnerRules(ctx.marketDeps, { userId: "partner-1" });
    expect(after).toEqual(before);
    const events = (ctx.events as Array<{ action: string }>);
    expect(events.some((e) => /social|publish|post/i.test(e.action))).toBe(false);
  });
});
