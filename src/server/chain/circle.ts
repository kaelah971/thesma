import { getAddress } from "viem";
import { createRequire } from "node:module";

// The Circle SDK ships minified CJS whose named exports tsx's ESM loader
// cannot statically link. Loading it through require() works identically
// under tsx, vitest, and the Next.js server runtime.
const circleRequire = createRequire(import.meta.url);
const { CircleDeveloperControlledWalletsClient } = circleRequire("@circle-fin/developer-controlled-wallets") as {
  CircleDeveloperControlledWalletsClient: new (config: { apiKey: string; entitySecret: string; baseUrl?: string }) => unknown;
};

/**
 * THESMA VERIFICATION BUYER WALLET — Circle Developer-Controlled Wallet.
 *
 * Server-only. Dedicated to verification procurement on Arc Testnet.
 * This is NOT the Northstar company wallet, NOT the mainnet executor,
 * NOT the verifier, and NOT the campaign vault. No private key material
 * ever exists in Thesma; Circle holds the key and signs remotely.
 *
 * Replay safety: the SDK's signMessage surface accepts no caller-supplied
 * idempotency key, so replay protection lives one layer up, where it
 * belongs — the procurement dedupe gate (requestFingerprint) rejects
 * already-seen logical purchases, and the atomic APPROVED→… state gate
 * admits exactly one signer per procurement row. A stable UUID v4 derived
 * from the dedupe key is attached to the approval audit record so any
 * logical purchase is traceable to one idempotency identity.
 */

export const CIRCLE_EXPECTED_BLOCKCHAIN = "ARC-TESTNET";

export interface CircleVerificationConfig {
  apiKey: string;
  entitySecret: string;
  walletId: string;
  expectedAddress: string | null;
}

/** Minimal structural surface we use — the real SDK client satisfies it. */
export interface CircleClientLike {
  getWallet: (input: { id: string }) => Promise<{ data?: { wallet?: { address?: string; blockchain?: string } } }>;
  signMessage: (input: { walletId: string; message: string }) => Promise<{ data?: { signature?: unknown } }>;
  signTypedData?: (input: { walletId: string; data: string }) => Promise<{ data?: { signature?: unknown } }>;
  getWalletsWithBalances: (input: { address?: string; blockchain?: string; tokenAddress?: string }) => Promise<{ data?: unknown }>;
}

export interface CircleVerificationBuyer {
  address: string;
  blockchain: string;
  walletId: string;
  /** Legacy EIP-191 message signer (local-test compatibility). */
  sign: (message: string) => Promise<`0x${string}`>;
  /** Standard EIP-712 signer used by live x402 EVM exact providers. */
  signTypedData?: (typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<`0x${string}`>;
  /** Canonical ERC-20 testnet USDC balance (micro-USDC, read-only eth_call). Fails closed without an RPC source. */
  usdcBalanceMicro: (
    usdcAddress: string,
    opts?: {
      /** Testnet RPC URL for the eth_call. Required unless readContract is injected (tests). */
      rpcUrl?: string;
      /** Injected balance reader (tests only; must return micro-USDC). */
      readContract?: (token: `0x${string}`, account: `0x${string}`) => Promise<bigint>;
    },
  ) => Promise<bigint>;
}

/** Present only when all three server-only values are configured. */
export function getCircleVerificationConfig(env: NodeJS.ProcessEnv = process.env): CircleVerificationConfig | null {
  const apiKey = (env.CIRCLE_API_KEY ?? "").trim();
  const entitySecret = (env.CIRCLE_ENTITY_SECRET ?? "").trim();
  const walletId = (env.CIRCLE_VERIFICATION_WALLET_ID ?? "").trim();
  if (!apiKey || !entitySecret || !walletId) return null;
  const expected = (env.CIRCLE_VERIFICATION_WALLET_ADDRESS ?? "").trim();
  return { apiKey, entitySecret, walletId, expectedAddress: expected || null };
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

function asChecksum(address: string, what: string): string {
  try {
    return getAddress(address);
  } catch {
    throw fail(503, "CIRCLE_MISCONFIGURED", `${what} is not a valid EVM address.`);
  }
}

function asCircleClient(client: unknown): CircleClientLike {
  const c = client as Partial<CircleClientLike>;
  if (!c || typeof c.getWallet !== "function" || typeof c.signMessage !== "function") {
    throw fail(503, "CIRCLE_MISCONFIGURED", "Circle client does not expose the required wallet surface.");
  }
  return c as CircleClientLike;
}

/**
 * Build the dedicated testnet buyer. Verifies on first use:
 * - wallet exists and lives on ARC-TESTNET (anything else fails closed),
 * - wallet address matches CIRCLE_VERIFICATION_WALLET_ADDRESS when set.
 * `client` is a test seam (fake, no network); default is the real SDK.
 */
export async function createCircleVerificationBuyer(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { client?: unknown },
): Promise<CircleVerificationBuyer> {
  const cfg = getCircleVerificationConfig(env);
  if (!cfg) {
    throw fail(503, "CIRCLE_NOT_CONFIGURED", "Circle verification buyer is not configured (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_VERIFICATION_WALLET_ID).");
  }
  const client = opts?.client !== undefined
    ? asCircleClient(opts.client)
    : asCircleClient(new CircleDeveloperControlledWalletsClient({ apiKey: cfg.apiKey, entitySecret: cfg.entitySecret }));
  let wallet: { address?: string; blockchain?: string };
  try {
    const res = await client.getWallet({ id: cfg.walletId });
    wallet = res?.data?.wallet ?? {};
  } catch (e) {
    throw fail(503, "CIRCLE_WALLET_UNAVAILABLE", `Could not load Circle verification wallet: ${(e as Error).message}`);
  }
  const address = asChecksum(String(wallet.address ?? ""), "Circle verification wallet address");
  const blockchain = String(wallet.blockchain ?? "");
  if (blockchain.toUpperCase() !== CIRCLE_EXPECTED_BLOCKCHAIN) {
    throw fail(503, "CIRCLE_WRONG_NETWORK", `Circle verification wallet must live on ${CIRCLE_EXPECTED_BLOCKCHAIN}.`);
  }
  if (cfg.expectedAddress && getAddress(cfg.expectedAddress) !== address) {
    throw fail(503, "CIRCLE_MISCONFIGURED", "Circle verification wallet does not match CIRCLE_VERIFICATION_WALLET_ADDRESS.");
  }
  const buyer: CircleVerificationBuyer = {
    address,
    blockchain,
    walletId: cfg.walletId,
    sign: async (message: string) => {
      let sig: unknown;
      try {
        const res = await client.signMessage({ walletId: cfg.walletId, message });
        sig = res?.data?.signature;
      } catch (e) {
        throw fail(500, "CIRCLE_SIGNING_FAILED", `Circle signing failed: ${(e as Error).message}`);
      }
      if (typeof sig !== "string" || !sig.startsWith("0x")) {
        throw fail(500, "CIRCLE_SIGNING_FAILED", "Circle returned an unusable signature.");
      }
      return sig as `0x${string}`;
    },
    usdcBalanceMicro: async (usdcAddress: string, opts?: { rpcUrl?: string; readContract?: (token: `0x${string}`, account: `0x${string}`) => Promise<bigint> }) => {
      const token = asChecksum(usdcAddress, "USDC address");
      const account = address as `0x${string}`;
      try {
        if (opts?.readContract) return await opts.readContract(token as `0x${string}`, account);
        if (opts?.rpcUrl) {
          const { createPublicClient, http, parseAbiItem } = await import("viem");
          const rpc = createPublicClient({ transport: http(opts.rpcUrl) });
          return (await rpc.readContract({
            address: token as `0x${string}`,
            abi: [parseAbiItem("function balanceOf(address account) view returns (uint256)")],
            functionName: "balanceOf",
            args: [account],
          })) as bigint;
        }
      } catch (e) {
        throw fail(503, "CIRCLE_BALANCE_UNAVAILABLE", `USDC balance read failed: ${(e as Error).message}`);
      }
      throw fail(503, "CIRCLE_BALANCE_UNAVAILABLE", "No RPC configured for the USDC balance read.");
    },
  };
  if (typeof client.signTypedData === "function") {
    buyer.signTypedData = async (typedData) => {
      let sig: unknown;
      try {
        const dataTyped = typedData.types.EIP712Domain
          ? typedData
          : {
              ...typedData,
              types: {
                EIP712Domain: Object.keys(typedData.domain).map((name) => ({
                  name,
                  type: name === "chainId" ? "uint256" : name === "verifyingContract" ? "address" : "string",
                })),
                ...typedData.types,
              },
            };
        const data = JSON.stringify(dataTyped, (_key, value) => typeof value === "bigint" ? value.toString() : value);
        const res = await client.signTypedData!({ walletId: cfg.walletId, data });
        sig = res?.data?.signature;
      } catch (e) {
        throw fail(500, "CIRCLE_SIGNING_FAILED", `Circle typed-data signing failed: ${(e as Error).message}`);
      }
      if (typeof sig !== "string" || !sig.startsWith("0x")) {
        throw fail(500, "CIRCLE_SIGNING_FAILED", "Circle returned an unusable typed-data signature.");
      }
      return sig as `0x${string}`;
    };
  }
  return buyer;
}

