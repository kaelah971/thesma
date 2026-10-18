# Thesma Arc Mainnet Runbook (S8.2A)

**Scope: provisioning preparation only. No broadcasts, no funds moved, no secrets stored.**
Canonical chain facts: `contracts/deployments/arc-mainnet.json`. Full preflight:
`contracts/deployments/ARC_MAINNET_PREFLIGHT.md`.

## 1. Database readiness

- **Shape:** any Postgres 14+ reachable via a single `DATABASE_URL`
  (local Docker, Neon, Supabase — provider-neutral by design, see `src/server/db/client.ts`).
- **Provider TLS:** Neon/Supabase require TLS — append `?sslmode=require` to
  `DATABASE_URL` (their dashboards document this; no code change needed).
- **Validate connectivity** (read-only, no secrets printed):
  `node --input-type=module -e "import pg from 'pg'; const c = new pg.Client({connectionString: process.env.DATABASE_URL}); await c.connect(); const r = await c.query('select version()'); console.log(r.rows[0].version); await c.end();"`
- **Apply migrations:** `npm run db:migrate` (applies `./drizzle`, currently 0000–0008).
- **Verify tables (expect 23):**
  `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1;`
- **Prove clean for the proof:** every `select count(*) from <table>;` must return 0
  (23 tables: users → supply_commitments). This DB must be fresh — never reuse a
  DB that holds testnet/local rows for the mainnet proof.
- **No destructive reset** is authorized. If the DB is not empty, provision a new
  empty database instead of resetting.

## 2. Runtime env template

### PUBLIC / NON-SECRET (safe to share and store)

| Name | Expected mainnet value |
|---|---|
| `DATABASE_URL` | owner-provisioned Postgres URL (server env only, but not a chain secret) |
| `ARC_RPC_URL` | `https://rpc.mainnet.arc.io` |
| `ARC_CHAIN_ID` | `5042` |
| `ARC_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` |
| `THESMA_VAULT_ADDRESS` | `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79` |
| `THESMA_EXECUTOR_ADDRESS` | owner-provisioned executor address (TBD — see §3) |
| `THESMA_VERIFIER_ADDRESS` | owner-provisioned verifier address (TBD — see §3) |
| `ARC_EXPLORER_BASE_URL` | optional, unset OK |
| `SESSION_COOKIE_NAME` | optional, unset OK |
| `NODE_ENV` | `production` |

### SECRET (server env only — never commit, log, chat, or put in commands)

| Name | Min | Purpose |
|---|---|---|
| `THESMA_VERIFIER_PRIVATE_KEY` | 32-byte hex | EIP-712 outcome proofs (backend signer) |
| `THESMA_EXECUTOR_PRIVATE_KEY` | 32-byte hex | vault payout submission (backend executor) |
| `VERIFIER_INTERNAL_SECRET` | 16 chars | `POST /internal/checkout/:id/verify` bearer |
| `PAYOUT_WORKER_SECRET` | 16 chars | `POST /internal/payouts/*` bearer (falls back to verifier secret) |
| `SUPPLY_AGENT_WORKER_SECRET` | 16 chars | `POST /internal/agents/supply/run` bearer |
| `CRON_SECRET` | 16 chars | Vercel Cron `GET` bearer for `/internal/payouts/process` (daily 06:00 UTC) + `/internal/agents/supply/run` (daily 06:30 UTC, Hobby-compatible); Vercel injects it automatically |
| `ATTRIBUTION_SECRET` | 32 chars | referral attribution HMAC |

Missing/short secrets fail closed (503/401) — verified by existing tests.

## 3. Signer plan (owner-executed, outside any agent session)

| Role | Address | Key custody | Funds needed |
|---|---|---|---|
| Owner/company/deployer | `0x76D7…7486` (known) | stays in owner browser/keystore/ledger — **never enters backend env** | ~3 USDC present; proof spends ~0.02 gas + 1.00 campaign funding |
| Customer payer | fresh dedicated wallet (TBD) | owner-held (browser second account is fine) | 1.00 USDC purchase + ~0.005 gas dust, funded by owner pre-proof |
| Executor | fresh dedicated wallet (TBD) | backend `THESMA_EXECUTOR_PRIVATE_KEY` only | ~0.05 gas dust from owner |
| Verifier | fresh dedicated wallet (TBD) | backend `THESMA_VERIFIER_PRIVATE_KEY` only | none (offchain signing) |
| Partner recipient | fresh address (TBD) | **no key needed anywhere** — passive payout destination | none |

Roles stay distinct (domain permits no safe combination that merges them).
**Do NOT generate wallets inside an agent session** (mnemonics/keys would land in
logs). Owner-side commands (run locally, private terminal):

```bash
cast wallet new                          # record mnemonic OFFLINE, never share it
cast wallet import thesma-customer --interactive
cast wallet import thesma-executor --interactive
cast wallet import thesma-verifier --interactive
cast wallet address --account thesma-customer   # report these three addresses back
```

## 4. Signer validation (backend does this automatically)

On startup/use, backend derives each key's address and compares it to the
configured `THESMA_*_ADDRESS`; mismatch or absence fails closed (503, no secret
leak — covered by S5 tests). Owner verifies by calling any authenticated
read endpoint and by the worker refusing to act until all four public
addresses + secrets are present. No private key is `NEXT_PUBLIC`,
client-visible, logged, or API-returned (verified by repo-wide scan each slice).

## 5. Worker readiness checklist (all runnable without touching live state)

- [ ] All internal routes require bearer secrets (`requireInternalSecret`, 16-char minimum).
- [ ] Every chain touch asserts RPC `eth_chainId == 5042` first (`assertChainMatches`).
- [ ] Vault/executor/verifier addresses resolve from env; EIP-712 domain pins chain 5042 + vault.
- [ ] Payout path is idempotent across restarts (unique outcome/tx/reservation constraints + reconcile-before-retry; tested).
- [ ] Supply worker reuses `joinCampaign` exactly (same gates, audit, idempotency): autoJoin-only Partners, wallet required, live-PUBLIC markets only, expectedMarketVersion staleness guard, per-market isolation, one `supply_agent.run` audit per Partner per run (tested, incl. concurrent runs).
- [ ] Schedulers are vendor-neutral adapters: Vercel Cron `GET`s the same workers (`/internal/payouts/process` daily 06:00 UTC; `/internal/agents/supply/run` daily 06:30 UTC, both Hobby-compatible) with `CRON_SECRET`; external cron or manual admin POST with the worker secret works identically. The workers support higher-frequency invocation; current Hobby infrastructure does not. Conservative cadence, no per-minute noise.

## 6. Mainnet DB isolation status

No schema change required. Isolation is structural:

- `campaign_fundings.chainId` and `checkout_intents.chainId` pin every money
  record to its chain; payouts resolve through their funding record.
- Every chain read/write asserts the live RPC chain equals configured `ARC_CHAIN_ID`.
- EIP-712 proof domains bind `chainId` + vault address — a testnet signature
  cannot validate on mainnet and vice versa.
- Operational rule for the proof: use a **fresh empty database** (§1) so no
  testnet/local rows exist at all.

## 7. S8.2 execution manifest (DO NOT EXECUTE — for the later live slice)

| # | Actor | Action (existing path) | Signer | Amount | State before → after | Verify command | Abort if |
|---|---|---|---|---|---|---|---|
| 0 | owner | fund customer (1 USDC + dust) + executor (dust) | owner | ~1.06 USDC | balances 0 → funded | `balanceOf` × 3 | any balance differs |
| 1 | owner | `createCampaign` (backend-built unsigned tx) | owner | gas only | no campaign → registered | `getCampaign` view call | key/policy/executor/verifier mismatch |
| 2 | owner | USDC `approve` (vault, 1 USDC) | owner | gas only | allowance 0 → 1 USDC | `allowance` call | allowance ≠ 1 USDC |
| 3 | owner | `fundCampaign` (1 USDC) | owner | 1.00 USDC | vault 0 → 1 USDC | `CampaignFunded` event + vault balance | amount/event mismatch |
| 4 | backend | funding-confirm → campaign LIVE | — (read-only) | — | FUNDING → LIVE | receipt + vault state re-read | any check fails |
| 5 | partner | join via backend API | — (no key) | — | no terms → ACTIVE terms + referral | terms snapshot read | price/version mismatch |
| 6 | customer | USDC `transfer` company 1 USDC | customer | 1.00 USDC | company +0 → +1 USDC | receipt + Transfer log | sender/recipient/amount differ |
| 7 | backend | verify → VERIFIED (internal secret) | — | — | PENDING → VERIFIED | outcome read | any rule fails |
| 8 | — | wait legitimate 1h hold (`refundHoldSeconds: 3600`) | — | — | hold active → cleared | `holdUntil` read | — |
| 9 | backend | worker reserve → sign → submit | executor key (server) | gas only | VERIFIED → SUBMITTED | tx hash + reservation state | any revalidation fails |
| 10 | backend | reconcile → SETTLED | — (read-only) | — | SUBMITTED → SETTLED | `OutcomePaid` event match | event mismatch → FAILED, never resend |
| 11 | backend | second worker run | — | — | stays SETTLED | no new tx, no new payout | anything broadcast |

Cumulative campaign funding: **exactly 1.00 USDC** (steps 0–3 move at most 1.00 into the vault; purchase pays the company, not the vault).

## 8. Product/deliverable gate

Resolved: the deliverable is `docs/proof-pack/SAFE_AGENT_PAYMENTS_CHECKLIST.md`
(the Thesma Mainnet Proof Pack). Run #1 is SETTLED; Run #2 is a real
production run (0.90 USDC purchase VERIFIED) progressing through payout
automation. Nothing may be fabricated; self-purchase stays rejected by
domain rule.

## 9. Abort rules (live slice)

Wrong chain/vault/signer/amount/recipient, duplicate reservation, ambiguous tx
without reconciliation, budget-math drift, or any transaction above plan →
STOP, reconcile first, never blind-retry. Cumulative vault funding must never
exceed 1.00 USDC.

## 10. Production campaign flow (normal operations — no fake traction)

Run `npm run mainnet:preflight` first; proceed only on zero FAIL. A local shell
without production secrets reports NOT_CONFIGURED/FAIL for the missing items —
that is LOCAL environment state, not a production outage. Production truth comes
only from preflight run where the production env is present.

1. provision production Postgres 2. apply migrations (`npm run db:migrate`)
3. configure app secrets (§2, incl. `SUPPLY_AGENT_WORKER_SECRET`) 4. obtain Arc RPC
5. confirm `THESMA_VAULT_ADDRESS` (`0x0fA8…F79`) or deploy + verify a new vault
6. configure executor/verifier addresses 7. re-run preflight 8. deploy web app
9. create company normally 10. register company Arc wallet 11. create campaign normally
12. approve + fund from owner wallet (browser) 13. open public market
14. Partner configures Supply Agent conversationally (`/app/agent`)
15. Partner enables autoJoin (or joins manually) — worker handles the rest
16. real customer follows referral 17. customer purchases with own Arc USDC
18. outcome verifies 19. payout settles 20. confirm `/markets/[campaignId]` proof
21. record tx hashes + evidence 22. never label an unconfirmed transaction settled.
