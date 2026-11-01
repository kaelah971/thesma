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
  serializeFunding,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";
import { registerTestWallet } from "./wallet-fixtures";
import type { ArcConfig } from "@/server/chain/arc";
import {
  BALANCE_OF_SELECTOR,
  buildBalanceOfCall,
  evaluateBalance,
  normalizeFundingPreview,
  parseBalanceHex,
  readUsdcBalanceMicro,
} from "@/lib/fundingPreview";
import type { InjectedProvider } from "@/lib/wallet";

/**
 * TRUTHFUL ARC USDC BALANCE PREFLIGHT.
 *
 * Northstar context: 50 USDC campaign, registered company wallet, Arc
 * Mainnet 5042, canonical Arc USDC, canonical Thesma vault — but the
 * connected wallet holds 0 USDC. Offering "Start signing" in that state
 * is unsafe. Before any signing signature, the preview must read
 * balanceOf(connectedCompanyWallet) on canonical Arc USDC (eth_call only)
 * and gate signing on sufficiency.
 *
 * Read-only: no approval, no signature, no transaction, no intent
 * creation, no store access from the balance path. Throwaway keys,
 * in-memory stores, mocked providers, no chain, no broadcast.
 */

const root = join(__dirname, "..");

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const VAULT = "0x0fA826256a58F19Ad24Fc9384d81D313f2266F79" as Address;
const EXECUTOR = "0x1111111111111111111111111111111111111111" as Address;
const VERIFIER = "0x2222222222222222222222222222222222222222" as Address;
const ACCOUNT = "0x85520000000000000000000000000000000094A3";

const NORTHSTAR_50 =
  "Get 5 paying customers by Sunday. Budget 50 USDC. Max 4 USDC per customer. Purchases below 10 USDC should not count.";
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");
const FIFTY_M = 50_000_000n;

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
      intentText: NORTHSTAR_50,
      overrides: { bountyFloorMicroUsdc: "2000000", deadline: "2026-12-31T23:59:59.999Z" },
    },
  );
  await moveToReview(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
  return approvePolicy(campaignDeps, { campaignId: d.campaign.id, userId: "owner-1", expectedVersion: 1 });
}

function hexBalance(micro: bigint): string {
  return `0x${micro.toString(16)}`;
}

/** Mock wallet: eth_chainId + eth_call(balanceOf) only, every call recorded. */
function mockWallet(opts: { chainIdHex?: string; balanceMicro?: bigint | null; throwOn?: string | null } = {}): {
  provider: InjectedProvider;
  calls: string[];
  seen: { method: string; params: unknown }[];
} {
  const calls: string[] = [];
  const seen: { method: string; params: unknown }[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      seen.push({ method, params });
      if (opts.throwOn === method) throw new Error("rpc down");
      if (method === "eth_chainId") return opts.chainIdHex ?? "0x13b2";
      if (method === "eth_call") {
        if (opts.balanceMicro === null || opts.balanceMicro === undefined) throw new Error("no data");
        return hexBalance(opts.balanceMicro);
      }
      return null;
    },
  } as InjectedProvider;
  return { provider, calls, seen };
}

describe("balance verdicts (micro-USDC exact)", () => {
  it("1. 0 USDC / 50 required → insufficient", () => {
    const v = evaluateBalance(0n, FIFTY_M);
    expect(v.status).toBe("INSUFFICIENT");
    if (v.status === "INSUFFICIENT") expect(v.shortfallMicro).toBe(FIFTY_M);
  });

  it("2. 4.999999 USDC / 5 required → insufficient (dust edge)", () => {
    const v = evaluateBalance(4_999_999n, 5_000_000n);
    expect(v.status).toBe("INSUFFICIENT");
    if (v.status === "INSUFFICIENT") expect(v.shortfallMicro).toBe(1n);
  });

  it("3. exactly required amount → sufficient", () => {
    expect(evaluateBalance(FIFTY_M, FIFTY_M).status).toBe("SUFFICIENT");
  });

  it("4. more than required → sufficient", () => {
    expect(evaluateBalance(75_000_000n, FIFTY_M).status).toBe("SUFFICIENT");
  });

  it("5. shortfall calculation exact in micro-USDC", () => {
    const v = evaluateBalance(10_000_000n, FIFTY_M);
    expect(v.status).toBe("INSUFFICIENT");
    if (v.status === "INSUFFICIENT") expect(v.shortfallMicro).toBe(40_000_000n);
  });
});

describe("balance read mechanics (read-only RPC)", () => {
  it("8. balance read uses the connected registered company wallet", async () => {
    const { provider, seen } = mockWallet({ balanceMicro: 0n });
    const res = await readUsdcBalanceMicro(provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 });
    expect(res).toEqual({ ok: true, balanceMicro: 0n });
    const call = seen.find((s) => s.method === "eth_call");
    expect(call).toBeDefined();
    const params = call!.params as [{ to: string; data: string }, string];
    expect(params[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(params[0].data).toBe(buildBalanceOfCall(USDC, ACCOUNT).data);
    // Account-specific: a different account encodes different calldata.
    expect(buildBalanceOfCall(USDC, ACCOUNT).data).not.toBe(
      buildBalanceOfCall(USDC, "0x0000000000000000000000000000000000000001").data,
    );
  });

  it("9. balance read uses Arc Mainnet 5042 and fails closed otherwise", async () => {
    const good = mockWallet({ chainIdHex: "0x13b2", balanceMicro: 1n });
    expect(await readUsdcBalanceMicro(good.provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 })).toEqual({
      ok: true,
      balanceMicro: 1n,
    });
    const wrong = mockWallet({ chainIdHex: "0x1", balanceMicro: 999_999_999n });
    expect(await readUsdcBalanceMicro(wrong.provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 })).toEqual({
      ok: false,
    });
  });

  it("10. balance read uses canonical USDC with the balanceOf selector", () => {
    const call = buildBalanceOfCall(USDC, ACCOUNT);
    expect(call.to).toBe(USDC);
    expect(call.data.startsWith(BALANCE_OF_SELECTOR)).toBe(true);
    expect(USDC).toBe("0x3600000000000000000000000000000000000000");
  });

  it("11. balance read failure is distinct from zero balance", async () => {
    const empty = mockWallet({ balanceMicro: 0n });
    expect(await readUsdcBalanceMicro(empty.provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 })).toEqual({
      ok: true,
      balanceMicro: 0n,
    });
    const failing = mockWallet({ throwOn: "eth_call" });
    expect(await readUsdcBalanceMicro(failing.provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 })).toEqual({
      ok: false,
    });
    const malformed = mockWallet({ balanceMicro: null });
    expect(
      await readUsdcBalanceMicro(malformed.provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 }),
    ).toEqual({ ok: false });
    expect(parseBalanceHex("garbage")).toBeNull();
    expect(parseBalanceHex(null)).toBeNull();
  });

  it("12. balance read failure fails closed (never sufficient)", async () => {
    const failing = mockWallet({ throwOn: "eth_call" });
    const res = await readUsdcBalanceMicro(failing.provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 });
    expect(res.ok).toBe(false);
    // Component rule: signing enabled ONLY on explicit SUFFICIENT.
    const src = readFileSync(join(root, "src/components/app/CampaignFunding.tsx"), "utf8");
    expect(src).toContain('const canSign = balance.status === "SUFFICIENT"');
    expect(src).toContain("disabled={!canSign}");
  });

  it("15/16. balance check makes zero sendTransaction and zero signing calls", async () => {
    const { provider, calls } = mockWallet({ balanceMicro: 0n });
    await readUsdcBalanceMicro(provider, { usdcAddress: USDC, account: ACCOUNT, chainId: 5042 });
    expect(calls).toEqual(["eth_chainId", "eth_call"]);
    for (const c of calls) {
      expect(c).not.toMatch(/eth_sendTransaction|eth_sign|personal_sign|approve|permit/);
    }
  });
});

describe("preview gating UX (static rails)", () => {
  const src = () => readFileSync(join(root, "src/components/app/CampaignFunding.tsx"), "utf8");

  it("6/7. insufficient disables Start signing, sufficient enables it", () => {
    const s = src();
    // Button disabled unless the balance read came back SUFFICIENT.
    expect(s).toContain("disabled={!canSign}");
    // Insufficient path renders the shortfall + blocking copy.
    expect(s).toContain("Insufficient USDC on");
    expect(s).toContain("Shortfall:");
    // Sufficient path renders the all-clear copy and keeps the same control.
    expect(s).toContain("Balance sufficient");
    expect(s.split("onClick={execute}").length - 1).toBe(1);
    // Unavailable path fails closed with an explicit retry (read-only).
    expect(s).toContain("USDC balance could not be checked.");
    expect(s).toContain("Funding cannot start until the balance check succeeds.");
    expect(s).toContain("Retry balance check");
  });

  it("balance read is wired to the verified connected account on the campaign chain", () => {
    const s = src();
    const at = s.indexOf("readUsdcBalanceMicro(");
    expect(at).toBeGreaterThan(-1);
    const callBlock = s.slice(at, at + 400);
    expect(callBlock).toContain("account");
    expect(callBlock).toContain("usdcAddress");
    expect(callBlock).toContain("chainId");
  });

  it("13/14. wrong account and wrong network remain blocked before any preview", () => {
    const s = src();
    expect(s).toContain("connected.toLowerCase() !== expectedSender.toLowerCase()");
    expect(s).toContain("chainHex.toLowerCase()");
    expect(s).toContain("Wrong account. Connected");
  });

  it("17. retry recreates no funding intent", () => {
    const s = src();
    const at = s.indexOf("function retryBalanceCheck");
    expect(at).toBeGreaterThan(-1);
    const end = s.indexOf("async function", at + 10);
    const body = s.slice(at, end === -1 ? at + 600 : end);
    expect(body).not.toContain("postJson");
    expect(body).not.toContain("funding-intent");
    expect(body).not.toContain("challenge");
  });
});

describe("intent safety around the balance gate", () => {
  it("18. existing PREPARED intent remains unchanged by preview/balance work", async () => {
    const { deps, campaignDeps, store } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const intent = await prepareFundingIntent(deps, {
      campaignId: a.campaign.id,
      userId: "owner-1",
      expectedVersion: 1,
    });
    const before = JSON.stringify(serializeFunding((await store.getFunding(a.campaign.id, 1))!));
    // Everything the preview does with the DTO: normalize + evaluate.
    const preview = normalizeFundingPreview(intent);
    expect(preview.actions.length).toBe(3);
    evaluateBalance(0n, BigInt(intent.funding.expectedAmountMicroUsdc));
    const after = JSON.stringify(serializeFunding((await store.getFunding(a.campaign.id, 1))!));
    expect(after).toBe(before);
    const row = await store.getFunding(a.campaign.id, 1);
    expect(row?.status).toBe("PREPARED");
    expect(row?.fundingTxHash).toBeNull();
  });

  it("19. Northstar-style campaign remains FUNDING / UNFUNDED (never confirmed)", async () => {
    const { deps, campaignDeps, store } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    await prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 });
    expect((await store.getCampaign(a.campaign.id))?.state).toBe("FUNDING");
    const funding = await store.getFunding(a.campaign.id, 1);
    expect(funding?.status).toBe("PREPARED");
    expect(funding?.status).not.toBe("CONFIRMED");
  });

  it("20. no @bgirl invitation changes from prepare", async () => {
    const { deps, campaignDeps, events } = setup();
    await registerTestWallet(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const a = await northstarApproved(deps, campaignDeps);
    const before = events.length;
    await prepareFundingIntent(deps, { campaignId: a.campaign.id, userId: "owner-1", expectedVersion: 1 });
    for (const e of events.slice(before)) {
      expect(e.action).not.toMatch(/invit|referral|payout|reservation|partner|bgirl/i);
    }
  });
});
