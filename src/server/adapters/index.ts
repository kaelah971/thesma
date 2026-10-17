/**
 * Adapter boundaries. S2 implements the Arc chain boundary for real
 * (see src/server/chain/arc.ts + keys.ts); the remaining entries stay as
 * documented stubs so domain code never imports a wallet/AI SDK directly.
 *
 * TARGET (not shipped):
 * - Arc RPC + wallet adapter      -> src/server/adapters/arc.ts
 * - ThesmaMarketVault contract    -> contracts/ + executor adapter
 * - Demand/Supply agent runtime   -> src/server/services/agents/* (S6/S7)
 * - Policy engine                 -> src/server/services/policy/* (S1)
 * - Market-state service          -> S3
 * - Verifier                      -> S4
 * - Executor/reconciliation       -> S5
 *
 * Rule: agent models NEVER receive raw private keys and NEVER write
 * directly to chain. All financial writes go through typed tools +
 * policy revalidation at execution time (PRD 4.2).
 */

export const ADAPTER_BOUNDARIES = [
  "arc-rpc",
  "wallet",
  "vault-executor",
  "policy-engine",
  "market-state",
  "verifier",
  "agent-runtime",
] as const;
