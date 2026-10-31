/**
 * Zero-login public proof funnel: canonical chain facts + link builders.
 *
 * All values are repo truth — docs/mainnet-proof.md (S8.2 full mainnet
 * proof) and the production database. Never invent addresses or hashes
 * here; unproven claims stay off the page.
 *
 * Pure + client-safe: no framework, env, or database imports, so unit
 * tests and server components share the exact same builders the page
 * renders with.
 */

import { ARC_MAINNET_CHAIN_ID } from "@/server/chain/arc";

export { ARC_MAINNET_CHAIN_ID };

/** Canonical demo: Aster Media — the clearest complete FUNDED → SETTLED lifecycle. */
export const DEMO_CAMPAIGN_ID = "5571f328-ceeb-4712-8671-a72be1966ffb";
/** Second completed proof, linked from the demo as further reading. */
export const BEACONFIELD_CAMPAIGN_ID = "dcec0b71-2a4d-496c-b573-6999d09c8cb2";

/** ThesmaMarketVault, canonical and unchanged (docs/mainnet-proof.md). */
export const THESMA_VAULT_ADDRESS = "0x0fA826256a58F19Ad24Fc9384d81D313f2266F79";

/** Arc Mainnet explorer fallback (docs truth). Runtime env may override. */
export const ARC_EXPLORER_FALLBACK = "https://explorer.arc.io";

export function explorerBaseUrl(): string {
  const raw = process.env.ARC_EXPLORER_BASE_URL?.trim();
  return (raw ? raw : ARC_EXPLORER_FALLBACK).replace(/\/$/, "");
}

export function txExplorerUrl(txHash: string, base?: string): string {
  return `${base ?? explorerBaseUrl()}/tx/${txHash}`;
}

export function addressExplorerUrl(address: string, base?: string): string {
  return `${base ?? explorerBaseUrl()}/address/${address}`;
}

/**
 * Sourcify exact-match verification, proven 2026-10-22 (docs/mainnet-proof.md).
 * This is the ONLY source-verification claim the repo has proven — do not
 * present Blockscout as a verifier, only as the address/tx viewer.
 */
export function sourcifyContractUrl(address: string = THESMA_VAULT_ADDRESS): string {
  return `https://sourcify.dev/server/v2/contract/${ARC_MAINNET_CHAIN_ID}/${address}`;
}

/* ---------------- Demo payload (public-safe projection) ---------------- */

/**
 * Narrow public-safe projection of the market detail DTO for the guided
 * demo. Every key is allowlisted: funding / purchase / proof / payout
 * evidence plus the display fields the walkthrough renders. Anything not
 * listed here (policy JSON, secrets, customer PII, internal terms) can
 * never reach the demo page, even if the upstream DTO grows.
 */
const DEMO_KEYS = [
  "campaignId",
  "workspaceName",
  "category",
  "state",
  "marketStatus",
  "objective",
  "qualificationRule",
  "approvedBudgetMicroUsdc",
  "publicBountyMicroUsdc",
  "deadline",
  "startedAt",
  "verifiedOutcomes",
  "holdSeconds",
  "funding",
  "purchaseTxs",
  "outcomeProofs",
  "payouts",
  "settledPayoutTotalMicroUsdc",
  "verifiedRevenueMicroUsdc",
  "realizedCacMicroUsdc",
  "completionReason",
] as const;

export type DemoPayload = Record<(typeof DEMO_KEYS)[number], unknown> & {
  kind: "completed";
};

export function buildDemoPayload(detail: Record<string, unknown>): DemoPayload {
  if (detail.kind !== "completed") {
    throw new Error("Demo requires a completed campaign with settled truth");
  }
  const out: Record<string, unknown> = { kind: "completed" };
  for (const k of DEMO_KEYS) out[k] = detail[k] ?? null;
  return out as DemoPayload;
}

export function demoPayloadKeys(): readonly string[] {
  return DEMO_KEYS;
}

/**
 * Markets empty-state rule: when nothing is live but completed proof
 * exists, completed markets render FIRST with only a compact live notice.
 * The "no live markets" fact stays visible — it just stops occupying the
 * valuable region.
 */
export function shouldPromoteCompleted(liveCount: number, completedCount: number): boolean {
  return liveCount === 0 && completedCount > 0;
}
