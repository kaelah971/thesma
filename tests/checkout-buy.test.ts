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
} from "@/server/services/campaignStore";
import type { MarketStore } from "@/server/services/campaignStore";
import {
  confirmFunding,
  prepareFundingIntent,
  recordFundingSubmitted,
  type FundingDeps,
} from "@/server/services/fundings";
import { registerTestWallet } from "./wallet-fixtures";
import type { ArcConfig, TxReceiptSummary, VaultCampaignState } from "@/server/chain/arc";
import type { TransferEvidence, VerifierChainReader } from "@/server/chain/arc";
import { joinCampaign, openMarket } from "@/server/services/markets";
import type { MarketDeps } from "@/server/services/markets";
import {
  createCheckoutIntent,
  getCheckoutPublicState,
  mintAttributionSession,
  resolveAttributionMetadata,
  submitCheckoutTx,
  verifyCheckoutIntent,
  type CheckoutDeps,
} from "@/server/services/checkout";

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const CUSTOMER = "0x6666666666666666666666666666666666666666" as Address;
const CUSTOMER_2 = "0x7777777777777777777777777777777777777777" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const BLOCK_MS = new Date("2026-06-01T12:05:00.000Z").getTime();
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

class FakeReader implements VerifierChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  evidence = new Map<string, TransferEvidence>();
  vaultStates = new Map<string, VaultCampaignState>();
  async getChainId() {
    return 31337;
  }
  async getReceipt(txHash: Hex) {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async getTransferEvidence(txHash: Hex) {
    return this.evidence.get(txHash.toLowerCase()) ?? null;
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

const txFor = (s: string) => (`0x${s.padEnd(64, "0").slice(0, 64)}` as Hex);
let tag = 100;
const nextTx = () => {
  tag += 1;
  return txFor(tag.toString(16).padStart(2, "0") + "b");
};

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
  }) as MarketStore;
  const { sink } = createMemoryAuditSink();
  const now = () => FIXED_NOW;
  const campaignDeps: CampaignDeps = { store, audit: sink, now };
  const marketDeps: MarketDeps = { store, audit: sink, now };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now };
  const checkoutDeps: CheckoutDeps = { store, audit: sink, config: CONFIG, reader, now };
  return { store, campaignDeps, marketDeps, fundingDeps, checkoutDeps, reader };
}

async function liveOpenAndJoined(ctx: ReturnType<typeof setup>, n: number) {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerTestWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  const ftx = txFor(`f${n}`);
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: ftx });
  ctx.reader.receipts.set(ftx.toLowerCase(), {
    status: "success", to: VAULT, blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: 15_000_000n, totalFunded: 15_000_000n }],
  });
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER,
    funded: 15_000_000n, spent: 0n, paused: false, closed: false, returned: false,
  });
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
  await openMarket(ctx.marketDeps, {
    campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1,
    openingBountyMicroUsdc: "2000000", destinationUrl: DEST,
  });
  const j = await joinCampaign(ctx.marketDeps, { campaignId: d.campaign.id, userId: "partner-1" });
  const referral = await ctx.store.getReferralByCode(j.referral.code);
  const session = await mintAttributionSession(ctx.checkoutDeps, {
    referralId: referral!.id,
    campaignId: d.campaign.id,
    partnerId: "p-1",
    partnerTermsId: j.terms.id,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { campaignId: d.campaign.id, handle: session.handle, termsId: j.terms.id };
}

function goodEvidence(payer: Address, amount = 10_000_000n, to: Address = OWNER_W) {
  return {
    sender: payer,
    blockTimestampMs: BLOCK_MS,
    blockNumber: 42n,
    transfers: [{ token: USDC, from: payer, to, amount }],
  };
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

describe("public attribution metadata (read-only, no consume)", () => {
  it("returns the exact required amount, merchant, and chain without consuming the handle", async () => {
    const ctx = setup();
    const { campaignId, handle } = await liveOpenAndJoined(ctx, 11);
    const meta = await resolveAttributionMetadata(ctx.checkoutDeps, { attributionHandle: handle });
    expect(meta.campaignId).toBe(campaignId);
    expect(meta.merchant.toLowerCase()).toBe(OWNER_W.toLowerCase());
    expect(meta.chainId).toBe(31337);
    expect(meta.usdcAddress.toLowerCase()).toBe(USDC.toLowerCase());
    const version = await ctx.store.getVersion(campaignId, 1);
    expect(meta.requiredAmountMicroUsdc).toBe((version!.minQualifyingPurchaseMicroUsdc as bigint).toString());
    expect(meta.partnerPayoutWallet?.toLowerCase()).toBe(PARTNER_W.toLowerCase());
    // Handle still unused: a normal intent can be created afterwards.
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: meta.requiredAmountMicroUsdc,
    });
    expect(created.intent.status).toBe("PREPARED");
  });

  it("rejects unknown, used, and expired handles", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 12);
    const unknown = await fails(resolveAttributionMetadata(ctx.checkoutDeps, { attributionHandle: "AAAAAAAA" }));
    expect(unknown.status).toBe(404);
    await createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000" });
    const used = await fails(resolveAttributionMetadata(ctx.checkoutDeps, { attributionHandle: handle }));
    expect(used.status).toBe(410);
    const ref = await ctx.store.getReferralByCode(
      (await joinCampaign(ctx.marketDeps, { campaignId: (await ctx.store.listCampaigns("ws-A"))[0].id, userId: "partner-1" })).referral.code,
    );
    const short = await mintAttributionSession(ctx.checkoutDeps, {
      referralId: ref!.id, campaignId: ref!.campaignId, partnerId: "p-1",
      partnerTermsId: (await ctx.store.getTerms(ref!.campaignId, "p-1"))!.id,
      expiresAt: new Date(FIXED_NOW.getTime() - 1000),
    });
    const expired = await fails(resolveAttributionMetadata(ctx.checkoutDeps, { attributionHandle: short.handle }));
    expect(expired.status).toBe(410);
  });

  it("refuses metadata for a campaign that is not live", async () => {
    const ctx = setup();
    const d = await createDraft(ctx.campaignDeps, { workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL });
    const session = await mintAttributionSession(ctx.checkoutDeps, {
      referralId: "r-x", campaignId: d.campaign.id, partnerId: "p-1",
      partnerTermsId: "t-x", expiresAt: new Date(Date.now() + 86_400_000),
    });
    const err = await fails(resolveAttributionMetadata(ctx.checkoutDeps, { attributionHandle: session.handle }));
    expect(err.code).toBe("CAMPAIGN_NOT_LIVE");
  });
});

describe("public verify trigger (server decides, browser never does)", () => {
  it("refuses to verify an intent with no submitted transaction", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 13);
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const err = await fails(verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id }));
    expect(err.code).toBe("NOT_SUBMITTED");
  });

  it("marks VERIFIED only through the service after a matching receipt", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 14);
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const tx = nextTx();
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: tx });
    // Read-only status checks never change state on their own.
    const before = await getCheckoutPublicState(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(before.intent.status).toBe("SUBMITTED");
    expect(before.outcome?.status).toBe("PENDING");
    ctx.reader.receipts.set(tx.toLowerCase(), { status: "success", to: VAULT, blockNumber: 42n, fundedEvents: [] });
    ctx.reader.evidence.set(tx.toLowerCase(), goodEvidence(CUSTOMER));
    const verified = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(verified.verified).toBe(true);
    const after = await getCheckoutPublicState(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(after.intent.status).toBe("CONFIRMED");
    expect(after.outcome?.status).toBe("VERIFIED");
    expect(after.outcome?.holdUntil).not.toBeNull();
  });

  it("records a reverted purchase as REJECTED instead of retrying", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 15);
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const tx = nextTx();
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: tx });
    ctx.reader.receipts.set(tx.toLowerCase(), { status: "reverted", to: VAULT, blockNumber: 43n, fundedEvents: [] });
    const result = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(result.verified).toBe(false);
    expect(result.outcome?.status).toBe("REJECTED");
    expect(result.outcome?.rejectionCode).toBe("TX_REVERTED");
  });
});

describe("resume and duplicate-payment safety", () => {
  it("resubmitting the same hash is idempotent and never creates a second outcome", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 16);
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const tx = nextTx();
    const first = await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: tx });
    const second = await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: tx });
    expect(second.alreadySubmitted).toBe(true);
    expect(second.outcome?.id).toBe(first.outcome?.id);
    // A different intent cannot reuse the same purchase transaction.
    const other = await liveOpenAndJoined(ctx, 17);
    const created2 = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: other.handle, payerAddress: CUSTOMER_2, amountMicroUsdc: "10000000",
    });
    const clash = await fails(submitCheckoutTx(ctx.checkoutDeps, { intentId: created2.intent.id, txHash: tx }));
    expect(clash.code).toBe("DUPLICATE_TX");
  });

  it("a second hash for the same intent is rejected, not resent", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 18);
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: nextTx() });
    const conflict = await fails(submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: nextTx() }));
    expect(conflict.code).toBe("TX_CONFLICT");
  });

  it("self-purchase and partner-wallet payers stay blocked", async () => {
    const ctx = setup();
    const a = await liveOpenAndJoined(ctx, 19);
    const selfBuy = await fails(createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: a.handle, payerAddress: OWNER_W, amountMicroUsdc: "10000000",
    }));
    expect(selfBuy.code).toBe("SELF_PURCHASE");
    const b = await liveOpenAndJoined(ctx, 20);
    const selfRef = await fails(createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: b.handle, payerAddress: PARTNER_W, amountMicroUsdc: "10000000",
    }));
    expect(selfRef.code).toBe("SELF_REFERRAL");
  });

  it("ambiguous receipts surface without resend and confirm later", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 21);
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const tx = nextTx();
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: tx });
    // No receipt yet: ambiguous, nothing verified, nothing resent.
    const first = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(first.verified).toBe(false);
    const mid = await getCheckoutPublicState(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(mid.intent.status).toBe("AMBIGUOUS");
    // Receipt lands later: the same intent confirms without a new payment.
    ctx.reader.receipts.set(tx.toLowerCase(), { status: "success", to: VAULT, blockNumber: 44n, fundedEvents: [] });
    ctx.reader.evidence.set(tx.toLowerCase(), goodEvidence(CUSTOMER));
    const later = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(later.verified).toBe(true);
  });
});
