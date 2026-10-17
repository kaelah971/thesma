# Thesma — S0 Backend Foundation

**Thesma is an autonomous market for verified business outcomes.** A company sets a customer goal, budget, and hard limits; a Demand Agent prices the next verified result inside those limits while Partner Supply Agents join or negotiate inside their own rules. A deterministic verifier establishes whether a qualifying purchase happened before any payout settles in USDC on Arc (target).

> Status vocabulary: **Shipped** = implemented and exercised in this build. **Target** = specified but not yet proven. **Roadmap** = deferred. **Hypothesis** = needs validation.

## Backend-first architecture (S0)

Route handlers are adapters, not business logic. Domain logic lives in `src/server/domain` + `src/server/services`; external systems plug in later through `src/server/adapters`. Money uses exact integer micro-USDC (`bigint` + decimal strings) — never floating point. Agent models will never receive raw private keys and never write directly to chain (enforced boundary for S1+).

```
src/
  app/                  # Next.js App Router: pages + /api/* route adapters
  server/
    db/                 # Drizzle schema/client (DATABASE_URL boundary)
    domain/             # enums, types, money, Zod validation (no I/O)
    services/           # workspaces, partners, audit (transactional logic)
    adapters/           # TARGET stubs: arc, vault, verifier, agents (not built)
    auth/               # session, password, server-side guards
    api/                # typed error envelope
```

## Stack (Shipped)

- Next.js 16 App Router + React 19 + TypeScript strict
- PostgreSQL via Drizzle ORM + migrations (provider-neutral `DATABASE_URL`)
- Zod v4 boundary validation
- Vitest tests, ESLint, npm
- Auth: lightweight email/password with `bcryptjs` + opaque DB sessions (`sessions` table, sha256 token hash, httpOnly cookie). No OAuth.
  - Why: avoids an auth rabbit hole for S0, stays Drizzle-first, keeps a clean swap boundary (`src/server/auth/*`) for better-auth/Auth.js later if needed.

## Local setup

```bash
npm install
cp .env.example .env        # set DATABASE_URL to any Postgres
npm run db:generate         # generate migration from Drizzle schema
npm run db:migrate          # apply ./drizzle to DATABASE_URL
npm run dev                 # http://localhost:3000
```

Postgres options: local Docker (`docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`), Neon, or Supabase — any works, domain code is not coupled to a provider.

## Env vars

| Var | Required | Purpose |
| --- | -------- | ------- |
| `DATABASE_URL` | yes (runtime) | Provider-neutral Postgres connection. Build + unit tests pass without it; API routes return `503 UNCONFIGURED` until set. |
| `SESSION_COOKIE_NAME` | no | Defaults to `thesma_session`. |

No secrets are committed. Never put private keys in `.env` for the agent runtime.

## Commands

```bash
npm run dev          # local dev
npm run build        # production build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest run (no live DB required)
npm run db:generate  # drizzle-kit generate
npm run db:migrate   # apply migrations
```

## S1 Shipped — Campaign Intent + Policy Engine

- Owner describes an objective in plain text; deterministic local interpreter (`LocalIntentInterpreter`) prepares a typed draft (counts, exact micro-USDC amounts, ISO deadlines only — relative dates are never guessed). Missing required fields are returned explicitly, never invented.
- Draft lifecycle `DRAFT -> REVIEW -> APPROVED` with versioned owner-controlled policy (`campaigns` + `campaign_policy_versions`, unique `(campaignId, version)`). `FUNDING`/`LIVE`/etc. exist as enums but have no legal entry in S1.
- Invariants (pure, tested): amounts > 0 (floor/min ≥ 0), floor ≤ ceiling, `target × floor ≤ budget`, deadline future at approval, no floats anywhere.
- Ownership: any workspace member may draft/revise/request review; **only `ORGANIZATION_OWNER` can approve**. Cross-workspace access denied server-side.
- APPROVED versions immutable: post-approval revision creates version N+1 and reopens at DRAFT; stale `expectedVersion` writes rejected (409); repeat approval is idempotent.
- Endpoints: `POST /api/campaigns/draft`, `GET /api/campaigns?workspaceId=`, `GET /api/campaigns/:id`, `PATCH /api/campaigns/:id/draft`, `POST /api/campaigns/:id/review`, `POST /api/campaigns/:id/approve`.
- Audit: `campaign.created`, `campaign.draft_revised`, `campaign.review_requested`, `campaign.policy_approved`, `campaign.policy_revision_created` (version IDs in metadata; not financial receipts).
- Interpreter boundary: `CampaignIntentInterpreter` interface keeps model SDKs out of domain code; a real LLM Demand Agent plugs in later. The deterministic parser does not mean the conversational agent is shipped.

No money moves in S1.

## S0 Shipped (prior slice)

- App + quality tooling (dev/build/lint/typecheck/test/db scripts)
- Domain enums: `WorkspaceRole`, `CampaignState`, `MarketState`, `AgentActionState` (behavior-free, for S1+)
- Money primitive: micro-USDC exact integers (`usdcToMicro`, `microToUsdcString`)
- Drizzle tables + migration: `users`, `workspaces`, `workspace_members`, `partners`, `sessions`, `audit_events`
- Email/password auth, workspace create/get with server-side isolation, partner create/update with per-user ownership
- Endpoints: `GET /api/health`, `GET /api/me`, `POST /api/auth/signup|signin|signout`, `GET|POST /api/workspaces`, `GET /api/workspaces/:id`, `GET|POST|PATCH /api/partners`
- Append-only `audit_events` for `workspace.created`, `partner.created`, `partner.updated`
- Tests: validation, money, authz/isolation, sessions/audit, health

## Explicitly NOT implemented (Target/Roadmap)

- actual LLM Demand Agent runtime (only the deterministic intent parser + adapter boundary exist)
- wallet connection / wallet ownership proof
- Arc
- Circle
- campaign funding
- vault (`ThesmaMarketVault`)
- live market
- market pricing / repricing
- Supply Agent
- referrals
- purchases
- outcome verification
- payouts

Next slice: **S2 — ThesmaMarketVault + Arc campaign funding**.
