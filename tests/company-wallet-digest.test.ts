import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  createMemoryAuditSink,
  createMemoryCampaignStore,
  type FundingStore,
} from "@/server/services/campaignStore";
import {
  proveCompanyWalletChallenge,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";
import { buildCompanyWalletTypedData } from "@/lib/wallet";
import { hashCompanyWalletTypedData, recoverCompanyWalletSigner } from "@/lib/walletCrypto";
import { signWalletRegistration, TEST_OWNER_PRIVATE_KEY } from "./wallet-fixtures";

vi.mock("@/server/auth/guard", () => ({ getSessionUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/server/api/campaignDeps", () => ({ marketDepsOr503: vi.fn() }));

/**
 * EIP-712 digest parity (production changing-recovered-signer incident).
 *
 * Proves client and server hash byte-identical typed data: the full
 * issue → JSON wire format → client hash/sign → server hash/recover path
 * uses real viem crypto, not shared in-memory objects. Any field, type,
 * order, or encoding drift breaks the golden digest or the equality
 * assertions. Throwaway dev keys only; no transactions, no mainnet.
 */

const root = join(__dirname, "..");
const OWNER_ADDR = privateKeyToAccount(TEST_OWNER_PRIVATE_KEY).address;
const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

// Golden digest for the fixed inputs below (domain Thesma/1/5042,
// CompanyWalletRegistration[workspaceId,purpose,nonce,issuedAt,expiresAt]).
const GOLDEN_TYPED_DATA_HASH = "0x0e65357e62c40ab42faa597a22c43c8adcac83f836b663af7a9fc0daefb3307c";

function setup() {
  const store = createMemoryCampaignStore({
    memberships: [{ userId: "owner-1", workspaceId: "ws-A", role: "ORGANIZATION_OWNER" }],
    workspaces: [{ id: "ws-A", ownerUserId: "owner-1", companyWallet: null, category: null, name: "Acme" }],
  }) as unknown as FundingStore;
  const { sink } = createMemoryAuditSink();
  const deps: FundingDeps = {
    store, audit: sink, config: null, reader: null, now: () => FIXED_NOW,
    challenges: createMemoryCompanyWalletChallengeStore(),
  };
  return { deps };
}

describe("EIP-712 digest parity", () => {
  it("golden digest pins the exact canonical encoding", () => {
    const typedData = buildCompanyWalletTypedData({
      workspaceId: "ws-golden",
      nonce: "00000000-0000-0000-0000-000000000000",
      issuedAt: "2026-06-01T12:00:00.000Z",
      expiresAt: "2026-06-01T12:10:00.000Z",
    });
    expect(hashCompanyWalletTypedData(typedData)).toBe(GOLDEN_TYPED_DATA_HASH);
  });

  it("full wire roundtrip: client hash === server hash, recovered === signer", async () => {
    const { deps } = setup();
    // Server issues; the response crosses a real JSON wire-format boundary.
    const signed = await signWalletRegistration(deps, { workspaceId: "ws-A", userId: "owner-1" });
    const wire = JSON.parse(JSON.stringify({ typedData: signed.typedData })) as { typedData: typeof signed.typedData };
    // Client hashes and recovers the EXACT object it sent to MetaMask.
    const clientHash = hashCompanyWalletTypedData(wire.typedData);
    const clientRecovered = await recoverCompanyWalletSigner(wire.typedData, signed.signature);
    expect(clientRecovered.toLowerCase()).toBe(OWNER_ADDR.toLowerCase());
    // Server hashes the stored challenge and recovers the same signer.
    const proved = await proveCompanyWalletChallenge(deps, {
      workspaceId: "ws-A", userId: "owner-1", nonce: signed.nonce, signature: signed.signature,
    });
    expect(proved.typedDataHash).toBe(clientHash);
    expect(proved.provedWallet.toLowerCase()).toBe(clientRecovered.toLowerCase());
    expect(proved.provedWallet).toBe(OWNER_ADDR);
  });

  it("any single-field divergence changes the digest (tamper-evident)", () => {
    const base = {
      workspaceId: "ws-A",
      nonce: "tamper-nonce",
      issuedAt: "2026-06-01T12:00:00.000Z",
      expiresAt: "2026-06-01T12:10:00.000Z",
    };
    const honest = hashCompanyWalletTypedData(buildCompanyWalletTypedData(base));
    expect(hashCompanyWalletTypedData(buildCompanyWalletTypedData({ ...base, nonce: "other-nonce" }))).not.toBe(honest);
    expect(hashCompanyWalletTypedData(buildCompanyWalletTypedData({ ...base, workspaceId: "ws-B" }))).not.toBe(honest);
    expect(hashCompanyWalletTypedData(buildCompanyWalletTypedData({ ...base, issuedAt: "2026-06-01T12:00:00.001Z" }))).not.toBe(honest);
    expect(hashCompanyWalletTypedData(buildCompanyWalletTypedData({ ...base, expiresAt: "2026-06-01T12:11:00.000Z" }))).not.toBe(honest);
  });

  it("component shows a clean production UX with no diagnostic surfaces", () => {
    const src = readFileSync(join(root, "src/components/app/CompanyWalletRegistration.tsx"), "utf8");
    // Verified production view for the registered wallet.
    expect(src).toContain("Company wallet");
    expect(src).toContain("Verified");
    expect(src).toContain("Used to sign and fund campaigns.");
    expect(src).toContain("Change wallet");
    expect(src).toContain("truncateAddress(account)");
    // Registration flow internals stay intact (frozen challenge → prove → confirm).
    expect(src).toContain("selectChallengePayload");
    expect(src).toContain("/company-wallet/prove");
    expect(src).toContain("typedDataHash");
    // No temporary debugging surfaces remain in production UX.
    expect(src).not.toMatch(/diagnostic/i);
    expect(src).not.toMatch(/temporary/i);
    expect(src).not.toMatch(/debug/i);
    expect(src).not.toContain("SIGNATURE REQUEST FAILED");
    expect(src).not.toContain("Request routing");
    expect(src).not.toContain("Injected providers discovered");
    expect(src).not.toMatch(/\{signed\.signature\}/);
    // Failures surface as normal product errors, never raw provider data.
    expect(src).toContain("signFailureCopy");
    expect(src).toContain("form-error");
  });
});
