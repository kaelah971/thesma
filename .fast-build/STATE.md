# Fast Build State

## Product
- Name: THESMA
- Outcome: Autonomous market for verified business outcomes (verified paid customer → USDC payout inside hard limits)
- Primary demo path (Target): Policy → Fund → Market → Refer → Purchase → Verify → Reprice → Pay → Reconcile

## MVP slices
- [x] S0: Foundation (backend-first: app, auth, Postgres/Drizzle, audit, minimal API, tests)
- [x] S1: Campaign Intent + Policy Engine
- [x] S2: ThesmaMarketVault + Arc campaign funding (contract + local verification; chain exercise LOCAL ONLY)
- [x] S3: Live market + Partner rules + join + referral routes
- [ ] S4: Customer purchase + verifier
- [ ] S5: Automatic payout + reconciliation
- [ ] S6: Dynamic Demand Agent (pricing kernel)
- [ ] S7: Supply Agent + negotiation
- [ ] S8: Demo + traction polish

## Current slice
- S3 Live market + Partner rules + join + referral routes — Shipped (this session)

## Completed (S3 this session)
- Market domain: MarketState reuse, strict PartnerRules (canonical + S0-legacy normalize), pure eligibility matrix, destination-URL guard, opaque referral codes
- Market service: openMarket (LIVE+APPROVED+CONFIRMED binding, floor/ceiling/affordability, single-open), public feed (PUBLIC/LIVE/OPEN/unexpired, no policy JSON), join (snapshot + idempotent + stale-version + row-locked active cap), private invites (hash-only, expiry, max-uses), referral resolve (attributable flag, money-free)
- Attribution: HMAC-signed v1 cookie tokens (referral/campaign/partner/exp/nonce only), 32-char secret minimum, /r/:code records CLICK + redirects stored destination
- Tables: market_states, partner_terms (unique pair), referrals (unique code), referral_events, private_invites (migration 0003, 14 tables total)
- Routes: market/open, market, markets (public), partners/me/rules, join, partners/me/campaigns, invites, /r/:code
- Tests: 17 market + 4 attribution (78 vitest total green); S0-S2 suites untouched and green; forge 34 still green
- Bootstrap bounty documented as temporary S3 seam (S6 owns strategy); no agent-pricing claims

## Completed (S2 this session)
- S1 hardening: CampaignStore.atomic (Drizzle transactions; in-memory snapshot/restore + buffered audit); all S1 ops + funding transitions atomic; FUNDING/LIVE blocks policy mutation; FAILED confirmation returns campaign to APPROVED
- Contract: ThesmaMarketVault (create/fund/pause/close/returnUnspent + EIP-712 payoutVerifiedOutcome, non-upgradeable, OZ v5.7.0, no withdraw backdoor) + MockUSDC + Deploy.s.sol (explicit --broadcast only)
- Canonical bindings: campaignKey/policyHash (ABI-encoded, stable rules JSON), cross-stack vector pin in KeyVector.t.sol
- Backend Arc boundary: ArcConfig/env, ViemArcReader, unsigned buildFundingIntent, fail-closed chain check; arc:doctor (NOT_CONFIGURED honest, never signs)
- Funding model: campaign_fundings + status enum (migration 0002); service prepare/submit/status/confirm + company-wallet register; 5 routes; 7 audit actions
- Tests: 34 forge (31 vault unit+fuzz + 1 invariant + 2 cross-stack vector pins) + 21 new vitest (4 keys + 17 funding); 57 vitest total green; S0/S1 suites untouched and green
- Deployment status: NOT EXERCISED on any chain (no addresses/txs exist)

## Completed (S1 prior session)
- Campaign domain: MarketVisibility, PolicyVersionStatus, pure analyzePolicyFields, S1 transition guard (DRAFT->REVIEW->APPROVED; FUNDING/LIVE rejected)
- Tables: campaigns, campaign_policy_versions (migration 0001, unique (campaignId, version))
- Intent boundary: CampaignIntentInterpreter + LocalIntentInterpreter (canonical demo sentence -> exact draft; relative dates never guessed)
- Service: createDraft/reviseDraft/moveToReview/approvePolicy/getCampaign/listWorkspaceCampaigns (store interface + in-memory for tests, Drizzle impl for routes)
- API: POST /api/campaigns/draft, GET /api/campaigns, GET /api/campaigns/:id, PATCH /api/campaigns/:id/draft, POST .../review, POST .../approve
- Approval: owner-only; member may draft/review; approved immutable (revision -> new version); stale writes 409; repeat approval idempotent
- Audit: campaign.created/draft_revised/review_requested/policy_approved/policy_revision_created
- Tests: 19 new (36 total, all green); S0 suite untouched and green

## Completed (S0 prior session)
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
- S3: market_states (campaign PK, bounty, OPEN status, destination, v1, policyVersion), partner_terms (unique campaign+partner, PUBLIC snapshot, expiry=deadline), referrals (unique opaque code), referral_events (CLICK + visitor hash), private_invites (token hash, expiry, max uses)
- users, workspaces, workspace_members, partners, sessions, audit_events (+ indexes, FKs, uniques)
- S1: campaigns (workspace FK cascade, state enum, currentPolicyVersionId, createdBy FK restrict), campaign_policy_versions (18 cols, micro-USDC bigint, deadline nullable, status/visibility enums, unique (campaignId, version), approvedBy/approvedAt nullable)
- S2: campaign_fundings (22 cols, unique (campaignId, policyVersion), unique nullable fundingTxHash, chain/vault/usdc/owner addresses, expected/observed micro-USDC, PREPARED/SUBMITTED/CONFIRMED/FAILED/AMBIGUOUS)

## Commands verified (S3)
- npm install: pass (no new deps)
- npm run db:generate: pass (drizzle/0003_common_runaways.sql, 14 tables total; NOT applied, no live DB)
- npm run typecheck: pass; npm run lint: pass (0 errors)
- npm test: pass (10 files, 78 tests: 57 S0-S2 + 21 S3)
- npm run build: pass (15/15 routes incl. markets/join/invites/r)
- forge fmt --check / build / test: pass, 34 unchanged
- secrets scan: clean; no .env; ATTRIBUTION_SECRET only in .env.example (commented)

## Commands verified (S2)
- npm install: pass (added viem 2.57.7; "type": "module" for tsx ESM)
- foundryup: forge/anvil/cast 1.8.5; OZ v5.7.0 + forge-std vendored
- npm run db:generate: pass (drizzle/0002_nostalgic_stranger.sql, 9 tables total; NOT applied, no live DB)
- npm run typecheck: pass; npm run lint: pass (0 errors, lib/ excluded)
- npm test: pass (8 files, 57 tests: 36 S0/S1 + 21 S2)
- npm run build: pass (all funding routes live)
- forge fmt --check: pass; forge build: pass; forge test: 34 pass
- npm run arc:doctor: NOT_CONFIGURED (honest, nothing contacted)
- secrets scan: clean; no .env; Deploy.s.sol dry-run only

## Commands verified (S1)
- npm install: pass (no new deps; lockfile unchanged)
- npm run db:generate: pass (drizzle/0001_tough_callisto.sql, 8 tables total)
- npm run typecheck: pass (incl. jsonb unknown->record mapper fix)
- npm run lint: pass (0 errors, 0 warnings)
- npm test: pass (6 files, 36 tests: 17 S0 + 19 S1)
- npm run build: pass (all 6 campaign routes live)
- secrets scan: clean; only .env.example (placeholder), no .env committed

## Blockers
- No local Postgres in this environment (psql/pg_isready missing); migration applied against DATABASE_URL when configured

## S2 architecture
- Money paths: customer revenue never enters the vault; vault holds only pre-funded acquisition budget; backend keyless (prepares + verifies, never signs)
- Funding state machine: APPROVED -> FUNDING (prepare) -> LIVE (confirm w/ full-budget onchain proof); FAILED -> APPROVED (retry); AMBIGUOUS holds for re-check; CONFIRMED idempotent
- RPC/funding adapter boundary: src/server/chain/* (viem contained); domain sees plain values; Deploy.s.sol requires explicit env + --broadcast; tests never touch mainnet
- Contract invariants: spent <= funded <= budgetCap (fuzz + handler invariant); payout binds key/policy/outcome/recipient/amount/proof/times to verifier signature; occurredAt<=deadline decides eligibility, not settlement time

## Known limitations (S2)
- Arc exercise is LOCAL ONLY (forge EVM + fake-reader backend tests); testnet/mainnet deployment + funding NOT EXERCISED
- Company wallet is registered, not cryptographically verified
- Payout primitive contract-tested but deliberately unwired from the backend (S5)
- Multi-tx funding (create+approve+fund) confirmed via the funding tx receipt + vault state, not per-action receipts

## Known limitations (S1)
- Interpreter is heuristic regex, not an LLM; unusual phrasing yields missing fields (by design, never guesses)
- Deadlines require explicit ISO dates; relative dates always reported missing
- Multi-write service transitions are sequential awaits, not a single DB transaction (single-node correctness holds; harden with transactions in S2 if funding races appear)
- In-memory store timestamps fixed; wall-clock only via injected now() for deadline checks

## S3 concurrency notes
- Market open: check-then-insert inside atomic + campaignId PK unique backs the race (409)
- Join: partner row SELECT FOR UPDATE serializes active-cap count-then-insert per Partner; unique (campaign,partner) + referral-code unique with retry make losers deterministic/idempotent
- Stale marketVersion rejected explicitly; terms snapshot frozen at join

## Next action
- S4 — CUSTOMER ARC PURCHASE + ATTRIBUTION CONSUMPTION + OUTCOME VERIFIER (do NOT start in this session)
