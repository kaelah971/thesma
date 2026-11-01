import { describe, expect, it } from "vitest";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  TypedDataUtils,
  SignTypedDataVersion,
  signTypedData,
  recoverTypedSignature,
} from "@metamask/eth-sig-util";
import {
  COMPANY_WALLET_DOMAIN,
  COMPANY_WALLET_REGISTRATION_TYPES,
  buildCompanyWalletTypedData,
  signCompanyWalletTypedDataDetailed,
  type CompanyWalletTypedData,
  type InjectedProvider,
} from "@/lib/wallet";
import { TEST_OWNER_PRIVATE_KEY } from "./wallet-fixtures";

/**
 * P0 METAMASK EIP-712 COMPATIBILITY AUDIT.
 *
 * Clean-profile production evidence: correct requested account, successful
 * signature, but recovered signer 0xf4d2…6169 instead of the requested
 * 0x8552…94A33 — while client/server viem hashes and recoveries matched
 * and the selected provider was MetaMask.
 *
 * Root cause proven below: the raw eth_signTypedData_v4 JSON omitted
 * types.EIP712Domain. Viem infers the domain type from the `domain`
 * object, so viem-only parity held — but MetaMask hashes the RAW payload
 * and, without EIP712Domain, signs a DIFFERENT digest (valid signature,
 * wrong signer). The canonical builder now includes EIP712Domain, and this
 * file pins viem === MetaMask byte-parity plus cross-library sign/recover
 * in both directions. Throwaway dev key only; no DB, no funding, no
 * mainnet.
 */

const FIXTURE = {
  workspaceId: "ws-compat",
  nonce: "11111111-2222-3333-4444-555555555555",
  issuedAt: "2026-06-01T12:00:00.000Z",
  expiresAt: "2026-06-01T12:10:00.000Z",
} as const;

// Golden digest for the fixed fixture: canonical payload hashed by viem
// and by MetaMask eth-sig-util V4 (verified byte-identical during audit).
const GOLDEN_COMPAT_DIGEST =
  "0xdfdfad9ae71410c93fd3f7bb42e62673170d58792da7dfd6a9d6fc64485c54a3";

function canonical(): CompanyWalletTypedData {
  return buildCompanyWalletTypedData({ ...FIXTURE });
}

function rawJson(typedData: CompanyWalletTypedData): never {
  return JSON.parse(JSON.stringify(typedData)) as never;
}

describe("raw payload inspection", () => {
  it("types.EIP712Domain is present with exact fields and order", () => {
    const typed = canonical();
    expect(typed.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ]);
    expect(typed.domain).toMatchObject({ name: "Thesma", version: "1", chainId: 5042 });
    expect(typed.primaryType).toBe("CompanyWalletRegistration");
  });

  it("no verifyingContract anywhere (domain genuinely has none)", () => {
    expect(JSON.stringify(canonical())).not.toContain("verifyingContract");
    expect(JSON.stringify(COMPANY_WALLET_DOMAIN)).not.toContain("verifyingContract");
  });
});

describe("three-hash parity", () => {
  it("A. viem hash of the canonical payload hits the golden digest", () => {
    const typed = canonical();
    const digest = hashTypedData({
      domain: { ...COMPANY_WALLET_DOMAIN },
      types: COMPANY_WALLET_REGISTRATION_TYPES,
      primaryType: "CompanyWalletRegistration",
      message: { ...typed.message },
    });
    expect(digest).toBe(GOLDEN_COMPAT_DIGEST);
  });

  it("B. MetaMask eth-sig-util V4 hash of the EXACT raw JSON matches viem", () => {
    const raw = rawJson(canonical());
    const metaDigest = `0x${TypedDataUtils.eip712Hash(raw, SignTypedDataVersion.V4).toString("hex")}`;
    expect(metaDigest).toBe(GOLDEN_COMPAT_DIGEST);
  });

  it("C. viem hash with explicit EIP712Domain matches (builder is the digest input)", () => {
    const typed = canonical();
    const digest = hashTypedData({
      domain: { ...typed.domain },
      types: typed.types,
      primaryType: typed.primaryType,
      message: { ...typed.message },
    });
    expect(digest).toBe(GOLDEN_COMPAT_DIGEST);
  });

  it("legacy shape without EIP712Domain diverges under MetaMask hashing (the bug)", () => {
    const typed = canonical();
    const legacyTypes = Object.fromEntries(Object.entries(typed.types).filter(([k]) => k !== "EIP712Domain"));
    const viemDigest = hashTypedData({
      domain: { ...COMPANY_WALLET_DOMAIN },
      types: legacyTypes,
      primaryType: "CompanyWalletRegistration",
      message: { ...typed.message },
    });
    const legacyRaw = { ...JSON.parse(JSON.stringify(typed)), types: legacyTypes };
    const metaDigest = `0x${TypedDataUtils.eip712Hash(legacyRaw, SignTypedDataVersion.V4).toString("hex")}`;
    // Viem is unaffected (it infers the domain type) — MetaMask is not.
    expect(viemDigest).toBe(GOLDEN_COMPAT_DIGEST);
    expect(metaDigest).not.toBe(GOLDEN_COMPAT_DIGEST);
  });
});

describe("cross-library sign/recover", () => {
  const key = TEST_OWNER_PRIVATE_KEY as `0x${string}`;
  const expected = privateKeyToAccount(key).address.toLowerCase();

  it("MetaMask eth-sig-util signs → viem recovers the key address", async () => {
    const raw = rawJson(canonical());
    const signature = signTypedData({
      privateKey: Buffer.from(key.slice(2), "hex"),
      data: raw,
      version: SignTypedDataVersion.V4,
    });
    const typed = canonical();
    const recovered = await recoverTypedDataAddress({
      domain: { ...typed.domain },
      types: typed.types,
      primaryType: typed.primaryType,
      message: { ...typed.message },
      signature: signature as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(expected);
  });

  it("viem signs → MetaMask eth-sig-util V4 recovers the key address", async () => {
    const account = privateKeyToAccount(key);
    const typed = canonical();
    const signature = await account.signTypedData({
      domain: { ...typed.domain },
      types: typed.types,
      primaryType: "CompanyWalletRegistration",
      message: { ...typed.message },
    });
    const recovered = recoverTypedSignature({
      data: rawJson(canonical()),
      signature,
      version: SignTypedDataVersion.V4,
    });
    expect(recovered.toLowerCase()).toBe(expected);
  });
});

describe("raw RPC payload to MetaMask", () => {
  it("mock receives eth_signTypedData_v4 with canonical JSON carrying EIP712Domain", async () => {
    const seen: { method: string; params: unknown }[] = [];
    const provider = {
      async request({ method, params }: { method: string; params?: unknown }) {
        seen.push({ method, params });
        return "0x" + "ab".repeat(65);
      },
    } as InjectedProvider;
    const account = "0x85520000000000000000000000000000000094a33";
    const res = await signCompanyWalletTypedDataDetailed(provider, account, canonical());
    expect("signature" in res).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("eth_signTypedData_v4");
    const params = seen[0].params as [string, string];
    expect(params[0]).toBe(account);
    const payload = JSON.parse(params[1]) as CompanyWalletTypedData;
    expect(payload.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ]);
    expect(payload.domain.chainId).toBe(5042);
    expect(payload.primaryType).toBe("CompanyWalletRegistration");
    expect(params[1]).toBe(JSON.stringify(canonical()));
  });
});
