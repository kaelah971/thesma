import { privateKeyToAccount } from "viem/accounts";
import { buildCompanyWalletTypedData } from "@/lib/wallet";
import {
  issueCompanyWalletChallenge,
  proveCompanyWalletChallenge,
  registerCompanyWallet,
  type FundingDeps,
} from "@/server/services/fundings";
import { createMemoryCompanyWalletChallengeStore } from "@/server/services/companyWalletChallenges";

/**
 * Signing fixtures for recovered-signer company-wallet registration.
 *
 * Flow: issue workspace-bound challenge → sign typed data with a throwaway
 * dev key → prove (server recovers the ACTUAL signer) → confirm (registers
 * ONLY the recovered signer; the client never sends an address). Always
 * uses an in-memory challenge store — never touches a real database.
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
  params: { workspaceId: string; userId: string; privateKey?: string },
) {
  ensureMemoryChallenges(deps);
  const key = (params.privateKey ?? TEST_OWNER_PRIVATE_KEY) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const ch = await issueCompanyWalletChallenge(deps, { workspaceId: params.workspaceId, userId: params.userId });
  const expected = buildCompanyWalletTypedData({
    workspaceId: params.workspaceId,
    nonce: ch.nonce,
    issuedAt: ch.issuedAt,
    expiresAt: ch.expiresAt,
  });
  if (JSON.stringify(ch.typedData) !== JSON.stringify(expected)) {
    throw new Error("typed-data schema drift between server and client builder");
  }
  const signature = await account.signTypedData({
    domain: { ...ch.typedData.domain },
    types: ch.typedData.types,
    primaryType: "CompanyWalletRegistration",
    message: { ...ch.typedData.message },
  });
  return { nonce: ch.nonce, signature, typedData: ch.typedData };
}

/** Full client flow: issue → sign → prove → confirm. Returns the registration. */
export async function registerTestWallet(
  deps: FundingDeps,
  params: { workspaceId: string; userId: string; privateKey?: string; confirmChange?: boolean },
) {
  ensureMemoryChallenges(deps);
  const signed = await signWalletRegistration(deps, params);
  const proved = await proveCompanyWalletChallenge(deps, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    nonce: signed.nonce,
    signature: signed.signature,
  });
  return {
    ...(await registerCompanyWallet(deps, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      nonce: signed.nonce,
      ...(params.confirmChange !== undefined ? { confirmChange: params.confirmChange } : {}),
    })),
    provedWallet: proved.provedWallet,
  };
}
