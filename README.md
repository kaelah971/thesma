# Thesma — Backend (S2: Vault + Funding)

**Thesma is an autonomous market for verified business outcomes.** A company sets a customer goal, budget, and hard limits; a Demand Agent prices the next verified result inside those limits while Partner Supply Agents join or negotiate inside their own rules. A deterministic verifier establishes whether a qualifying purchase happened before any payout settles in USDC on Arc (target).

> Status vocabulary: **Shipped** = implemented and exercised in this build. **Target** = specified but not yet proven. **Roadmap** = deferred. **Hypothesis** = needs validation.

## Arc Mainnet Proof

Thesma completed the full real lifecycle on **Arc Mainnet (chain ID 5042)** — exactly **1.00 USDC** of campaign funding, one real purchase, one verified outcome, one settled payout, reconciled against canonical onchain evidence, plus a live second-run no-double-pay proof. Full record: `docs/mainnet-proof.md`. No secrets below; all hashes/addresses are public onchain data.

Lifecycle: campaign funded → real purchase → outcome VERIFIED → legitimate 3600s safety hold → payout reserved → submitted once → reconciled SETTLED → second processing attempt skipped as ALREADY_SETTLED.

- Network: Arc Mainnet, chain ID **5042** (`https://rpc.mainnet.arc.io`)
- USDC (Arc canonical): `0x3600000000000000000000000000000000000000`
- ThesmaMarketVault (canonical): `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`
- Campaign ID: `5571f328-ceeb-4712-8671-a72be1966ffb`
- Campaign key: `0x28bfb4381fc8feb2af0e93d9b42eb2276d24631c762c4cd195f9f918b655f0b9`
- Policy hash: `0x83d2b960ce515e6989179baf2893cbab8d864851c597c7ae8405dec8944e007`
- Funding tx (1.00 USDC): `0x5302634da4500b29338a14739917aff66d22e902f1d8dcf910f91a4f1cec05a3`
- Purchase tx (1.00 USDC, payer → company): `0xddf1fd01f815b69c5e30487d2916c6e91186f58af293fd38b5bfef15473aa5ad`
- Outcome: **VERIFIED** (`2026-10-17T19:48:17.123Z`), proof hash `0xca8a726ab92366eade1acd4186e5aa01e9b120e94a5da18eb6587e5703a8c9e2`
- Payout: **SETTLED** — exactly **1,000,000 micro-USDC** to `0xeBB551653815900D6886d2eeEea2325d86275173`, tx `0xec3ab9e2bd8ad1ce1412fc0c2c4a65897dc598ddc221c3ef18cd148f350cb6b0`
- No-double-pay: second worker run settled 0, submitted 0, reason `ALREADY_SETTLED`; single tx, reservation and payout unchanged.

## Backend-first architecture (S0)

Route handlers are adapters, not business logic. Domain logic lives in `src/server/domain` + `src/server/services`; external systems plug in later through `src/server/adapters`. Money uses exact integer micro-USDC (`bigint` + decimal strings) — never floating point. Agent models will never receive raw private keys and never write directly to chain (enforced boundary for S1+).

```
src/
  app/                  # Next.js App Router: pages + /api/* route adapters
  server/
    db/                 # Drizzle schema/client (DATABASE_URL boundary)
    domain/             # enums, types, money, Zod validation (no I/O)
    services/           # workspaces, partners, audit (transactional logic)
    adapters/           # TARGET stubs: arc, vault, verifier, agents (not built)
    auth/               # session, password, server-side guards
    api/                # typed error envelope
```

## Stack (Shipped)

- Next.js 16 App Router + React 19 + TypeScript strict
- PostgreSQL via Drizzle ORM + migrations (provider-neutral `DATABASE_URL`)
- Zod v4 boundary validation
- Vitest tests, ESLint, npm
- Auth: lightweight email/password with `bcryptjs` + opaque DB sessions (`sessions` table, sha256 token hash, httpOnly cookie). No OAuth.
  - Why: avoids an auth rabbit hole for S0, stays Drizzle-first, keeps a clean swap boundary (`src/server/auth/*`) for better-auth/Auth.js later if needed.
- Chain: `viem` read client + unsigned-intent builder (never signs); Solidity `ThesmaMarketVault` + Foundry tests (forge-std, OpenZeppelin v5.7.0).

## Local setup

```bash
npm install
cp .env.example .env        # set DATABASE_URL to any Postgres
npm run db:generate         # generate migration from Drizzle schema
npm run db:migrate          # apply ./drizzle to DATABASE_URL
npm run dev                 # http://localhost:3000
```

Postgres options: local Docker (`docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16`), Neon, or Supabase — any works, domain code is not coupled to a provider.

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

No secrets are committed. Never put private keys in `.env` for the agent runtime.

## Commands

```bash
npm run dev          # local dev
npm run build        # production build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest run (no live DB required)
npm run db:generate  # drizzle-kit generate
npm run db:migrate   # apply migrations
npm run arc:doctor   # read-only chain check (never signs/broadcasts)
forge build/test    # run inside contracts/ (32 unit+fuzz+invariant + 2 vector pins)
```

## S7.1 Shipped — Accepted Negotiation Commitment Safety (LOCAL ONLY)

- **Problem fixed:** S7 ACCEPTED terms without locking economics; two 1M accepts on 1M funded both succeeded. Now ACCEPT atomically commits one supply unit (price x 1) + one capacity unit, so the second accept deterministically REJECTs.
- **Model:** `supply_commitments` (unique per negotiation; ACTIVE/CONSUMED/RELEASED/EXPIRED). Free budget = `funded − settled − active reservations − active commitments`. Capacity = active commitment units vs remaining required outcomes.
- **ACCEPT transaction:** revalidates market/version/policy/funding/wallet/terms-absence fresh, checks budget + capacity + ceiling/floor, then mints terms + referral + commitment + ACCEPTED status + ACCEPT decision in one atomic unit. Kernel output is advisory; the commit is authoritative (audit can never show an uncommitted ACCEPT).
- **Handoff (no double-count):** first S5 reservation for the terms consumes the commitment (links outcome + reservation); the outcome's own commitment is excluded from its free-budget check so conversion never self-blocks. S5 release restores a consumed-by-it commitment to ACTIVE.
- **Release:** supplier withdraw on ACCEPTED revokes terms + releases (once; second withdraw 409s); lazy paths respect expiry; pause/pending-verification never release.
- **Read model:** negotiation view exposes commitment state/amount/links.

## S7 Shipped — Supply Agent + Negotiation (LOCAL ONLY)

- **Model:** one negotiation row per campaign+partner round-track (`OPEN → COUNTERED/ACCEPTED/REJECTED/EXPIRED/WITHDRAWN/HOLD`); exactly one non-terminal row per pair (partial unique index); append-only `negotiation_decisions` history.
- **Kernel (pure, bigint):** solvency cap = `free ÷ remaining` (protects the rest of the campaign, not just this ask); band = `min(ceiling, cap)`, tightened to the reference bounty unless S6 pace is UNDER-paced; `ACCEPT` at the ask inside the band, `COUNTER` at the cap when meaningfully above reference, else `REJECT`; malformed/over-ceiling/over-round/insolvent fail closed. Urgency (`HEALTHY/TIGHT/CRITICAL/EXHAUSTED`) derives from the solvency margin.
- **Counters:** bounded by floor/ceiling, ≥5% lift to avoid noise, max 3 rounds, 24h default expiry, same-state re-evaluation returns the stored row (no duplicate counters).
- **Accept freezes:** atomic `NEGOTIATED` PartnerTerms at the ask + referral route, so S4/S5 consume the snapshot through the existing pipeline. No payment at negotiation time — only verified outcomes pay via S5. One terms row per pair; second commitments deterministically rejected.
- **Safety:** supplier profile + wallet + category gates mirror join rules; PAUSED/CLOSED markets and expired offers cannot accept; market moves under an offer HOLD for fresh input; supplier withdraw supported.
- **Agent/worker:** deterministic `evaluateNegotiation` + `processNegotiationEvaluations` (`POST /internal/negotiations/evaluate`, existing secret convention); per-row isolation; read API (`GET /api/negotiations/:id`, propose/withdraw routes) with urgency/reasons/expiry/accepted price. No LLM is wired — fixed explanation template only.
- **New tables:** `negotiations`, `negotiation_decisions` (unique negotiation+inputsHash).
- **Chain exercise: LOCAL ONLY.** No testnet/mainnet, no funds moved.

## S6 Shipped — Dynamic Demand Agent + Pricing Kernel + Pace States (LOCAL ONLY)

- **Kernel (pure, no floats):** pace ratio via integer cross-multiplication; `UNDER_PACED` (<85% of expected progress), `ON_PACE`, `OVER_PACED` (>115%), `EXHAUSTED` (target met / deadline passed / cannot afford one floor unit). Corrupt money/bounds fail closed to PAUSE.
- **Decisions:** UNDER → bounded raise (gap-proportional, ≤25%/step, capped at ceiling); OVER → bounded ease-down (floored, never below floor or 1 micro); ON → KEEP. Applies to future participation only — frozen PartnerTerms/outcomes are never rewritten.
- **Anti-thrash:** <5% change → KEEP; 1h cooldown after an executed REPRICE (PAUSE always bypasses); same-state re-evaluation returns the stored row via inputs-hash uniqueness.
- **Pause:** budget/target/deadline exhaustion or invalid state → market PAUSED (new joins/feed stop; reserved/verified/held/reconciling outcomes untouched, payout lifecycle intact). Terminal in S6 (no resume yet).
- **Agent:** deterministic `evaluateMarket` + `processPricingEvaluations` worker (`POST /internal/pricing/evaluate`, existing secret convention). No LLM is wired; the explanation is a fixed template over codes/numbers (LLM narration stays TARGET).
- **Read model:** `GET /api/campaigns/:id/market/pricing` — price, live pace, last decision + reasons, evaluated/cooldown timestamps, window metrics.
- **New table:** `market_decisions` (unique campaign+inputsHash, old/new bounty, autoExecuted flag).
- **Chain exercise: LOCAL ONLY.** No testnet/mainnet, no funds moved.

## S5 Shipped — Automatic Partner Payout + Reservation + Reconciliation (LOCAL ONLY)

- **Authority:** no per-payout approval. The company granted payout authority when it funded the campaign inside hard policy. The worker (`POST /internal/payouts/process`, `PAYOUT_WORKER_SECRET`) scans hold-cleared VERIFIED outcomes and drives reserve → execute → reconcile per outcome, idempotently.
- **Reservation:** `reserveOutcomePayout` runs transactionally — VERIFIED + hold cleared + LIVE/CLOSING/CLOSED + funded-policy binding + frozen terms price (never market price) + current registered wallet + ceiling + allocation + free-budget (`funded − committed`, so concurrent outcomes never overcommit). One reservation + one PREPARED payout per outcome for life (unique constraints); repeats are idempotent; retries reset the same rows.
- **Execution:** `settleReservedPayout` revalidates everything (incl. recipient rotation → safe release, allocation, onchain vault/executor/verifier/funded-spent bindings), signs the exact EIP-712 proof with the isolated verifier key, broadcasts once via the executor, persists SUBMITTED. SUBMITTED is never called settled.
- **Reconciliation:** `reconcilePayout` reads chain independently — SETTLED only on a matching `OutcomePaid` (vault, key, outcome, recipient, amount, proof). Reverts/wrong-vault/no-event → FAILED + evidence-backed release. Unknown receipts → AMBIGUOUS, never resend. Crash-before-hash-persist is detected via onchain consumption checks.
- **Receipt:** `GET /api/receipts/payouts/:id` with live recomputed checks (funded, terms match, wallet match, hold) and truthful `settledMeansReconciled` flag.
- **Isolation:** `OutcomeProofSigner`/`PayoutExecutor` interfaces keep keys out of models/clients/routes; env keys must derive to configured addresses or fail closed; Circle adapter remains a clean future swap (TARGET).
- **Chain exercise: LOCAL ONLY** — fake-reader units plus the full Anvil loop (fund → join → purchase → verify → hold → reserve → sign → execute → SETTLED → no double-pay). No testnet/mainnet.

## S4 Shipped — Customer Arc Purchase + Attribution Consumption + Outcome Verifier

- **Money path:** customer USDC goes DIRECTLY to the company wallet (`POST /api/checkout/intents` returns an unsigned `transfer(companyWallet, exactAmount)`; backend never signs). No Partner money moves — VERIFIED means evidence passed, NOT paid.
- **Portable attribution:** `/r/:code` still sets the signed same-origin cookie AND appends an opaque `?thesma_attribution=<random>` handle backed by `attribution_sessions` (single-use, expiring; nothing sensitive in the URL).
- **Checkout:** account-free intent (attribution/payer/amount checks incl. self-referral + self-purchase + minimum), `POST /api/checkout/:id/confirm` records SUBMITTED + PENDING outcome (hash format only — never success), `GET /api/checkout/:id` safe receipt state.
- **Verifier (`POST /internal/checkout/:id/verify`, `VERIFIER_INTERNAL_SECRET` bearer):** reads Arc independently — chain match, receipt success, USDC Transfer(sender==payer, recipient==company, amount==intent), minimum, canonical block time vs deadline/intent/terms expiry, self-dealing re-checks, funded-policy pinning, one-tx/one-intent/one-customer uniqueness. Definitive failures → REJECTED + code; unknown RPC/receipt → AMBIGUOUS (recoverable, never blind). Success → VERIFIED + proofHash + `holdUntil = verifiedAt + refundHoldSeconds`.
- **Refund boundary:** only the HOLD timer is implemented. No refund-event detection exists; S5 must not settle before `holdUntil`.
- **New tables:** `attribution_sessions`, `checkout_intents` (unique order/tx), `outcomes` (unique intent/tx/customer-per-campaign/proof).
- **Audit:** `checkout.intent_created/submitted/confirmed/rejected/ambiguous`, `outcome.verified/rejected`.
- **Proven locally:** opt-in Anvil E2E (`ARC_ANVIL_TESTS=1`) drives a real ERC20 transfer through receipt → verifier → VERIFIED with onchain company settlement. No testnet/mainnet exercise.

## S3 Shipped — Live Market + Partner Rules + Join + Referral Routes

- **Market open (owner-approved bootstrap bounty — temporary, S6 repricing owns strategy later):** `POST /api/campaigns/:id/market/open` requires LIVE + APPROVED + CONFIRMED funding for the same policy version, bounty within [floor, ceiling] and affordable (`target × bounty ≤ funded`), future deadline, validated destination URL, one open per campaign. Starts at version 1, status OPEN.
- **Partner rules (strict, canonical S3 names; legacy S0 keys still normalize):** `GET/PATCH /api/partners/me/rules` — minimum bounty (exact micro-USDC), allowed/blocked categories, max active campaigns, max allocation, `autoJoin`/`autoNegotiate` stored only (no autonomous action in S3).
- **Discovery:** public `GET /api/markets` (LIVE + OPEN + unexpired + PUBLIC only; no policy internals) and authenticated `GET /api/campaigns/:id/market`. PRIVATE campaigns stay invisible publicly; owner-issued invites (`POST /api/campaigns/:id/invites`, hashed opaque tokens, expiry, optional max uses) gate private joins.
- **Join (`POST /api/campaigns/:id/join`):** transactional eligibility (open/live/unexpired, min bounty, category allow/block, active cap with row-lock vs races, allocation cap, payout wallet), frozen PUBLIC terms snapshot (price + policy + market version), opaque referral code, idempotent re-join, stale-version rejection. Terms never silently change.
- **Referral (`GET /r/:code`):** validates, records CLICK in `referral_events` (clicks never touch `audit_events`, never earn money), mints HMAC-signed first-party cookie (`ATTRIBUTION_SECRET`, ≥32 chars) with referral/campaign/partner/expiry/nonce only, redirects to the stored destination (re-validated; no open redirect). No customer PII stored.
- **New tables:** `market_states`, `partner_terms` (unique campaign+partner), `referrals` (unique opaque code), `referral_events` (CLICK), `private_invites` (hash-only).
- **Audit:** `market.opened`, `partner.rules_updated`, `partner.joined`, `referral.created`, `private_invite.created` (no receipt language).

## S2 Shipped — ThesmaMarketVault + Arc Campaign Funding

**Deployment status: DEPLOYED on Arc mainnet (S8.1B, owner-broadcast).** Vault `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79` (tx `0xe3c153…711c558`, block 26454958, fee 0.03294 USDC) — independently verified onchain; canonical record in `contracts/deployments/arc-mainnet.json`. No campaign funding, purchase, or payout has occurred yet.

- **Money separation:** customer revenue (`customer -> company wallet`) never touches the vault. The vault custodies only the pre-funded acquisition budget (`company wallet -> ThesmaMarketVault -> Partner payout`). The backend holds no keys and never signs.
- **Contract** (`contracts/src/ThesmaMarketVault.sol`, non-upgradeable, OZ SafeERC20/EIP-712/ReentrancyGuard): `createCampaign` (immutable policyHash, cap/ceiling/deadline/executor/verifier checks), `fundCampaign` (owner-only, cap-enforced, pre-deadline, partial + exact-cap), `pauseCampaign`, `closeCampaign`, `returnUnspent` (exact `funded - spent`, once), plus a tested-but-unwired `payoutVerifiedOutcome` (executor-only EIP-712, ceiling/balance/replay/expiry checks; pre-deadline outcomes may settle after deadline via `occurredAt`). No generic withdraw path by construction.
- **Bindings:** `campaignKey = keccak256(abi.encode("thesma:campaign", campaignId, policyVersion))`; `policyHash = keccak256(abi.encode("thesma:policy:v1", campaignId, version, target, budget, floor, ceiling, minPurchase, deadlineUnix, visibility, refundHold, allowedRulesHash, escalationRulesHash, companyWallet))` with stable-sorted rules JSON. Pinned by `contracts/test/KeyVector.t.sol` against backend vectors.
- **Funding sequence:** `POST .../funding-intent` (owner, APPROVED + wallet + config required → `APPROVED→FUNDING`, PREPARED record, unsigned create/approve/fund actions) → owner signs in browser → `POST .../funding-submitted` (hash format only, never LIVE) → `POST .../funding-confirm` (reads Arc: chain, receipt status, vault address, key event, owner, policyHash, full-budget funded → CONFIRMED + `LIVE`; failures → FAILED with code; unknown → AMBIGUOUS; idempotent). Partial funding never goes LIVE. S1 transitions are now atomic (DB transactions; snapshot-rollback in memory).
- **New tables:** `campaign_fundings` (one row per campaign+version, unique funding tx) + `funding_status` enum. New endpoints listed above plus `POST /api/workspaces/:id/company-wallet` (register, not verify) and `GET /api/campaigns/:id/funding`.
- **Audit:** `workspace.company_wallet_registered`, `campaign.funding_prepared/submitted/confirmed/failed/ambiguous`, `campaign.live` (not payout receipts).

## S1 Shipped — Campaign Intent + Policy Engine

- Owner describes an objective in plain text; deterministic local interpreter (`LocalIntentInterpreter`) prepares a typed draft (counts, exact micro-USDC amounts, ISO deadlines only — relative dates are never guessed). Missing required fields are returned explicitly, never invented.
- Draft lifecycle `DRAFT -> REVIEW -> APPROVED` with versioned owner-controlled policy (`campaigns` + `campaign_policy_versions`, unique `(campaignId, version)`). `FUNDING`/`LIVE`/etc. exist as enums but have no legal entry in S1.
- Invariants (pure, tested): amounts > 0 (floor/min ≥ 0), floor ≤ ceiling, `target × floor ≤ budget`, deadline future at approval, no floats anywhere.
- Ownership: any workspace member may draft/revise/request review; **only `ORGANIZATION_OWNER` can approve**. Cross-workspace access denied server-side.
- APPROVED versions immutable: post-approval revision creates version N+1 and reopens at DRAFT; stale `expectedVersion` writes rejected (409); repeat approval is idempotent.
- Endpoints: `POST /api/campaigns/draft`, `GET /api/campaigns?workspaceId=`, `GET /api/campaigns/:id`, `PATCH /api/campaigns/:id/draft`, `POST /api/campaigns/:id/review`, `POST /api/campaigns/:id/approve`.
- Audit: `campaign.created`, `campaign.draft_revised`, `campaign.review_requested`, `campaign.policy_approved`, `campaign.policy_revision_created` (version IDs in metadata; not financial receipts).
- Interpreter boundary: `CampaignIntentInterpreter` interface keeps model SDKs out of domain code; a real LLM Demand Agent plugs in later. The deterministic parser does not mean the conversational agent is shipped.

No money moves in S1.

## S0 Shipped (prior slice)

- App + quality tooling (dev/build/lint/typecheck/test/db scripts)
- Domain enums: `WorkspaceRole`, `CampaignState`, `MarketState`, `AgentActionState` (behavior-free, for S1+)
- Money primitive: micro-USDC exact integers (`usdcToMicro`, `microToUsdcString`)
- Drizzle tables + migration: `users`, `workspaces`, `workspace_members`, `partners`, `sessions`, `audit_events`
- Email/password auth, workspace create/get with server-side isolation, partner create/update with per-user ownership
- Endpoints: `GET /api/health`, `GET /api/me`, `POST /api/auth/signup|signin|signout`, `GET|POST /api/workspaces`, `GET /api/workspaces/:id`, `GET|POST|PATCH /api/partners`
- Append-only `audit_events` for `workspace.created`, `partner.created`, `partner.updated`
- Tests: validation, money, authz/isolation, sessions/audit, health

## Explicitly NOT implemented (Target/Roadmap)

- actual LLM Demand Agent runtime (only the deterministic intent parser + adapter boundary exist)
- wallet connection / cryptographic wallet ownership proof (address is registered, not verified)
- Arc deployment / live funding (contract + local verification shipped; chain exercise: LOCAL ONLY)
- Circle
- backend automatic Partner payout (contract primitive exists + tested; backend must not call it yet)
- actual Supply Agent automation (rules are enforced data; no agent acts on them)
- pricing/repricing (bootstrap bounty is owner-set; no pace calculation)
- negotiation/private terms (join source is always PUBLIC)
- customer Arc checkout, purchase verification, outcome creation
- revenue/CAC analytics derived from purchases
- Partner payout beyond the S5 local loop (no testnet/mainnet settlement exercised)
- LLM-driven pricing/explanations (kernel + templated reasons are deterministic; agent cannot override bounds)
- LLM-driven negotiation (kernel decides price/class/bounds; wording-only LLM stays TARGET)
- full refund detection (hold timer only)
- Gateway/CCTP
- live market
- market pricing / repricing
- Supply Agent
- referrals
- purchases
- outcome verification
- payouts

Next slice: **S2 — ThesmaMarketVault + Arc campaign funding**.
