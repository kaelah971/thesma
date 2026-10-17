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
- [x] S4: Customer Arc purchase + attribution consumption + outcome verifier (LOCAL ONLY chain exercise)
- [x] S5: Automatic payout + reservation + reconciliation (LOCAL ONLY chain exercise)
- [ ] S6: Dynamic Demand Agent (pricing kernel)
- [ ] S7: Supply Agent + negotiation
- [ ] S8: Demo + traction polish

## Current slice
- S5 Automatic payout + reservation + reconciliation — Shipped (this session)

## Completed (S5 this session)
- Reservation: transactional VERIFIED+hold+policy/terms/wallet/ceiling/allocation/budget gate; one pair per outcome for life; idempotent repeats; in-place retry after release
- Execution: full revalidation, isolated EIP-712 signer, single broadcast, SUBMITTED persistence; recipient rotation/allocation/vault mismatches release safely pre-broadcast
- Reconciliation: SETTLED only on matching OutcomePaid; FAILED+release on revert/wrong-vault/no-event with evidence; AMBIGUOUS never resends; crash-before-hash detected via consumption check
- Worker: processEligiblePayouts (reserve->execute->reconcile, per-item isolation, duplicate-safe) behind PAYOUT_WORKER_SECRET; reconcile-one endpoint; truthful receipt API
- Signer/executor adapters: provider-neutral interfaces, viem local-key impls, env address-match fail-closed; Circle remains a clean future swap
- EIP-712: exact contract shape (viim signTypedData), digest determinism tests, onchain acceptance proven in Anvil E2E
- Tables: spend_reservations, payouts (migration 0005, 19 tables total)
- Tests: 15 payout unit + 1 anvil full-loop (106 unit green incl. 91 prior; forge 34 unchanged)
- Chain exercise: LOCAL ONLY (fake-reader units + anvil fund->join->purchase->verify->hold->reserve->sign->execute->SETTLED->no-double-pay)

## Completed (S4 this session)
- Attribution portability: attribution_sessions (opaque single-use handle in ?thesma_attribution=); /r/:code keeps signed cookie + appends handle
- Checkout: account-free intent (unsigned transfer calldata, exact micro-USDC), submit (SUBMITTED + PENDING, hash never trusted), public receipt state
- Verifier: VerifierChainReader (sender/block-time/Transfer logs) + 15 ordered checks (chain, receipt, token, payer, merchant, amount, minimum, deadline/intent/terms on canonical time, self-dealing, funded-policy pin, 3 uniqueness scopes); AMBIGUOUS on uncertainty, idempotent terminals
- Outcome/proof: VERIFIED + proofHash (keccak binding for S5 reuse) + customerKeyHash (salted, never raw wallet) + holdUntil = verifiedAt + refundHold (hold timer only, no refund detection)
- Internal verify route behind VERIFIER_INTERNAL_SECRET bearer; accepts no facts
- Tables: attribution_sessions, checkout_intents, outcomes (migration 0004, 17 tables total)
- Tests: 13 checkout + 1 anvil E2E (+4 secret-gate asserts inside); 91 unit green + anvil green; forge 34 unchanged
- Chain exercise: LOCAL ONLY (fake-reader units + opt-in anvil transfer->VERIFIED)

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
- S5: spend_reservations (unique outcome, RESERVED/SUBMITTED/SETTLED/FAILED/AMBIGUOUS/RELEASED), payouts (unique reservation/outcome/tx, PREPARED/SUBMITTED/SETTLED/FAILED/AMBIGUOUS)
- S4: attribution_sessions (opaque handle PK, single-use, expiry), checkout_intents (unique order/tx, PREPARED/SUBMITTED/CONFIRMED/REJECTED/AMBIGUOUS), outcomes (unique intent/tx/customer-per-campaign/proof, PENDING/VERIFIED/REJECTED, holdUntil)
- S3: market_states (campaign PK, bounty, OPEN status, destination, v1, policyVersion), partner_terms (unique campaign+partner, PUBLIC snapshot, expiry=deadline), referrals (unique opaque code), referral_events (CLICK + visitor hash), private_invites (token hash, expiry, max uses)
- users, workspaces, workspace_members, partners, sessions, audit_events (+ indexes, FKs, uniques)
- S1: campaigns (workspace FK cascade, state enum, currentPolicyVersionId, createdBy FK restrict), campaign_policy_versions (18 cols, micro-USDC bigint, deadline nullable, status/visibility enums, unique (campaignId, version), approvedBy/approvedAt nullable)
- S2: campaign_fundings (22 cols, unique (campaignId, policyVersion), unique nullable fundingTxHash, chain/vault/usdc/owner addresses, expected/observed micro-USDC, PREPARED/SUBMITTED/CONFIRMED/FAILED/AMBIGUOUS)

## Commands verified (S5)
- npm install: pass (no new deps)
- npm run db:generate: pass (drizzle/0005_odd_dark_phoenix.sql, 19 tables total; NOT applied, no live DB)
- npm run typecheck: pass; npm run lint: pass (0 errors)
- npm test: pass (12 files, 106 tests + 2 anvil-skips; S0-S4 all green)
- ARC_ANVIL_TESTS=1: payout E2E 1/1 pass (fund->join->purchase->verify->hold->reserve->sign->execute->SETTLED, exact bounty, no double-pay)
- npm run build: pass (17/17 routes incl. internal payouts + receipt)
- forge fmt --check / build / test: pass, 34 unchanged
- npm run arc:doctor: NOT_CONFIGURED (honest, nothing contacted)
- secrets scan: clean; no .env; signing keys only in .env.example (commented)

## Commands verified (S4)
- npm install: pass (no new deps)
- npm run db:generate: pass (drizzle/0004_cynical_mad_thinker.sql, 17 tables total; NOT applied, no live DB)
- npm run typecheck: pass; npm run lint: pass (0 errors)
- npm test: pass (11 files, 91 tests + 1 anvil-skip; S0-S3 all green)
- ARC_ANVIL_TESTS=1: 1/1 pass (real ERC20 transfer -> receipt -> VERIFIED + onchain company balance)
- npm run build: pass (16/16 routes incl. checkout + internal verify)
- forge fmt --check / build / test: pass, 34 unchanged
- npm run arc:doctor: NOT_CONFIGURED (honest, nothing contacted)
- secrets scan: clean; no .env; VERIFIER_INTERNAL_SECRET only in .env.example (commented)

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

## S4 verifier notes
- Canonical block timestamp decides timing; client time/webhooks never trusted
- VERIFIED = evidence passed, NOT paid; S5 must respect holdUntil (refund detection NOT shipped)
- Single-use attribution handles; conflicting submission hashes 409; unknown receipts stay AMBIGUOUS and recover
- Anvil E2E is opt-in (ARC_ANVIL_TESTS=1), skipped by default, never mainnet

## S5 payout notes
- VERIFIED != PAID, SUBMITTED != SETTLED; payout authority is campaign-scoped (funded policy), never treasury access
- Server signer isolated from model/client; keys server-only, address-matched, never logged/returned
- Uncertain broadcast state resolves via reconciliation, never resend; FAILED releases only with no-payment evidence
- Anvil E2E opt-in (ARC_ANVIL_TESTS=1), skipped by default, never mainnet

## Next action
- S6 — DYNAMIC DEMAND AGENT + PRICING KERNEL + PACE STATES + REPRICING/PAUSE DECISIONS (do NOT start in this session)
