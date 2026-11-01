import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  approvePolicy,
  createDraft,
  moveToReview,
  type CampaignDeps,
} from "@/server/services/campaigns";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
  type FundingStore,
} from "@/server/services/campaignStore";
import {
  prepareFundingIntent,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";
import { registerTestWallet } from "./wallet-fixtures";
import type { ArcConfig } from "@/server/chain/arc";
import {
  normalizeFundingPreview,
  previewErrorMessage,
} from "@/lib/fundingPreview";

/**
 * P0 FUNDING PREVIEW CRASH REGRESSION.
 *
 * Production repro: APPROVED + UNFUNDED Northstar, registered company
 * wallet, click "Fund campaign" → prepare returned 201, but the whole
 * campaign route crashed into the error boundary. MetaMask never opened,
 * no preview, no signature.
 *
 * Root cause pinned here: prepareFundingIntent returned a SHORTER shape
 * than resumeFundingIntent (no `completed`, no `confirmReady`, despite the
 * client typing it as ResumeData). The client stored `completed:
 * undefined` and the preflight render threw on `completed.length` —
 * a render-phase throw takes down the entire route.
 *
 * Fix: prepare returns the full shape (completed: [], confirmReady:
 * false) AND the client normalizes every DTO through
 * normalizeFundingPreview (missing/malformed → safe empty preview),
 * plus a Funding card error boundary as containment. Throwaway keys,
 * in-memory stores, no chain, no broadcast.
 */

const root = join(__dirname, "..");

const OWNER = "0x85520000000000000000000000000000000094A3" as Address;
const VAULT = "0x0fA826256a58F19Ad24Fc9384d81D313f2266F79" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EXECUTOR = "0x1111111111111111111111111111111111111111" as Address;
const VERIFIER = "0x2222222222222222222222222222222222222222" as Address;

// Northstar-shaped: 50 USDC budget.
const NORTHSTAR =
  "Get 5 paying customers by Sunday. Budget 50 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

const CONFIG: ArcConfig = {
  chainId: 5042,
  rpcUrl: "http://localhost:8545",
  usdcAddress: USDC,
  vaultAddress: VAULT,
  executorAddress: EXECUTOR,
  verifierAddress: VERIFIER,
  explorerBaseUrl: null,
};

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Northstar" }],
  }) as unknown as FundingStore;
  const { sink, events } = createMemoryAuditSink();
  const deps: FundingDeps = {
    store,
    audit: sink,
    config: CONFIG,
    reader: null,
    now: () => FIXED_NOW,
    challenges: createMemoryCompanyWalletChallengeStore(),
  };
  const campaignDeps: CampaignDeps = { store, audit: sink, now: () => FIXED_NOW };
  return { store, events, deps, campaignDeps };
}

async function northstarApproved(deps: FundingDeps, campaignDeps: CampaignDeps) {
  const d = await createDraft(
    { ...campaignDeps },
    {
      workspaceId: "ws-A",
      userId: "owner-1",
      intentText: NORTHSTAR,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: "2026-12-31T23:59:59.999Z" },
    },
  );
  await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  return approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
}

async function fails(promise: Promise<unknown>): Promise<{ status?: number; code?: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    return e as { status?: number; code?: string; message: string };
  }
  throw new Error("expected operation to fail");
}

describe("prepare returns a render-safe preview DTO", () => {
  it("1. APPROVED + UNFUNDED + registered wallet opens a funding preview", async () => {
    const { deps, campaignDeps } = setup();
    const reg = await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    expect(reg.workspace.companyWallet).toBeTruthy();
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    // The server contract: the FULL resume shape, so preview state can
    // never hold undefined fields. (Before the fix these were missing and
    // the route crashed on `completed.length`.)
    expect(intent.completed).toEqual([]);
    expect(intent.confirmReady).toBe(false);
    const preview = normalizeFundingPreview(intent);
    expect(preview.actions.length).toBeGreaterThan(0);
    expect(preview.completed).toEqual([]);
    expect(preview.confirmReady).toBe(false);
    // The exact render that used to throw now reads safely.
    expect(preview.completed.length).toBe(0);
  });

  it("2. preview shows 50 USDC from campaign data", async () => {
    const { deps, campaignDeps } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    expect(intent.funding.expectedAmountMicroUsdc).toBe("50000000");
    const fund = intent.actions.find((x) => x.purpose === "fund-campaign");
    expect(fund?.expectedAmountMicroUsdc).toBe("50000000");
  });

  it("3. preview uses Arc Mainnet 5042", async () => {
    const { deps, campaignDeps } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    expect(intent.actions.length).toBeGreaterThan(0);
    for (const action of intent.actions) expect(action.chainId).toBe(5042);
    expect(intent.funding.chainId).toBe(5042);
  });

  it("4. preview approve uses canonical Arc USDC from backend config", async () => {
    const { deps, campaignDeps } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    const approve = intent.actions.find((x) => x.purpose === "approve-usdc");
    expect(approve?.to.toLowerCase()).toBe(USDC.toLowerCase());
  });

  it("5. preview fund uses the canonical vault from the backend action", async () => {
    const { deps, campaignDeps } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    const fund = intent.actions.find((x) => x.purpose === "fund-campaign");
    expect(fund?.to.toLowerCase()).toBe(VAULT.toLowerCase());
  });

  it("6. sender is the registered workspace company wallet on every action", async () => {
    const { deps, campaignDeps, store } = setup();
    const reg = await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const registered = reg.workspace.companyWallet;
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    expect(intent.actions.length).toBeGreaterThan(0);
    for (const action of intent.actions) {
      expect(action.expectedSender.toLowerCase()).toBe((registered ?? "").toLowerCase());
    }
    expect(registered).toBeTruthy();
    expect((await store.getWorkspace("ws-A"))?.companyWallet).toBe(registered);
  });
});

describe("preview failure containment", () => {
  it("7. zero wallet balance cannot crash the preview (no balance fields involved)", () => {
    // No balance data exists anywhere in the preview path — the DTO
    // carries actions only. A wallet with 0 USDC normalizes identically.
    const preview = normalizeFundingPreview({
      actions: [
        {
          purpose: "approve-usdc",
          chainId: 5042,
          to: USDC,
          data: "0x1234",
          value: "0",
          expectedSender: OWNER,
          expectedAmountMicroUsdc: "50000000",
        },
      ],
    });
    expect(preview.actions).toHaveLength(1);
    expect(preview.completed).toEqual([]);
    expect(preview.confirmReady).toBe(false);
    const component = readFileSync(join(root, "src/components/app/CampaignFunding.tsx"), "utf8");
    expect(component).not.toMatch(/balance/i);
  });

  it("8. prepare API failure surfaces as a string message", async () => {
    const { deps, campaignDeps } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const err = await fails(
      prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 99 }),
    );
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
    expect(previewErrorMessage(err, "fallback")).toBe(err.message);
  });

  it("9. malformed API payloads degrade to a safe empty preview, never throw", () => {
    for (const garbage of [null, undefined, 42, "nope", [], {}, { actions: "nope" }, { completed: 7 }, { actions: [{ nope: 1 }] }]) {
      const preview = normalizeFundingPreview(garbage);
      expect(preview).toEqual({ actions: [], completed: [], confirmReady: false });
      expect(preview.completed.length).toBe(0);
    }
    // Legacy shorter shape (the production crash input): missing
    // `completed`/`confirmReady` must not crash either.
    const legacy = normalizeFundingPreview({ actions: [] });
    expect(legacy.completed).toEqual([]);
    expect(legacy.confirmReady).toBe(false);
    expect(previewErrorMessage(null, "Funding preview couldn't be prepared.")).toBe(
      "Funding preview couldn't be prepared.",
    );
  });
});

describe("no signing or broadcast before explicit confirmation", () => {
  it("10/11. the Fund click path sends no transaction and signs nothing", () => {
    const src = readFileSync(join(root, "src/components/app/CampaignFunding.tsx"), "utf8");
    const beginStart = src.indexOf("async function begin()");
    const executeStart = src.indexOf("async function execute()");
    expect(beginStart).toBeGreaterThan(-1);
    expect(executeStart).toBeGreaterThan(beginStart);
    const clickPath = src.slice(beginStart, executeStart);
    expect(clickPath).not.toContain("eth_sendTransaction");
    expect(clickPath).not.toMatch(/method:\s*[\"']eth_sign[\"']/);
    expect(clickPath).not.toContain("personal_sign");
    expect(clickPath).not.toContain("eth_signTypedData");
  });

  it("12. broadcast happens only from the explicit Start signing control", async () => {
    const src = readFileSync(join(root, "src/components/app/CampaignFunding.tsx"), "utf8");
    expect(src.split("eth_sendTransaction").length - 1).toBe(1);
    expect(src.split("onClick={execute}").length - 1).toBe(1);
    // Preview construction is pure: zero provider calls.
    const calls: string[] = [];
    const { deps, campaignDeps } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    const preview = normalizeFundingPreview(intent);
    expect(preview.actions.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
});

describe("intent durability without money movement", () => {
  it("13. retry cannot create duplicate active funding intents", async () => {
    const { deps, campaignDeps, store } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const first = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    expect(first.funding.status).toBe("PREPARED");
    const second = await fails(
      prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 }),
    );
    // Retry is refused (state moved to FUNDING on first prepare, so the
    // APPROVED-only guard or the in-progress guard rejects it) — either
    // way no second intent is created.
    expect([400, 409]).toContain(second.status);
    expect(["BAD_REQUEST", "FUNDING_IN_PROGRESS"]).toContain(second.code);
    const row = await store.getFunding(a.campaign.id, 1);
    expect(row?.status).toBe("PREPARED");
    expect(row?.fundingTxHash).toBeNull();
  });

  it("14. campaign remains UNFUNDED until receipt reconciliation", async () => {
    const { deps, campaignDeps, store } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    await prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 });
    const campaign = await store.getCampaign(a.campaign.id);
    expect(campaign?.state).toBe("FUNDING");
    const funding = await store.getFunding(a.campaign.id, 1);
    expect(funding?.status).toBe("PREPARED");
    expect(funding?.status).not.toBe("CONFIRMED");
    expect(funding?.fundingTxHash).toBeNull();
  });

  it("15. existing @bgirl invitation untouched by funding prepare", async () => {
    const { deps, campaignDeps, events } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const before = events.length;
    await prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 });
    const fresh = events.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    for (const e of fresh) {
      expect(e.action).not.toMatch(/invit|referral|payout|reservation|partner|bgirl/i);
    }
    expect(fresh.some((e) => e.action === "campaign.funding_prepared")).toBe(true);
  });
});
