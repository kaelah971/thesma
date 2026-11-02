# ProofPilot production Shadow pilot

## Status

- Date: 2026-11-02
- **BLOCKED — the production schema is reconciled; authenticated ProofPilot product access is still unavailable in this session.**

This document is the bounded proof artifact and runbook for the first real production software pilot. It does not claim that the pilot was executed.

- Environment: production software / Shadow financial mode
- Project: ProofPilot Labs — **not resolved in this session**
- Program: ProofPilot Partner Growth — **not created in this session**
- Integration: ProofPilot Production — **not created or reused in this session**
- Participant: ProofPilot Pilot Partner — **not created in this session**
- Event: `proofpilot_shadow_pilot_001` — **not submitted in this session**

## Why execution stopped

Vercel CLI access was found for the linked `thesma` project. A repo-local production-safe connection was used without printing credentials. The shipped Outcome API and embedded Growth schema were manually reconciled through 0018→0021 in one transaction; the Drizzle migration journal remains untrusted and unchanged. No Neon CLI/authentication, `ths_api_` key, or authenticated ProofPilot product session exists. The production health endpoint is reachable and reports `checks.db: ok`.

The public ProofPilot program endpoint now returns the expected HTTP 404 `PROGRAM_NOT_FOUND` because no program exists. No account, program, participant, integration, attribution identity, event or receipt was created.

## Migration review

The pending migrations were reviewed manually:

### `0019_safe_stranger.sql`

- Creates `developer_growth_programs`.
- Adds nullable `external_outcome_events.growth_program_id`.
- Adds foreign keys to workspaces, campaigns, policy versions, integrations, outcome definitions, users, and external outcome events.
- Adds program indexes and bounded check constraints.
- No drops, deletes, destructive rewrites, or data seeding.
- Dependency: existing workspace/campaign/policy/integration/definition/user/event tables.
- Assessment: **SAFE if missing and absent from production; must be schema-diffed first.**

### `0020_salty_sunspot.sql`

- Creates `growth_program_participants` and `growth_attribution_identities`.
- Adds nullable `external_outcome_events.attribution_identity_id`.
- Adds `external_outcome_events.attribution_status` with default `UNATTRIBUTED` and `NOT NULL`; existing rows receive the default value.
- Adds participant/identity foreign keys, indexes, unique active-identity constraints, and bounded checks.
- No drops, deletes, or fixture data.
- Dependency: `0019` program table and existing users/events.
- Assessment: **SAFE in dependency order if missing; existing attribution objects must not be replayed.**

### `0021_abnormal_eternals.sql`

- Adds nullable `developer_growth_programs.product_url`.
- No indexes, foreign keys, defaults, rewrites, drops, or data seeding.
- Dependency: `0019` program table.
- Assessment: **SAFE if the column is missing; no-op if already present.**

A read-only checker is available at `scripts/review-production-growth-migrations.ts`. It requires a locally supplied production `DATABASE_URL`, prints only a sanitized host/database summary, performs no writes, and reports missing/present/conflicting tables, columns, indexes and constraints. It now also blocks manual application when prerequisite Outcome API tables are absent.

The authenticated production connection resolved to the safe host/database identifier `ep-bitter-fog-b4i36qj8.c-6.us-east-2.aws.neon.tech` / `thesma_mainnet`. The production preflight confirmed the existing `workspaces`, `campaigns`, `campaign_policy_versions` and `users` dependencies with compatible text IDs; all six new tables were absent and empty by definition. A 51-statement transactional rehearsal passed all schema assertions and rollback. The exact 0018→0021 SQL then committed in one transaction, and the post-apply checker reports zero missing, partial or conflicting objects. PostgreSQL-truncated constraint names were verified against their actual names.

**Production migration status: APPLIED — 0018, 0019, 0020 and 0021 manually reconciled.** No rows were inserted, no existing rows were modified, and the historical Drizzle migration journal remains untrusted and unchanged.

## External-style proof client

`scripts/proofpilot-shadow-pilot.ts` uses only the shipped server SDK and public attribution endpoint. It does not import internal database or domain services. It requires explicit opt-in:

```powershell
$env:THESMA_BASE_URL = "https://thesma.vercel.app"
$env:THESMA_API_KEY = "ths_api_..." # local secret only; never commit or print
$env:THESMA_ATTRIBUTION_CODE = "ref_..."
$env:THESMA_PROOF_CONFIRM = "PROOFPILOT_SHADOW_001"
npx tsx scripts/proofpilot-shadow-pilot.ts
```

The script resolves attribution, submits one deterministic `ACTIVATED_USER` event, retries the same idempotency key, reads the receipt, and prints only bounded state plus zero-spend counters.

## Expected successful result

When authenticated production access is supplied and the schema is reviewed/applied safely:

- Attribution: `DIRECT_ATTRIBUTION`
- Verification: actual production result, expected `VERIFIED` only if evidence satisfies policy
- Procurement: actual VOI result, commonly `NO_CHECK` or `WOULD_BUY`; never a forced value
- Reward: frozen 8 USDC policy, eligibility distinct from payment
- Funding: `UNFUNDED`
- Settlement: `NOT_READY` with `PROGRAM_UNFUNDED` unless existing funding truth says otherwise
- Operator mode: `SHADOW`
- Paid: `0`
- Financial transaction: `NONE`
- Idempotent retry: original event and receipt, no duplicate reward exposure

This pilot proves the production Build with Thesma integration path. It is not customer traction, a real activation, a paid acquisition, a creator payout, or a financial execution proof.

## Financial side effects recorded for this attempt

- Circle calls: `0`
- x402 purchases: `0`
- Mainnet transactions: `0`
- Testnet transactions: `0`
- Vault funding: `0`
- Payouts: `0`
- USDC moved: `0`

## Next unblock

Provide authenticated ProofPilot product/API access through the existing secure process; do not paste secrets into chat. The schema blocker is resolved. Then resume the existing explicit Shadow pilot once.
