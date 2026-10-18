<div align="center">

<p align="center">
  <img
    src="./public/brand/thesma-wordmark.png"
    alt="Thesma"
    width="320"
  />
</p>

<h1>THESMA</h1>

<p><strong>Autonomous operators for outcome based campaigns.</strong></p>

<p><em>Pay only for verified results.</em></p>

<p>Businesses define the outcome, budget and rules. Thesma coordinates campaign execution, verification and settlement so money moves only when proof, policy and budget agree.</p>

<p><code>INTENT → POLICY → PROOF → SETTLEMENT</code></p>

<p>
<a href="https://thesma.vercel.app"><img src="https://img.shields.io/badge/OPEN_THESMA-LIVE_APP-63FF2A?style=for-the-badge" alt="Open Thesma — live app" /></a>
<a href="docs/mainnet-proof.md"><img src="https://img.shields.io/badge/MAINNET_PROOF-EVIDENCE-111111?style=for-the-badge" alt="Mainnet proof — evidence" /></a>
</p>

<p>
<img src="https://img.shields.io/badge/track-autonomous_business_operator-45E0CF?style=flat-square" alt="Track: Autonomous Business Operator" />
<img src="https://img.shields.io/badge/network-Arc_Mainnet-4CC9FF?style=flat-square" alt="Network: Arc Mainnet" />
<img src="https://img.shields.io/badge/settlement-USDC-66F2A2?style=flat-square" alt="Settlement: USDC" />
<img src="https://img.shields.io/badge/proof-reconciled-66F2A2?style=flat-square" alt="Proof: reconciled" />
<img src="https://img.shields.io/badge/safety-no_double_pay-66F2A2?style=flat-square" alt="Safety: no double pay" />
<img src="https://img.shields.io/badge/tests-182_passing-66F2A2?style=flat-square" alt="Tests: 182 passing" />
<img src="https://img.shields.io/badge/next.js-16-111111?style=flat-square" alt="Next.js 16" />
<img src="https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square" alt="TypeScript strict" />
</p>

<p><sub>Tameion Hackathon · RFB 04: Autonomous Business Operator</sub></p>

<p>
<a href="https://thesma.vercel.app">Website</a> ·
<a href="docs/mainnet-proof.md">Mainnet Proof</a> ·
<a href="#how-thesma-works">How It Works</a> ·
<a href="#technical-architecture">Architecture</a> ·
<a href="#local-setup">Local Setup</a>
</p>

</div>

---

## Live production usage

On October 18, 2026, a user-operated production run took a fresh Thesma campaign from approved policy to LIVE on Arc Mainnet through the deployed web app and MetaMask — not a script-only chain call.

- Workspace: Beaconfield Studio
- Campaign: `dcec0b71-2a4d-496c-b573-6999d09c8cb2`
- Budget funded: **0.90 USDC** (900,000 micro-USDC)
- Register campaign: `0x09fed70acc01a01db5a338226d58bafd5664cc485aa5663711a634682c1c9377`
- Approve USDC: `0xd0ee24f7acf0c0689efb633f00da19b66c0cbf0ec1ac70f1281b7f8a07d92006`
- Fund campaign: `0x10465a59d6fc5309fc8220a04f0af9f81d8bd564def54d567502328842fbcae6`
- Reconciled product state: **LIVE**, funding **CONFIRMED**, funded **900000**, spent **0**

The owner signed each transaction in the Thesma UI. Thesma moved the campaign to LIVE only after independently reading Arc and matching the expected onchain funding state.

This run is intentionally separate from the canonical completed lifecycle below. Run #1 already completed:

customer purchase → deterministic verification → legitimate 1-hour safety hold → partner payout → independent onchain reconciliation → SETTLED.

This demonstrates both:
1. a fresh user-operated campaign can be launched through the production product;
2. the canonical full lifecycle has already settled successfully on Arc Mainnet.

### Proof #2: real customer purchase, VERIFIED in hold

The same production campaign then processed a real public customer checkout through the deployed app — no Thesma account required. The customer connected a wallet, signed the exact USDC transfer in MetaMask, and the backend verified it by independently reading Arc.

- Partner: Jordan Lee (`0007a280-d3fd-4872-ab2e-146c5d045681`), terms `7d253855-19f2-4847-8c99-c29883c756ca`, referral `GQzyC4jPnMAy`
- Checkout intent: `4779e772-f62a-4926-ae4d-59ecd894f5e0`, order `ord_f4d98886bfe9194d365cb5c4`
- Purchase tx: `0x0b967b216d8eada977d1fd738425a40bda490a2daaeca335fde0e500ba2c0812` (receipt `success`, block `26548564`)
- Customer: `0x15b8605e7ce72E114aBeAF1D8b3315C0874B53E7`, merchant: `0x51c63A4bcF8E622D686bF1D7ec5ae5b77D50E677`, amount **0.90 USDC** (900,000 micro-USDC; decoded onchain recipient and amount match exactly)
- Outcome: `5fb1e592-0a87-4bcf-a502-9cdb98cb295d`, status **VERIFIED**, proof hash `0xdc0f207f682623e0f05165262cfa63d8ea4cd6a3b5884feb7ce82e16018a0fd7`
- Verified: `2026-10-18T04:50:26.889Z`; safety hold **3600 seconds** until `2026-10-18T05:50:26.889Z` (06:50:26 Nigeria time)

At the time of writing, Proof #2 is VERIFIED and serving its legitimate safety hold. It is NOT settled: no reservation, no payout, and no `OutcomePaid` event exist for this outcome. Run #1 remains the canonical completed SETTLED lifecycle.

### Fresh campaign through the production UI

Screenshots captured immediately before Proof #2 funding — the campaign waiting in FUNDING with zero funded/settled state, not the later LIVE/VERIFIED state.

<table>
  <tr>
    <td width="50%"><img src="docs/readme/proof2-campaign-pre-funding.jpg" alt="Proof #2 campaign detail before funding" /><br /><sub><strong>Campaign detail (pre-funding)</strong> — approved 0.90 USDC policy, 1h safety hold, and the owner-side "Continue funding" flow before mainnet activation.</sub></td>
    <td width="50%"><img src="docs/readme/proof2-overview-pre-funding.jpg" alt="Proof #2 workspace overview before funding" /><br /><sub><strong>Overview (pre-funding)</strong> — fresh production workspace with zero funded/settled state; the campaign waiting in FUNDING.</sub></td>
  </tr>
</table>

---

## Proof at a glance

Thesma completed the full real lifecycle on **Arc Mainnet (chain ID 5042)**. Full canonical evidence: [`docs/mainnet-proof.md`](docs/mainnet-proof.md). All hashes/addresses below are public onchain data.

- **FUNDED** — exactly **1.00 USDC** of campaign funding on Arc Mainnet (tx `0x5302634da4500b29338a14739917aff66d22e902f1d8dcf910f91a4f1cec05a3`, CONFIRMED 1,000,000 / 1,000,000 micro-USDC).
- **PURCHASED** — one real customer purchase, payer → company, tx `0xddf1fd01f815b69c5e30487d2916c6e91186f58af293fd38b5bfef15473aa5ad`.
- **VERIFIED** — deterministic outcome verification succeeded (`2026-10-17T19:48:17.123Z`), proof hash `0xca8a726ab92366eade1acd4186e5aa01e9b120e94a5da18eb6587e5703a8c9e2`.
- **HELD** — legitimate **3600-second** safety hold enforced before any payout became eligible.
- **SETTLED** — exactly **1.00 USDC** partner payout submitted once (tx `0xec3ab9e2bd8ad1ce1412fc0c2c4a65897dc598ddc221c3ef18cd148f350cb6b0`) and reconciled against the matching onchain `OutcomePaid` event.
- **NO DOUBLE PAY** — a second worker run settled 0 and submitted 0 with reason `ALREADY_SETTLED`: no second reservation, no second payout, no second transaction.

## How Thesma works

A business describes its intent in plain language. Thesma turns it into a typed campaign policy, funds it onchain, and then enforces the policy end to end:

`business intent → typed campaign policy → campaign funding → partner participation → customer outcome → deterministic verification → safety hold → payout reservation → signed submission → independent reconciliation → settled receipt`

What this guarantees:

- **Arc Mainnet is live and proven.** The canonical lifecycle above ran on chain 5042 against the deployed `ThesmaMarketVault` (`0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`).
- **USDC settlement is real.** Exactly 1,000,000 micro-USDC moved from funded budget to partner wallet, matched event-for-event onchain.
- **Payout authority is policy-bound.** The company grants payout authority when it funds a campaign inside hard limits (budget, floor, ceiling, deadline). No per-payout approval exists — and none is needed, because the worker can only pay what the frozen policy allows.
- **Duplicate settlement is structurally impossible.** One reservation and one payout per outcome for life (unique constraints), plus a second-run `ALREADY_SETTLED` proof.
- **Outcome proof is EIP-712.** The verifier signs the exact outcome proof; the executor submits once; reconciliation independently matches the `OutcomePaid` event before anything is called settled.
- **Signing responsibilities stay separated.** Campaign funding is signed by the owner in their own browser wallet (the backend only prepares unsigned intents and verifies receipts). Payout submission and outcome-proof signing run through isolated backend executor/verifier roles bound into each campaign — and the backend refuses to start unless those keys derive to the configured addresses.
- **The Operator explains; rules authorize.** The in-app Operator answers deterministically over the live workspace snapshot. Financial authorization comes only from the deterministic kernels and onchain reconciliation — an LLM never decides a payout.

What Thesma does **not** claim: Circle Gateway, CCTP, x402, Circle Wallets / App Kit / Agent Stack, paymasters, fiat ramps, or LLM-decided payouts.

## Product

Screenshots from the live production app at [thesma.vercel.app](https://thesma.vercel.app), showing the real Arc Mainnet proof campaign (1.00 USDC funded, one payout settled and reconciled onchain).

<p align="center">
  <img src="docs/readme/landing.png" alt="Thesma landing page" width="900" />
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/readme/overview.png" alt="Thesma workspace overview" /><br /><sub><strong>Overview</strong> — funded, available, verified and settled budget at a glance.</sub></td>
    <td width="50%"><img src="docs/readme/campaign-create.png" alt="Draft a campaign from plain language" /><br /><sub><strong>Campaign creation</strong> — plain-language intent becomes a draft policy; nothing is funded until the owner approves.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/readme/campaign-detail.png" alt="Campaign detail with policy and funding" /><br /><sub><strong>Campaign detail</strong> — frozen policy, confirmed onchain funding and budget accounting.</sub></td>
    <td width="50%"><img src="docs/readme/operator.png" alt="Operator answering over live workspace state" /><br /><sub><strong>Operator</strong> — deterministic answers over live workspace state.</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/readme/payout-receipt.png" alt="Settled payout receipt with live checks" width="50%" /><br /><sub><strong>Payout receipt</strong> — marked settled only after reconciliation matched the onchain <code>OutcomePaid</code> event.</sub></td>
  </tr>
</table>

### Product surfaces

The live app gives each workspace:

- **Overview** — funded vs committed vs available budget per campaign.
- **Campaigns** — draft, review, approve, fund, and open markets within policy bounds.
- **Outcomes** — every customer outcome with truthful state: `PENDING`, `VERIFIED` (evidence passed — **not** paid), `REJECTED`.
- **Payouts** — reservation → submission → reconciliation states; `SUBMITTED` is never called settled.
- **Receipts** — human-readable payout receipts with live-recomputed checks (funded, terms match, wallet match, hold) and a truthful `settledMeansReconciled` flag.
- **Activity** — append-only audit trail of who did what, when.
- **Operator** — deterministic answers over live workspace state (status, holds, budget, verified outcomes, receipts).
- **Owner funding** — connect MetaMask → register campaign → approve USDC → fund → independent onchain confirmation → LIVE. Recorded funding steps are never blindly resent; submitted/ambiguous funding state reconciles first.
- **Public checkout** — `/buy/[attributionHandle]` with no Thesma account required. Wallet safety is enforced before signing (correct Arc chain, payer ≠ merchant, payer ≠ partner payout wallet, balance check) and the backend validates the exact unsigned USDC transfer; the browser only submits the tx hash and the server mints `VERIFIED` from canonical Arc evidence only, with the 1h safety hold shown to the customer. Prepared/submitted checkout state survives refresh with no duplicate intent or payment resend.
- **Automatic payouts** — `processEligiblePayouts()` scans `VERIFIED` outcomes: hold-active outcomes are skipped, expired holds follow reserve → submit once → reconcile `OutcomePaid` → `SETTLED`, settled outcomes are skipped, and submitted/ambiguous payouts reconcile before any resend. No per-payout user approval or manual prompt is required. Vercel Cron invokes the same worker via `GET /internal/payouts/process` (the existing authenticated trigger remains `POST`); the current Hobby deployment runs this cron daily as a production backstop, while the worker itself supports higher-frequency invocation without code changes.
- **Public market discovery** — `/markets` needs no login: LIVE markets (PUBLIC + LIVE + OPEN + unexpired) plus a completed history that stays visible after close/expiry with factual results only (goal, final state, verified outcomes, spend, verified revenue and realized CAC when computable — never fabricated). `/markets/[campaignId]` shows the judge-proof detail: terms, progress, agent decisions, funding state, and for completed markets payouts, receipts and Arc explorer links where available. PRIVATE campaigns never leak.
- **Supply Agent onboarding** — `/app/agent` starts from one question ("What kinds of outcome markets should I watch for you?") and progressively gathers minimum bounty, auto-join/auto-negotiate and caps. Answers become typed `PartnerRules` (exact micro-USDC, allow/block lists, caps, toggles) through the existing rules service — chat never writes, and nothing activates until the confirmation card is pressed. The agent dashboard shows real state (watching/matched/joined/skipped-with-reasons/negotiations), answers questions from live market data, and runs eligible auto-joins through the unchanged join policy on explicit invocation. Negotiation automation is not available in this build.

## Technical architecture

Route handlers are adapters, not business logic. Domain logic lives in `src/server/domain` + `src/server/services`; chain access goes through `src/server/chain` (fail-closed: RPC `eth_chainId` must equal `ARC_CHAIN_ID`).

```
src/
  app/                  # Next.js App Router: pages + /api/* route adapters
  server/
    db/                 # Drizzle schema/client (DATABASE_URL boundary)
    chain/              # Arc RPC boundary, EIP-712 signers, receipt checks
    domain/             # enums, types, money, Zod validation (no I/O)
    services/           # campaigns, funding, market, payouts, negotiations (transactional)
    auth/               # session, password, server-side guards
    api/                # typed error envelope
contracts/              # ThesmaMarketVault (Solidity, Foundry-tested, deployed on Arc Mainnet)
```

Money uses exact integer micro-USDC (`bigint` + decimal strings) — never floating point. Agent models never receive raw private keys and never write directly to chain.

## Local setup

```bash
npm install
cp .env.example .env        # set DATABASE_URL to any Postgres
npm run db:generate         # generate migration from Drizzle schema
npm run db:migrate          # apply ./drizzle to DATABASE_URL
npm run dev                 # http://localhost:3000
```

Postgres options: local Postgres, Neon, or Supabase — any works, domain code is not coupled to a provider.

## Env vars

| Var | Required | Purpose |
| --- | -------- | ------- |
| `DATABASE_URL` | yes (runtime) | Provider-neutral Postgres connection. Build + unit tests pass without it; API routes return `503 UNCONFIGURED` until set. |
| `SESSION_COOKIE_NAME` | no | Defaults to `thesma_session`. |
| `ARC_CHAIN_ID` | for funding | Expected chain ID; RPC `eth_chainId` must match or every chain op fails closed. |
| `ARC_RPC_URL` | for funding | Arc RPC endpoint. Absent → funding APIs report unconfigured, `arc:doctor` reports NOT_CONFIGURED. |
| `ARC_USDC_ADDRESS` | no | Defaults to `0x3600000000000000000000000000000000000000` (Arc USDC). |
| `THESMA_VAULT_ADDRESS` | for funding | Deployed `ThesmaMarketVault`. Absent → intents cannot be built. |
| `THESMA_EXECUTOR_ADDRESS` | for campaign creation | Executor bound into created campaigns. |
| `THESMA_VERIFIER_ADDRESS` | for campaign creation | Verifier bound into created campaigns. |
| `ARC_EXPLORER_BASE_URL` | no | Optional explorer base for receipt links. |
| `ATTRIBUTION_SECRET` | for referrals | HMAC secret for signed attribution tokens (≥32 chars, fails closed). |
| `VERIFIER_INTERNAL_SECRET` | for workers | Bearer secret for internal verify routes (≥16 chars, fails closed). |
| `PAYOUT_WORKER_SECRET` | for workers | Bearer secret for payout worker routes (falls back to verifier secret). |
| `CRON_SECRET` | for workers | Server-only secret Vercel Cron sends as Bearer auth for `GET /internal/payouts/process`. Both the cron `GET` and the authenticated `POST` reuse the same `processEligiblePayouts()` worker. |
| `THESMA_VERIFIER_PRIVATE_KEY` | for settlement | Isolated local verifier key; must derive to `THESMA_VERIFIER_ADDRESS`. |
| `THESMA_EXECUTOR_PRIVATE_KEY` | for settlement | Isolated local executor key; must derive to `THESMA_EXECUTOR_ADDRESS`. |

No secrets are committed. Server secrets are never exposed via `NEXT_PUBLIC` variables.

## Testing and verification

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run — 182 passing, 2 env-gated (Anvil) skipped
npm run build        # production build
npm run arc:doctor   # read-only chain check (never signs/broadcasts)
forge build/test    # run inside contracts/ (unit + fuzz + invariant + key vectors)
```

Current suite: **182 passing, 2 skipped** (the 2 skips require `ARC_ANVIL_TESTS=1` with a local Anvil node). Every money path is additionally pinned by the S8.2 mainnet proof above — the second worker run is the live no-double-pay test.

## Security guarantees

- Exact integer money everywhere; no floats, no rounding drift.
- `VERIFIED` never means paid; `SUBMITTED` never means settled — only independent onchain reconciliation settles.
- Safety holds enforced before payout eligibility; unknown receipts go `AMBIGUOUS`, never resend blindly.
- One reservation + one payout per outcome for life; concurrent outcomes share free-budget accounting (`funded − committed`) so campaigns can never overcommit.
- Chain mismatch, wrong vault, reverted receipts, or binding mismatches fail closed with evidence.
- Internal worker routes are bearer-secret gated; the backend refuses to construct signers unless keys derive to their configured addresses.
- Workspace isolation is server-side: every read and mutation is scoped to the caller's membership; only `ORGANIZATION_OWNER` can approve policy, fund, or open markets.

## Current limitations

Honest boundaries of the shipped product:

- No LLM is wired anywhere — intent parsing, pricing, negotiation, and Operator answers are deterministic kernels and fixed templates.
- Company and partner wallet addresses are registered, not cryptographically ownership-proven.
- Refund protection is the hold timer only; no refund-event detection exists.
- No Circle Gateway/CCTP/x402, no paymasters, no fiat ramps.
- No revenue/CAC analytics derived from purchases.
- Payout scheduling latency: the current Vercel Hobby production schedule runs the payout worker daily, so settlement can wait for the next run after hold expiry; payout safety and idempotency are unchanged, and lower latency needs a higher-frequency scheduler or plan.

## Engineering history

Thesma was built slice by slice. Milestones S0–S7 were **proven locally (Anvil)** at the time — deterministic kernels, transaction safety, and idempotency were all exercised without moving real funds. The canonical **Arc Mainnet** lifecycle completed later (S8.2, documented in [`docs/mainnet-proof.md`](docs/mainnet-proof.md)). History is preserved below without rewriting it: "LOCAL ONLY" marks where each slice stood when it shipped, not where the product stands today.

- **S0 — Foundation:** app + quality tooling, domain enums, micro-USDC money primitive, Drizzle tables + migration, email/password auth with workspace isolation, append-only audit.
- **S1 — Campaign intent + policy engine:** plain-text objective → typed draft; `DRAFT → REVIEW → APPROVED` with versioned owner-controlled policy; owner-only approval; immutable approved versions.
- **S2 — ThesmaMarketVault + Arc campaign funding:** non-upgradeable vault (`createCampaign`, owner-funded, pause/close/return-unspent, executor-only EIP-712 payout); owner signs funding in browser; `funding-intent → funding-submitted → funding-confirm` drives `APPROVED → FUNDING → LIVE`. Vault deployed to Arc Mainnet.
- **S3 — Live market + partner rules + join + referral:** owner-approved bootstrap bounty, strict partner rules, public discovery, transactional join with frozen terms snapshot, HMAC-signed attribution.
- **S4 — Customer purchase + attribution + outcome verifier:** customer USDC goes directly to the company wallet; single-use attribution sessions; verifier reads Arc independently and mints `VERIFIED` + proof hash + hold window.
- **S5 — Automatic payout + reservation + reconciliation:** hold-cleared scan, transactional reservation, single signed submission, independent `OutcomePaid` reconciliation, truthful receipts, crash-safe idempotency.
- **S6 — Dynamic demand agent + pricing kernel:** integer pace states, bounded reprice/ease-down, anti-thrash cooldown, pause on exhaustion.
- **S7 — Supply agent + negotiation:** solvency-capped kernel (`ACCEPT`/`COUNTER`/`REJECT`/`HOLD`), frozen negotiated terms, deterministic evaluation worker.
- **S7.1 — Accepted negotiation commitment safety:** atomic supply-unit + capacity-unit commit on ACCEPT, consumed exactly once by the first reservation.
- **S8 — Arc Mainnet proof:** deployment verification, funding, purchase, verification, hold, payout, reconciliation, and the live no-double-pay second run — all on Arc Mainnet (chain 5042).

## Docs

- [`docs/mainnet-proof.md`](docs/mainnet-proof.md) — canonical S8.2 mainnet evidence (detailed record).
- [`docs/MAINNET_RUNBOOK.md`](docs/MAINNET_RUNBOOK.md) — mainnet runtime provisioning runbook.
- [`docs/proof-pack/SAFE_AGENT_PAYMENTS_CHECKLIST.md`](docs/proof-pack/SAFE_AGENT_PAYMENTS_CHECKLIST.md) — safe agent payments checklist.
