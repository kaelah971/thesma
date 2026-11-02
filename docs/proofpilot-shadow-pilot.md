# ProofPilot production Shadow pilot

## Status

- Date: 2026-11-02
- **BLOCKED — production authenticated access was not available in this session.**

This document is the bounded proof artifact and runbook for the first real production software pilot. It does not claim that the pilot was executed.

- Environment: production software / Shadow financial mode
- Project: ProofPilot Labs — **not resolved in this session**
- Program: ProofPilot Partner Growth — **not created in this session**
- Integration: ProofPilot Production — **not created or reused in this session**
- Participant: ProofPilot Pilot Partner — **not created in this session**
- Event: `proofpilot_shadow_pilot_001` — **not submitted in this session**

## Why execution stopped

The agent session has no production `DATABASE_URL`, Vercel/Neon access, authenticated ProofPilot session, or `ths_api_` key. The production health endpoint is reachable and reports `checks.db: ok`, but authenticated developer records cannot be inspected or mutated safely without those credentials.

A read-only request to the public ProofPilot program endpoint currently returns HTTP 500, so it is not safe to infer that the production schema or program exists. No migration, account, program, participant, integration, attribution identity, event or receipt was created.

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

A read-only checker is available at `scripts/review-production-growth-migrations.ts`. It requires a locally supplied production `DATABASE_URL`, prints only a sanitized host/database summary, performs no writes, and reports missing/present/conflicting tables, columns, indexes and constraints.

**Production migration status: NOT APPLIED.** The historical Drizzle migration journal remains untrusted and was not modified.

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

Provide temporary authenticated ProofPilot access and a reviewed production database connection through the existing secure deployment process. Then run the read-only schema checker first, manually apply only missing migration objects in dependency order, and execute the proof client once.
