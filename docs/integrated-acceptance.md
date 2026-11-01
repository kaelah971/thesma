# Thesma — Integrated No-Spend Acceptance
_Last tested: November 1, 2026 · commit `04ce7aa` (record written on top; product code unchanged by this milestone unless a defect is listed below)_

## Product thesis

Thesma is a multi-sided autonomous growth-finance marketplace: organizations buy verified outcomes, creators earn inside frozen rules, customers trigger attribution, verification mints truth, and settlement moves money only after proof and policy agree.

**AI proposes. Policy permits or refuses. Thesma executes. The ledger proves it.**

## Integrated lifecycle (judge story)

1. An organization defines a measurable growth outcome → typed, versioned, owner-approved policy (frozen budget/floor/ceiling/target/deadline).
2. Thesma ranks creators on fit/evidence/economics — never follower counts — and explains every match.
3. The organization sends frozen economic terms; invitation ≠ participation; no referral, payout, or market activation is created.
4. The creator sees the exact frozen offer pre-funding; acceptance stays disabled until funding is confirmed and the market opens.
5. The organization proves wallet control (workspace-bound EIP-712 challenge, server-recovered signer, explicit confirmation; zero fund movement).
6. Funding is prepared as unsigned intents; a read-only Arc USDC balance preflight gates signing and fails closed on 0 USDC.
7. Once funded, customer purchases are attributed, independently read from Arc, and verified before becoming payable.
8. Holds, reservations, submissions, and settlement stay distinct; the operator acts only inside deterministic authority; every decision lands in the audit ledger.
9. Aster is the permanent real-mainnet proof that the full lifecycle already completed.

Invariant held everywhere: **CLICKED != CONVERTED · CONVERTED/PURCHASED != VERIFIED · VERIFIED != PAID · SUBMITTED != SETTLED.**

## Organization acceptance — PASS

- Approved campaigns retain frozen typed policy; budget/floor/ceiling/target/deadline verified consistent (`campaign.test.ts`, `validation.test.ts`, `owner-activation.test.ts`).
- Creator Matches renders recommended/review/eligible states from real score output with reasons; no follower-count input (`creator-matching.test.ts`, `creator-discovery-legacy.test.ts`, `creator-ux.test.ts`).
- @bgirl invitation is frozen; economics cannot silently mutate; invite creates no referral, reserves no payout, never marks the market live (`creator-invitations.test.ts`, `creator-inbox-prefunding.test.ts`).
- All four hybrid structures (`PERFORMANCE_ONLY`, `BASE_PLUS_PERFORMANCE`, `MILESTONE_PLUS_PERFORMANCE`, `HYBRID_FULL`) render with bounded maximum exposure; frozen terms immutable post-invite; unsupported settlement labelled truthfully (`hybrid-deals.test.ts`).

## Creator acceptance — PASS

- Public `/@bgirl` profile loads (HTTP 200, correct title, no error-boundary copy).
- Opportunity inbox shows frozen Northstar economics (5 USDC per verified purchase, Nov 30, 2026 deadline) with truthful pre-funding state; Accept stays unavailable while the market is not LIVE (`creator-inbox-prefunding.test.ts`).
- Scout/agent auto-accept uses the same frozen terms as manual accept — never repriced; REFUSE (agent assessment) stays distinct from DECLINED (creator action); review states remain manual; no referral or payout obligation before canonical participation/verified truth (`creator-autojoin.test.ts`, `creator-scout-background.test.ts`, `creator-scout-cron.test.ts`).

## Wallet ownership acceptance — PASS

- No live signature requested or performed in this pass (code/tests only).
- Full chain pinned by tests: workspace-bound challenge → `eth_signTypedData_v4` with canonical `EIP712Domain` → server-recovered signer is authoritative → PROVED → explicit confirmation → CONSUMED → replay rejected.
- Nonce, expiry, user/workspace binding, owner authorization, no address-substitution parameter, change-wallet confirmation, zero transaction/approve/permit, no `personal_sign`, no `eth_sign` (`company-wallet*.test.ts`, `provider-identity.test.ts`).
- Temporary diagnostic surfaces confirmed removed from production UX (`company-wallet-production-ux.test.ts`).

## Funding preflight acceptance — PASS

- Northstar resume/preview path verified: 50 USDC, Arc Mainnet 5042, canonical Arc USDC, canonical Thesma vault, sender = registered company wallet (`funding-preview-crash.test.ts` — 14 tests, incl. the exact production-crash regression).
- Balance preflight: `eth_chainId` + `eth_call balanceOf` only. Current connected balance 0 USDC → Available 0 / Required 50 / Shortfall 50, "Insufficient USDC on Arc Mainnet to fund this campaign.", Start signing DISABLED (`funding-balance-preflight.test.ts` — 18 tests, incl. dust-edge, exact-amount, RPC-failure-fails-closed, no-sendTransaction/no-sign static rails).
- Prepare/resume DTO normalization defaults safely; Funding card error boundary contains render faults; wrong account/network remain blocked; retry creates no duplicate intent; campaign stays UNFUNDED until reconciliation.

**Balance: 0 USDC · Required: 50 USDC · Shortfall: 50 USDC · Signing enabled: NO**

## Customer/attribution acceptance — PASS

- Referral → attribution → checkout → independent onchain purchase read → outcome → verification, all pinned on deterministic/local fixtures plus the canonical Aster/Beaconfield mainnet records (`attribution.test.ts`, `checkout.test.ts`, `checkout-buy.test.ts`, `buy-checkout.test.ts`, `proof-lifecycle.test.ts`).
- Click alone never counts; purchase alone never verifies without verifier proof; wrong amount/recipient/chain fails; attribution cannot replay; no fake customer activity.
- PUBLIC `/markets` never leaks private campaigns (`public-markets.test.ts`, `csp.test.ts`, `security-trust.test.ts`, `role-trust.test.ts`).

## Verification acceptance — PASS

- Deterministic verification with proof-hash binding, EIP-712 outcome proof, verifier identity enforcement, exact amount/recipient/campaign binding; invalid/ambiguous evidence fails closed; safety hold begins only after VERIFIED.
- External procurement with no provider/budget is `NOT_CONFIGURED` fail-closed, never presented as purchased (`verification.test.ts` — 30 tests; x402 v2 protocol-tested locally only, no live provider claim).

## Hybrid economics acceptance — PASS

- ACCEPTED != EARNED, DELIVERED != VERIFIED, VERIFIED != PAID, SUBMITTED != SETTLED across all four shipped structures.
- Maximum base/performance/milestone/total exposure bounded; hard campaign-capacity enforced; milestone idempotency; no click/unverified conversion triggers bonuses; unsupported deliverables stay manual/unsupported; no theoretical max counted as payable; frozen accepted terms cannot drift (`hybrid-deals.test.ts` — 15 tests). No new contract, no fake settlement.

## Creator reliability acceptance — PASS

- Scores derive only from real evidence (verified outcomes, settlement history, retention/quality signals); never followers, engagement, self-reported reach, or unverified claims.
- No-history creators are `PROVISIONAL`/low, neutral, never branded; evidence strengthens without breaking cold-start; explainability available (`reliability.test.ts` — 19 tests).

## Campaign CFO acceptance — PASS

- Accounting identity holds across funded/spent/committed/verified-unpaid/available; hybrid hard/verified-unpaid/contingent exposures tracked without double counting.
- Cross-campaign movement is a hardcoded `UNAVAILABLE`; allocator output is `RECOMMENDED`, never executed — no capital movement is faked (`cfo.test.ts`).
- CONTINUE/SLOW/PAUSE/ESCALATE/COMPLETE decided from deterministic inputs.

## Financial operator acceptance — PASS

- VERIFIED → hold → reservation → submit-once → reconcile-against-`OutcomePaid` → SETTLED, pinned by unit, resume, cron, and Anvil-gated tests; hold-active skipped; duplicates impossible; second worker run submits zero; ambiguous receipts reconcile-before-resend; free budget cannot overcommit; wrong chain/vault/signers fail closed (`payout.test.ts`, `funding-resume.test.ts`, `payout-cron.test.ts`, `operator-onchain.test.ts`).
- The canonical Aster mainnet run is the live no-double-pay proof. Production payout worker never invoked in this pass.

## Autonomy ladder acceptance — PASS

- Allowed autonomous vs review-required vs refused vs human-approval/escalation states compose; decisions end in bounded states, never silent execution.
- Financial authority stays deterministic; no model call authorizes money; no UX claims "AI decided payout" (`autonomy.test.ts` — 17 tests).

## Decision ledger acceptance — PASS

- Match, invitation, auto-accept/review/refuse, CFO plan/decisions, growth, verification, payout/reservation/reconciliation, and escalation events all carry decision + reasons + input snapshot/version + actor/mode + timestamps + campaign/workspace binding, with no secret or key material (`audit.test.ts`, plus per-domain suites).

## Public judge path — PASS (read-only sweep, Nov 1 2026)

All HTTP 200, no error-boundary copy, correct titles:

- `/`, `/start`, `/markets`, `/demo`, `/@bgirl`, `/security`, `/privacy`, `/terms`, `/.well-known/security.txt`, `/api/health`
- Aster `markets/5571f328…` — SETTLED, `OutcomePaid`, 1 USDC reconciled present
- Beaconfield `markets/dcec0b71…` — VERIFIED + safety-hold language present, nothing settled

No wallet connected from automation. Layout/hydration/CSP covered by the local browser-smoke matrix (desktop + 5 mobile widths, all green).

## Security/trust — PASS

- `/security`, `/privacy`, `/terms`, `/.well-known/security.txt` all 200.
- No auto-connect, no on-load `requestAccounts`/signature/transaction, no open redirect, no unexpected approve/permit paths (static rails in `security-trust.test.ts`, `csp.test.ts`, `wallet-connection.test.ts`).
- `docs/security-reputation.md` preserved; no bypass language added anywhere.

## Real integration defects found

NONE. The composed flows pass on existing architecture; no code was changed in this milestone.

## Defects fixed

NONE.

## New tests added

NONE (deliberately — coverage already exists for every slice above; see Integration test map in git history and per-domain suites).

## Final verification status

- Targeted suites: 73/73 across funding-balance, funding-preview-crash, production-UX, inbox-prefunding, auto-join, hybrid deals
- Full suite: **836 passing, 2 skipped** (intentional Anvil/env-gated)
- Typecheck: clean · Lint: clean · Build: success
- Browser smoke (local prod server, desktop + mobile): all green, incl. funding-balance matrix (0/4/50/75 USDC + RPC failure)
- Contracts (`forge test`): green in CI (no local forge binary in this environment)
- Secret hygiene: pass (no tracked secrets); `npm audit` policy: 0 critical/high

## Zero-spend statement

Production DB mutated: **NO** · Northstar mutated: **NO** (FUNDING / PREPARED / 0 funded / no tx / market closed / wallet `0x85522b...894A33` / @bgirl INVITED intact) · @bgirl mutated: **NO** · Mainnet broadcast: **NO** · Real money spent: **0 USDC** · No signature requested or performed in this pass.

## Canonical Aster mainnet evidence

`FUNDED → PURCHASED → VERIFIED → HELD → SETTLED` on Arc Mainnet 5042 — 1 USDC moved, 1 USDC settled, second run submitted zero. Full record: [`docs/mainnet-proof.md`](mainnet-proof.md). Zero-login view: `/demo`.

## Known limitations (real remaining ones)

- External verification procurement: `NOT_CONFIGURED` without a provider/signing budget.
- x402 v2: protocol-tested locally only; no live provider interoperability claimed.
- Cross-campaign capital movement: `UNAVAILABLE` by vault design (allocator recommends, never moves).
- Hybrid base/milestone legs: settlement `UNSUPPORTED` onchain; recorded truthfully as payable, not paid.
- Payout worker on Hobby cron runs daily — settlement can wait for the next run after hold expiry.
- No Circle Gateway/CCTP, paymasters, or fiat ramps.
- Beaconfield page copy is a historical checkpoint, not current live state.
