import { privateKeyToAccount } from "viem/accounts";
import { buildCompanyWalletMessage } from "@/lib/wallet";
import { normalizeAddress } from "@/server/chain/arc";
import { registerCompanyWallet, type FundingDeps } from "@/server/services/fundings";

/**
 * Shared signing fixture for company-wallet registration tests.
 *
 * Registration requires a real ownership signature (no pasted addresses),
 * so tests sign with a well-known throwaway dev key (Anvil default #0 —
 * public, unfunded, never mainnet). Nothing here touches a real wallet.
 */
export const TEST_OWNER_PRIVATE_KEY =
  "0x96d8b4d4a3d1e17a76d1c8114237cc46fb89196fe4db85aae2f9f14c8ba560d7" as const;

export function testOwnerAccount() {
  return privateKeyToAccount(TEST_OWNER_PRIVATE_KEY);
}

/** Sign the canonical registration challenge for (workspaceId, address). */
export async function signWalletRegistration(workspaceId: string, address: string, privateKey: string = TEST_OWNER_PRIVATE_KEY) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const normalized = normalizeAddress(address);
  const message = buildCompanyWalletMessage(workspaceId, normalized);
  const signature = await account.signMessage({ message });
  return { address, normalized, message, signature };
}

/**
 * Register a workspace wallet with a valid ownership signature.
 * Defaults to the fixture key/address pair; pass address (any case) and
 * the signature is computed over the normalized form, like the server.
 */
export async function registerTestWallet(
  deps: FundingDeps,
  params: { workspaceId: string; userId: string; address?: string; privateKey?: string; confirmChange?: boolean },
) {
  const key = params.privateKey ?? TEST_OWNER_PRIVATE_KEY;
  const account = privateKeyToAccount(key as `0x${string}`);
  const address = params.address ?? account.address;
  const { signature } = await signWalletRegistration(params.workspaceId, address, key);
  return registerCompanyWallet(deps, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    address,
    signature,
    ...(params.confirmChange !== undefined ? { confirmChange: params.confirmChange } : {}),
  });
}
