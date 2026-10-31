import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { newId } from "@/server/auth/session";
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
  getPublicMarketDetail,
  joinCampaign,
  listCompletedMarkets,
  openMarket,
  type MarketDeps,
} from "@/server/services/markets";
import { deriveLifecycle } from "@/components/proof/lifecycle";
import {
  addressExplorerUrl,
  buildDemoPayload,
  DEMO_CAMPAIGN_ID,
  demoPayloadKeys,
  explorerBaseUrl,
  shouldPromoteCompleted,
  sourcifyContractUrl,
  THESMA_VAULT_ADDRESS,
  txExplorerUrl,
  ARC_MAINNET_CHAIN_ID,
} from "@/lib/proof";

/* ---------------- Fixtures (Aster-shaped, in-memory) ---------------- */

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL =
  "Get 1 paying customer. Budget 1 USDC. Max 1 USDC per customer. Purchases below 1 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEST = "https://acme.example/product";
const FUNDING_TX = `0x${"53".repeat(32)}` as Hex;
const PURCHASE_TX = `0x${"dd".repeat(32)}` as Hex;
const PAYOUT_TX = `0x${"ec".repeat(32)}` as Hex;

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
  async getChainId() { return 31337; }
  async getReceipt(txHash: Hex) { return this.receipts.get(txHash.toLowerCase()) ?? null; }
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
  async usdcBalanceOf() { return 0n; }
  async hasCode() { return true; }
}

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Aster Media" }],
    partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
  }) as unknown as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const marketDeps: MarketDeps = { store, audit: sink, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  return { store, events, marketDeps, campaignDeps, fundingDeps, reader };
}

async function settledCampaign(ctx: ReturnType<typeof setup>, payoutState: "SUBMITTED" | "SETTLED" = "SETTLED") {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "1000000", deadline: DEADLINE } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerTestWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: FUNDING_TX });
  ctx.reader.receipts.set(FUNDING_TX.toLowerCase(), {
    status: "success", to: VAULT, blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 1_000_000n, totalFunded: 1_000_000n }],
  });
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 1_000_000n,
    bountyCeiling: 1_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
    funded: 1_000_000n, spent: 0n, paused: false, closed: false, returned: false,
  });
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
  await openMarket(ctx.marketDeps, {
    campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1,
    openingBountyMicroUsdc: "1000000", destinationUrl: DEST,
  });
  await joinCampaign(ctx.marketDeps, { campaignId: d.campaign.id, userId: "partner-1" });
  const terms = await ctx.store.getTerms(d.campaign.id, "p-1");
  const outcomeId = newId();
  await ctx.store.insertOutcome({
    id: outcomeId, campaignId: d.campaign.id, partnerId: "p-1", partnerTermsId: terms!.id,
    checkoutIntentId: "ci-1", customerKeyHash: "ckh-1",
    purchaseTx: PURCHASE_TX, purchaseAmountMicroUsdc: 1_000_000n,
  });
  await ctx.store.updateOutcome(outcomeId, { status: "VERIFIED", verifiedAt: FIXED_NOW, holdUntil: FIXED_NOW });
  const version = await ctx.store.getVersion(d.campaign.id, 1);
  const reservation = await ctx.store.insertReservation({
    id: newId(), campaignId: d.campaign.id, outcomeId, partnerId: "p-1",
    partnerTermsId: terms!.id, amountMicroUsdc: 1_000_000n, policyVersionId: version!.id,
  });
  const payout = await ctx.store.insertPayout({
    id: newId(), reservationId: reservation.id, outcomeId, campaignId: d.campaign.id,
    partnerId: "p-1", recipient: PARTNER_W, amountMicroUsdc: 1_000_000n, proofHash: `0x${"ab".repeat(32)}`,
  });
  await ctx.store.updateCampaign(d.campaign.id, { state: "CLOSED" });
  if (payoutState === "SETTLED") {
    await ctx.store.updateReservation(reservation.id, { state: "SETTLED" });
    await ctx.store.updatePayout(payout.id, { state: "SETTLED", txHash: PAYOUT_TX, settledAt: FIXED_NOW });
  } else {
    await ctx.store.updateReservation(reservation.id, { state: "SUBMITTED" });
    await ctx.store.updatePayout(payout.id, { state: "SUBMITTED", txHash: PAYOUT_TX });
  }
  return d.campaign.id;
}

/* ---------------- Canonical campaign + link truth ---------------- */

describe("canonical demo campaign", () => {
  it("is Aster (strongest complete FUNDED → SETTLED lifecycle)", () => {
    expect(DEMO_CAMPAIGN_ID).toBe("5571f328-ceeb-4712-8671-a72be1966ffb");
  });

  it("loads real public completed data with settled truth", async () => {
    const ctx = setup();
    const id = await settledCampaign(ctx);
    const detail = await getPublicMarketDetail(ctx.marketDeps, { campaignId: id });
    expect(detail.kind).toBe("completed");
    if (detail.kind !== "completed") throw new Error("unreachable");
    expect(detail.completionReason).toBe("TARGET_SETTLED");
    expect(detail.funding?.status).toBe("CONFIRMED");
    expect(detail.purchaseTxs).toHaveLength(1);
    expect(detail.payouts).toHaveLength(1);
    expect(detail.payouts[0].state).toBe("SETTLED");
    expect(detail.payouts[0].txHash).toBe(PAYOUT_TX);
    expect(typeof (detail as unknown as Record<string, unknown>).holdSeconds).toBe("number");
    const demo = buildDemoPayload(detail as unknown as Record<string, unknown>);
    expect(demo.kind).toBe("completed");
    expect(demo.workspaceName).toBe("Aster Media");
  });

  it("SUBMITTED is never presented as SETTLED", async () => {
    const ctx = setup();
    const id = await settledCampaign(ctx, "SUBMITTED");
    const detail = await getPublicMarketDetail(ctx.marketDeps, { campaignId: id });
    expect(detail.kind).toBe("completed");
    if (detail.kind !== "completed") throw new Error("unreachable");
    expect(detail.payouts[0].state).toBe("SUBMITTED");
    expect(detail.settledPayoutTotalMicroUsdc).toBe("0");
    const steps = deriveLifecycle({ fundingStatus: "CONFIRMED", verifiedOutcomes: 1, settledPayouts: 0 });
    expect(steps.find((s) => s.key === "SETTLED")?.state).toBe("pending");
    expect(steps.find((s) => s.key === "VERIFIED")?.state).toBe("done");
  });

  it("settled display requires genuinely settled payouts (derivation guard)", () => {
    const pending = deriveLifecycle({ fundingStatus: "CONFIRMED", verifiedOutcomes: 1, settledPayouts: 0 });
    expect(pending.find((s) => s.key === "SETTLED")?.state).toBe("pending");
    const done = deriveLifecycle({ fundingStatus: "CONFIRMED", verifiedOutcomes: 1, settledPayouts: 1, settledTotal: "1.00 USDC" });
    expect(done.find((s) => s.key === "SETTLED")?.state).toBe("terminal");
    expect(done.find((s) => s.key === "SETTLED")?.sublabel).toBe("1.00 USDC");
  });
});

describe("external verification links", () => {
  it("builds correct funding/payout explorer URLs with safe fallback", () => {
    delete process.env.ARC_EXPLORER_BASE_URL;
    expect(txExplorerUrl("0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
    expect(txExplorerUrl("0xabc", "https://explorer.arc.io")).toBe("https://explorer.arc.io/tx/0xabc");
    expect(addressExplorerUrl(THESMA_VAULT_ADDRESS)).toBe(`https://explorer.arc.io/address/${THESMA_VAULT_ADDRESS}`);
  });

  it("builds the proven Sourcify exact-match URL on Arc Mainnet", () => {
    expect(ARC_MAINNET_CHAIN_ID).toBe(5042);
    expect(THESMA_VAULT_ADDRESS).toBe("0x0fA826256a58F19Ad24Fc9384d81D313f2266F79");
    expect(sourcifyContractUrl()).toBe(
      "https://sourcify.dev/server/v2/contract/5042/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79",
    );
  });

  it("prefers DTO explorer URLs and falls back per-hash", async () => {
    const ctx = setup();
    const id = await settledCampaign(ctx);
    const detail = await getPublicMarketDetail(ctx.marketDeps, {
      campaignId: id, explorerBaseUrl: "https://explorer.arc.io",
    });
    expect(detail.kind).toBe("completed");
    if (detail.kind !== "completed") throw new Error("unreachable");
    expect(detail.funding?.fundingExplorerUrl).toBe(`https://explorer.arc.io/tx/${FUNDING_TX}`);
    expect(detail.purchaseTxs[0].explorerUrl).toBe(`https://explorer.arc.io/tx/${PURCHASE_TX}`);
    expect(detail.payouts[0].explorerUrl).toBe(`https://explorer.arc.io/tx/${PAYOUT_TX}`);
    expect(explorerBaseUrl()).toBe("https://explorer.arc.io");
  });
});

describe("demo DTO privacy boundary", () => {
  it("exposes only allowlisted keys — no private fields can leak", async () => {
    const ctx = setup();
    const id = await settledCampaign(ctx);
    const detail = await getPublicMarketDetail(ctx.marketDeps, { campaignId: id });
    const demo = buildDemoPayload(detail as unknown as Record<string, unknown>);
    expect(Object.keys(demo).sort()).toEqual([...demoPayloadKeys(), "kind"].sort());
    const raw = JSON.stringify(demo);
    for (const forbidden of [
      "rulesJson", "customerKeyHash", "checkoutIntentId", "passwordHash",
      "PRIVATE_KEY", "allowedPartnerRulesJson", "email", "policyJson", "escalationRules",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("refuses non-completed detail (settled language needs settled truth)", () => {
    expect(() => buildDemoPayload({ kind: "live" })).toThrow(/completed/);
  });
});

describe("public route creates no audit/event writes", () => {
  it("demo-equivalent reads leave the audit sink empty", async () => {
    const ctx = setup();
    const id = await settledCampaign(ctx);
    const writesBefore = ctx.events.length;
    await getPublicMarketDetail(ctx.marketDeps, { campaignId: id });
    await listCompletedMarkets(ctx.marketDeps);
    expect(ctx.events.length).toBe(writesBefore);
  });
});

/* ---------------- Funnel wiring (source contracts) ---------------- */

describe("proof funnel wiring", () => {
  const root = process.cwd();
  const src = (f: string) => readFileSync(join(root, f), "utf8");

  it("demo route is public: no login, no session, no signin redirect", () => {
    const page = src("src/app/demo/page.tsx");
    expect(page).not.toContain("getSessionUser");
    expect(page).not.toContain("redirect(");
    expect(page).not.toContain("/signin");
    expect(page).not.toContain("connectWallet");
    expect(page).not.toContain("useWallet");
    expect(page).toContain("No login required");
  });

  it("demo refuses settled language without settled truth", () => {
    const page = src("src/app/demo/page.tsx");
    expect(page).toContain('detail.kind !== "completed"');
    expect(page).toContain("only shown once onchain reconciliation confirms it");
  });

  it("demo final CTA routes to role selection (/start) after proof", () => {
    const page = src("src/app/demo/page.tsx");
    expect(page).toContain('href="/start"');
    expect(page).toContain("Run your own campaign");
  });

  it("demo explains why the payout happened from deterministic data", () => {
    const page = src("src/app/demo/page.tsx");
    expect(page).toContain("Why this payout happened");
    expect(page).toContain("Qualifying action");
    expect(page).toContain("Hold condition");
    expect(page).toContain("Settlement proof");
  });

  it("demo contract section claims only proven Sourcify verification", () => {
    const page = src("src/app/demo/page.tsx");
    expect(page).toContain("sourcifyContractUrl");
    expect(page).toContain("Sourcify exact_match");
    expect(page).not.toMatch(/Blockscout (verif|confirm)/);
  });

  it("homepage proof CTA routes to the demo", () => {
    const hero = src("src/components/landing/Hero.tsx");
    expect(hero).toContain('href="/demo"');
    expect(hero).toContain("Explore real proof");
    expect(hero).toContain("Open app");
    expect(hero).toContain("Arc Mainnet");
  });

  it("simulated homepage visuals are clearly labeled as examples", () => {
    const phone = src("src/components/landing/PhoneMockup.tsx");
    expect(phone).toContain("EXAMPLE");
    expect(phone).toContain("Illustrative");
    const sections = src("src/components/landing/Sections.tsx");
    expect(sections).toContain("Illustrative example");
  });

  it("markets zero-live state promotes completed with a compact notice", () => {
    expect(shouldPromoteCompleted(0, 2)).toBe(true);
    expect(shouldPromoteCompleted(1, 2)).toBe(false);
    expect(shouldPromoteCompleted(0, 0)).toBe(false);
    const markets = src("src/app/markets/page.tsx");
    expect(markets).toContain("shouldPromoteCompleted");
    expect(markets).toContain("No live markets right now.");
    // Completed renders first when promoted: the promoted branch precedes
    // the full live section in document order.
    const promotedIdx = markets.indexOf("{promoteCompleted && <CompletedMarkets");
    const liveIdx = markets.indexOf('<section aria-label="Live markets">');
    expect(promotedIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(-1);
    expect(promotedIdx).toBeLessThan(liveIdx);
  });

  it("demo layout truncates hashes and stays fluid on small screens", () => {
    const page = src("src/app/demo/page.tsx");
    expect(page).toContain("EvidenceHash");
    expect(page).toContain("flexWrap");
    expect(page).toContain("maxWidth: 960");
    expect(page).not.toMatch(/width:\s*\d{3,}px/);
  });
});
