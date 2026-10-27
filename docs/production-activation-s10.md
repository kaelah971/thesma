# Slice 10B — Production Migration + Deployment Runbook

**10B ACTUALS (2026-10-27, appended during controlled activation):**
- Activation commit: a076e3f (HEAD == origin/main at activation; Slices 1–9 + Arc docs verified in history).
- Production DB: Neon Postgres 18.6, `thesma_mainnet` (us-east-2), `sslmode=verify-full`. Read-only connectivity verified (`SELECT current_database(), version()`).
- Recovery point: local logical backup `.tmp-10b-backup/` (git-ignored, never committed) — 28 tables, 173 rows, MANIFEST.json at 2026-10-27T16:22:53Z; spot-verified row-for-row against live counts. No Neon API key exists in this environment, so no provider-native branch/snapshot was possible; the CSV backup is the rollback reference.
- __drizzle_migrations: table DOES NOT EXIST in production (confirms 10A finding — never run `npm run db:migrate` here).
- Drift check: zero pending objects pre-existed (no invitation_status, none of the 5 tables/columns/indexes). No drift → proceeded.
- Migration hashes (sha256 of exact committed files applied byte-for-byte):
  0014_creator_capability.sql: 1e034db10b7d8791a32a811d2bcbfe797111d37964366e17f4a0c136fbd7c1cc
  0015_creator_invitations.sql: f08457efd924ba50cefd985996955487d10faf67ac457395c78bdad96b247e15
  0016_cuddly_selene.sql: 1e045ecb3d5f73df589ca2150540fa1c641213a9d520fc9c53d10cb97a04e3c2 (hand-trimmed new-tables-only version, NOT regenerated)
  0017_outstanding_misty_knight.sql: 557ade6181b25f4fad30919735dd3e71ae15a3535b3e917588d7b7dc3897b4bd
- Migrations applied in order 0014→0015→0016→0017, one transaction per file, all COMMIT_OK; per-file verification passed (columns/types/defaults, enum, tables, FKs, unique/partial/regular indexes, CHECK constraints).
- Post-migration invariants: all pre-existing row counts identical (users 9, personas 1 (@bgirl untouched: handle=bgirl, new cols null/[]), campaigns 7, outcomes 2×VERIFIED, payouts 2×SETTLED, reservations 2, audit_events 93, partners/terms/referrals/fundings 2, policy_versions 7); new tables all 0 rows.
- Deployment: production auto-deploys on git push (Vercel GitHub integration); live deployment dpl_EXPkA7r26zZWFqN5Pac7Ta24bVUq (Ready 17:17:55 UTC+1) already serves a076e3f — no separate deploy action was needed or taken. Previous deployment (26m earlier) retained as rollback target.
- Cron verified live: `/internal/agents/scout/run 20 8 * * *`, `/internal/agents/supply/run 30 6 * * *`, `/internal/payouts/process 0 6 * * *` (daily, Hobby-compatible; no sub-daily).
- Worker auth: unauthenticated POST/GET → 401 on payouts/scout/cron paths; supply POST → 503 UNCONFIGURED (pre-existing fail-closed: SUPPLY_AGENT_WORKER_SECRET intentionally unset; scheduled GET path via CRON_SECRET healthy).
- Env audit (names only, via `vercel env ls production`): all 13 required secrets present; procurement/test vars correctly ABSENT (NOT_CONFIGURED by design).
- Public health: /,/start,/markets,/security,@bgirl,Aster,Beaconfield all 200, zero error markers, proof content intact; /creator,/app* correctly 307 (auth redirect).
- New tables still 0 rows post-deploy (no render path mutates). Ledger read on real history: payout.submitted×2 vs settled×2 distinct, AMBIGUOUS×1 preserved, funding/operator actions present.
- Authenticated smoke (/creator as @bgirl, org workspaces): DEFERRED — no operator-held user session available in this sandbox; no fake users created. Carried to 10C.
- Procurement smoke: NOT_CONFIGURED confirmed (no policy rows, no env, no local-test execution in prod); no spend possible.
- No source changes were required or made in 10B (docs + STATE + .gitignore scratch-guard only).

---

# Slice 10B — Production Migration + Deployment Runbook (plan; actuals above)

**Status: PLAN ONLY. Nothing here has been executed. Slice 10A proved readiness; 10B performs the work.**

Related: `docs/integration-readiness.md` (inventory), `docs/MAINNET_RUNBOOK.md` (chain proof era),
Slice-10A rehearsal: `tests/slice10a-rehearsal.test.ts` (memory-store E2E, auth matrix, privacy scan, legacy rendering).

---

## 1. Preconditions (all must hold before touching production)

- [ ] HEAD pinned to a verified commit (current: `87dc757` + 10A commit below); no uncommitted changes on the deploy machine.
- [ ] Full suite green on that commit (10A recorded: typecheck + lint + 505-test suite + build).
- [ ] Production database reachable from the operator machine with a **read-write owner session kept aside** (writes only in the steps below).
- [ ] Recovery point established (Section 3) and restore procedure rehearsed or documented by the provider.
- [ ] All required existing env values present in the production environment (Section 2). Do not rotate secrets during 10B.
- [ ] App deployment target known (Vercel project that serves thesma.vercel.app) with a working rollback path (previous deployment selectable).

## 2. Required production env (names only — values stay in the hosting provider)

REQUIRED_EXISTING (deployment fails closed or misbehaves without them):
`DATABASE_URL`, `ARC_NETWORK`, `ARC_RPC_URL`, `ARC_CHAIN_ID`, `ARC_USDC_ADDRESS`,
`THESMA_VAULT_ADDRESS`, `THESMA_VERIFIER_ADDRESS`, `THESMA_VERIFIER_PRIVATE_KEY`,
`THESMA_EXECUTOR_ADDRESS`, `THESMA_EXECUTOR_PRIVATE_KEY`,
`VERIFIER_INTERNAL_SECRET`, `PAYOUT_WORKER_SECRET`, `SUPPLY_AGENT_WORKER_SECRET`,
`SCOUT_WORKER_SECRET`, `CRON_SECRET`, `ATTRIBUTION_SECRET`,
`ARC_TESTNET_*` variants (only if testnet verification is re-run).

OPTIONAL (safe defaults when unset):
`ARC_EXPLORER_BASE_URL`, `ARC_TESTNET_EXPLORER_BASE_URL`, `SESSION_COOKIE_NAME`,
`NODE_ENV=production`, `NEXT_PUBLIC_SITE_URL`, `ARC_TESTNET_OPERATOR_ADDRESS`.

NEW_NOT_CONFIGURED (Slice 8 — leave unset in 10B; app fails closed to NOT_CONFIGURED):
`THESMA_PROCUREMENT_ADDRESS`, `THESMA_PROCUREMENT_PRIVATE_KEY`,
`THESMA_VERIFICATION_PROVIDER_URL`, `THESMA_VERIFICATION_ALLOWED_HOSTS`,
`THESMA_TEST_CHECK_COST_MICRO_USDC`, `THESMA_ALLOW_TEST_PROVIDERS` (must stay unset in prod).

OBSOLETE: none. No env var is removed by Slices 1–9.

## 3. Recovery point (before any write)

Preferred: provider-native restore point/branch of the production database
(Neon branch/restore, Supabase PITR snapshot, or `pg_dump -Fc` to operator-controlled storage).
Record the recovery identifier in the 10B log. Do NOT proceed if no recovery path exists —
that alone aborts 10B (see Section 5).

## 4. Read-only production schema truth (no writes)

1. `SELECT * FROM __drizzle_migrations ORDER BY id;` (or the provider's journal table).
   Record which idx values exist. Expected per Slice-10A: journal UNRELIABLE —
   do NOT trust it; verify objects directly.
2. Object inventory (information_schema / pg_catalog, read-only):
   - tables `user_personas`, `operator_policies`, `growth_policies`, `creator_follows`, `creator_notifications` exist;
   - pending objects ABSENT: columns `user_personas.creator_type|interests|preferences`;
     tables `campaign_creator_invitations`, `hybrid_deals`, `milestone_awards`,
     `verification_procurements`, `verification_procurement_policies`; type `invitation_status`.
   - row counts for capacity awareness only (`campaigns`, `outcomes`, `payouts`, `audit_events`, …). No private data exported.
3. If ANY pending object already exists (partial application or drift): STOP. Do not apply, do not drop. Record exact drift and abort 10B.

## 5. Migration order (exact committed SQL, manually, in order)

**CRITICAL: DO NOT run `npm run db:migrate` against production.** The journal is
untrustworthy and drizzle-kit would diff against snapshots, not history. Apply each
file below with `psql -v ON_ERROR_STOP=1 -f <file>` (or the provider SQL runner) inside
an explicit transaction where the file allows it. After EACH file, run its verification
query before proceeding.

### 10B-M1 — `drizzle/0014_creator_capability.sql`
- Creates/changes: 3× `ALTER TABLE user_personas ADD COLUMN` (`creator_type` text nullable;
  `interests`/`preferences` text[] NOT NULL DEFAULT '{}').
- Pre-state: `user_personas` exists WITHOUT the three columns.
- Verify post: columns present with the defaults above; existing rows readable
  (`SELECT id, creator_type, interests, preferences FROM user_personas LIMIT 5` shows NULL/{} as appropriate).
- Legacy-row safety: defaults fill every existing row; no backfill, no NOT NULL violation, no new constraints.
- Abort if: columns already exist with different types/defaults (drift → stop, do not ALTER blindly).

### 10B-M2 — `drizzle/0015_creator_invitations.sql`
- Creates: enum `invitation_status`; table `campaign_creator_invitations` (13 cols);
  3 FKs (campaigns, users ×2, all ON DELETE cascade); partial unique index
  `creator_invitations_active_unique` on (campaign_id, creator_user_id) WHERE status='INVITED'; 2 btree indexes.
- Pre-state: none of the above exist.
- Verify post: table + enum + 3 FKs + 3 indexes present; `INSERT` probe row in a rolled-back transaction (do not leave test rows).
- Abort if: enum/table already exists, or FK targets missing (means base schema drift — stop).

### 10B-M3 — `drizzle/0016_cuddly_selene.sql`
- Creates: `hybrid_deals` (UNIQUE terms_id, base_status CHECK), `milestone_awards`
  (status CHECK); 5 FKs incl. `hybrid_deals.invitation_id → campaign_creator_invitations.id`
  (**ordering dependency on M2 proven**); 4 indexes incl. unique (deal_id, milestone_index).
- Pre-state: M2 applied; new tables absent.
- Verify post: both tables + constraints + indexes; FK to invitations resolves.
- Abort if: M2 missing (order violation), or tables already exist.

### 10B-M4 — `drizzle/0017_outstanding_misty_knight.sql`
- Creates: `verification_procurement_policies` (PK workspace_id), `verification_procurements`
  (UNIQUE dedupe_key, state CHECK with 10 states); 6 FKs to base tables only
  (workspaces/campaigns/outcomes/users — no dependency on M2/M3); 2 indexes.
- Pre-state: new tables absent.
- Verify post: both tables + constraints + indexes.
- Abort if: tables already exist.

**Second-run behavior:** these scripts are NOT idempotent (plain CREATE). A failed file must be
inspected, the partial transaction rolled back (ON_ERROR_STOP aborts the file's transaction),
the cause fixed, and the file re-run from the start — never hand-apply half a file and continue.

## 6. Deployment order (code, after schema is verified)

1. Recovery point recorded (Section 3).
2. Production schema read (Section 4) — clean, no drift.
3. Apply 10B-M1 → verify → M2 → verify → M3 → verify → M4 → verify.
4. Deploy application (Vercel production deployment of the pinned commit).
5. Health check: `/` + `/markets` render; no 500s in logs for 10 minutes.
6. Job/cron check: `vercel.json` schedules unchanged (06:00 payouts, 06:30 supply, 08:20 scout UTC, daily — Hobby-compatible); next-run times sane.
7. Authenticated smoke (owner): creator matches load → CFO snapshot loads (shows new verify
...[truncated 3074 chars]