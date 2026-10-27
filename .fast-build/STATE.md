# Fast Build State

## Product
- Name: THESMA
- Outcome: Autonomous growth marketplace — orgs buy verified outcomes, creators earn inside rules.
- Primary demo path: Campaign → Match creators → Invite → Accept → Join → Verify → Settle → Proof profile.

## Existing capabilities (trusted)
- Creator Scout (score/decision/confidence), auto-join authority, idempotent joinCampaign, referrals, frozen terms.
- Background Scout + creator_notifications (dedupe, daily Hobby cron), public /@handle profiles, follows.
- Growth kernel (pace, bounty optimization, allocation, liquidity), payouts + reconciliation, auditEvents.
- Persona onboarding (POST /api/persona), partner rules API, org workspaces/memberships.

## MVP slices (autonomous growth marketplace)
- [x] Slice 1: Creator capability graph + org match engine (332cd11)
- [x] Slice 2: Org creator discovery + invitations (02bd4df)
- [x] Slice 3: Creator opportunity inbox + accept/decline (914263e)
- [x] Slice 4: Creator agent invitation auto-accept (f2084da + toggle-copy fix this session)
- [x] Slice 5: Campaign CFO + cross-campaign capital allocator (this session)
- [x] Slice 6: Hybrid creator deals + expanded outcome economics (this session)
- [x] Slice 7: Creator reliability + outcome quality/retention (this session)
- [x] Slice 8: Verification procurement agent (this session)
- [x] Slice 9: Autonomy ladder + unified decision ledger (this session)
- [ ] Slice 10: Integrated test + production activation + proof

## Current slice
- Slice 9 SHIPPED: unified autonomy + decision ledger (envelope, ladder, escalations, metrics, read-only ledger over existing auditEvents; no new persistence, no migration, no new powers, no policy widened). See Appendix A for the audited decision systems.

## Files (slice 9)
- src/server/services/autonomy.ts (envelope, 60+ event mapping, ladder, escalations, metrics, ledger reader)
- src/app/api/operator/autonomy/route.ts + decisions/route.ts (member read-only) + creator/autonomy/route.ts (rules-only)
- src/components/app/AutonomyPanel.tsx (ladder + metrics + escalations + filtered ledger)
- src/components/start/CreatorAutonomyPanel.tsx (creator authority, on /creator)
- src/app/creator/page.tsx + OperatorWorkspace.tsx (wiring)
- docs/integration-readiness.md (Slice-10 inventory: migrations, env, not-configured, unsupported, journal risk)
- tests/autonomy.test.ts (17 tests)

## Files (slice 8)
- src/server/services/verification.ts (provider interface, policy, decision engine, x402 v2 client, signer, normalization)
- src/server/services/verificationProcurement.ts (evaluate/execute orchestration, idempotency, ambiguity, spend accounting, CFO hook)
- src/server/services/verification.test-resource.ts (local x402 v2 test server, test-only, prod-gated)
- src/server/db/schema.ts (verification_procurements, verification_procurement_policies) + drizzle/0017_outstanding_misty_knight.sql + meta (committed, NOT applied)
- src/server/services/campaignStore.ts + .drizzle.ts (procurement + policy impls)
- src/server/services/cfo.ts (verification spend/pending in org totals)
- src/app/api/operator/verification/route.ts (member read) + evaluate/route.ts (owner evaluate)
- src/components/app/GrowthPanel.tsx (VERIFICATION AGENT card)
- tests/verification.test.ts (30 tests)

## Files (slice 7)
- src/server/services/reliability.ts (score/retention/quality/anomaly/readiness kernels + loaders + retention audit)
- src/server/services/matching.ts (evidence boost, reliability DTO, defaultHistory consistency+retention)
- src/server/services/scout.ts (retained-evidence per candidate)
- src/server/services/checkout.ts (retention.qualified hook on fresh VERIFIED)
- src/server/services/invitations.ts (creator.reliability.evaluated at invite)
- src/server/services/cfo.ts (retention-gated capital score, milestone-deal campaigns only)
- src/server/services/creatorProfiles.ts (public proof-first retention + campaignsWithVerified)
- src/server/services/growth.ts (review_flagged audit action) + growth GET/evaluate routes (quality block + flags)
- src/server/services/campaignStore.ts + .drizzle.ts (intent list/count accessors)
- src/components/app/CreatorMatches.tsx + GrowthPanel.tsx + app/[handle]/page.tsx (reliability/quality UI)
- tests/reliability.test.ts (19 tests)

## Files (slice 6)
- src/server/services/deals.ts (kernel + milestone awards + base review + settlement audit)
- src/server/db/schema.ts (hybridDeals, milestoneAwards) + drizzle/0016_cuddly_selene.sql + meta (committed, NOT applied)
- src/server/services/campaignStore.ts + .drizzle.ts (hybrid + milestone-award + per-partner verified count impls)
- src/server/services/invitations.ts (frozen deal create/accept, HYBRID_REVIEW auto-accept gate)
- src/server/services/checkout.ts (milestone hook on VERIFIED, best-effort)
- src/server/services/cfo.ts (hybridCommitted/hybridContingent financials)
- src/app/api/deals/[id]/verify-base/route.ts + campaigns/[id]/invitations/route.ts (deal payload)
- src/components/app/CreatorMatches.tsx (hybrid composer + exposure preview) + OpportunityInbox.tsx (YOU CAN EARN)
- tests/hybrid-deals.test.ts (15 tests)

## Files (slice 5)
- src/server/services/cfo.ts (score/spend/capital/allocate kernels + org snapshot loader + capital plan + audit)
- src/app/api/operator/cfo/route.ts (member-readable GET) + evaluate/route.ts (owner POST, ledgers plan)
- src/components/app/CfoPanel.tsx + OperatorWorkspace wiring (org CFO section)
- tests/cfo.test.ts (13 tests)

## Files (slice 4)
- src/server/services/scout.ts (evaluateInvitationAuthority + recovery hook)
- src/server/services/invitations.ts (evaluateAndAutoAccept, recoverCreatorInvitations, acceptedBy, agent assessment, AUTO_JOINED)
- src/app/internal/agents/scout/run/route.ts (recovery wiring, no new cron)
- src/components/start/OpportunityInbox.tsx + src/components/app/CreatorMatches.tsx (agent/status UX)
- src/components/start/AutoJoinToggle.tsx (copy covers open campaigns + direct invitations)
- tests/creator-invitations.test.ts (26 tests)

## Files (slice 3)
- src/server/services/invitations.ts (accept/decline + inbox read model)
- src/app/api/creator/invitations/* (inbox + accept/decline routes)
- src/app/creator/page.tsx + src/components/start/OpportunityInbox.tsx

## Files (slice 1+2)
- Slice 1: matching.ts, personas.ts, schema.ts, 0014_creator_capability.sql, persona route, OnboardingForms, creator-matching.test.ts (13 tests)
- Slice 2: invitations.ts, matches/invitations routes, CreatorMatches.tsx, campaignStore persistence, 0015_creator_invitations.sql

## Blockers
- Migrations 0014/0015 committed but NOT applied to prod; no prod deploy/migration/mutation until slice 10.
- Arc Showcase/Mainnet submission complete (b7f4c6a, accd972) — preserved, untouched; no contract redeploy, no mainnet tx, no Sourcify changes.

## Verification
- typecheck clean + lint clean + build clean + FULL SUITE green: 505 passed / 2 skipped (opt-in anvil) across 50 files, incl. 17 new autonomy tests (this session).

## Protocol research (Slice 8, recorded 2026-10-27)
- x402 v2 HTTP semantics implemented per product spec: 402 → PAYMENT-REQUIRED → client validates → PAYMENT-SIGNATURE retry → PAYMENT-RESPONSE. Exact-match only; v1 X-PAYMENT headers explicitly rejected.
- CAIP-2 network ids; Arc mainnet eip155:5042 used as the canonical network constant.
- No x402 npm package installed; no live spec fetch possible from this offline build sandbox (no web access). Provider payload shapes beyond the three headers are adapter-isolated and MUST be confirmed against the current official x402 spec before any mainnet use.
- viem 2.57.7 (repo-pinned) used for procurement signing/recovery; no new payment dependencies.
- Real provider discovery: none suitable found/connected from sandbox (no subscriptions, no funds, no paid calls). Local deterministic test resource only; real execution = CONFIGURATION_REQUIRED. Never presented as traction.
- Circle Gateway/nanopayments: no repo integration exists (README explicitly disclaims it); boundary left as env config, no provisioning in this slice.

## Next action
- Slice 10: Integrated test + production activation + proof.

## Appendix A — Slice-9 decision systems audit (source of mapping truth)
- CREATOR_SCOUT: scoreCandidate + evaluateAutoJoinAuthority (RECOMMEND/JOIN/REFUSE) + background runs; events: creator.autojoin.evaluated/executed, creator.scout.background.completed.
- CREATOR_INVITATION_AGENT: AUTO_ACCEPT/REVIEW/REFUSE + accept/decline/cancel; events: creator.invitation.* (7 kinds).
- CREATOR_MATCH_AGENT: INVITE/REVIEW/SKIP/NOT_ELIGIBLE + reasons; event: match_engine.run.
- CAMPAIGN_CFO: CONTINUE/SLOW/PAUSE/ESCALATE/COMPLETE + INCREASE/KEEP/REDUCE/PAUSE_NEW/NO_ACTION + proportional allocation; events: cfo.plan.generated, cfo.campaign.decision, cfo.escalated. Never executes onchain (no transfer primitive).
- GROWTH_OPTIMIZER: KEEP/INCREASE/DECREASE/ESCALATE/NO_ACTION + PAUSE + allocation; events: operator.growth.evaluated, operator.bounty.*, operator.allocation.recommended, pricing.decision.
- FINANCIAL_OPERATOR: PAY_NOW/WAIT_FOR_HOLD/HOLD_FOR_LIQUIDITY/ESCALATE_APPROVAL/NO_ACTION; payout lifecycle PREPARED→RESERVED→SUBMITTED→SETTLED (+FAILED/AMBIGUOUS/RELEASED); funding prepared/submitted/confirmed/failed/ambiguous; events: operator.decision, operator.escalation(.decision), payout.*, campaign.funding.*.
- VERIFICATION_AGENT: NO_CHECK/BUY_CHECK/WAIT/ESCALATE/REFUSE; states CANDIDATE→…→RESULT_RECEIVED (+FAILED/AMBIGUOUS); events: verification.procurement.* (7 kinds).
- QUALITY_AGENT: reliability PROVISIONAL/ESTABLISHED/STRONG_EVIDENCE; quality states (6); anomaly INFO/REVIEW; readiness NONE/REVIEW/EXTERNAL_CHECK_CANDIDATE; events: creator.reliability.evaluated, outcome.quality.review_flagged, retention.qualified, outcome.verified, checkout.confirmed.
- HYBRID (via invitation agent): PERFORMANCE_ONLY/BASE_PLUS/MILESTONE/HYBRID_FULL; base PENDING→VERIFIED→SETTLEMENT_NOT_SUPPORTED; milestones one-time; settlement UNSUPPORTED onchain; events: creator.deal.accepted/milestone.awarded/base.verified.
- Unified layer changes NONE of the above; it only names agentType/authorityState/executionState per row.
