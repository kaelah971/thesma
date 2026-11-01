import { getAddress } from "viem";
import * as CircleSDK from "@circle-fin/developer-controlled-wallets";

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
  getWalletsWithBalances: (input: { address?: string; blockchain?: string; tokenAddress?: string }) => Promise<{ data?: unknown }>;
}

export interface CircleVerificationBuyer {
  address: string;
  blockchain: string;
  walletId: string;
  /** EIP-191 message signer for x402 payment proofs. No key material here. */
  sign: (message: string) => Promise<`0x${string}`>;
  /** Canonical testnet USDC balance of the buyer wallet (read-only). */
  usdcBalanceMicro: (usdcAddress: string) => Promise<bigint>;
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
    : asCircleClient(new CircleSDK.CircleDeveloperControlledWalletsClient({ apiKey: cfg.apiKey, entitySecret: cfg.entitySecret }));
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
  return {
    address,
    blockchain,
    walletId: cfg.walletId,
    sign: async (message: string) => {
      let sig: unknown;
      try {
        // The SDK sign-message surface takes no idempotency key; replay
        // safety is enforced by the procurement dedupe + state gates.
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
    usdcBalanceMicro: async (usdcAddress: string) => {
      const token = asChecksum(usdcAddress, "USDC address");
      if (typeof client.getWalletsWithBalances !== "function") {
        throw fail(503, "CIRCLE_BALANCE_UNAVAILABLE", "Circle client cannot list wallet balances.");
      }
      let wallets: Array<Record<string, unknown>>;
      try {
        const res = await client.getWalletsWithBalances({ address, blockchain: CIRCLE_EXPECTED_BLOCKCHAIN, tokenAddress: token });
        const data = (res?.data ?? {}) as { wallets?: unknown[] };
        wallets = Array.isArray(data.wallets) ? (data.wallets as Array<Record<string, unknown>>) : [];
      } catch (e) {
        throw fail(503, "CIRCLE_BALANCE_UNAVAILABLE", `Could not read Circle wallet balances: ${(e as Error).message}`);
      }
      const row = wallets.find((w) => String((w as Record<string, unknown>).address ?? (w as Record<string, unknown>).id ?? "").toLowerCase() === address.toLowerCase());
      const balances = Array.isArray((row ?? {})?.tokenBalances) ? ((row as Record<string, unknown>).tokenBalances as Array<Record<string, unknown>>) : [];
      const entry = balances.find((b) => String(b.tokenAddress ?? b.contractAddress ?? "").toLowerCase() === token.toLowerCase());
      const amount = entry?.amount ?? entry?.balance;
      if (amount === undefined || amount === null) return 0n;
      try {
        const v = BigInt(String(amount));
        return v >= 0n ? v : 0n;
      } catch {
        throw fail(503, "CIRCLE_BALANCE_UNAVAILABLE", "Circle returned an unparseable USDC balance.");
      }
    },
  };
}

