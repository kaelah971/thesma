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
- [ ] Slice 5: Campaign CFO + cross-campaign capital allocator
- [ ] Slice 6: Hybrid creator deals + expanded outcome economics
- [ ] Slice 7: Creator reliability + outcome quality/retention
- [ ] Slice 8: Verification procurement agent
- [ ] Slice 9: Autonomy ladder + unified decision ledger
- [ ] Slice 10: Integrated testing, production migration/activation, proof, README/demo

## Current slice
- Slice 4 SHIPPED: invitation authority adapter reuses evaluateAutoJoinAuthority on frozen offer → AUTO_ACCEPT/REVIEW/REFUSE; immediate evaluation on invite (failure leaves INVITED); same acceptInvitation path (AGENT mode); background recovery via existing Scout worker (quiet/idempotent); agent UX on inbox + org panel; AUTO_JOINED dedupe + CAMPAIGN_INVITED read; agent_evaluated audit. REFUSE never declines; manual override preserved.

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
- typecheck clean + lint clean + 39 targeted (matching + invitations) + 54 scout/autojoin/ux regression green (this session).

## Next action
- Slice 5: Campaign CFO + cross-campaign capital allocator.
