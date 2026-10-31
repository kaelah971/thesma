import { privateKeyToAccount } from "viem/accounts";
import { buildCompanyWalletTypedData } from "@/lib/wallet";
import { normalizeAddress } from "@/server/chain/arc";
import {
  issueCompanyWalletChallenge,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";

/**
 * Signing fixtures for company-wallet registration tests.
 *
 * Registration requires a server-issued challenge + EIP-712 signature, so
 * this helper performs the full client flow: challenge → canonical
 * typed-data build (byte-checked like the UI) → viem signTypedData →
 * register. Always uses an in-memory challenge store — never touches a
 * real database. Keys are throwaway dev keys, never mainnet keys.
 */
export const TEST_OWNER_PRIVATE_KEY =
  "0x96d8b4d4a3d1e17a76d1c8114237cc46fb89196fe4db85aae2f9f14c8ba560d7" as const;

export function testOwnerAccount() {
  return privateKeyToAccount(TEST_OWNER_PRIVATE_KEY);
}

function ensureMemoryChallenges(deps: FundingDeps) {
  if (!deps.challenges) deps.challenges = createMemoryCompanyWalletChallengeStore();
  return deps.challenges;
}

/** Issue a challenge and sign its typed data (mirrors the client exactly). */
export async function signWalletRegistration(
  deps: FundingDeps,
  params: { workspaceId: string; userId: string; address: string; privateKey?: string },
) {
  ensureMemoryChallenges(deps);
  const key = (params.privateKey ?? TEST_OWNER_PRIVATE_KEY) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const normalized = normalizeAddress(params.address);
  const ch = await issueCompanyWalletChallenge(deps, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address: normalized,
  });
  const expected = buildCompanyWalletTypedData({
    workspaceId: params.workspaceId,
    wallet: normalized,
    nonce: ch.nonce,
    issuedAt: ch.issuedAt,
    expiresAt: ch.expiresAt,
  });
  if (JSON.stringify(ch.typedData) !== JSON.stringify(expected)) {
    throw new Error("typed-data schema drift between server and client builder");
  }
  const signature = await account.signTypedData({
    domain: { ...expected.domain },
    types: expected.types,
    primaryType: "CompanyWalletRegistration",
    message: { ...expected.message },
  });
  return { address: params.address, normalized, nonce: ch.nonce, signature, typedData: ch.typedData };
}

/**
 * Full client flow with ownership proof. Defaults to the fixture keypair;
 * pass address (any case) and the signature is computed over the normalized
 * form, exactly like production.
 */
export async function registerTestWallet(
  deps: FundingDeps,
  params: { workspaceId: string; userId: string; address?: string; privateKey?: string; confirmChange?: boolean },
) {
  ensureMemoryChallenges(deps);
  const key = (params.privateKey ?? TEST_OWNER_PRIVATE_KEY) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const address = params.address ?? account.address;
  const { nonce, signature } = await signWalletRegistration(deps, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address,
    privateKey: key,
  });
  return registerCompanyWallet(deps, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address,
    nonce,
    signature,
    ...(params.confirmChange !== undefined ? { confirmChange: params.confirmChange } : {}),
  });
}
