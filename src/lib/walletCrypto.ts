/**
 * Client-safe EIP-712 helpers (viem-based). Kept separate from lib/wallet so
 * the dependency-free discovery helper stays tiny for browser smoke bundles.
 */
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import {
  COMPANY_WALLET_DOMAIN,
  COMPANY_WALLET_REGISTRATION_TYPES,
  type CompanyWalletTypedData,
} from "./wallet";

function eip712Params(typedData: CompanyWalletTypedData) {
  return {
    domain: { ...COMPANY_WALLET_DOMAIN },
    types: COMPANY_WALLET_REGISTRATION_TYPES,
    primaryType: "CompanyWalletRegistration" as const,
    message: { ...typedData.message },
  };
}

/** EIP-712 digest of the exact payload MetaMask is asked to sign. */
export function hashCompanyWalletTypedData(typedData: CompanyWalletTypedData): Hex {
  return hashTypedData(eip712Params(typedData));
}

/** Recovers the actual signer of a registration signature (diagnostic + prove parity). */
export async function recoverCompanyWalletSigner(
  typedData: CompanyWalletTypedData,
  signature: string,
): Promise<string> {
  return recoverTypedDataAddress({ ...eip712Params(typedData), signature: signature as Hex });
}
