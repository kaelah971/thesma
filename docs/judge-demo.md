# Thesma — Judge Demo Guide
_No wallet. No signature. No USDC. No account needed for the core proof. Nothing here spends money._

## One-sentence thesis

Most business agents automate bills — **Thesma autonomously buys verified growth**: organizations fund measurable outcomes, creators earn against verified outcomes, and Thesma verifies, holds, settles, and proves every decision.

## 90-second judge path

1. `/` — read the thesis, click **Explore real proof**.
2. `/demo` — scroll the Aster lifecycle: funded → purchased → verified → held → settled, every hash opening in the Arc explorer.
3. `/markets` — see LIVE vs completed separation, open Aster for the settled receipt.

## 3-minute full demo path

1. `/` — thesis + proof strip (30s).
2. `/demo` — full 7-step Aster settlement with payout amount, settlement proof, and the no-double-pay second run (60s).
3. `/markets` — completed history first; open Aster (settled) and Beaconfield (verified-but-held, explicitly not settled) (45s).
4. `/@bgirl` — creator-side public identity: proof-first metrics, no follower scoring, marketplace-connected proof (30s).
5. Authenticated Northstar (org account required): Creator Matches with match reasoning → frozen 5 USDC invitation visible to both sides → PREPARED funding preview showing 50 USDC required vs 0 USDC balance with **Start signing disabled** — the safety story (45s).

## Build with Thesma judge-safe path

Open `/build` after developer onboarding. Create an organization-scoped integration and show the one-time key warning, then narrate the quickstart as **DEVELOPER QUICKSTART / SANDBOX EXAMPLE**: `ACTIVATED_USER = 8 USDC`, evidence for `user_123`, deterministic decision, hold state and receipt. If using a local/test database, submit the same event twice with the same `Idempotency-Key` to show the original event is returned; change the evidence with that key to show `IDEMPOTENCY_CONFLICT`. This proves an external integration boundary without claiming external customer traction or spending money.

The API base is `/api/v1`:

- `POST /api/v1/integrations` — owner session creates an integration and receives the key once
- `POST /api/v1/outcomes` — register a versioned bounded outcome definition
- `POST /api/v1/outcomes/:slug/events` — submit idempotent evidence
- `GET /api/v1/outcomes/events/:id` — read safe status, receipt and decision trail

## Shadow Operator judge-safe path

In the authenticated Operator workspace, an organization owner can enable **SHADOW** mode, run the deterministic portfolio/verification/settlement recommendations, and review each with `AGREE`, `OVERRIDE` (reason required), or `IGNORE`. The panel shows immutable input/policy snapshots, confidence segmentation and agreement telemetry. Every row stays `NOT_EXECUTED`; shadow mode blocks payments, x402 purchases, capital movement, creator invites and settlements. This path requires no wallet signature, testnet spend or mainnet activity.

## Exact routes

- Landing / thesis: `/`
- Real proof (no login): `/demo`
- Public markets: `/markets`
- Aster settled proof: `/markets/5571f328-ceeb-4712-8671-a72be1966ffb`
- Beaconfield intermediate proof: `/markets/dcec0b71-2a4d-496c-b573-6999d09c8cb2`
- Creator identity: `/@bgirl`
- Trust: `/security`, `/privacy`, `/terms`, `/.well-known/security.txt`
- Authenticated (org owner): Northstar campaign → Creator Matches → Funding card

## Proof to show

- **Aster (canonical):** 1 USDC funded → 1 real customer purchase → deterministic verification → 3600s hold → exactly one payout → reconciled against the onchain `OutcomePaid` event → SETTLED. Second worker run submitted zero (`ALREADY_SETTLED`).
- **Beaconfield (intermediate):** LIVE, funded, 1 VERIFIED purchase serving its hold. VERIFIED ≠ paid, HELD ≠ settled — stated on the page.
- **Northstar (safety):** workspace `northstar`, campaign `307eb746-dcd6-4f92-b640-cff9764a84f2`, FUNDING / PREPARED, 50 USDC intended, 0 funded, no tx, market closed until independently confirmed, registered wallet `0x85522b...894A33`, @bgirl frozen 5 USDC INVITED opportunity intact.

## Northstar safety story (authenticated, zero-spend)

"We matched @bgirl before funding. We froze the offer. The creator can already see it. The campaign is not live yet. The organization proved its wallet. The funding intent is prepared. The wallet has 0 USDC, so Thesma refuses to start signing."

The preview shows Available 0 USDC / Required 50 USDC / Shortfall 50 USDC with a disabled Start signing control. A failed balance read also fails closed (never treated as 0). No approval, signature, transaction, or new intent is created by the check.

## Aster real-money proof story

One real campaign on Arc Mainnet 5042: budget moved into `ThesmaMarketVault` (`0x0fA8…6F79`) first, a real customer paid the company, the backend verified by independently reading Arc, the hold expired, exactly one payout submitted, reconciliation matched the `OutcomePaid` event. Canonical record: `docs/mainnet-proof.md`.

## Known limitations (state explicitly, do not overclaim)

- External verification procurement: `NOT_CONFIGURED` without a provider/budget — never presented as purchased. Build with Thesma only records a value-of-information recommendation; this slice makes no x402 call.
- Build with Thesma V1 is campaign-independent and does not yet attach an eligible external receipt to a new payout executor, webhook delivery or arbitrary custom workflow.
- x402 v2: protocol-tested locally only; no live provider interoperability claimed.
- Cross-campaign capital movement: `UNAVAILABLE` by vault design; the allocator recommends, never moves. Shadow mode additionally blocks capital movement intents and other operator side effects.
- Hybrid base/milestone legs: settlement `UNSUPPORTED` onchain; recorded truthfully, not paid.
- Payouts run on a daily Hobby cron — settlement can wait for the next run after hold expiry.
- No Circle Gateway/CCTP, paymasters, or fiat ramps.
- Beaconfield market copy is a historical checkpoint, not current live state.

## Screenshot capture list (final walkthrough)

1. **Landing hero** — `/` — thesis + "Explore real proof" CTA. Narration: "Thesma doesn't automate bills; it buys verified growth."
2. **Demo lifecycle strip** — `/demo` (top) — FUNDED→SETTLED strip with Arc Mainnet pills. Narration: "One real campaign, every stage checkable."
3. **Demo settlement + no-double-pay** — `/demo` (steps 6–7) — payout amount, receipt, second-run-submits-zero. Narration: "Submitted is not settled — reconciliation settles, and the rerun proves no double pay."
4. **Markets completed history** — `/markets` — Aster settled above Beaconfield intermediate. Narration: "Completed proof stays visible; live and settled never mix."
5. **Aster detail** — `/markets/5571f328…` — TARGET_SETTLED, receipts, explorer links. Narration: "The canonical closed loop."
6. **Beaconfield detail** — `/markets/dcec0b71…` — VERIFIED purchase, hold language, no payouts. Narration: "Verified is not paid — this page says so."
7. **Creator profile** — `/@bgirl` — proof-first metrics, marketplace connection. Narration: "Creators have durable, evidence-based identities."
8. **Northstar matches + invite** (authenticated) — match reasoning + frozen 5 USDC offer, creator-visible pre-funding. Narration: "Matched and frozen before a cent moves."
9. **Northstar funding preview** (authenticated) — 50 required / 0 available / 50 shortfall, disabled Start signing. Narration: "Thesma refuses to start signing without funds — that refusal is the feature."
10. **Trust strip** (optional) — `/security` or demo pills — Arc Mainnet, verified contract, real USDC. Narration: "Safety is enforced, not promised."

## Verification behind this guide

- Full suite 920 passing / 2 intentional skips; typecheck, lint, build green; local browser smoke (desktop + mobile) green; CI 6/6 on the shipped commit.
- Public routes swept read-only Nov 1, 2026: all 200, correct titles, no error-boundary copy.
- Zero-spend: no production writes, no signatures, no broadcasts in preparing this guide.
