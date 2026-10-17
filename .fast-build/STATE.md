# Fast Build State

## Product
- Name: THESMA
- Outcome: Autonomous market for verified business outcomes (verified paid customer → USDC payout inside hard limits)
- Primary demo path (Target): Policy → Fund → Market → Refer → Purchase → Verify → Reprice → Pay → Reconcile

## MVP slices
- [x] S0: Foundation (backend-first: app, auth, Postgres/Drizzle, audit, minimal API, tests)
- [ ] S1: Campaign Intent + Policy Engine
- [ ] S2: Campaign vault (ThesmaMarketVault + funding)
- [ ] S3: Live market + Partner join/referral
- [ ] S4: Customer purchase + verifier
- [ ] S5: Automatic payout + reconciliation
- [ ] S6: Dynamic Demand Agent (pricing kernel)
- [ ] S7: Supply Agent + negotiation
- [ ] S8: Demo + traction polish

## Current slice
- S0 Foundation — Shipped (this session)

## Completed
- Next.js 16 + React 19 + TS strict + Drizzle + Zod + Vitest + ESLint scaffold
- Domain enums/types/money (micro-USDC bigint) + Zod boundaries
- Tables: users, workspaces, workspace_members, partners, sessions, audit_events
- Email/password auth (bcryptjs + opaque sessions), workspace isolation, partner ownership
- API: health, me, auth/*, workspaces, partners; audit on S0 mutations
- Tests: validation, money, authz, audit/session, health
- README + .env.example; adapter stubs reserved for S1+

## Architectural decisions
- Provider-neutral DATABASE_URL; no Neon/Supabase/Circle/Arc SDK coupling
- App-generated UUID text PKs (no pgcrypto dependency)
- Custom session auth over full auth framework (documented in README; swappable at src/server/auth/*)
- Money as integer micro-USDC decimal-strings on wire, bigint in code; no floats
- Adapters reserved, not implemented (arc/vault/verifier/agents/policy/market-state)

## Schema created
- users, workspaces, workspace_members, partners, sessions, audit_events (+ indexes, FKs, uniques)

## Commands verified
- npm install: pass (413 pkgs; fixed @types/react 19.3.1 -> 19.3.0, nonexistent)
- npm run db:generate: pass (drizzle/0000_steady_doctor_faustus.sql, 6 tables)
- npm run typecheck: pass (incl. after Next build touched tsconfig)
- npm run lint: pass (0 errors, 0 warnings after fix)
- npm test: pass (5 files, 17 tests)
- npm run build: pass (Next 16.4.2 production build, all routes)
- secrets scan: clean; only .env.example (placeholder), no .env committed

## Blockers
- No local Postgres in this environment (psql/pg_isready missing); migration applied against DATABASE_URL when configured

## Next action
- S1 Campaign Intent + Policy Engine (do NOT start in this session)
