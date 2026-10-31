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
  type FundingDeps,
} from "@/server/services/fundings";
import { registerTestWallet } from "./wallet-fixtures";
import type { ArcChainReader, ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import {
  createInvite,
  getMarketState,
  getPartnerRules,
  joinCampaign,
  listPublicMarkets,
  openMarket,
  resolveReferral,
  updatePartnerRules,
  type MarketDeps,
} from "@/server/services/markets";

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
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
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "member-2", workspaceId: "ws-A", role: "ORGANIZATION_MEMBER" },
    ],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [
      { id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} },
      { id: "p-2", userId: "partner-2", payoutWallet: PARTNER_W, rulesJson: {} },
      { id: "p-3", userId: "partner-3", payoutWallet: PARTNER_W, rulesJson: {} },
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

/** Drive a campaign to LIVE, then return its id (tag selects a unique tx hash). */
async function liveCampaign(
  ctx: ReturnType<typeof setup>,
  tag = 1,
  overrides: Record<string, unknown> = {},
  userId = "owner-1",
) {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId,
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, ...overrides } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId, expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId, expectedVersion: 1 });
  await registerTestWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId, address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId, expectedVersion: 1 });
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId, expectedVersion: 1, fundingTxHash: txFor(tag) });
  ctx.reader.receipts.set(txFor(tag).toLowerCase(), {
    status: "success",
    to: VAULT,
    blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 15_000_000n, totalFunded: 15_000_000n }],
  });
  ctx.reader.vaultStates.set(
    p.campaignKey.toLowerCase(),
    {
      exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
      bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
      funded: 15_000_000n, spent: 0n, paused: false, closed: false, returned: false,
    },
  );
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId });
  return d.campaign.id;
}

async function openedCampaign(ctx: ReturnType<typeof setup>, tag = 1, open: Record<string, unknown> = {}) {
  const id = await liveCampaign(ctx, tag);
  const m = await openMarket(ctx.marketDeps, {
    campaignId: id,
    userId: "owner-1",
    expectedPolicyVersion: 1,
    openingBountyMicroUsdc: "2000000",
    destinationUrl: DEST,
    ...open,
  });
  return { campaignId: id, market: m.market };
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

describe("market open (owner-approved bootstrap bounty)", () => {
  it("only the owner can open; the campaign must be LIVE and funded", async () => {
    const ctx = setup();
    const id = await liveCampaign(ctx);
    const member = await fails(
      openMarket(ctx.marketDeps, { campaignId: id, userId: "member-2", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST }),
    );
    expect(member.status).toBe(403);

    const ctx2 = setup();
    const draft = await createDraft(ctx2.campaignDeps, { workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL });
    const early = await fails(
      openMarket(ctx2.marketDeps, { campaignId: draft.campaign.id, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST }),
    );
    expect(early.code).toBe("BAD_REQUEST");
  });

  it("binds the funded policy version and rejects stale versions", async () => {
    const ctx = setup();
    // Approved but unfunded: no market may open (version binding needs funding).
    const d = await createDraft(ctx.campaignDeps, {
      workspaceId: "ws-A",
      userId: "owner-1",
      intentText: CANONICAL,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE } as never,
    });
    await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
    await registerTestWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
    const tooEarly = await fails(
      openMarket(ctx.marketDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST }),
    );
    expect(tooEarly.code).toBe("BAD_REQUEST"); // approved but not LIVE
    // Out-of-band LIVE without confirmed funding: binding check refuses.
    await ctx.store.updateCampaign(d.campaign.id, { state: "LIVE" });
    const unfunded = await fails(
      openMarket(ctx.marketDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST }),
    );
    expect(unfunded.code).toBe("NOT_FUNDED");

    // Funded: opening against a stale version is rejected (FUNDING/LIVE locks
    // policy mutation, so the funded version is always the current one).
    const id = await liveCampaign(ctx, 7);
    const stale = await fails(
      openMarket(ctx.marketDeps, { campaignId: id, userId: "owner-1", expectedPolicyVersion: 99, openingBountyMicroUsdc: "2000000", destinationUrl: DEST }),
    );
    expect(stale.status).toBe(409);
  });

  it("rejects bounty below floor, above ceiling, and unaffordable openings", async () => {
    const ctx = setup();
    const id = await liveCampaign(ctx);
    const base = { campaignId: id, userId: "owner-1", expectedPolicyVersion: 1, destinationUrl: DEST };
    expect((await fails(openMarket(ctx.marketDeps, { ...base, openingBountyMicroUsdc: "1000000" }))).code).toBe("BELOW_FLOOR");
    expect((await fails(openMarket(ctx.marketDeps, { ...base, openingBountyMicroUsdc: "5000000" }))).code).toBe("ABOVE_CEILING");
    // 4M x 5 outcomes = 20M > 15M funded.
    expect((await fails(openMarket(ctx.marketDeps, { ...base, openingBountyMicroUsdc: "4000000" }))).code).toBe("UNAFFORDABLE");
  });

  it("rejects expired campaigns, duplicate opens, and unsafe destinations", async () => {
    const ctx = setup();
    const id = await liveCampaign(ctx);
    const late: MarketDeps = { ...ctx.marketDeps, now: () => new Date("2027-01-01T00:00:00.000Z") };
    expect(
      (await fails(openMarket(late, { campaignId: id, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST }))).code,
    ).toBe("EXPIRED");

    await openMarket(ctx.marketDeps, { campaignId: id, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST });
    expect(
      (await fails(openMarket(ctx.marketDeps, { campaignId: id, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST }))).code,
    ).toBe("ALREADY_OPEN");

    const ctx2 = setup();
    const id2 = await liveCampaign(ctx2, 2);
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "https://user:pass@acme.example/", "not-a-url", "ftp://acme.example/x"]) {
      const err = await fails(
        openMarket(ctx2.marketDeps, { campaignId: id2, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: bad }),
      );
      expect(err.status).toBe(400);
    }
  });

  it("opens at version 1 with audit evidence", async () => {
    const ctx = setup();
    const { market } = await openedCampaign(ctx);
    expect(market.version).toBe(1);
    expect(market.status).toBe("OPEN");
    expect(market.publicBountyMicroUsdc).toBe("2000000");
    const evt = ctx.events.find((e) => e.action === "market.opened");
    expect(evt?.metadata.campaignKey).toBeDefined();
    expect(evt?.metadata.chainId).toBe(31337);
  });
});

describe("partner rules (strict, stored-only automation flags)", () => {
  it("validates exact micro-USDC and rejects malformed rules", async () => {
    const ctx = setup();
    const err = await fails(updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { minimumBountyMicroUsdc: "2.5" } }));
    expect(err.status).toBe(400);
    const neg = await fails(updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { maxActiveCampaigns: -1 } }));
    expect(neg.status).toBe(400);
  });

  it("only the profile owner changes rules; legacy S0 keys still normalize", async () => {
    const ctx = setup();
    const missing = await fails(getPartnerRules(ctx.marketDeps, { userId: "ghost" }));
    expect(missing.status).toBe(404);
    // Legacy S0 shape stored directly: canonical read still works.
    await ctx.store.updatePartnerRules("p-1", { minBountyMicroUSDC: "1000000", maxAllocation: 3 });
    const r = await getPartnerRules(ctx.marketDeps, { userId: "partner-1" });
    expect(r.rules.minimumBountyMicroUsdc).toBe("1000000");
    expect(r.rules.maxAllocationCount).toBe(3);
    // partner-2 cannot affect partner-1's rules (per-user scoping).
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-2", rules: { minimumBountyMicroUsdc: "9000000" } });
    const still = await getPartnerRules(ctx.marketDeps, { userId: "partner-1" });
    expect(still.rules.minimumBountyMicroUsdc).toBe("1000000");
  });

  it("stores autoJoin/autoNegotiate without acting on them", async () => {
    const ctx = setup();
    const before = (await ctx.store.listMarkets()).length;
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { autoJoin: true, autoNegotiate: true } });
    const r = await getPartnerRules(ctx.marketDeps, { userId: "partner-1" });
    expect(r.rules.autoJoin).toBe(true);
    expect((await ctx.store.listMarkets()).length).toBe(before);
    expect((await ctx.store.listPartnerTerms("p-1")).length).toBe(0);
    expect(ctx.events.some((e) => e.action === "partner.rules_updated")).toBe(true);
  });
});

describe("public feed (no private internals)", () => {
  it("hides PRIVATE, expired, and non-live markets and exposes no policy JSON", async () => {
    const ctx = setup();
    await openedCampaign(ctx, 1);
    const privId = await liveCampaign(ctx, 2, { marketVisibility: "PRIVATE" });
    await openMarket(ctx.marketDeps, { campaignId: privId, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST });
    const feed = await listPublicMarkets(ctx.marketDeps);
    expect(feed.markets.length).toBe(1);
    expect(feed.markets[0].publicBountyMicroUsdc).toBe("2000000");
    expect(feed.markets[0].workspaceName).toBe("Acme");
    expect("allowedPartnerRulesJson" in feed.markets[0]).toBe(false);
    expect(JSON.stringify(feed)).not.toMatch(/policyHash|campaignKey/);

    const late: MarketDeps = { ...ctx.marketDeps, now: () => new Date("2027-06-01T00:00:00.000Z") };
    expect((await listPublicMarkets(late)).markets.length).toBe(0);
  });
});

describe("join flow (versioned snapshot, idempotent)", () => {
  it("joins at the exact public bounty + policy + market version with an opaque referral", async () => {
    const ctx = setup();
    const { campaignId } = await openedCampaign(ctx);
    const j = await joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" });
    expect(j.alreadyJoined).toBe(false);
    expect(j.terms.priceMicroUsdc).toBe("2000000");
    expect(j.terms.policyVersion).toBe(1);
    expect(j.terms.marketVersion).toBe(1);
    expect(j.terms.source).toBe("PUBLIC");
    expect(j.terms.expiresAt).toBe(new Date(DEADLINE).toISOString()); // never beyond the deadline
    expect(j.referral.code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(j.referral.code).not.toBe(j.terms.id);
    const state = await getMarketState(ctx.marketDeps, { campaignId, userId: "partner-1" });
    expect(state.market.publicBountyMicroUsdc).toBe("2000000");
  });

  it("requires an invite on private markets; honors expiry and max uses", async () => {
    const ctx = setup();
    const id = await liveCampaign(ctx, 1, { marketVisibility: "PRIVATE" });
    await openMarket(ctx.marketDeps, { campaignId: id, userId: "owner-1", expectedPolicyVersion: 1, openingBountyMicroUsdc: "2000000", destinationUrl: DEST });
    const none = await fails(joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1" }));
    expect(none.code).toBe("INVITE_REQUIRED");
    const bad = await fails(joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1", inviteToken: "nope" }));
    expect(bad.code).toBe("INVITE_INVALID");

    const inv = await createInvite(ctx.marketDeps, { campaignId: id, userId: "owner-1", maxUses: 1 });
    expect(inv.invite.token).toMatch(/^[a-f0-9]{64}$/);
    const ok = await joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-1", inviteToken: inv.invite.token });
    expect(ok.alreadyJoined).toBe(false);
    const exhausted = await fails(joinCampaign(ctx.marketDeps, { campaignId: id, userId: "partner-2", inviteToken: inv.invite.token }));
    expect(exhausted.code).toBe("INVITE_EXHAUSTED");

    const exp = await createInvite(ctx.marketDeps, { campaignId: id, userId: "owner-1", expiresAt: "2026-07-01T00:00:00.000Z" });
    const late: MarketDeps = { ...ctx.marketDeps, now: () => new Date("2026-08-01T00:00:00.000Z") };
    const expired = await fails(joinCampaign(late, { campaignId: id, userId: "partner-3", inviteToken: exp.invite.token }));
    expect(expired.code).toBe("INVITE_EXPIRED");
  });

  it("enforces category, minimum bounty, wallet, and active-campaign rules", async () => {
    const ctx = setup();
    const { campaignId } = await openedCampaign(ctx);
    // Blocked category.
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { blockedCategories: ["media"] } });
    expect((await fails(joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" }))).code).toBe("CATEGORY_BLOCKED");
    // Allowed list that does not match.
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { blockedCategories: [], allowedCategories: ["music"] } });
    expect((await fails(joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" }))).code).toBe("CATEGORY_NOT_ALLOWED");
    // Minimum bounty above the public price.
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { allowedCategories: [], minimumBountyMicroUsdc: "3000000" } });
    expect((await fails(joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" }))).code).toBe("MIN_BOUNTY");
    // Missing payout wallet.
    expect((await fails(joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-9" }))).code).toBe("WALLET_REQUIRED");
  });

  it("caps active campaigns and allocation; rejects stale market versions", async () => {
    const ctx = setup();
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-1", rules: { maxActiveCampaigns: 1, maxAllocationCount: 2 } });
    const a = await openedCampaign(ctx, 1);
    await joinCampaign(ctx.marketDeps, { campaignId: a.campaignId, userId: "partner-1", allocationCount: 2 });
    const b = await openedCampaign(ctx, 2);
    expect((await fails(joinCampaign(ctx.marketDeps, { campaignId: b.campaignId, userId: "partner-1" }))).code).toBe("MAX_ACTIVE");
    await updatePartnerRules(ctx.marketDeps, { userId: "partner-2", rules: { maxAllocationCount: 2 } });
    const over = await fails(joinCampaign(ctx.marketDeps, { campaignId: b.campaignId, userId: "partner-2", allocationCount: 3 }));
    expect(over.code).toBe("MAX_ALLOCATION");
    const stale = await fails(joinCampaign(ctx.marketDeps, { campaignId: a.campaignId, userId: "partner-2", expectedMarketVersion: 99 }));
    expect(stale.code).toBe("STALE_MARKET");
  });

  it("duplicate joins return the original referral without duplicating identity", async () => {
    const ctx = setup();
    const { campaignId } = await openedCampaign(ctx);
    const first = await joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" });
    const second = await joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" });
    expect(second.alreadyJoined).toBe(true);
    expect(second.referral.code).toBe(first.referral.code);
    expect((await ctx.store.listPartnerTerms("p-1")).length).toBe(1);
    expect(ctx.events.filter((e) => e.action === "partner.joined").length).toBe(1);
  });
});

describe("referral resolution (attribution-grade, money-free)", () => {
  it("resolves live referrals as attributable and records no money movement", async () => {
    const ctx = setup();
    const { campaignId } = await openedCampaign(ctx);
    const j = await joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" });
    const r = await resolveReferral(ctx.marketDeps, { code: j.referral.code });
    expect(r.attributable).toBe(true);
    expect(r.destinationUrl).toBe(DEST);
    expect(r.partnerId).toBe("p-1");
  });

  it("rejects unknown codes and flags expired markets unattributable", async () => {
    const ctx = setup();
    const { campaignId } = await openedCampaign(ctx);
    const j = await joinCampaign(ctx.marketDeps, { campaignId, userId: "partner-1" });
    const unknown = await fails(resolveReferral(ctx.marketDeps, { code: "AAAAAAAAAAAA" }));
    expect(unknown.status).toBe(404);
    const late: MarketDeps = { ...ctx.marketDeps, now: () => new Date("2027-01-01T00:00:00.000Z") };
    const r = await resolveReferral(late, { code: j.referral.code });
    expect(r.attributable).toBe(false);
    expect(r.destinationUrl).toBe(DEST);
  });

  it("mints distinct opaque codes per join", async () => {
    const ctx = setup();
    const a = await openedCampaign(ctx, 1);
    const b = await openedCampaign(ctx, 2);
    const j1 = await joinCampaign(ctx.marketDeps, { campaignId: a.campaignId, userId: "partner-1" });
    const j2 = await joinCampaign(ctx.marketDeps, { campaignId: b.campaignId, userId: "partner-1" });
    expect(j1.referral.code).not.toBe(j2.referral.code);
  });
});
