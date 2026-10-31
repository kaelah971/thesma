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
import type { TransferEvidence, VerifierChainReader } from "@/server/chain/arc";
import { joinCampaign, openMarket } from "@/server/services/markets";
import type { MarketDeps } from "@/server/services/markets";
import {
  createCheckoutIntent,
  mintAttributionSession,
  submitCheckoutTx,
  verifyCheckoutIntent,
  type CheckoutDeps,
} from "@/server/services/checkout";
import { requireInternalSecret } from "@/server/api/internalAuth";

const OWNER_W = "0xe7f4fDeC1Df452FE07b6b1E886ECF04D8A24bEa5" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const CUSTOMER = "0x6666666666666666666666666666666666666666" as Address;
const CUSTOMER_2 = "0x7777777777777777777777777777777777777777" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER = "0x5555555555555555555555555555555555555555" as Address;
const OTHER_TOKEN = "0x8888888888888888888888888888888888888888" as Address;

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
  chainId = 31337;
  receipts = new Map<string, TxReceiptSummary>();
  evidence = new Map<string, TransferEvidence>();
  vaultStates = new Map<string, VaultCampaignState>();
  async getChainId() {
    return this.chainId;
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
let tag = 0;
const nextTx = () => {
  tag += 1;
  return txFor(tag.toString(16).padStart(2, "0") + "a");
};

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [{ id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} }],
  }) as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const now = () => FIXED_NOW;
  const campaignDeps: CampaignDeps = { store, audit: sink, now };
  const marketDeps: MarketDeps = { store, audit: sink, now };
  const reader = new FakeReader();
  const fundingDeps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now };
  const checkoutDeps: CheckoutDeps = { store, audit: sink, config: CONFIG, reader, now };
  return { store, events, campaignDeps, marketDeps, fundingDeps, checkoutDeps, reader };
}

async function liveOpenAndJoined(ctx: ReturnType<typeof setup>, n: number, refundHold = 3600) {
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: { bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, refundHoldSeconds: refundHold } as never,
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
  return { campaignId: d.campaign.id, handle: session.handle };
}

function goodEvidence(payer: Address, amount = 10_000_000n, atMs = BLOCK_MS, to: Address = OWNER_W, token: Address = USDC) {
  return {
    sender: payer,
    blockTimestampMs: atMs,
    blockNumber: 42n,
    transfers: [{ token, from: payer, to, amount }],
  };
}

/** Stage both halves of Arc evidence: a successful receipt plus transfer data. */
function stageEvidence(ctx: { reader: FakeReader }, tx: Hex, ev: ReturnType<typeof goodEvidence>) {
  ctx.reader.receipts.set(tx.toLowerCase(), { status: "success", to: VAULT, blockNumber: ev.blockNumber, fundedEvents: [] });
  ctx.reader.evidence.set(tx.toLowerCase(), ev);
}

async function submittedIntent(
  ctx: ReturnType<typeof setup>,
  opts: { payer?: Address; amount?: string; handle?: string; campaignTag?: number } = {},
) {
  const { handle } = await liveOpenAndJoined(ctx, opts.campaignTag ?? 1);
  const created = await createCheckoutIntent(ctx.checkoutDeps, {
    attributionHandle: opts.handle ?? handle,
    payerAddress: opts.payer ?? CUSTOMER,
    amountMicroUsdc: opts.amount ?? "10000000",
  });
  const ctxTx = nextTx();
  await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: ctxTx });
  return { created, tx: ctxTx };
}

function mustOutcome(r: { outcome: { status: string } | null }): { status: string; [k: string]: unknown } {
  if (!r.outcome) throw new Error("expected an outcome");
  return r.outcome as { status: string; [k: string]: unknown };
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

describe("checkout intent creation (public, unsigned)", () => {
  it("rejects unknown, reused, and expired attribution handles", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 1);
    const unknown = await fails(
      createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: "AAAAAAAA", payerAddress: CUSTOMER, amountMicroUsdc: "10000000" }),
    );
    expect(unknown.status).toBe(404);
    await createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000" });
    const reused = await fails(
      createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: handle, payerAddress: CUSTOMER_2, amountMicroUsdc: "10000000" }),
    );
    expect(reused.status).toBe(410);
  });

  it("rejects below-minimum amounts and self-dealing payers", async () => {
    const ctx = setup();
    const a = await liveOpenAndJoined(ctx, 1);
    const low = await fails(
      createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: a.handle, payerAddress: CUSTOMER, amountMicroUsdc: "5000000" }),
    );
    expect(low.code).toBe("BELOW_MINIMUM");
    const b = await liveOpenAndJoined(ctx, 2);
    const selfRef = await fails(
      createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: b.handle, payerAddress: PARTNER_W, amountMicroUsdc: "10000000" }),
    );
    expect(selfRef.code).toBe("SELF_REFERRAL");
    const c = await liveOpenAndJoined(ctx, 3);
    const selfBuy = await fails(
      createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: c.handle, payerAddress: OWNER_W, amountMicroUsdc: "10000000" }),
    );
    expect(selfBuy.code).toBe("SELF_PURCHASE");
  });

  it("rejects expired attribution handles", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 8);
    // Backdate the session past expiry via a fresh short-lived handle.
    const ref = await ctx.store.getReferralByCode(
      (await joinCampaign(ctx.marketDeps, { campaignId: (await ctx.store.listCampaigns("ws-A"))[0].id, userId: "partner-1" })).referral.code,
    );
    const short = await mintAttributionSession(ctx.checkoutDeps, {
      referralId: ref!.id,
      campaignId: ref!.campaignId,
      partnerId: "p-1",
      partnerTermsId: ref!.partnerTermsId,
      expiresAt: new Date(FIXED_NOW.getTime() - 1000),
    });
    const expired = await fails(
      createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: short.handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000" }),
    );
    expect(expired.status).toBe(410);
    void handle;
  });

  it("returns the exact unsigned USDC transfer and never signs", async () => {
    const ctx = setup();
    const { handle } = await liveOpenAndJoined(ctx, 1);
    const { intent, payment } = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: handle,
      payerAddress: CUSTOMER,
      amountMicroUsdc: "10000000",
    });
    expect(payment.chainId).toBe(31337);
    expect(payment.token).toBe(USDC);
    expect(payment.to).toBe(USDC);
    expect(payment.value).toBe("0");
    expect(payment.expectedPayer).toBe(CUSTOMER);
    expect(payment.merchant).toBe(OWNER_W);
    expect(payment.amountMicroUsdc).toBe("10000000");
    expect(payment.data.startsWith("0xa9059cbb")).toBe(true); // transfer(address,uint256)
    expect(payment.data.toLowerCase()).toContain(OWNER_W.slice(2).toLowerCase());
    const allowed = new Set(["chainId", "token", "to", "data", "value", "expectedPayer", "merchant", "amountMicroUsdc", "checkoutIntentId", "orderId", "expiry"]);
    for (const k of Object.keys(payment)) expect(allowed.has(k)).toBe(true);
    expect(JSON.stringify(payment)).not.toMatch(/signature|privateKey|mnemonic/i);
    expect(intent.orderId.startsWith("ord_")).toBe(true);
  });
});

describe("submission (recorded, never trusted)", () => {
  it("submission alone leaves intent SUBMITTED with a PENDING outcome", async () => {
    const ctx = setup();
    const { created } = await submittedIntent(ctx);
    const state = await ctx.store.getCheckoutIntent(created.intent.id);
    expect(state?.status).toBe("SUBMITTED");
    const outcome = await ctx.store.getOutcomeByIntent(created.intent.id);
    expect(outcome?.status).toBe("PENDING");
  });

  it("rejects malformed and conflicting hashes; repeats are idempotent", async () => {
    const ctx = setup();
    const { created, tx } = await submittedIntent(ctx);
    const bad = await fails(submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: "0x123" }));
    expect(bad.status).toBe(400);
    const clash = await fails(submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: nextTx() }));
    expect(clash.code).toBe("TX_CONFLICT");
    const again = await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: tx });
    expect(again.alreadySubmitted).toBe(true);
  });
});

describe("deterministic verifier (reads Arc, trusts nothing)", () => {
  it("verifies valid evidence into exactly one VERIFIED outcome with correct hold", async () => {
    const ctx = setup();
    const { created, tx } = await submittedIntent(ctx);
    stageEvidence(ctx, tx, goodEvidence(CUSTOMER));
    const r = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(r.verified).toBe(true);
    const o = mustOutcome(r);
    expect(o.status).toBe("VERIFIED");
    expect(o.purchaseAmountMicroUsdc).toBe("10000000");
    expect(o.occurredAt).toBe(new Date(BLOCK_MS).toISOString()); // canonical block time
    expect(o.proofHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(new Date(o.holdUntil as string).getTime() - new Date(o.verifiedAt as string).getTime()).toBe(3_600_000);
    expect(r.intent.status).toBe("CONFIRMED");
    const again = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect("alreadyVerified" in again && again.alreadyVerified).toBe(true);
    const verifiedAudits = ctx.events.filter((e) => e.action === "outcome.verified");
    expect(verifiedAudits.length).toBe(1);
  });

  it("rejects wrong chain, reverted receipts, and unknown receipts without deciding", async () => {
    const ctx = setup();
    const { created, tx } = await submittedIntent(ctx);
    ctx.reader.chainId = 999;
    const chain = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(chain.intent.status).toBe("AMBIGUOUS");
    expect(chain.intent.failureCode).toBe("CHAIN_MISMATCH");
    ctx.reader.chainId = 31337;

    const ctx2 = setup();
    const s2 = await submittedIntent(ctx2);
    ctx2.reader.receipts.set(s2.tx.toLowerCase(), { status: "reverted", to: VAULT, blockNumber: 1n, fundedEvents: [] });
    const rev = await verifyCheckoutIntent(ctx2.checkoutDeps, { intentId: s2.created.intent.id });
    expect(mustOutcome(rev).status).toBe("REJECTED");
    expect(rev.outcome?.rejectionCode).toBe("TX_REVERTED");

    const ctx3 = setup();
    const s3 = await submittedIntent(ctx3);
    const amb = await verifyCheckoutIntent(ctx3.checkoutDeps, { intentId: s3.created.intent.id });
    expect(amb.intent.status).toBe("AMBIGUOUS");
    expect(amb.outcome).toBeNull();
    // Recovery: evidence appears later and verification succeeds (never stuck).
    stageEvidence(ctx3, s3.tx, goodEvidence(CUSTOMER));
    const recovered = await verifyCheckoutIntent(ctx3.checkoutDeps, { intentId: s3.created.intent.id });
    expect(recovered.verified).toBe(true);
  });

  it("rejects wrong token, payer, merchant, and amount explicitly", async () => {
    const mk = async (ev: ReturnType<typeof goodEvidence>, n: number) => {
      const ctx = setup();
      const s = await submittedIntent(ctx, { campaignTag: n });
      stageEvidence(ctx, s.tx, ev);
      return verifyCheckoutIntent(ctx.checkoutDeps, { intentId: s.created.intent.id });
    };
    expect((await mk({ ...goodEvidence(CUSTOMER), transfers: [{ token: OTHER_TOKEN, from: CUSTOMER, to: OWNER_W, amount: 10_000_000n }] }, 11)).outcome?.rejectionCode).toBe("WRONG_TOKEN");
    expect((await mk(goodEvidence(CUSTOMER_2), 12)).outcome?.rejectionCode).toBe("WRONG_PAYER");
    expect((await mk(goodEvidence(CUSTOMER, 10_000_000n, BLOCK_MS, PARTNER_W), 13)).outcome?.rejectionCode).toBe("WRONG_MERCHANT");
    expect((await mk(goodEvidence(CUSTOMER, 12_000_000n), 14)).outcome?.rejectionCode).toBe("WRONG_AMOUNT");
  });

  it("rejects late and intent-expired transactions on canonical time", async () => {
    const ctx = setup();
    const s = await submittedIntent(ctx);
    stageEvidence(ctx, s.tx, goodEvidence(CUSTOMER, 10_000_000n, new Date("2027-02-01T00:00:00Z").getTime()));
    expect((await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: s.created.intent.id })).outcome?.rejectionCode).toBe("LATE_TRANSACTION");

    const ctx2 = setup();
    const s2 = await submittedIntent(ctx2);
    // Intent expiry is creation +30min; a block 1h later is expired but pre-deadline.
    stageEvidence(ctx2, s2.tx, goodEvidence(CUSTOMER, 10_000_000n, new Date("2026-06-01T13:00:00Z").getTime()));
    expect((await verifyCheckoutIntent(ctx2.checkoutDeps, { intentId: s2.created.intent.id })).outcome?.rejectionCode).toBe("INTENT_EXPIRED");
  });

  it("rejects duplicate transactions and duplicate customers", async () => {
    const ctx = setup();
    const first = await submittedIntent(ctx, { campaignTag: 1 });
    stageEvidence(ctx, first.tx, goodEvidence(CUSTOMER));
    expect((await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: first.created.intent.id })).verified).toBe(true);

    // Same tx on a second intent: rejected at submission.
    const { handle } = await liveOpenAndJoined(ctx, 2);
    const second = await createCheckoutIntent(ctx.checkoutDeps, { attributionHandle: handle, payerAddress: CUSTOMER_2, amountMicroUsdc: "10000000" });
    const dupTx = await fails(submitCheckoutTx(ctx.checkoutDeps, { intentId: second.intent.id, txHash: first.tx }));
    expect(dupTx.code).toBe("DUPLICATE_TX");

    // Same customer, same campaign, new tx: rejected at verification.
    const rejoin = await joinCampaign(ctx.marketDeps, { campaignId: first.created.intent.campaignId, userId: "partner-1" });
    const refRow = await ctx.store.getReferralByCode(rejoin.referral.code);
    const sess = await mintAttributionSession(ctx.checkoutDeps, {
      referralId: refRow!.id,
      campaignId: first.created.intent.campaignId,
      partnerId: "p-1",
      partnerTermsId: refRow!.partnerTermsId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const third = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: sess.handle,
      payerAddress: CUSTOMER,
      amountMicroUsdc: "10000000",
    });
    const tx3 = nextTx();
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: third.intent.id, txHash: tx3 });
    stageEvidence(ctx, tx3, goodEvidence(CUSTOMER));
    expect((await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: third.intent.id })).outcome?.rejectionCode).toBe("DUPLICATE_CUSTOMER");
  });

  it("creates no payout, reservation, or Partner-bound money movement", async () => {
    const ctx = setup();
    const { created, tx } = await submittedIntent(ctx);
    stageEvidence(ctx, tx, goodEvidence(CUSTOMER));
    const r = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(r.verified).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/payout|reservation|transfer\(|approve/i);
    const actions = ctx.events.map((e) => e.action);
    expect(actions).not.toContain("payout.requested");
    expect(actions).toContain("outcome.verified");
    expect(actions).not.toContain("outcome.paid");
  });
});

describe("internal verify gate", () => {
  it("rejects missing, short, and wrong secrets; accepts the configured one", async () => {
    const req = (auth: string | null, env: Record<string, string>) =>
      new Request("http://x/internal", { method: "POST", headers: auth ? { authorization: auth } : {} });
    const OLD = process.env.VERIFIER_INTERNAL_SECRET;
    try {
      process.env.VERIFIER_INTERNAL_SECRET = "test-internal-secret-32!!";
      expect(requireInternalSecret(req(null, {}))).not.toBeNull();
      expect(requireInternalSecret(req("Bearer wrong-secret-value-000000", {}))?.status).toBe(401);
      expect(requireInternalSecret(req("Bearer test-internal-secret-32!!", {}))).toBeNull();
      process.env.VERIFIER_INTERNAL_SECRET = "short";
      expect(requireInternalSecret(req("Bearer short", {}))?.status).toBe(503);
    } finally {
      if (OLD === undefined) delete process.env.VERIFIER_INTERNAL_SECRET;
      else process.env.VERIFIER_INTERNAL_SECRET = OLD;
    }
  });
});
