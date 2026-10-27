# Thesma Integration Readiness (Slice 10 preparation — Slice 9)

This document inventories what Slice 10 must handle. NOTHING here activates
anything: no migrations applied, no deployment, no funding, no real providers.

## Migration journal risk (READ FIRST)

Drizzle migrations live in `drizzle/*.sql` with the journal at
`drizzle/meta/_journal.json` (idx 0–17). Production status is UNKNOWN from
this repo: the code cannot see the production database.

Before Slice 10 applies anything, it MUST inspect the production
`__drizzle_migrations` table (or the drizzle journal table in use) and
confirm exactly which idx entries are already recorded:

- idx 0–13: foundation → Scout (assumed applied; VERIFY, do not assume).
- idx 14 (`0014_creator_capability`): user_personas capability columns. NOT applied to prod (Slices 1–9 dev only).
- idx 15 (`0015_creator_invitations`): campaign_creator_invitations table. NOT applied to prod.
- idx 16 (`0016_cuddly_selene`): hybrid_deals + milestone_awards. Hand-trimmed to new tables only (see STATE.md Slice 6). NOT applied to prod.
- idx 17 (`0017_outstanding_misty_knight`): verification_procurements + verification_procurement_policies. NOT applied to prod.

Risks:
- A gap between journal idx and `__drizzle_migrations` rows means drizzle-kit will try to apply (or skip) the wrong files. Reconcile by hash, not by faith.
- 0016 was hand-trimmed; its snapshot (0016_snapshot.json) reflects full schema. If a future `drizzle-kit generate` diffs against it, confirm no phantom diffs before generating 0018+.
- Never run `drizzle-kit push` against production; use versioned `migrate` only, with a backup first.

## Required production env

Core (existing): DATABASE_URL, SESSION_COOKIE_NAME, NODE_ENV=production,
ATTRIBUTION_SECRET, ARC_NETWORK (+ ARC_RPC_URL / ARC_CHAIN_ID / ARC_USDC_ADDRESS /
ARC_EXPLORER_BASE_URL or the ARC_TESTNET_* set), THESMA_VAULT_ADDRESS,
THESMA_VERIFIER_ADDRESS, THESMA_VERIFIER_PRIVATE_KEY, THESMA_EXECUTOR_ADDRESS,
THESMA_EXECUTOR_PRIVATE_KEY, CRON_SECRET / SCOUT_WORKER_SECRET / payout + verifier
internal secrets (see Slice 0–5 notes).

Slice 8 additions (only if verification procurement is activated):
- THESMA_PROCUREMENT_PRIVATE_KEY (server-side only, never logged, never committed)
- THESMA_PROCUREMENT_ADDRESS (must derive from the key or startup fails closed)
- THESMA_VERIFICATION_PROVIDER_URL (allowlisted https endpoint; absent = CONFIGURATION_REQUIRED)
- THESMA_VERIFICATION_ALLOWED_HOSTS (extra allowlist, comma-separated)
- THESMA_TEST_CHECK_COST_MICRO_USDC (default 80000; test/local only)
- THESMA_ALLOW_TEST_PROVIDERS must be UNSET in production (local x402 test resource refuses prod).

## Capabilities ready (Slices 1–9)

Matching, invitations, inbox accept/decline, agent auto-accept, CFO allocator,
hybrid deals (invitation + milestone + base-review flows), reliability/retention
scoring, verification procurement decision + local-test execution path, unified
autonomy ledger (read-only over auditEvents; no new ledger persistence).

## Known NOT configured

- Real verification provider: no adapter registered beyond `local-test` / `unconfigured`. Real execution returns CONFIGURATION_REQUIRED by design.
- Procurement wallet: no private key provisioned or funded (Slice 10 decision).
- Per-workspace policies ship DISABLED by default (growth optimization, procurement). Activation is an explicit owner action per workspace.

## Known UNSUPPORTED (product truth, not bugs)

- Hybrid base/milestone onchain settlement (vault has no deliverable registry or milestone schedule).
- Cross-campaign onchain fund transfer (vault has per-campaign returnUnspent only; CFO allocations are prospective plans).
- Retention observation beyond canonical VERIFIED trails (no external SaaS hooks).
- x402 provider payload shapes beyond the three v2 headers (adapter-isolated; confirm against the current official spec before mainnet use).

## Production risks

1. Missing `__drizzle_migrations` journal rows → double-apply or skipped migrations (see above).
2. 0014/0015/0016/0017 unapplied → Slice 1–8 code paths that read new tables will 503/fail-closed until migrated (by design: marketDepsOr503 + per-call catches), but the coordinated activation must land code + migrations together (Slice 10).
3. No funded procurement wallet → verification stays NOT_CONFIGURED (safe default).
4. Mainnet x402 interop unproven (local-test only) — do not enable autonomous BUY_CHECK on mainnet without a proven provider adapter + small-cap trial.
5. Follower/vanity metrics: none exist; keep it that way (regression tests assert no social inputs).
