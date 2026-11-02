# Fast Build State

## Product
- Name: THESMA
- Outcome: Embed Thesma's autonomous, verified-outcome growth infrastructure into another product.
- Primary demo path: `/build` → create Growth Program → inspect objective/readiness → bind Outcome API evidence.

## Milestone
- BUILD WITH THESMA — EMBEDDED GROWTH INFRASTRUCTURE

## Existing capabilities
- Working: developer persona and isolated `/build` shell; project/workspace ownership.
- Working: bounded Outcome API, one-time `ths_api_` keys, definitions, evidence normalization, deterministic verification, idempotency/replay protection, holds, receipts and audit ledger.
- Working: creator capability graph, matching, invitations, referrals/attribution sessions, reliability, hybrid deals, campaign policies, CFO, Outcome Portfolio Operator, Shadow Operator and settlement boundaries.
- Working: developer accounts recover to `/build`; organization persona/shell remains separate.

## MVP slices
- [x] Slice 1: Embedded Growth Program foundation + developer creation/detail flow.
- [x] Slice 2: Partner / creator enrollment + attribution primitives.
- [ ] Slice 3: Embedded SDK / hosted components / external-product integration surface.
- [ ] Slice 4: Operator + verification + settlement integration across embedded programs.
- [ ] Slice 5: Real ProofPilot end-to-end integration + docs / public proof.

## Slice 1 result
- Growth Programs at `/build/programs` and `/build/programs/:id`.
- Project-scoped `developer_growth_programs` compose a draft campaign/policy with bounded outcome definitions and optional integrations.
- Exact bigint budget, verified CAC and reward ceilings; bounded `CREATORS` / `REFERRAL_PARTNERS`; default `SHADOW`.
- Program creation requires no integration, funding, wallet, Circle call, x402 payment or settlement call.
- Legacy Outcome API events remain unbound; new events can carry validated `growthProgramId`.
- Attribution, participation, funding and settlement readiness are shown honestly as not configured/not funded.

## Slice 2 result
- Participation mode management (`CLOSED`, `INVITE_ONLY`, `OPEN`) and project-scoped enrollment UI/API.
- Bounded `CREATOR` and `REFERRAL_PARTNER` rows with frozen reward-policy snapshots, creator acceptance semantics, pause/remove/decline transitions and no external notifications.
- Active participants receive stable `ref_…` attribution identities; resolution is program/project scoped and fail-closed for revoked, inactive, cross-scope or ambiguous references.
- Outcome API events accept optional `attributionId`, expose attribution state/identity in receipts, record conflicts in the existing audit ledger, and preserve legacy unbound fingerprints.
- Creator discovery reuses the existing matching/reliability kernel. Shadow Mode blocks creator invitations; open enrollment remains a no-side-effect application.

## Files
- `src/server/services/growthPrograms.ts`
- `src/app/build/programs/page.tsx`
- `src/app/build/programs/[id]/page.tsx`
- `src/components/build/DeveloperGrowthProgramForm.tsx`
- `src/app/api/v1/programs/`
- `drizzle/0019_safe_stranger.sql` + `drizzle/0020_salty_sunspot.sql` + snapshots/journal (created, not applied)
- `src/server/services/growthProgramParticipation.ts`
- `src/components/build/DeveloperProgramParticipantsPanel.tsx`
- `src/app/api/v1/programs/[id]/participants/`, `participation/`, `attribution/`
- `tests/growth-programs.test.ts`, `tests/growth-participation.test.ts`
- `docs/embedded-growth-programs.md`, `docs/build-with-thesma.md`, `docs/current-state.md`, `README.md`

## Verification
- Focused: Growth Program + Outcome API + participation tests passed (23 tests).
- Full suite: 946 passed, 2 skipped.
- Typecheck: pass. Lint: pass. Production build: pass. Browser smoke: pass.
- `git diff --check`: pass.

## Blockers / truth
- Migrations 0018, 0019 and 0020 are created locally and must go through the reviewed production migration process; do not apply blindly.
- No mainnet transactions, testnet transactions, x402 payments, Circle calls, real USDC or test USDC were made.
- Unrelated worktree changes preserved: `next-env.d.ts`, `.circle-register-existing.mjs`, `AGENTS.md`, `contracts/verification/`, `docs/ui redesign/`, `docs/ui refresh/`.

## Next action
- Slice 3: embedded SDK / hosted components / external-product integration surface.
