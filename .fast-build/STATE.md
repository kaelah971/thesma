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
- [x] Slice 3: Embedded SDK / hosted components / external-product integration surface.
- [x] Slice 4: Operator + verification + settlement integration across embedded programs.
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
- `drizzle/0019_safe_stranger.sql` + `drizzle/0020_salty_sunspot.sql` + `drizzle/0021_abnormal_eternals.sql` + snapshots/journal (created, not applied)
- `src/server/services/growthProgramParticipation.ts`
- `src/components/build/DeveloperProgramParticipantsPanel.tsx`
- `src/app/api/v1/programs/[id]/participants/`, `participation/`, `attribution/`
- `src/server/services/publicGrowthPrograms.ts`
- `src/server/services/growthProgramOutcome.ts`
- `src/app/api/v1/public/programs/[slug]/`
- `src/app/g/[slug]/page.tsx`, `src/components/public/HostedGrowthProgram.tsx`
- `src/sdk/browser.ts`, `src/sdk/server.ts`
- `src/components/build/DeveloperProgramIntegrationPanel.tsx`
- `drizzle/0021_abnormal_eternals.sql` + snapshot/journal (created, not applied)
- `tests/growth-programs.test.ts`, `tests/growth-participation.test.ts`, `tests/embedded-sdk.test.ts`, `tests/growth-program-outcome.test.ts`
- `docs/sdk.md`
- `docs/embedded-growth-programs.md`, `docs/build-with-thesma.md`, `docs/current-state.md`, `README.md`

## Slice 4 result
- Program-bound Outcome API events now expose one deterministic evaluation combining attribution, existing verification/VOI state, frozen participant reward terms, bigint program economics, holds, settlement eligibility, operator recommendation, execution status and receipt context.
- Production evaluation maps each Growth Program to its existing campaign id/Campaign CFO and settlement authority; performance-only is supported, hybrid legs are explicit `UNSUPPORTED_SETTLEMENT_PATH`, and Outcome Portfolio remains campaign-only.
- Shadow records `WOULD_SETTLE`/review recommendations through the existing decision ledger; payout, procurement, Circle, x402 and chain execution remain blocked. No migration was added or applied.

## Verification
- Focused: Slice 4 pipeline + SDK + Outcome API tests passed (30 tests); Growth Program + participation regression tests passed (12 tests).
- Full suite: 965 passed, 2 skipped.
- Typecheck: pass. Lint: pass. Production build: pass. Browser smoke: pass.
- `git diff --check`: pending final checkpoint.

## Blockers / truth
- Migrations 0019, 0020 and 0021 are created locally and must go through the reviewed production migration process; do not apply blindly.
- No mainnet transactions, testnet transactions, x402 payments, Circle calls, real USDC or test USDC were made.
- Unrelated worktree changes preserved: `next-env.d.ts`, `.circle-register-existing.mjs`, `AGENTS.md`, `contracts/verification/`, `docs/ui redesign/`, `docs/ui refresh/`.

## Next action
- Slice 5: safely apply pending production migrations, create the real ProofPilot Growth Program, connect a real integration, submit one real Shadow outcome from an external ProofPilot-style client, and inspect the production receipt with zero financial execution.
