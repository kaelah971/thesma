import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  approvePolicy,
  createDraft,
  moveToReview,
  reviseDraft,
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
  type FundingDeps,
} from "@/server/services/fundings";
import type {
  ArcChainReader,
  ArcConfig,
  FundedEventEvidence,
  TxReceiptSummary,
  VaultCampaignState,
} from "@/server/chain/arc";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x3333333333333333333333333333333333333333" as Address;
const VERIFIER = "0x4444444444444444444444444444444444444444" as Address;
const OTHER = "0x5555555555555555555555555555555555555555" as Address;

const FUNDING_TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const CREATE_TX = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;

const CANONICAL =
  "Get 5 paying customers by Sunday. Budget 15 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

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
  chainId = 31337;
  receipts = new Map<string, TxReceiptSummary>();
  vaultStates = new Map<string, VaultCampaignState>();
  failReads = false;
  receiptCalls = 0;

  async getChainId() {
    return this.chainId;
  }
  async getReceipt(txHash: Hex) {
    this.receiptCalls += 1;
    if (this.failReads) throw new Error("rpc down");
    return this.receipts.get(txHash.toLowerCase()) ?? null;
  }
  async readVaultCampaign(_vault: Address, campaignKey: Hex) {
    if (this.failReads) throw new Error("rpc down");
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
    exists: true,
    owner: OWNER,
    budgetCap: 15_000_000n,
    bountyCeiling: 4_000_000n,
    deadline: 1_798_761_599n,
    executor: EXECUTOR,
    verifier: VERIFIER,
    spent: 0n,
    paused: false,
    closed: false,
    returned: false,
    ...overrides,
  };
}

function successReceipt(overrides: Partial<TxReceiptSummary> & { fundedEvents: FundedEventEvidence[] }): TxReceiptSummary {
  return { status: "success", to: VAULT, blockNumber: 12345n, ...overrides };
}

function setup(reader?: FakeReader) {
  const store = createMemoryCampaignStore({
    memberships: [
      { userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" },
      { userId: "member-2", workspaceId: "ws-A", role: "ORGANIZATION_MEMBER" },
    ],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null }],
  }) as FundingStore;
  const { sink, events } = createMemoryAuditSink();
  const deps: FundingDeps = {
    store,
    audit: sink,
    config: CONFIG,
    reader: reader ?? new FakeReader(),
    now: () => FIXED_NOW,
  };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  return { store, events, deps, campaignDeps };
}

async function approvedCampaign(deps: FundingDeps, campaignDeps: CampaignDeps, userId = "owner-1") {
  const d = await createDraft(
    { ...campaignDeps },
    {
      workspaceId: "ws-A",
      userId,
      intentText: CANONICAL,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: "2026-12-31T23:59:59.999Z" },
    },
  );
  await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId, expectedVersion: 1 });
  const a = await approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId, expectedVersion: 1 });
  return a;
}

async function prepared(deps: FundingDeps, campaignDeps: CampaignDeps, reader: FakeReader) {
  await registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER });
  const a = await approvedCampaign(deps, campaignDeps);
  const p = await prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 });
  void reader;
  return { campaignId: a.campaign.id, intent: p };
}

async function fails(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected operation to fail");
}

describe("funding access control", () => {
  it("only the owner can prepare funding; members and outsiders are blocked", async () => {
    const { deps, campaignDeps } = setup();
    await registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER });
    const a = await approvedCampaign(deps, campaignDeps);
    const member = await fails(prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "member-2", expectedVersion: 1 }));
    expect(member.status).toBe(403);
    const outsider = await fails(prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "ghost", expectedVersion: 1 }));
    expect(outsider.status).toBe(403);
  });

  it("members cannot submit or confirm funding", async () => {
    const reader = new FakeReader();
    const { deps, campaignDeps } = setup(reader);
    const { campaignId } = await prepared(deps, campaignDeps, reader);
    const s = await fails(
      recordFundingSubmitted(deps, { campaignId, userId: "member-2", expectedVersion: 1, fundingTxHash: FUNDING_TX }),
    );
    expect(s.status).toBe(403);
    const c = await fails(confirmFunding(deps, { campaignId, userId: "member-2" }));
    expect(c.status).toBe(403);
  });

  it("requires APPROVED policy, fresh version, and a registered company wallet", async () => {
    const { deps, campaignDeps } = setup();
    const d = await createDraft(campaignDeps, { workspaceId: "ws-A", userId: "owner-1", intentText: CANONICAL });
    const draftErr = await fails(prepareFundingIntent(deps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 }));
    expect(draftErr.status).toBe(400);

    await registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER });
    const a = await approvedCampaign(deps, campaignDeps);
    const stale = await fails(prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 99 }));
    expect(stale.status).toBe(409);
  });

  it("rejects malformed wallet addresses without storing them", async () => {
    const { deps } = setup();
    const err = await fails(registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: "0x123" }));
    expect(err.status).toBe(400);
    const ws = await deps.store.getWorkspace("ws-A");
    expect(ws?.companyWallet).toBeNull();
  });

  it("registers (not verifies) the company wallet with a checksummed address and audit", async () => {
    const { events, deps } = setup();
    const r = await registerCompanyWallet(deps, {
      workspaceId: "ws-A",
      userId: "member-2",
      address: OWNER,
    }).catch((e) => e);
    expect(r.status).toBe(403); // member cannot register
    const ok = await registerCompanyWallet(deps, { workspaceId: "ws-A", userId: "owner-1", address: OWNER.toLowerCase() });
    expect(ok.workspace.companyWallet).toBe(OWNER);
    expect(events.some((e) => e.action === "workspace.company_wallet_registered")).toBe(true);
  });
});

describe("funding intent (unsigned, exact)", () => {
  it("moves APPROVED -> FUNDING with a PREPARED record and exact unsigned calls", async () => {
    const reader = new FakeReader();
    const { events, deps, campaignDeps } = setup(reader);
    const { campaignId, intent } = await prepared(deps, campaignDeps, reader);
    expect(intent.campaign.state).toBe("FUNDING");
    expect(intent.funding.status).toBe("PREPARED");
    expect(intent.funding.expectedAmountMicroUsdc).toBe("15000000");
    expect(intent.actions.map((a) => a.purpose)).toEqual(["create-campaign", "approve-usdc", "fund-campaign"]);
    for (const action of intent.actions) {
      expect(action.chainId).toBe(31337);
      expect(action.value).toBe("0");
      expect(action.expectedSender).toBe(OWNER);
      expect(action.data.startsWith("0x")).toBe(true);
    }
    const approve = intent.actions.find((a) => a.purpose === "approve-usdc")!;
    expect(approve.to).toBe(USDC);
    expect(approve.expectedAmountMicroUsdc).toBe("15000000");
    const serialized = JSON.stringify(intent.actions);
    expect(serialized).not.toMatch(/signature|privateKey|mnemonic/i);
    const allowedKeys = new Set([
      "purpose",
      "chainId",
      "to",
      "data",
      "value",
      "expectedSender",
      "expectedAmountMicroUsdc",
    ]);
    for (const action of intent.actions) {
      for (const k of Object.keys(action)) expect(allowedKeys.has(k)).toBe(true);
    }
    expect(events.some((e) => e.action === "campaign.funding_prepared")).toBe(true);
    const stored = await getFundingStatus(deps, { campaignId, userId: "owner-1" });
    expect(stored.funding.campaignKey).toBe(intent.campaignKey);
  });

  it("skips the create step when the campaign already exists onchain", async () => {
    const { buildFundingIntent } = await import("@/server/chain/arc");
    const base = {
      config: CONFIG,
      ownerAddress: OWNER,
      campaignKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
      policyHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
      budgetMicroUsdc: 15_000_000n,
      bountyCeilingMicroUsdc: 4_000_000n,
      deadlineUnix: 1_798_761_599n,
      executorAddress: EXECUTOR,
      verifierAddress: VERIFIER,
    };
    const fresh = buildFundingIntent({ ...base, campaignExistsOnchain: false });
    expect(fresh.map((a) => a.purpose)).toEqual(["create-campaign", "approve-usdc", "fund-campaign"]);
    const existing = buildFundingIntent({ ...base, campaignExistsOnchain: true });
    expect(existing.map((a) => a.purpose)).toEqual(["approve-usdc", "fund-campaign"]);
  });

  it("a supplied tx hash never causes LIVE by itself", async () => {
    const reader = new FakeReader();
    const { deps, campaignDeps, store } = setup(reader);
    const { campaignId } = await prepared(deps, campaignDeps, reader);
    await recordFundingSubmitted(deps, {
      campaignId,
      userId: "owner-1",
      expectedVersion: 1,
      createTxHash: CREATE_TX,
      fundingTxHash: FUNDING_TX,
    });
    const stored = await getFundingStatus(deps, { campaignId, userId: "owner-1" });
    expect(stored.funding.status).toBe("SUBMITTED");
    expect((await store.getCampaign(campaignId))?.state).toBe("FUNDING");
  });

  it("rejects malformed tx hashes and empty submissions", async () => {
    const reader = new FakeReader();
    const { deps, campaignDeps } = setup(reader);
    const { campaignId } = await prepared(deps, campaignDeps, reader);
    const bad = await fails(recordFundingSubmitted(deps, { campaignId, userId: "owner-1", expectedVersion: 1, fundingTxHash: "0x123" }));
    expect(bad.status).toBe(400);
    const empty = await fails(recordFundingSubmitted(deps, { campaignId, userId: "owner-1", expectedVersion: 1 }));
    expect(empty.status).toBe(400);
  });
});

describe("funding confirmation (reads Arc, trusts nothing)", () => {
  async function submittedFlow() {
    const reader = new FakeReader();
    const ctx = setup(reader);
    const { campaignId, intent } = await prepared(ctx.deps, ctx.campaignDeps, reader);
    await recordFundingSubmitted(ctx.deps, { campaignId, userId: "owner-1", expectedVersion: 1, fundingTxHash: FUNDING_TX });
    return { ...ctx, reader, campaignId, intent };
  }

  it("confirms valid funding evidence to LIVE exactly once and is idempotent", async () => {
    const { events, deps, reader, campaignId, intent } = await submittedFlow();
    reader.receipts.set(
      FUNDING_TX.toLowerCase(),
      successReceipt({
        fundedEvents: [{ campaignKey: intent.campaignKey as Hex, funder: OWNER, amount: 15_000_000n, totalFunded: 15_000_000n }],
      }),
    );
    reader.vaultStates.set(
      intent.campaignKey.toLowerCase(),
      vaultState({ policyHash: intent.policyHash as Hex, funded: 15_000_000n }),
    );
    const first = await confirmFunding(deps, { campaignId, userId: "owner-1" });
    expect(first.campaign.state).toBe("LIVE");
    expect(first.funding.status).toBe("CONFIRMED");
    expect(first.funding.observedAmountMicroUsdc).toBe("15000000");
    const actions = events.map((e) => e.action);
    expect(actions).toContain("campaign.funding_confirmed");
    expect(actions).toContain("campaign.live");

    const count = events.length;
    const second = await confirmFunding(deps, { campaignId, userId: "owner-1" });
    expect("alreadyConfirmed" in second && second.alreadyConfirmed).toBe(true);
    expect(events.length).toBe(count);
  });

  it("rejects a wrong-chain receipt", async () => {
    const { deps, reader, campaignId } = await submittedFlow();
    reader.chainId = 99999;
    const r = await confirmFunding(deps, { campaignId, userId: "owner-1" });
    expect(r.funding.status).toBe("FAILED");
    expect(r.funding.failureCode).toBe("CHAIN_MISMATCH");
  });

  it("rejects a receipt to the wrong vault", async () => {
    const { deps, reader, campaignId, intent } = await submittedFlow();
    reader.receipts.set(
      FUNDING_TX.toLowerCase(),
      successReceipt({
        to: OTHER,
        fundedEvents: [{ campaignKey: intent.campaignKey as Hex, funder: OWNER, amount: 15_000_000n, totalFunded: 15_000_000n }],
      }),
    );
    const r = await confirmFunding(deps, { campaignId, userId: "owner-1" });
    expect(r.funding.failureCode).toBe("WRONG_VAULT");
  });

  it("rejects a receipt without the campaign key event", async () => {
    const { deps, reader, campaignId } = await submittedFlow();
    reader.receipts.set(FUNDING_TX.toLowerCase(), successReceipt({ fundedEvents: [] }));
    const r = await confirmFunding(deps, { campaignId, userId: "owner-1" });
    expect(r.funding.failureCode).toBe("NO_FUNDING_EVENT");
  });

  it("rejects wrong owner, policy mismatch, and underfunding", async () => {
    const one = await submittedFlow();
    one.reader.receipts.set(
      FUNDING_TX.toLowerCase(),
      successReceipt({
        fundedEvents: [{ campaignKey: one.intent.campaignKey as Hex, funder: OWNER, amount: 15_000_000n, totalFunded: 15_000_000n }],
      }),
    );
    one.reader.vaultStates.set(
      one.intent.campaignKey.toLowerCase(),
      vaultState({ policyHash: one.intent.policyHash as Hex, funded: 15_000_000n, owner: OTHER }),
    );
    expect((await confirmFunding(one.deps, { campaignId: one.campaignId, userId: "owner-1" })).funding.failureCode).toBe("WRONG_OWNER");

    const two = await submittedFlow();
    two.reader.receipts.set(
      FUNDING_TX.toLowerCase(),
      successReceipt({
        fundedEvents: [{ campaignKey: two.intent.campaignKey as Hex, funder: OWNER, amount: 15_000_000n, totalFunded: 15_000_000n }],
      }),
    );
    two.reader.vaultStates.set(
      two.intent.campaignKey.toLowerCase(),
      vaultState({ policyHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex, funded: 15_000_000n }),
    );
    expect((await confirmFunding(two.deps, { campaignId: two.campaignId, userId: "owner-1" })).funding.failureCode).toBe("POLICY_MISMATCH");

    const three = await submittedFlow();
    three.reader.receipts.set(
      FUNDING_TX.toLowerCase(),
      successReceipt({
        fundedEvents: [{ campaignKey: three.intent.campaignKey as Hex, funder: OWNER, amount: 5_000_000n, totalFunded: 5_000_000n }],
      }),
    );
    three.reader.vaultStates.set(
      three.intent.campaignKey.toLowerCase(),
      vaultState({ policyHash: three.intent.policyHash as Hex, funded: 5_000_000n }),
    );
    const partial = await confirmFunding(three.deps, { campaignId: three.campaignId, userId: "owner-1" });
    expect(partial.funding.failureCode).toBe("UNDERFUNDED");
    expect(partial.campaign.state).toBe("FUNDING"); // partial funding never goes LIVE
  });

  it("rejects reverted receipts and marks unknown receipts AMBIGUOUS without sending", async () => {
    const { deps, reader, campaignId } = await submittedFlow();
    reader.receipts.set(FUNDING_TX.toLowerCase(), { status: "reverted", to: VAULT, blockNumber: 1n, fundedEvents: [] });
    const bad = await confirmFunding(deps, { campaignId, userId: "owner-1" });
    expect(bad.funding.failureCode).toBe("TX_REVERTED");

    const fresh = await submittedFlow();
    const callsBefore = fresh.reader.receiptCalls;
    const amb = await confirmFunding(fresh.deps, { campaignId: fresh.campaignId, userId: "owner-1" });
    expect(amb.funding.status).toBe("AMBIGUOUS");
    expect(fresh.reader.receiptCalls).toBe(callsBefore + 1); // read-only check, no broadcast possible
    const again = await confirmFunding(fresh.deps, { campaignId: fresh.campaignId, userId: "owner-1" });
    expect(again.funding.status).toBe("AMBIGUOUS");
  });

  it("locks policy mutation once funding begins and allows FAILED retry", async () => {
    const reader = new FakeReader();
    const { deps, campaignDeps } = setup(reader);
    const { campaignId } = await prepared(deps, campaignDeps, reader);
    const locked = await fails(reviseDraft({ ...campaignDeps }, { campaignId, userId: "owner-1", expectedVersion: 1, patch: {} }));
    expect(locked.status).toBe(409);

    await recordFundingSubmitted(deps, { campaignId, userId: "owner-1", expectedVersion: 1, fundingTxHash: FUNDING_TX });
    reader.receipts.set(FUNDING_TX.toLowerCase(), { status: "reverted", to: VAULT, blockNumber: 1n, fundedEvents: [] });
    const failed = await confirmFunding(deps, { campaignId, userId: "owner-1" });
    expect(failed.funding.status).toBe("FAILED");
    const retry = await prepareFundingIntent(deps, { campaignId, userId: "owner-1", expectedVersion: 1 });
    expect(retry.funding.status).toBe("PREPARED");
  });

  it("rolls back campaign, funding, and audit together when the sink fails", async () => {
    const reader = new FakeReader();
    const { store, events, campaignDeps } = setup(reader);
    const throwingSink = async (input: { action: string; metadata?: Record<string, unknown> }) => {
      if (input.action === "campaign.funding_prepared") throw new Error("audit outage");
      events.push({ action: input.action, metadata: input.metadata ?? {} });
      return { id: "evt" };
    };
    const deps: FundingDeps = { store, audit: throwingSink, config: CONFIG, reader, now: () => FIXED_NOW };
    await registerCompanyWallet({ ...deps, audit: throwingSink }, { workspaceId: "ws-A", userId: "owner-1", address: OWNER });
    const a = await approvedCampaign({ ...deps }, campaignDeps);
    const err = await fails(prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 }));
    expect(err.message).toBe("audit outage");
    expect((await store.getCampaign(a.campaign.id))?.state).toBe("APPROVED"); // unchanged
    expect(await store.getFunding(a.campaign.id, 1)).toBeNull(); // no partial row
    expect(events.some((e) => e.action === "campaign.funding_prepared")).toBe(false);
  });
});
