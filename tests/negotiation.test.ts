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
import type {
  PaidEventEvidence,
  PayoutChainReader,
  TransferEvidence,
  TxReceiptSummary,
  VaultCampaignState,
} from "@/server/chain/arc";
import { joinCampaign, openMarket } from "@/server/services/markets";
import type { MarketDeps } from "@/server/services/markets";
import {
  createCheckoutIntent,
  mintAttributionSession,
  submitCheckoutTx,
  verifyCheckoutIntent,
  type CheckoutDeps,
} from "@/server/services/checkout";
import {
  deriveSupplyUrgency,
  evaluateNegotiationOffer,
  MAX_NEGOTIATION_ROUNDS,
  solvencyCap,
  type NegotiationKernelInputs,
} from "@/server/domain/negotiation";
import {
  evaluateMarket,
  type PricingDeps,
} from "@/server/services/pricing";
import {
  evaluateNegotiation,
  explainNegotiation,
  getNegotiationView,
  processNegotiationEvaluations,
  proposeNegotiation,
  withdrawNegotiation,
  type NegotiationDeps,
} from "@/server/services/negotiations";
import { reconcilePayout, reserveOutcomePayout, settleReservedPayout } from "@/server/services/payouts";
import type { OutcomeProofSigner, PayoutExecutor, PayoutSubmitArgs } from "@/server/chain/signers";
import { outcomeId32For } from "@/server/domain/payout";

const OWNER_W = "0x1111111111111111111111111111111111111111" as Address;
const PARTNER_W = "0x2222222222222222222222222222222222222222" as Address;
const PARTNER2_W = "0x9999999999999999999999999999999999999999" as Address;
const CUSTOMER = "0x6666666666666666666666666666666666666666" as Address;
const VAULT = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR_W = "0x4444444444444444444444444444444444444444" as Address;
const VERIFIER_W = "0x5555555555555555555555555555555555555555" as Address;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const DEADLINE = "2026-12-31T23:59:59.999Z";
const DEST = "https://acme.example/product";
const BLOCK_MS = new Date("2026-06-01T12:05:00.000Z").getTime();

const CONFIG = {
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR_W,
  verifierAddress: VERIFIER_W,
  explorerBaseUrl: null,
};

class FakeChain implements PayoutChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  evidence = new Map<string, TransferEvidence>();
  vaultStates = new Map<string, VaultCampaignState>();
  payoutEvidence = new Map<string, { status: "success" | "reverted"; to: Address | null; blockNumber: bigint; paid: PaidEventEvidence[] }>();
  consumed = new Set<string>();
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
  async getPayoutEvidence(txHash: Hex) {
    return this.payoutEvidence.get(txHash.toLowerCase()) ?? null;
  }
  async isOutcomeConsumed(_vault: Address, outcomeId: Hex) {
    return this.consumed.has(outcomeId.toLowerCase());
  }
}

class FakeSigner implements OutcomeProofSigner {
  readonly address = VERIFIER_W;
  lastMessage: unknown = null;
  async signVerifiedOutcomeProof(args: { chainId: number; vault: Address; message: never }) {
    this.lastMessage = args.message;
    return "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Hex;
  }
  proofDigest() {
    return "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as Hex;
  }
}

class FakeExecutor implements PayoutExecutor {
  readonly address = EXECUTOR_W;
  calls: PayoutSubmitArgs[] = [];
  async submitVerifiedOutcomePayout(args: PayoutSubmitArgs): Promise<Hex> {
    this.calls.push(args);
    return "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hex;
  }
}

const txFor = (s: string) => (`0x${s.padEnd(64, "0").slice(0, 64)}` as Hex);
let tag = 900;
const nextTx = () => {
  tag += 1;
  return txFor(`d${tag.toString(16)}`);
};

function setup(nowMs: number) {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "partner-1", workspaceId: "ws-A", role: "PARTNER" },
      { userId: "partner-2", workspaceId: "ws-A", role: "PARTNER" },
    ],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: "media", name: "Acme" }],
    partners: [
      { id: "p-1", userId: "partner-1", payoutWallet: PARTNER_W, rulesJson: {} },
      { id: "p-2", userId: "partner-2", payoutWallet: PARTNER2_W, rulesJson: {} },
    ],
  }) as MarketStore;
  const { sink, events } = createMemoryAuditSink();
  const now = () => new Date(nowMs);
  const reader = new FakeChain();
  const base = { store, audit: sink, now };
  return {
    store, events, reader,
    campaignDeps: { ...base } as CampaignDeps,
    marketDeps: { ...base } as MarketDeps,
    fundingDeps: { ...base, config: CONFIG, reader } as unknown as FundingDeps,
    checkoutDeps: { ...base, config: CONFIG, reader } as unknown as CheckoutDeps,
    negotiationDeps: { ...base } as NegotiationDeps,
    pricingDeps: { ...base } as PricingDeps,
  };
}

type Ctx = ReturnType<typeof setup>;

/** Full flow to an OPEN market with no joins (negotiation supplies terms). */
async function openLiveMarket(
  ctx: Ctx,
  n: number,
  bounty = "2000000",
  opts: { overrides?: Record<string, unknown>; funded?: bigint } = {},
) {
  const funded = opts.funded ?? 15_000_000n;
  const d = await createDraft(ctx.campaignDeps, {
    workspaceId: "ws-A",
    userId: "owner-1",
    intentText: CANONICAL,
    overrides: {
      bountyFloorMicroUsdc: "2000000", deadline: DEADLINE, refundHoldSeconds: 0,
      ...(opts.overrides ?? {}),
    } as never,
  });
  await moveToReview(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await approvePolicy(ctx.campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  await registerCompanyWallet(ctx.fundingDeps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER_W });
  const p = await prepareFundingIntent(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  const ftx = txFor(`f${n}`);
  await recordFundingSubmitted(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1, fundingTxHash: ftx });
  ctx.reader.receipts.set(ftx.toLowerCase(), {
    status: "success", to: VAULT, blockNumber: 1n,
    fundedEvents: [{ campaignKey: p.campaignKey as Hex, funder: OWNER_W, amount: funded, totalFunded: funded }],
  });
  ctx.reader.vaultStates.set(p.campaignKey.toLowerCase(), {
    exists: true, owner: OWNER_W, policyHash: p.policyHash as Hex, budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n, deadline: 1_798_761_599n, executor: EXECUTOR_W, verifier: VERIFIER_W,
    funded, spent: 0n, paused: false, closed: false, returned: false,
  });
  await confirmFunding(ctx.fundingDeps, { campaignId: d.campaign.id, userId: "owner-1" });
  await openMarket(ctx.marketDeps, {
    campaignId: d.campaign.id, userId: "owner-1", expectedPolicyVersion: 1,
    openingBountyMicroUsdc: bounty, destinationUrl: DEST,
  });
  return { campaignId: d.campaign.id, funding: p };
}

function kernelInputs(over: Partial<NegotiationKernelInputs> = {}): NegotiationKernelInputs {
  return {
    askMicroUsdc: 2_000_000n,
    referenceBountyMicroUsdc: 2_000_000n,
    bountyFloorMicroUsdc: 2_000_000n,
    bountyCeilingMicroUsdc: 4_000_000n,
    freeMicroUsdc: 15_000_000n,
    remainingRequired: 5,
    paceState: "ON_PACE",
    round: 1,
    nowMs: new Date("2026-07-01T00:00:00.000Z").getTime(),
    ...over,
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

describe("kernel (pure, deterministic)", () => {
  it("accepts asks inside the safe band at the ask price", () => {
    const r = evaluateNegotiationOffer(kernelInputs());
    expect(r.decision).toBe("ACCEPT");
    expect(r.reasons).toEqual(["WITHIN_SAFE_BAND"]);
    expect(r.counterMicroUsdc).toBeNull();
    expect(r.maxAffordableMicroUsdc).toBe(3_000_000n); // min(4M ceiling, 15M/5)
    expect(r.inputs.askMicroUsdc).toBe("2000000");
  });

  it("counters above-band asks without matching them; rejects above ceiling", () => {
    const counter = evaluateNegotiationOffer(kernelInputs({ askMicroUsdc: 3_500_000n, paceState: "UNDER_PACED" }));
    expect(counter.decision).toBe("COUNTER");
    expect(counter.counterMicroUsdc).toBe(3_000_000n); // solvency cap, toward (not at) the ask
    expect(counter.reasons).toEqual(["COUNTERED_TOWARD_ASK"]);
    const over = evaluateNegotiationOffer(kernelInputs({ askMicroUsdc: 4_000_001n }));
    expect(over.decision).toBe("REJECT");
    expect(over.reasons).toEqual(["ASK_ABOVE_CEILING"]);
  });

  it("rejects insolvent asks even when one unit looks affordable", () => {
    // Spec example shape: free 5M for 5 remaining -> cap 1M < floor 2M.
    const r = evaluateNegotiationOffer(kernelInputs({ freeMicroUsdc: 5_000_000n, askMicroUsdc: 2_000_000n }));
    expect(r.decision).toBe("REJECT");
    expect(r.reasons).toEqual(["NO_SOLVENCY"]);
    expect(solvencyCap(5_000_000n, 5)).toBe(1_000_000n);
  });

  it("widens the band under pace pressure but never past the ceiling", () => {
    const ask = 2_500_000n;
    const behind = evaluateNegotiationOffer(kernelInputs({ askMicroUsdc: ask, paceState: "UNDER_PACED", freeMicroUsdc: 12_500_000n }));
    expect(behind.decision).toBe("ACCEPT"); // cap min(4M, 2.5M) covers the ask
    const calm = evaluateNegotiationOffer(kernelInputs({ askMicroUsdc: ask, paceState: "ON_PACE", freeMicroUsdc: 12_500_000n }));
    expect(calm.decision).toBe("REJECT"); // willing capped at the 2M reference
    expect(calm.reasons).toEqual(["CANNOT_MEET_ASK"]);
  });

  it("healthy supply never overpays the reference", () => {
    const r = evaluateNegotiationOffer(kernelInputs({ askMicroUsdc: 2_100_000n, paceState: "ON_PACE", freeMicroUsdc: 100_000_000n }));
    expect(r.decision).toBe("REJECT");
    expect(r.reasons).toEqual(["CANNOT_MEET_ASK"]);
  });

  it("suppresses meaningless micro-counters and enforces max rounds", () => {
    // Cap 2.05M vs reference 2M: 50k lift < 5% minimum -> REJECT, not COUNTER.
    const tiny = evaluateNegotiationOffer(
      kernelInputs({ askMicroUsdc: 3_000_000n, paceState: "UNDER_PACED", freeMicroUsdc: 10_250_000n }),
    );
    expect(tiny.decision).toBe("REJECT");
    expect(tiny.reasons).toEqual(["CANNOT_MEET_ASK"]);
    const late = evaluateNegotiationOffer(kernelInputs({ round: MAX_NEGOTIATION_ROUNDS + 1 }));
    expect(late.decision).toBe("REJECT");
    expect(late.reasons).toEqual(["ROUND_EXCEEDED"]);
    const bad = evaluateNegotiationOffer(kernelInputs({ askMicroUsdc: 0n }));
    expect(bad.reasons).toEqual(["ASK_MALFORMED"]);
    const low = evaluateNegotiationOffer(kernelInputs({ askMicroUsdc: 1_000_000n }));
    expect(low.reasons).toEqual(["ASK_BELOW_FLOOR"]);
  });

  it("derives supply urgency deterministically from the solvency margin", () => {
    const u = (free: bigint, remaining: number) =>
      deriveSupplyUrgency({ freeMicroUsdc: free, remainingRequired: remaining, referenceBountyMicroUsdc: 2_000_000n, bountyFloorMicroUsdc: 2_000_000n });
    expect(u(20_000_000n, 5)).toBe("HEALTHY"); // 10 units, surplus 5 >= 5
    expect(u(15_000_000n, 5)).toBe("TIGHT"); // 7 units, surplus 2 < 5
    expect(u(4_000_000n, 5)).toBe("CRITICAL"); // 2 units < 5 required
    expect(u(1_000_000n, 5)).toBe("EXHAUSTED"); // below one floor unit
    expect(u(15_000_000n, 0)).toBe("EXHAUSTED");
  });
});

const JULY = new Date("2026-07-01T00:00:00.000Z").getTime();

describe("negotiation lifecycle (propose -> evaluate -> terms)", () => {
  it("accepts in-band asks and freezes NEGOTIATED terms + referral", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    // Under-paced (0 verified, half elapsed) with cap 3M: ask 2.5M accepts.
    const r = await proposeNegotiation(ctx.negotiationDeps, {
      campaignId, userId: "partner-1", askMicroUsdc: "2500000",
    });
    expect(r.alreadyRecorded).toBe(false);
    expect(r.evaluation?.decision).toBe("ACCEPT");
    expect(r.negotiation.status).toBe("ACCEPTED");
    expect(r.negotiation.round).toBe(1);
    const terms = await ctx.store.getTerms(campaignId, "p-1");
    expect(terms?.priceMicroUsdc).toBe(2_500_000n);
    expect(terms?.source).toBe("NEGOTIATED");
    expect(terms?.policyVersion).toBe(1);
    const referral = await ctx.store.getReferralByTerms(terms!.id);
    expect(referral?.code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(ctx.events.some((e) => e.action === "negotiation.accepted")).toBe(true);
    expect(ctx.events.some((e) => e.action === "referral.created")).toBe(true);
  });

  it("counters above-band asks and accepts the meeting counter", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    const first = await proposeNegotiation(ctx.negotiationDeps, {
      campaignId, userId: "partner-1", askMicroUsdc: "3500000",
    });
    expect(first.evaluation?.decision).toBe("COUNTER");
    expect(first.evaluation?.counterMicroUsdc).toBe("3000000");
    expect(first.negotiation.status).toBe("COUNTERED");
    // Supplier meets the counter exactly: round 2 accepts at 3M.
    const second = await proposeNegotiation(ctx.negotiationDeps, {
      campaignId, userId: "partner-1", askMicroUsdc: "3000000",
    });
    expect(second.evaluation?.decision).toBe("ACCEPT");
    expect(second.negotiation.status).toBe("ACCEPTED");
    expect(second.negotiation.round).toBe(2);
    expect((await ctx.store.getTerms(campaignId, "p-1"))?.priceMicroUsdc).toBe(3_000_000n);
  });

  it("rejects above-ceiling asks and frees the pair for a fresh start", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    const r = await proposeNegotiation(ctx.negotiationDeps, {
      campaignId, userId: "partner-1", askMicroUsdc: "9000000",
    });
    expect(r.evaluation?.decision).toBe("REJECT");
    expect(r.negotiation.status).toBe("REJECTED");
    // Terminal state frees the pair: a sane ask starts a new row.
    const retry = await proposeNegotiation(ctx.negotiationDeps, {
      campaignId, userId: "partner-1", askMicroUsdc: "2500000",
    });
    expect(retry.negotiation.id).not.toBe(r.negotiation.id);
    expect(retry.evaluation?.decision).toBe("ACCEPT");
  });

  it("stops after max rounds and treats duplicate asks idempotently", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    const asks = ["3500000", "3400000", "3300000", "3200000"];
    let last = null as unknown as Awaited<ReturnType<typeof proposeNegotiation>>;
    for (const ask of asks) {
      last = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: ask });
    }
    expect(last.negotiation.round).toBe(4);
    expect(last.evaluation?.decision).toBe("REJECT");
    expect(last.evaluation?.reasonCodes).toContain("ROUND_EXCEEDED");
    expect(last.negotiation.status).toBe("REJECTED");
    // Duplicate ask on an active row: same round, same decision, no new row.
    const ctx2 = setup(JULY);
    const c2 = await openLiveMarket(ctx2, 2);
    const a = await proposeNegotiation(ctx2.negotiationDeps, { campaignId: c2.campaignId, userId: "partner-1", askMicroUsdc: "3500000" });
    const b = await proposeNegotiation(ctx2.negotiationDeps, { campaignId: c2.campaignId, userId: "partner-1", askMicroUsdc: "3500000" });
    expect(b.alreadyRecorded).toBe(true);
    expect(b.negotiation.id).toBe(a.negotiation.id);
    expect(b.negotiation.round).toBe(1);
  });

  it("expires stale offers and blocks paused markets", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    const past = await fails(
      proposeNegotiation(ctx.negotiationDeps, {
        campaignId, userId: "partner-1", askMicroUsdc: "2500000",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(past.status).toBe(400);
    // Worker-driven expiry: evaluate past the offer expiry.
    await proposeNegotiation(ctx.negotiationDeps, {
      campaignId, userId: "partner-1", askMicroUsdc: "3500000",
      expiresAt: new Date(JULY + 3_600_000).toISOString(),
    });
    const active = await ctx.store.getActiveNegotiation(campaignId, "p-1");
    const late = { ...ctx.negotiationDeps, now: () => new Date(JULY + 2 * 3_600_000) };
    const expired = await evaluateNegotiation(late, { negotiationId: active!.id });
    expect(expired.negotiation.status).toBe("EXPIRED");
    expect(expired.evaluation).toBeNull();
    // Paused market: no new negotiations, in-flight ones cannot accept.
    await ctx.store.updateMarket(campaignId, 1, { status: "PAUSED", version: 2 });
    const blocked = await fails(
      proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-2", askMicroUsdc: "2500000" }),
    );
    expect(blocked.code).toBe("MARKET_NOT_OPEN");
  });

  it("holds when the market moved under the offer until fresh input", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "3500000" });
    const row = (await ctx.store.getActiveNegotiation(campaignId, "p-1"))!;
    // S6 reprices the market out from under the ask.
    await evaluateMarket(ctx.pricingDeps, { campaignId });
    expect((await ctx.store.getMarket(campaignId))?.version).toBe(2);
    const held = await evaluateNegotiation(ctx.negotiationDeps, { negotiationId: row.id });
    expect(held.negotiation.status).toBe("HOLD");
    expect(held.evaluation?.decision).toBe("HOLD");
    expect(held.evaluation?.reasonCodes).toContain("MARKET_MOVED");
    // Supplier re-confirms against the fresh bounty: round 2 proceeds.
    const fresh = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "3500000" });
    expect(fresh.negotiation.round).toBe(2);
    expect(fresh.negotiation.status).not.toBe("HOLD");
  });

  it("supports withdraw and restricts the read model", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    const r = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "3500000" });
    const foreign = await fails(withdrawNegotiation(ctx.negotiationDeps, { negotiationId: r.negotiation.id, userId: "partner-2" }));
    expect(foreign.status).toBe(403);
    const w = await withdrawNegotiation(ctx.negotiationDeps, { negotiationId: r.negotiation.id, userId: "partner-1" });
    expect(w.negotiation.status).toBe("WITHDRAWN");
    const view = await getNegotiationView(ctx.negotiationDeps, { negotiationId: r.negotiation.id, userId: "owner-1" });
    expect(view.negotiation.status).toBe("WITHDRAWN");
    expect(view.latestDecision?.decision).toBe("COUNTER");
    const outsider = await fails(getNegotiationView(ctx.negotiationDeps, { negotiationId: r.negotiation.id, userId: "ghost" }));
    expect(outsider.status).toBe(403);
  });

  it("accepted suppliers flow through the existing outcome-to-payout pipeline", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    const accepted = await proposeNegotiation(ctx.negotiationDeps, {
      campaignId, userId: "partner-1", askMicroUsdc: "2500000",
    });
    expect(accepted.evaluation?.decision).toBe("ACCEPT");
    const terms = (await ctx.store.getTerms(campaignId, "p-1"))!;
    const referral = (await ctx.store.getReferralByTerms(terms.id))!;
    // Standard S4 checkout against the negotiated terms.
    const sess = await mintAttributionSession(ctx.checkoutDeps, {
      referralId: referral.id, campaignId, partnerId: "p-1",
      partnerTermsId: terms.id, expiresAt: new Date(Date.now() + 86_400_000),
    });
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: sess.handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const ctxTx = nextTx();
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: ctxTx });
    ctx.reader.receipts.set(ctxTx.toLowerCase(), { status: "success", to: USDC, blockNumber: 42n, fundedEvents: [] });
    ctx.reader.evidence.set(ctxTx.toLowerCase(), {
      sender: CUSTOMER, blockTimestampMs: BLOCK_MS, blockNumber: 42n,
      transfers: [{ token: USDC, from: CUSTOMER, to: OWNER_W, amount: 10_000_000n }],
    });
    const v = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(v.verified).toBe(true);
    // S5 reserves, signs, executes, and reconciles at the NEGOTIATED price.
    const signer = new FakeSigner();
    const executor = new FakeExecutor();
    const payoutDeps = { store: ctx.store, audit: ctx.checkoutDeps.audit, config: CONFIG, reader: ctx.reader, signer, executor, now: () => new Date(JULY) };
    const outcome = await ctx.store.getOutcomeByIntent(created.intent.id);
    const reserved = await reserveOutcomePayout(payoutDeps as never, { outcomeId: outcome!.id });
    expect(reserved.reserved).toBe(true);
    const reservationId = (reserved.reservation as { id: string }).id;
    const settled = await settleReservedPayout(payoutDeps as never, { reservationId });
    expect((settled as { advanced?: boolean }).advanced).toBe(true);
    const payout = await ctx.store.getPayoutByOutcome(outcome!.id);
    expect(payout?.amountMicroUsdc).toBe(2_500_000n); // negotiated, not the 2M bounty
    expect(executor.calls[0].amount).toBe(2_500_000n);
    const fundingRow = await ctx.store.getFunding(campaignId, 1);
    ctx.reader.payoutEvidence.set(payout!.txHash!.toLowerCase(), {
      status: "success", to: VAULT, blockNumber: 77n,
      paid: [{
        campaignKey: fundingRow!.campaignKey as Hex, policyHash: fundingRow!.policyHash as Hex,
        outcomeId: outcomeId32For(outcome!.id), recipient: PARTNER_W,
        amount: 2_500_000n, proofHash: payout!.proofHash as Hex,
      }],
    });
    const rec = await reconcilePayout(payoutDeps as never, { payoutId: payout!.id });
    expect(rec.settled).toBe(true);
    expect((await ctx.store.getPayout(payout!.id))?.state).toBe("SETTLED");
  });

  it("concurrent accepts cannot overcommit: the pipeline serializes payment", async () => {
    // Tiny campaign: 1M funded, 1M bounty. Both partners accept 1M terms
    // (terms lock no budget), but only one can ever reserve.
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 7, "1000000", {
      overrides: {
        bountyFloorMicroUsdc: "1000000",
        minQualifyingPurchaseMicroUsdc: "1000000",
        targetOutcomeCount: 1,
        budgetMicroUsdc: "1000000",
        deadline: DEADLINE,
        refundHoldSeconds: 0,
      },
      funded: 1_000_000n,
    });
    const a1 = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "1000000" });
    const a2 = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-2", askMicroUsdc: "1000000" });
    expect(a1.evaluation?.decision).toBe("ACCEPT");
    // S7.1: the second accept cannot commit what the first already locked.
    expect(a2.evaluation?.decision).toBe("REJECT");
    expect(a2.negotiation.status).toBe("REJECTED");
    const mkOutcome = async (partnerUser: string, customer: Address) => {
      const t = await ctx.store.getTerms(campaignId, partnerUser === "partner-1" ? "p-1" : "p-2");
      const ref = await ctx.store.getReferralByTerms(t!.id);
      const sess = await mintAttributionSession(ctx.checkoutDeps, {
        referralId: ref!.id, campaignId, partnerId: t!.partnerId,
        partnerTermsId: t!.id, expiresAt: new Date(Date.now() + 86_400_000),
      });
      const created = await createCheckoutIntent(ctx.checkoutDeps, {
        attributionHandle: sess.handle, payerAddress: customer, amountMicroUsdc: "1000000",
      });
      const ctxTx = nextTx();
      await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: ctxTx });
      ctx.reader.receipts.set(ctxTx.toLowerCase(), { status: "success", to: USDC, blockNumber: 42n, fundedEvents: [] });
      ctx.reader.evidence.set(ctxTx.toLowerCase(), {
        sender: customer, blockTimestampMs: BLOCK_MS, blockNumber: 42n,
        transfers: [{ token: USDC, from: customer, to: OWNER_W, amount: 1_000_000n }],
      });
      const vv = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
      if (!vv.verified) throw new Error("fixture failed to verify");
      return (await ctx.store.getOutcomeByIntent(created.intent.id))!.id;
    };
    // The rejected supplier holds no terms, so no outcome can even start.
    expect(await ctx.store.getTerms(campaignId, "p-2")).toBeNull();
    // The accepted supplier flows to a real reservation against the lock.
    const o1 = await mkOutcome("partner-1", CUSTOMER);
    const deps = { store: ctx.store, audit: ctx.checkoutDeps.audit, config: CONFIG, reader: ctx.reader, signer: null, executor: null, now: () => new Date(JULY) } as never;
    const r1 = await reserveOutcomePayout(deps, { outcomeId: o1 });
    expect(r1.reserved).toBe(true);
    // Commitment consumed exactly once; reservation alone accounts the spend.
    const com = await ctx.store.getCommitmentByNegotiation(a1.negotiation.id);
    expect(com?.state).toBe("CONSUMED");
    expect(com?.consumedByOutcomeId).toBe(o1);
  });

  it("S6 repricing never mutates already-negotiated frozen terms", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "2500000" });
    expect((await ctx.store.getTerms(campaignId, "p-1"))?.priceMicroUsdc).toBe(2_500_000n);
    const repriced = await evaluateMarket(ctx.pricingDeps, { campaignId });
    expect(repriced.decision).toBe("REPRICE"); // still under-paced, moves up
    expect((await ctx.store.getMarket(campaignId))?.publicBountyMicroUsdc).not.toBe(2_000_000n);
    expect((await ctx.store.getTerms(campaignId, "p-1"))?.priceMicroUsdc).toBe(2_500_000n);
    expect((await ctx.store.getTerms(campaignId, "p-1"))?.marketVersion).toBe(1);
  });

  it("S7.1: competing accepts serialize on budget and capacity, not at payout", async () => {
    // 10M funded, target 1: first 1M accept locks the only capacity unit.
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 3, "1000000", {
      overrides: {
        bountyFloorMicroUsdc: "1000000",
        minQualifyingPurchaseMicroUsdc: "1000000",
        targetOutcomeCount: 1,
        budgetMicroUsdc: "10000000",
        deadline: DEADLINE,
        refundHoldSeconds: 0,
      },
      funded: 10_000_000n,
    });
    const a1 = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "1000000" });
    expect(a1.evaluation?.decision).toBe("ACCEPT");
    // Commitment is immediate and exact.
    const com1 = await ctx.store.getCommitmentByNegotiation(a1.negotiation.id);
    expect(com1?.state).toBe("ACTIVE");
    expect(com1?.amountMicroUsdc).toBe(1_000_000n);
    const { committedForCampaign: committed } = await import("@/server/services/payouts");
    expect(await committed(ctx.store, campaignId)).toBe(1_000_000n);
    // One unit remains required and one is committed: capacity is exhausted.
    const a2 = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-2", askMicroUsdc: "1000000" });
    expect(a2.evaluation?.decision).toBe("REJECT");
    expect(a2.negotiation.status).toBe("REJECTED");
    // Re-evaluating the accepted row never double-commits.
    const again = await evaluateNegotiation(ctx.negotiationDeps, { negotiationId: a1.negotiation.id });
    expect((await ctx.store.listActiveCommitments(campaignId)).length).toBe(1);
    expect(again.negotiation.status).toBe("ACCEPTED");
    // Store-level race guard: one commitment per negotiation, always.
    const dup = await fails(
      ctx.store.insertSupplyCommitment({
        id: "c-dup", campaignId, negotiationId: a1.negotiation.id, partnerId: "p-1",
        partnerTermsId: "t-x", amountMicroUsdc: 1_000_000n, expiresAt: new Date(DEADLINE),
      }),
    );
    expect(dup.code).toBe("UNIQUE_VIOLATION");
  });

  it("S7.1: pause and reprice never disturb accepted commitments", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 4);
    await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "2500000" });
    const com = (await ctx.store.listActiveCommitments(campaignId))[0];
    expect(com.amountMicroUsdc).toBe(2_500_000n);
    await evaluateMarket(ctx.pricingDeps, { campaignId }); // reprices up
    expect((await ctx.store.getMarket(campaignId))?.publicBountyMicroUsdc).not.toBe(2_000_000n);
    const afterReprice = await ctx.store.getCommitmentByNegotiation(com.negotiationId);
    expect(afterReprice?.state).toBe("ACTIVE");
    expect(afterReprice?.amountMicroUsdc).toBe(2_500_000n);
    await ctx.store.updateMarket(campaignId, 2, { status: "PAUSED", version: 3 });
    const afterPause = await ctx.store.getCommitmentByNegotiation(com.negotiationId);
    expect(afterPause?.state).toBe("ACTIVE");
  });

  it("S7.1: outcome consumes the commitment once; rejection never unlocks", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 5);
    const acc = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "2500000" });
    expect(acc.evaluation?.decision).toBe("ACCEPT");
    const terms = (await ctx.store.getTerms(campaignId, "p-1"))!;
    const referral = (await ctx.store.getReferralByTerms(terms.id))!;
    const sess = await mintAttributionSession(ctx.checkoutDeps, {
      referralId: referral.id, campaignId, partnerId: "p-1",
      partnerTermsId: terms.id, expiresAt: new Date(Date.now() + 86_400_000),
    });
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: sess.handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const ctxTx = nextTx();
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: ctxTx });
    ctx.reader.receipts.set(ctxTx.toLowerCase(), { status: "success", to: USDC, blockNumber: 42n, fundedEvents: [] });
    ctx.reader.evidence.set(ctxTx.toLowerCase(), {
      sender: CUSTOMER, blockTimestampMs: BLOCK_MS, blockNumber: 42n,
      transfers: [{ token: USDC, from: CUSTOMER, to: OWNER_W, amount: 10_000_000n }],
    });
    const v = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(v.verified).toBe(true);
    const outcome = await ctx.store.getOutcomeByIntent(created.intent.id);
    const deps = { store: ctx.store, audit: ctx.checkoutDeps.audit, config: CONFIG, reader: ctx.reader, signer: null, executor: null, now: () => new Date(JULY) } as never;
    const r = await reserveOutcomePayout(deps, { outcomeId: outcome!.id });
    expect(r.reserved).toBe(true);
    // Consumed exactly once, linked to the outcome + reservation...
    const consumed = await ctx.store.getCommitmentByNegotiation(acc.negotiation.id);
    expect(consumed?.state).toBe("CONSUMED");
    expect(consumed?.consumedByOutcomeId).toBe(outcome!.id);
    expect(consumed?.consumedByReservationId).toBe((r.reservation as { id: string }).id);
    const { committedForCampaign: committed } = await import("@/server/services/payouts");
    // ...and the campaign accounts the reservation alone (no double count).
    expect(await committed(ctx.store, campaignId)).toBe(2_500_000n);
  });

  it("S7.1: rejected future outcomes change nothing economic", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 9);
    const acc = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "2500000" });
    const terms = (await ctx.store.getTerms(campaignId, "p-1"))!;
    const referral = (await ctx.store.getReferralByTerms(terms.id))!;
    const sess = await mintAttributionSession(ctx.checkoutDeps, {
      referralId: referral.id, campaignId, partnerId: "p-1",
      partnerTermsId: terms.id, expiresAt: new Date(Date.now() + 86_400_000),
    });
    const created = await createCheckoutIntent(ctx.checkoutDeps, {
      attributionHandle: sess.handle, payerAddress: CUSTOMER, amountMicroUsdc: "10000000",
    });
    const ctxTx = nextTx();
    await submitCheckoutTx(ctx.checkoutDeps, { intentId: created.intent.id, txHash: ctxTx });
    // Evidence pays the wrong amount: verification deterministically rejects.
    ctx.reader.receipts.set(ctxTx.toLowerCase(), { status: "success", to: USDC, blockNumber: 42n, fundedEvents: [] });
    ctx.reader.evidence.set(ctxTx.toLowerCase(), {
      sender: CUSTOMER, blockTimestampMs: BLOCK_MS, blockNumber: 42n,
      transfers: [{ token: USDC, from: CUSTOMER, to: OWNER_W, amount: 1_000_000n }],
    });
    const v = await verifyCheckoutIntent(ctx.checkoutDeps, { intentId: created.intent.id });
    expect(v.verified).toBe(false);
    const com = await ctx.store.getCommitmentByNegotiation(acc.negotiation.id);
    expect(com?.state).toBe("ACTIVE"); // still promised; partner may retry
    const { committedForCampaign: committed } = await import("@/server/services/payouts");
    expect(await committed(ctx.store, campaignId)).toBe(2_500_000n); // unchanged
  });

  it("S7.1: legitimate withdraw releases exactly once; revoked terms cannot pay", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 6);
    const a = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "2500000" });
    expect(a.evaluation?.decision).toBe("ACCEPT");
    const w = await withdrawNegotiation(ctx.negotiationDeps, { negotiationId: a.negotiation.id, userId: "partner-1" });
    expect(w.negotiation.status).toBe("WITHDRAWN");
    const com = await ctx.store.getCommitmentByNegotiation(a.negotiation.id);
    expect(com?.state).toBe("RELEASED");
    expect(com?.releasedReason).toBe("SUPPLIER_WITHDRAWN");
    expect((await ctx.store.getTerms(campaignId, "p-1"))?.status).toBe("REVOKED");
    const { committedForCampaign: committed } = await import("@/server/services/payouts");
    expect(await committed(ctx.store, campaignId)).toBe(0n); // fully restored
    const again = await fails(withdrawNegotiation(ctx.negotiationDeps, { negotiationId: a.negotiation.id, userId: "partner-1" }));
    expect(again.status).toBe(409); // second release impossible
    expect((await ctx.store.getCommitmentByNegotiation(a.negotiation.id))?.state).toBe("RELEASED");
  });

  it("S7.1: commitment accounting is immediate, singular, and race-safe", async () => {
    const { committedForCampaign: committed } = await import("@/server/services/payouts");
    // 10M funded, target 1: one 1M accept locks budget + the only capacity unit.
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 10, "1000000", {
      overrides: {
        bountyFloorMicroUsdc: "1000000",
        minQualifyingPurchaseMicroUsdc: "1000000",
        targetOutcomeCount: 1,
        budgetMicroUsdc: "10000000",
        deadline: DEADLINE,
        refundHoldSeconds: 0,
      },
      funded: 10_000_000n,
    });
    expect(await committed(ctx.store, campaignId)).toBe(0n);
    const a1 = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "1000000" });
    expect(a1.evaluation?.decision).toBe("ACCEPT");
    expect(await committed(ctx.store, campaignId)).toBe(1_000_000n); // budget locked now
    expect((await ctx.store.listActiveCommitments(campaignId)).length).toBe(1); // capacity locked now
    // Duplicate evaluation of the accepted row commits nothing new.
    await evaluateNegotiation(ctx.negotiationDeps, { negotiationId: a1.negotiation.id });
    await evaluateNegotiation(ctx.negotiationDeps, { negotiationId: a1.negotiation.id });
    expect((await ctx.store.listActiveCommitments(campaignId)).length).toBe(1);
    expect(await committed(ctx.store, campaignId)).toBe(1_000_000n);
    // Second supplier loses on capacity even though budget would allow it.
    const a2 = await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-2", askMicroUsdc: "1000000" });
    expect(a2.evaluation?.decision).toBe("REJECT");
    // Store-level race guard holds regardless of service flow.
    const race = await fails(
      ctx.store.insertSupplyCommitment({
        id: "c-race", campaignId, negotiationId: a1.negotiation.id, partnerId: "p-1",
        partnerTermsId: "t-x", amountMicroUsdc: 1_000_000n, expiresAt: new Date(DEADLINE),
      }),
    );
    expect(race.code).toBe("UNIQUE_VIOLATION");
  });

  it("S7.1: corrupt states fail closed without partial commits", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 8);
    // Zero free budget with a non-zero floor can never accept.
    const { evaluateNegotiationOffer } = await import("@/server/domain/negotiation");
    const broke = evaluateNegotiationOffer({
      askMicroUsdc: 2_000_000n, referenceBountyMicroUsdc: 2_000_000n,
      bountyFloorMicroUsdc: 2_000_000n, bountyCeilingMicroUsdc: 4_000_000n,
      freeMicroUsdc: -5n, remainingRequired: 5, paceState: "UNDER_PACED", round: 1,
      nowMs: JULY,
    });
    expect(broke.decision).toBe("REJECT");
    // Proposing against a non-LIVE campaign fails before touching state.
    const draft = await createDraft(ctx.campaignDeps, { workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL });
    const bad = await fails(proposeNegotiation(ctx.negotiationDeps, { campaignId: draft.campaign.id, userId: "partner-1", askMicroUsdc: "2000000" }));
    expect(bad.status).toBe(404); // no market exists yet: nothing to negotiate against
    expect(await ctx.store.getActiveNegotiation(draft.campaign.id, "p-1")).toBeNull();
    void campaignId;
  });

  it("worker isolates failures and never duplicates decisions for one state", async () => {
    const ctx = setup(JULY);
    const { campaignId } = await openLiveMarket(ctx, 1);
    // ACCEPTED rows leave the actionable set: sweep finds nothing.
    await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-1", askMicroUsdc: "2500000" });
    const empty = await processNegotiationEvaluations(ctx.negotiationDeps, { campaignId });
    expect(empty.evaluated).toBe(0);
    // COUNTERED rows stay actionable but re-evaluation is idempotent.
    await proposeNegotiation(ctx.negotiationDeps, { campaignId, userId: "partner-2", askMicroUsdc: "3500000" });
    const first = await processNegotiationEvaluations(ctx.negotiationDeps, { campaignId });
    expect(first.evaluated).toBe(1);
    expect(first.failed.length).toBe(0);
    const second = await processNegotiationEvaluations(ctx.negotiationDeps, { campaignId });
    expect(second.evaluated).toBe(1);
    expect(ctx.events.filter((e) => e.action === "negotiation.countered").length).toBe(1);
    const row = await ctx.store.getActiveNegotiation(campaignId, "p-2");
    const decisions = (await ctx.store.getLatestNegotiationDecision(row!.id))!;
    expect(decisions.decision).toBe("COUNTER");
    // Exactly one decision row exists for the unchanged state.
    const mixed = await processNegotiationEvaluations(ctx.negotiationDeps, { negotiationIds: [row!.id, "missing-id"] });
    expect(mixed.evaluated).toBe(1);
    expect(mixed.failed.length).toBe(1);
    expect(mixed.failed[0].negotiationId).toBe("missing-id");
  });
});
