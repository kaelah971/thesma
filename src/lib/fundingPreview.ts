/**
 * Failure-contained funding-preview normalization plus the read-only
 * USDC balance preflight. Client+node safe; viem only (already a
 * production dependency) — no wagmi, ethers, or new wallet framework.
 *
 * The prepare endpoint historically returned a SHORTER shape than the
 * resume endpoint (no `completed`, no `confirmReady`, typed as if
 * present) — feeding that DTO straight into preview state crashed the
 * whole route on first render (`completed.length` of undefined).
 * Every consumer MUST normalize through here: missing or malformed
 * fields degrade to a safe empty preview, never a throw.
 *
 * Balance reads are eth_call only: no approval, no signature, no
 * transaction, no funding-intent creation, no store access.
 */
import { encodeFunctionData, type Address } from "viem";
import type { InjectedProvider } from "./wallet";

export type PreviewPurpose = "create-campaign" | "approve-usdc" | "fund-campaign";

export interface PreviewAction {
  purpose: PreviewPurpose;
  chainId: number;
  to: string;
  data: string;
  value: string;
  expectedSender: string;
  expectedAmountMicroUsdc?: string;
}

export interface FundingPreview {
  actions: PreviewAction[];
  completed: PreviewPurpose[];
  confirmReady: boolean;
}

const PURPOSES: ReadonlySet<string> = new Set(["create-campaign", "approve-usdc", "fund-campaign"]);

function isPreviewAction(value: unknown): value is PreviewAction {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.purpose === "string" &&
    PURPOSES.has(a.purpose) &&
    typeof a.chainId === "number" &&
    typeof a.to === "string" &&
    typeof a.data === "string" &&
    typeof a.value === "string" &&
    typeof a.expectedSender === "string" &&
    (a.expectedAmountMicroUsdc === undefined || typeof a.expectedAmountMicroUsdc === "string")
  );
}

/**
 * Normalize any prepare/resume DTO (or garbage) into a render-safe
 * preview. Never throws; never returns undefined fields.
 */
export function normalizeFundingPreview(data: unknown): FundingPreview {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const actions = Array.isArray(d.actions) ? d.actions.filter(isPreviewAction) : [];
  const completed = Array.isArray(d.completed)
    ? d.completed.filter((c): c is PreviewPurpose => typeof c === "string" && PURPOSES.has(c))
    : [];
  return { actions, completed, confirmReady: d.confirmReady === true };
}

/** Render-safe message for a preview failure. Never returns an object. */
export function previewErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && typeof err.message === "string" && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}

/* ---------------- USDC balance preflight (read-only) ---------------- */

/** Minimal ERC-20 balanceOf ABI: lean client bundle, no full ERC-20 import. */
const BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

/** balanceOf(address) selector prefix, for assertions and the smoke mock. */
export const BALANCE_OF_SELECTOR = "0x70a08231";

export type BalanceVerdict =
  | { status: "SUFFICIENT"; shortfallMicro: 0n }
  | { status: "INSUFFICIENT"; shortfallMicro: bigint };

/**
 * Pure funds comparison in micro-USDC. Exact bigint arithmetic — a 1-micro
 * dust shortfall is still INSUFFICIENT. Never throws.
 */
export function evaluateBalance(balanceMicro: bigint, requiredMicro: bigint): BalanceVerdict {
  if (balanceMicro >= requiredMicro) return { status: "SUFFICIENT", shortfallMicro: 0n };
  return { status: "INSUFFICIENT", shortfallMicro: requiredMicro - balanceMicro };
}

/**
 * Parse an eth_call uint256 response. Any non-hex/garbage outcome is null
 * (read failure) — never confused with a 0 balance.
 */
export function parseBalanceHex(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Build the eth_call payload for balanceOf(account) on the USDC contract. */
export function buildBalanceOfCall(usdcAddress: string, account: string): { to: string; data: `0x${string}` } {
  return {
    to: usdcAddress,
    data: encodeFunctionData({
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [account as Address],
    }),
  };
}

export type BalanceReadResult = { ok: true; balanceMicro: bigint } | { ok: false };

/**
 * Read-only USDC balance for the EXACT connected account on the EXACT
 * expected chain. Verifies eth_chainId first and fails closed on any
 * mismatch, RPC error, or malformed response. Only eth_chainId + eth_call
 * are ever requested — never eth_sendTransaction, never any signing.
 */
export async function readUsdcBalanceMicro(
  provider: InjectedProvider,
  params: { usdcAddress: string; account: string; chainId: number },
): Promise<BalanceReadResult> {
  try {
    if (!provider || typeof provider.request !== "function") return { ok: false };
    if (!params.usdcAddress || !params.account) return { ok: false };
    const chainHex = (await provider.request({ method: "eth_chainId" }).catch(() => null)) as unknown;
    const expectedHex = `0x${params.chainId.toString(16)}`;
    if (typeof chainHex !== "string" || chainHex.toLowerCase() !== expectedHex.toLowerCase()) {
      return { ok: false };
    }
    const call = buildBalanceOfCall(params.usdcAddress, params.account);
    const raw = (await provider.request({ method: "eth_call", params: [call, "latest"] }).catch(() => null)) as unknown;
    const parsed = parseBalanceHex(raw);
    if (parsed === null || parsed < 0n) return { ok: false };
    return { ok: true, balanceMicro: parsed };
  } catch {
    return { ok: false };
  }
}
