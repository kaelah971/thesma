# Slice 10B — Production Migration + Deployment Runbook

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