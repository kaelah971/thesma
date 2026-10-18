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
import type { FundingStore } from "@/server/services/campaignStore";
import {
  confirmFunding,
  getFundingStatus,
  prepareFundingIntent,
  recordFundingSubmitted,
  registerCompanyWallet,
  resumeFundingIntent,
  type FundingDeps,
} from "@/server/services/fundings";
import type {
  ArcChainReader,
  FundedEventEvidence,
  TxReceiptSummary,
  VaultCampaignState,
} from "@/server/chain/arc";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x3333333333333333333333333333333333333333" as Address;
const VERIFIER = "0x4444444444444444444444444444444444444444" as Address;

const FUNDING_TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const CREATE_TX = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const APPROVE_TX = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;

const CONFIG = {
  chainId: 31337,
  rpcUrl: "http://localhost:8542",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR,
  verifierAddress: VERIFIER,
  explorerBaseUrl: null,
};

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

class FakeReader implements ArcChainReader {
  receipts = new Map<string, TxReceiptSummary>();
  vaultStates = new Map<string, VaultCampaignState>();

  async getChainId() {
    return 31337;
  }
  async getReceipt(txHash: Hex) {
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async readVaultCampaign(_vault: Address, campaignKey: Hex) {
    const s = this.vaultStates.get(campaignKey.toLowerCase());
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

function vaultState(overrides: Partial<VaultCampaignState> & { policyHash: Hex; funded: bigint }): VaultCampaignState {
  return {
    exists: true, owner: OWNER, budgetCap: 15_000_000n, bountyCeiling: 4_000_000n,
    deadline: 1_798_761_599n, executor: EXECUTOR, verifier: VERIFIER, spent: 0n,
    paused: false, closed: false, returned: false,
    ...overrides,
  };
}

function okReceipt(): TxReceiptSummary {
  return { status: "success", to: VAULT, blockNumber: 1n, fundedEvents: [] as FundedEventEvidence[] };
}

function setup() {
  const reader = new FakeReader();
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" }],
  }) as FundingStore;
  const { sink } = createMemoryAuditSink();
  const deps: FundingDeps = { store, audit: sink, config: CONFIG, reader, now: () => FIXED_NOW };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  return { store, deps, campaignDeps, reader };
}

async function approvedCampaign(deps: FundingDeps, campaignDeps: CampaignDeps) {
  const d = await createDraft(
    { ...campaignDeps },
    {
      workspaceId: "ws-A",
      userId: "owner-1",
      intentText: CANONICAL,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: "2026-12-31T23:59:59.999Z" },
    },
  );
  await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  return approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
}

async function preparedFlow() {
  const ctx = setup();
  await registerCompanyWallet(ctx.deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER });
  const a = await approvedCampaign(ctx.deps, ctx.campaignDeps);
  const intent = await prepareFundingIntent(ctx.deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 });
  return { ...ctx, campaignId: a.campaign.id, intent };
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

describe("funding resume (idempotent, no new rows)", () => {
  it("fresh PREPARED flow resumes with identical bindings and all three actions", async () => {
    const { deps, campaignId, intent } = await preparedFlow();
    const resumed = await resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 });
    expect(resumed.campaignKey).toBe(intent.campaignKey);
    expect(resumed.policyHash).toBe(intent.policyHash);
    expect(resumed.actions.map((a) => a.purpose)).toEqual(["create-campaign", "approve-usdc", "fund-campaign"]);
    expect(resumed.completed).toEqual([]);
    expect(resumed.confirmReady).toBe(false);
    for (const a of resumed.actions) {
      expect(a.expectedSender).toBe(OWNER);
      expect(a.chainId).toBe(31337);
    }
    // No duplicate funding row: preparing again is still rejected, record unchanged.
    const again = await fails(
      prepareFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 }),
    );
    expect(again.status).toBe(400); // campaign already left APPROVED for FUNDING
    const stored = await getFundingStatus(deps, { campaignId, userId: "owner-1" });
    expect(stored.funding.status).toBe("PREPARED");
    expect(stored.funding.campaignKey).toBe(intent.campaignKey);
  });

  it("recorded create hash with onchain registration omits create-campaign", async () => {
    const { deps, reader, campaignId, intent } = await preparedFlow();
    reader.receipts.set(CREATE_TX.toLowerCase(), okReceipt());
    reader.vaultStates.set(intent.campaignKey.toLowerCase(), vaultState({ policyHash: intent.policyHash as Hex, funded: 0n }));
    await recordFundingSubmitted(deps, { campaignId, userId: "owner-1", expectedVersion: 1, createTxHash: CREATE_TX });
    const resumed = await resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 });
    expect(resumed.campaignKey).toBe(intent.campaignKey);
    expect(resumed.actions.map((a) => a.purpose)).toEqual(["approve-usdc", "fund-campaign"]);
    expect(resumed.completed).toEqual(["create-campaign"]);
  });

  it("recorded approve hash prevents blind approve resend", async () => {
    const { deps, reader, campaignId, intent } = await preparedFlow();
    reader.receipts.set(CREATE_TX.toLowerCase(), okReceipt());
    reader.receipts.set(APPROVE_TX.toLowerCase(), okReceipt());
    reader.vaultStates.set(intent.campaignKey.toLowerCase(), vaultState({ policyHash: intent.policyHash as Hex, funded: 0n }));
    await recordFundingSubmitted(deps, {
      campaignId, userId: "owner-1", expectedVersion: 1, createTxHash: CREATE_TX, approveTxHash: APPROVE_TX,
    });
    const resumed = await resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 });
    expect(resumed.actions.map((a) => a.purpose)).toEqual(["fund-campaign"]);
    expect(resumed.completed).toEqual(["create-campaign", "approve-usdc"]);
    expect(resumed.confirmReady).toBe(false);
  });

  it("recorded fund hash omits fund-campaign and signals confirmReady", async () => {
    const { deps, reader, campaignId, intent } = await preparedFlow();
    reader.receipts.set(CREATE_TX.toLowerCase(), okReceipt());
    reader.receipts.set(APPROVE_TX.toLowerCase(), okReceipt());
    reader.receipts.set(FUNDING_TX.toLowerCase(), okReceipt());
    reader.vaultStates.set(intent.campaignKey.toLowerCase(), vaultState({ policyHash: intent.policyHash as Hex, funded: 0n }));
    await recordFundingSubmitted(deps, {
      campaignId, userId: "owner-1", expectedVersion: 1,
      createTxHash: CREATE_TX, approveTxHash: APPROVE_TX, fundingTxHash: FUNDING_TX,
    });
    const resumed = await resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 });
    expect(resumed.actions).toEqual([]);
    expect(resumed.completed).toEqual(["create-campaign", "approve-usdc", "fund-campaign"]);
    expect(resumed.confirmReady).toBe(true);
  });

  it("recorded hash without a receipt fails closed as ambiguous with no actions", async () => {
    const { deps, campaignId } = await preparedFlow();
    await recordFundingSubmitted(deps, { campaignId, userId: "owner-1", expectedVersion: 1, createTxHash: CREATE_TX });
    const err = await fails(resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 }));
    expect(err.code).toBe("TX_AMBIGUOUS");
  });

  it("recorded reverted transaction fails closed with no actions", async () => {
    const { deps, reader, campaignId } = await preparedFlow();
    reader.receipts.set(APPROVE_TX.toLowerCase(), { status: "reverted", to: USDC, blockNumber: 2n, fundedEvents: [] });
    await recordFundingSubmitted(deps, { campaignId, userId: "owner-1", expectedVersion: 1, approveTxHash: APPROVE_TX });
    const err = await fails(resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 }));
    expect(err.code).toBe("TX_REVERTED");
  });

  it("create success without onchain registration fails closed as ambiguous", async () => {
    const { deps, reader, campaignId } = await preparedFlow();
    reader.receipts.set(CREATE_TX.toLowerCase(), okReceipt());
    // No vault state: success receipt but campaign missing onchain.
    await recordFundingSubmitted(deps, { campaignId, userId: "owner-1", expectedVersion: 1, createTxHash: CREATE_TX });
    const err = await fails(resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 }));
    expect(err.code).toBe("TX_AMBIGUOUS");
  });

  it("stored bindings that drift from the approved policy refuse to resume", async () => {
    const { deps, store, campaignId } = await preparedFlow();
    await store.updateFunding(campaignId, 1, {
      campaignKey: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });
    const err = await fails(resumeFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 }));
    expect(err.code).toBe("BINDING_MISMATCH");
  });

  it("resume is owner-only, version-pinned, and refuses confirmed funding", async () => {
    const ctx = await preparedFlow();
    const outsider = await fails(
      resumeFundingIntent(ctx.deps, { campaignId: ctx.campaignId, userId: "ghost", expectedVersion: 1 }),
    );
    expect(outsider.status).toBe(403);
    const stale = await fails(
      resumeFundingIntent(ctx.deps, { campaignId: ctx.campaignId, userId: "owner-1", expectedVersion: 99 }),
    );
    expect(stale.status).toBe(409);
    ctx.reader.receipts.set(
      FUNDING_TX.toLowerCase(),
      {
        status: "success", to: VAULT, blockNumber: 7n,
        fundedEvents: [{ campaignKey: ctx.intent.campaignKey as Hex, funder: OWNER, amount: 15_000_000n, totalFunded: 15_000_000n }],
      },
    );
    ctx.reader.vaultStates.set(
      ctx.intent.campaignKey.toLowerCase(),
      vaultState({ policyHash: ctx.intent.policyHash as Hex, funded: 15_000_000n }),
    );
    await recordFundingSubmitted(ctx.deps, { campaignId: ctx.campaignId, userId: "owner-1", expectedVersion: 1, fundingTxHash: FUNDING_TX });
    await confirmFunding(ctx.deps, { campaignId: ctx.campaignId, userId: "owner-1" });
    const funded = await fails(
      resumeFundingIntent(ctx.deps, { campaignId: ctx.campaignId, userId: "owner-1", expectedVersion: 1 }),
    );
    expect(funded.code).toBe("ALREADY_FUNDED");
  });
});
