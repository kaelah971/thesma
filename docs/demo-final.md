# Thesma — Judge Demo Script (Slice 10C)

**Target: 3–5 minutes. Everything below is either live production state or
explicitly marked as a manual checkpoint. Nothing is fabricated.**

Production: https://thesma.vercel.app · Arc Mainnet (chain 5042) ·
Vault `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79` (Sourcify `exact_match`,
see `docs/mainnet-verification.md`).

Manual checkpoints (need a real signed-in user — NOT performed in 10C):
- `MANUAL_CHECKPOINT:ORG_SMOKE` — view an owned workspace (Creator Matches, Growth, CFO, Autonomy, Ledger) as the org owner.
- `MANUAL_CHECKPOINT:CREATOR_SMOKE` — view /creator as @bgirl (Scout, Agent Authority, Opportunities, notifications).
- `MANUAL_CHECKPOINT:LIVE_INVITE` — create one real invitation to @bgirl through the UI (no email/push; creates exactly one INVITED row + notification).
- `MANUAL_CHECKPOINT:LIVE_ACCEPT` — accept as @bgirl (creates terms + referral only).
- `MANUAL_CHECKPOINT:LIVE_CUSTOMER` — a real customer purchase through a live referral (only with the customer's informed consent; real USDC moves).
- `MANUAL_CHECKPOINT:SCREENSHOTS` — no headless browser exists in this repo/sandbox, so no automated screenshots were captured; capture the listed screens by hand during 10C playback.

---

## 0:00–0:25 — Thesis (say it, then show it)

> "Thesma is an autonomous growth-finance operator. Most business agents
> automate bills. Thesma autonomously buys verified growth — it answers:
> *given the cash I have, which outcomes should I buy, from whom, at what
> price, how confidently can I verify them, and should I keep spending?*"

Show the README loop diagram. Then open the live app (`/`, 200).

## 0:25–1:15 — Organization: matches → invitation → frozen economics

Open `/markets` (live, 200) → Beaconfield (`dcec0b71…`, LIVE, 0.9 USDC bounty)
and Aster (`5571f328…`, completed proof). State the matching rule in one line:
*ranked by fit, evidence and economics — never by bounty alone, never by followers.*

If `MANUAL_CHECKPOINT:ORG_SMOKE` is available: open Creator Matches for a workspace
campaign. Point at one row: score, confidence, **WHY THIS CREATOR**, reliability
section (verified outcomes · campaigns with verified results · retained), and the
recommended INVITE/REVIEW action. Otherwise say: "Matching runs on live data;
the org-owner view needs the owner's session, so here is what the engine returns
for the same inputs" — and show `tests/slice10a-rehearsal.test.ts` (Slices 1–9
E2E on the memory store, green).

If `MANUAL_CHECKPOINT:LIVE_INVITE` is available: invite @bgirl once through the UI.
Show the frozen offer (bounty, hold, policy/market versions), the single
CAMPAIGN_INVITED notification, and that nothing else was created (no terms,
no referral, no payout, no reservation). Re-inviting is deduped.

## 1:15–1:55 — Creator agent: opportunity → decision → frozen terms

If `MANUAL_CHECKPOINT:CREATOR_SMOKE` is available: open /creator as @bgirl.
Show Campaign Scout, **AGENT AUTHORITY** (direct invitations: MANUAL — auto-join
is OFF for @bgirl, minimums and caps as she set them, hybrid always REVIEW),
and the Opportunity inbox with YOU CAN EARN / WHAT QUALIFIES / WHEN YOU GET PAID.
If `MANUAL_CHECKPOINT:LIVE_ACCEPT` is available: accept once; show one
participation + one referral + frozen economics + still no payout/reservation.
Otherwise: "Auto-join stays OFF because the creator left it off — the agent
refuses to invent consent. The REVIEW path is the proof, not a gap."

State the rule the audience must remember:
**ACCEPTED ≠ EARNED, VERIFIED ≠ PAID, SUBMITTED ≠ SETTLED.**

## 1:55–2:35 — Verified outcomes, quality, reliability

Show the two canonical VERIFIED outcomes (Aster 1.0 USDC, Beaconfield 0.9 USDC)
and their reliability readouts, computed live from production-shaped data:
- Earner partner (2 verified across 2 campaigns, 2 settled): score 52, LOW confidence, PROVISIONAL — thin sample stays provisional, never branded.
- @bgirl's partner (0 verified): score 50, LOW, PROVISIONAL — neutral, discoverable, not "bad".
- D7/D30 retention: no matured windows → null (pending windows are not failures).

If a checkout is demoed live, it must be `MANUAL_CHECKPOINT:LIVE_CUSTOMER`
with informed consent. Otherwise use the canonical onchain lifecycle below.

## 2:35–3:20 — Campaign CFO + verification decision

If `MANUAL_CHECKPOINT:ORG_SMOKE` is available: open the CFO panel on a real
workspace. Show available / committed / verified-unpaid / reserve / 24h forecast,
spend decisions, and prospective allocations that explicitly **chainMovement:
UNAVAILABLE** — "CFO recommends; it never moves money."
Then the VERIFICATION AGENT card: current production state is
**NOT_CONFIGURED** (no provider, no wallet, no policy row — verified live).
Explain the economics gate with the canonical example: a 0.08 USDC check
against a 12 USDC exposure is 67 bps vs a 200 bps policy cap — *if* it were
configured. The x402 v2 transport itself is proven by 30 green protocol tests.

## 3:20–4:10 — Financial operator: real Arc money, reconciled

Read the chain live (or show the 10C-recorded read):
- Aster campaign onchain: funded **1,000,000** = spent **1,000,000** micro-USDC,
  not paused/closed — exactly matching the DB's SETTLED payout.
- `docs/mainnet-proof.md`: fund → purchase → verify (2026-10-17T19:48:17Z) →
  hold → reserve → submit once (tx `0xec3ab9…`) → reconcile → SETTLED with
  `OutcomePaid`; the Beaconfield 0.9 USDC run shows hold-then-verify with
  re-submission refused (no-double-pay proof).
- Unified decision ledger maps the real history: SUBMITTED stays EXECUTED,
  only reconciliation earns SETTLED; the one AMBIGUOUS payout later reconciled
  to SETTLED (the ledger shows both, honestly).

## 4:10–5:00 — Autonomy ladder, ledger, and the close

If `MANUAL_CHECKPOINT:ORG_SMOKE` is available: open THESMA AUTHORITY —
per-capability rows (matching ADVISORY, invitations HUMAN, bounty ADVISORY
today, capital ADVISORY, payouts AUTONOMOUS within bounds, verification
NOT_CONFIGURED, hybrid settlement UNSUPPORTED), the metrics row (2 obligations
settled, 1.9 USDC, 0 escalations open), and the filtered decision ledger.

Close with the RFB-04 mapping:

| Judge question | Thesma answer |
|---|---|
| WHO should we buy from? | Creator Match Agent |
| SHOULD THE CREATOR TAKE IT? | Creator Scout / auto-join authority |
| WHAT PRICE? | Growth intelligence + hybrid deal composer |
| WHERE SHOULD NEW CAPITAL GO? | Campaign CFO (prospective, never moved) |
| IS THE OUTCOME GOOD? | Reliability / retention / quality agent |
| IS EXTRA VERIFICATION WORTH BUYING? | Verification procurement agent (NOT_CONFIGURED in prod, protocol-proven locally) |
| CAN WE PAY? | Financial operator (policy + liquidity + proof) |
| WHY DID THESMA DO THAT? | Unified decision ledger — every row traceable to an audit event |

Final line: *"No fake users, no fake conversions, no fake providers. Where a
human is required — accepting, funding, approving above limits, enabling a new
provider — Thesma stops and says so. That restraint is the product."*

---

## Appendix: 10C factual production snapshot (read-only, 2026-10-27)

- Users: 9 rows (traction claim stays the canonical **2 users** per user instruction — DB rows are accounts, not traction).
- Workspaces: 6 (incl. Beaconfield Studio, Aster Media, Alder & Finch Coffee Roasters).
- Campaigns: 7 (2 LIVE with CLOSED/completed markets: Aster 5571f328, Beaconfield dcec0b71; 2 APPROVED awaiting markets; 3 DRAFT).
- Verified outcomes: 2 (1.0 + 0.9 USDC, single partner, two campaigns).
- Payouts: 2 SETTLED (1,000,000 + 900,000 micro-USDC = **1.9 USDC settled**); reservations: 2.
- Fundings: 2 CONFIRMED (1.0 + 0.9 USDC). Invitations: 0. Hybrid deals/milestones: 0. Procurement policies/procurements: 0.
- Audit events: 93 (30 normalize to decision envelopes: 9 autonomous decisions, 10 autonomous executions, 0 open escalations after sibling-resolution, 0 refusals).
- Creator persona: 1 (@bgirl, onboarded, category ai). Auto-join: OFF (explicit). Growth optimization: disabled by default. Procurement: disabled, unconfigured.
- Onchain (Arc mainnet, read 2026-10-27): block 0x1adc429; Aster campaign funded=spent=1,000,000, not paused/closed/returned; bounty ceiling 1,000,000.
- No invitations, referrals (beyond the 2 historic), payouts, or reservations were created by 10B/10C verification. Aster/Beaconfield/@bgirl unchanged.
