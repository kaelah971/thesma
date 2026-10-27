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
- [ ] Slice 8: Verification procurement agent
- [ ] Slice 9: Autonomy ladder + unified decision ledger
- [ ] Slice 10: Integrated testing, production migration/activation, proof, README/demo

## Current slice
- Slice 7 SHIPPED: reliability kernel (scoreReliability with 5 components, fairness rule, PROVISIONAL/ESTABLISHED/STRONG_EVIDENCE) + retention model (D7/D30 windows from canonical VERIFIED trails, matured-denominator rates, UNSUPPORTED/REVIEW/PENDING/MISSED) + quality classification (6 states) + anomaly detector (4 signals, INFO/REVIEW, never auto-rejects) + verification readiness for Slice 8 (no purchasing) + loaders + retention.qualified audit on fresh VERIFIED + reliability audit at invite + review flags in growth evaluate + quality block in growth briefing + public profile proof-first retention + match evidence boost (capped, cold-start neutral) + match DTO reliability + Scout retained-evidence + CFO retention-gated scoring (milestone-deal campaigns only). No migration; no new contract; no external calls.

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
- typecheck clean + lint clean + build clean + 219 targeted green across 16 suites (19 reliability + match/scout/autojoin/background/ux/cfo/invitations/hybrid/checkout/buy-checkout/payout/growth/campaigns/profile/market) (this session). Shared kernels untouched (reuse only), no full-suite run.

## Next action
- Slice 8: Verification procurement agent.
