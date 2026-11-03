# Fast Build State

## Product
- Name: THESMA
- Outcome: Embed Thesma's autonomous, verified-outcome growth infrastructure into another product.
- Primary demo path: `/build` → create Growth Program → inspect objective/readiness → bind Outcome API evidence.

## Milestone
- BUILD WITH THESMA — EMBEDDED GROWTH INFRASTRUCTURE
- Status: COMPLETE

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
- [x] Slice 5: Real ProofPilot end-to-end integration + docs / public proof.

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
- `scripts/review-production-growth-migrations.ts` (read-only schema checker; no SQL writes)
- `scripts/proofpilot-shadow-pilot.ts` (external-style SDK proof client; explicit opt-in)
- `docs/proofpilot-shadow-pilot.md` (completed production Shadow proof artifact)

## Slice 4 result
- Program-bound Outcome API events now expose one deterministic evaluation combining attribution, existing verification/VOI state, frozen participant reward terms, bigint program economics, holds, settlement eligibility, operator recommendation, execution status and receipt context.
- Production evaluation maps each Growth Program to its existing campaign id/Campaign CFO and settlement authority; performance-only is supported, hybrid legs are explicit `UNSUPPORTED_SETTLEMENT_PATH`, and Outcome Portfolio remains campaign-only.
- Shadow records `WOULD_SETTLE`/review recommendations through the existing decision ledger; payout, procurement, Circle, x402 and chain execution remain blocked. Production schema was manually reconciled through 0018→0021 without product data or migration-journal writes.

## Verification
- Production health read: `https://thesma.vercel.app/api/health` returned HTTP 200 with `checks.db: ok`; the ProofPilot hosted route and public program API returned HTTP 200.
- Production ProofPilot readback resolved `proofpilot-partner-growth`, the pre-provisioned active referral partner and public attribution code; the public response exposed no private data or secrets.
- Read-only production schema review: all 0018–0021 objects were initially missing with no conflicts; the minimum chain was rehearsed transactionally, rolled back cleanly, then applied exactly once.
- External proof client safety guard: verified; it refuses to create records without explicit `THESMA_PROOF_CONFIRM` and `THESMA_API_KEY`.
- Typecheck: pass. Lint: pass.
- Typecheck, lint, production build, browser smoke, and tracked-secret hygiene pass after the production proof docs update.
- Full suite: `npm test` passed with 969 tests passed and 2 skipped (86 files passed, 2 skipped).
- `git diff --check`: pass.

## Blockers / truth
- Slice 5 is complete: authenticated production SDK/API access was used without exposing the API key.
- The existing script submitted one synthetic `ACTIVATED_USER` event and read the real production receipt; verification was `VERIFIED`, reward was frozen at `8 USDC` and `ON_HOLD`, settlement was `NOT_READY`, and the Shadow operator decision was `HOLD`.
- Idempotency replay returned the original event and receipt with no duplicate event, reward exposure, receipt or economic outcome.
- Hard zero-spend proof: Circle `0`, x402 `0`, mainnet `0`, testnet `0`, vault funding `0`, payout `0`, real USDC `0`, test USDC `0`.
- Exact 0018→0021 SQL: 51 statements, transactional rehearsal PASS with rollback verified, then one production transaction committed; the historical migration journal remains untrusted and unchanged.
- This was a synthetic production integration test under Shadow Mode. It is not customer traction, not a real acquired user, and not a creator payout.
- Unrelated worktree changes preserved: `next-env.d.ts`, `.circle-register-existing.mjs`, `AGENTS.md`, `contracts/verification/`, `docs/ui redesign/`, `docs/ui refresh/`.

## Next action
- Milestone complete. Preserve Shadow Mode and the zero-spend boundary; do not fund or settle this synthetic proof.
