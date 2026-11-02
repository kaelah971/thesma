# Verification Procurement — Value-of-Information Buyer

Thesma autonomously decides whether buying an external verification signal is
economically justified — and, only on a justified BUY, purchases it over
x402 on **Arc Testnet** with a dedicated Circle Developer-Controlled Wallet.

## Problem

An outcome has real USDC at risk and verification confidence is too low.
A second opinion costs real money. Buying blindly wastes budget; refusing
blindly risks paying out on a bad outcome. The decision must be a number,
not a vibe.

## Value-of-information formula

All integer math (bigint micro-USDC, integer basis points). Never floating point.

```
uncertaintyBps        = max(0, requiredConfidenceBps − currentConfidenceBps)
riskExposureMicro     = payoutAtRiskMicroUsdc × uncertaintyBps / 10_000
economicEvidenceCap   = riskExposureMicro × maxEvidenceCostShareBps / 10_000
maxJustifiable        = min(cap, remainingBudgetMicroUsdc, maxPerCheckMicroUsdc)
```

Decision, in order:

1. Uncertainty is zero → **NOT_NEEDED** (already confident enough).
2. Price is not positive → **REFUSED**.
3. Price > remaining verification budget → **REFUSED** (or **REVIEW** when a human-approval threshold is configured).
4. Price > per-check ceiling → **REFUSED** (or **REVIEW** with a threshold).
5. Price > value-of-information ceiling → **REFUSED** (or **REVIEW** with a threshold).
6. Otherwise → **BUY**, and the existing policy engine still applies its own liquidity, signer, and period-cap gates.

Example (the canonical fixture): 20 USDC at risk, confidence 6200→8000,
budget 0.10 USDC, max/check 0.01 USDC, price 0.002 USDC.
Uncertainty 1800 bps → risk 3.6 USDC → cap 0.0072 USDC → ceiling
min(0.0072, 0.10, 0.01) = 0.01 USDC ≥ 0.002 → **BUY**, with the reason
stating the ceiling explicitly.

## Decision states

`NOT_NEEDED` (confident already) · `BUY` (economically justified) ·
`REFUSED` (autonomous no) · `REVIEW` (human threshold set — escalate).
On the wire the procurement row uses the existing lifecycle:
`CANDIDATE → QUOTED → APPROVED → PAYMENT_AUTHORIZED → PURCHASED →
RESULT_RECEIVED`, plus `REFUSED`, `ESCALATED`, `FAILED`, `AMBIGUOUS`.
Terminal rows are never re-spent; ambiguous post-sign states never repay
blindly — reconcile first.

BUY ≠ PURCHASED. PURCHASED ≠ evidence received. Evidence ≠ VERIFIED.
A provider signal can never flip an outcome, accuse anyone, or pay anybody.

## Circle Developer-Controlled Wallet architecture

- Dedicated buyer wallet, resolved from `CIRCLE_API_KEY`,
  `CIRCLE_ENTITY_SECRET`, `CIRCLE_VERIFICATION_WALLET_ID` (all server-only;
  never `NEXT_PUBLIC`, never logged, never committed).
- On first use the adapter verifies the wallet lives on `ARC-TESTNET` and,
  when set, matches `CIRCLE_VERIFICATION_WALLET_ADDRESS`. Anything else
  fails closed (`CIRCLE_WRONG_NETWORK` / `CIRCLE_MISCONFIGURED`).
- The adapter exposes the buyer address, legacy message signer, EIP-712 typed-data
  signer, and canonical read-only USDC balance. No private key material exists
  in Thesma; Circle signs remotely. The SDK's sign-message surface takes no
  caller idempotency key, so replay safety lives in the procurement dedupe gate
  (identical logical purchase → same row, never re-signed) plus the atomic
  APPROVED-state gate; a stable UUID v4 derived from the dedupe fingerprint
  rides on the approval audit for traceability.
- This wallet is NOT the Northstar company wallet, NOT the mainnet
  executor/verifier, NOT the campaign vault, and NEVER touches mainnet.

## x402 lifecycle (Arc Testnet only)

1. Owner-triggered evaluation (or the proof script) selects a VERIFIED
   outcome with review-grade evidence and an explicit confidence pair.
2. A live, unpaid `GET` fetches the provider's 402 challenge.
3. The challenge is validated field-by-field: x402 v2, `accepts` terms with
   the `exact` scheme, network `eip155:5042002`, canonical testnet USDC,
   positive integer amount, expected payee, same-path resource, sane timeout.
   Anything else fails closed before any signature.
4. The value-of-information gate and the policy engine must both say BUY.
5. The Circle buyer signs the canonical EIP-712 authorization; the retry
   carries `PAYMENT-SIGNATURE`; the provider returns the resource. A provider
   payment receipt is recorded when supplied — it is never invented when the
   provider omits `PAYMENT-RESPONSE`.
6. The response is normalized into *scoped* evidence, and the outcome pipeline
   continues unchanged — evidence informs, it never decides.

## Arc Testnet boundary

`eip155:5042002` + canonical testnet USDC `0x3600…0000` is the ONLY
spendable combination, enforced in three places: challenge validation,
signing-gate assertion, and environment validation (any other configured
network fails closed at startup). Mainnet execution is structurally
impossible from this path — there is no mainnet signer, no mainnet asset,
and no mainnet network constant anywhere in it.

## Budget safety

- Per-check ceiling, period budget, and evidence-cost-share bound every
  evaluation; a second atomic check runs inside the purchase transaction.
- Spend is tracked per workspace and per provider from procurement rows;
  only `PURCHASED`/`RESULT_RECEIVED` count as spent. Failed and ambiguous
  rows never count. Verification spend is fully separate from creator
  payout accounting (CFO surfaces both, never mixed).
- The balance never moves without an explicit BUY: quotes, evaluations,
  failed validations, and read-only doctors spend nothing.

## Idempotency

- Request fingerprint (`provider|resource|check|campaign|outcome|amount|
  asset|network|payTo|quoteVersion`) dedupes logical purchases: an existing
  terminal row short-circuits to NO_CHECK with zero signing.
- In-flight (`APPROVED`/`PAYMENT_AUTHORIZED`) and ambiguous rows block new
  spends until reconciled.
- The stable UUID v4 from the fingerprint is recorded on the approval audit
  so retries and re-evaluations are provably the same logical purchase.

## Provider abstraction

`VerificationProvider` (quote + check) is unchanged. Testnet x402
providers plug in through the `remote-x402` kind: explicit URL allowlist
(HTTPS, no redirects, host-pinned), challenge-derived quotes only, exact
network/asset/amount/payee matching, provider-relative timeout ceilings.

## First real testnet provider

AuraGate GitHub repository metadata (`/api/premium/github-repo`), observed
live as a valid x402 v2 challenge on `eip155:5042…02002` for 2000
micro-USDC (0.002 USDC) — always read from the live challenge, never
hardcoded. Evidence class: `repository-identity-only`. It may corroborate
that a repository exists under a claimed name. It explicitly does NOT prove
a purchase, a PR merge, user retention, creator-caused revenue, or anything
about any payout. Unknown verdicts stay inconclusive; the outcome row is
never touched by provider output.

## Live proof record — November 2, 2026

**LIVE PROVEN ON ARC TESTNET.** The guarded proof completed one AuraGate
x402 purchase for the live repository challenge.

- Network: `eip155:5042002`; canonical testnet USDC; buyer
  `0xa3cc5aefc97cc16077cbb93fff9f428290e77ad7`
- Amount/payee: `2,000` micro-USDC (`0.002 USDC`) to
  `0xB52D1D41DAf8c87c8709bc79be41c4C424aD36F1`
- Gateway balance: `0.002 USDC` before payment and `0.000 USDC` after payment
- Setup transactions: [approval](https://explorer.testnet.arc.io/tx/0x2044bf80616c5d5cf2cf6a0c4c453a42fcda51daae5841d457dad31b48f6f929) and [deposit](https://explorer.testnet.arc.io/tx/0x898e92d9eb501517843d5259acec9bb392a88a1eab72ca3cd6f3f02c5d59b7f4)
- Provider result: HTTP 200; normalized `INCONCLUSIVE`; response hash `4c272ab8`
- Post-evidence posture: `INCONCLUSIVE` / review required. The provider result
  is repository-identity evidence only and does not mark the business outcome
  VERIFIED.
- Receipt: the provider omitted `payment-response`, so no payment ID or
  settlement transaction hash is claimed. The Gateway balance transition is
  the available payment-side reconciliation.
- The proof's second in-memory evaluation purchased nothing and counted the
  `2,000` micro-USDC spend exactly once.

## Provisioning the buyer wallet (operator runbook)

No credentials are fabricated or committed. Whoever owns the Circle
account performs these steps (Circle dashboard unless noted):

1. Create / open a Circle Developer-Controlled Wallets app and copy the
   **API key** → `CIRCLE_API_KEY`.
2. Generate an entity secret (SDK: `generateEntitySecret()` — it prints
   once; store it in the secret manager) → `CIRCLE_ENTITY_SECRET`.
3. Register the entity secret ciphertext once (SDK:
   `registerEntitySecretCiphertext({ apiKey, entitySecret })`) and keep
   the recovery file offline.
4. Create a wallet set, then create one **Arc Testnet** wallet inside it.
5. Fund it with test Arc USDC (Circle testnet faucet / `RequestTestnetTokens`).
6. Copy the wallet id (dashboard or `listWallets`) →
   `CIRCLE_VERIFICATION_WALLET_ID`; optionally pin the address in
   `CIRCLE_VERIFICATION_WALLET_ADDRESS` (mismatch fails closed).
7. Set `THESMA_EXTERNAL_VERIFICATION_ENABLED=true` plus the provider URL
   (`THESMA_EXTERNAL_VERIFICATION_PROVIDER_URL`) and caps.
8. Run `npm run verification:x402:doctor` — expect CONFIGURED, a
   testnet address on ARC-TESTNET, a USDC balance, a valid 402 challenge
   with a quoted price, and a WOULD_BUY verdict on the fixture.
9. Run `npm run verification:x402:proof` — exactly one guarded testnet
   purchase, idempotent on retry. The proof command checks the Circle Gateway
   depositor balance first and, when needed, performs an exactly-once Arc
   Testnet approval + deposit for only the quoted amount.

Do not paste secrets into chat, tickets, or the repo. The doctor never
prints them (presence only).

## Known limitations

- Live execution needs Circle credentials + testnet USDC funding for the
  buyer wallet; without them the feature reports NOT_CONFIGURED and every
  other surface keeps working.
- Provider timeout windows can be long (AuraGate advertises ~7 days); the
  ceiling is explicit per deployment, and our own quote expiry stays short.
- The provider's advertised checksum casing is not trusted — addresses are
  compared case-insensitively after strict hex validation.
- No mainnet path exists by design; adding one would require a new
  authority decision, new wallets, and new review — never an env edit.
