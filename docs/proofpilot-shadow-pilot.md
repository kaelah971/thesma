# ProofPilot production Shadow pilot

## Status

- **DONE — Slice 5 production shadow proof completed**
- Captured: November 3, 2026
- API authentication: `PASS`
- Secret exposed: `NO`
- Environment: production software / Shadow financial mode

This was a synthetic production integration test under Shadow Mode. It is not customer traction, not a real acquired user, and not a creator payout.

## Production resolution

- Project: `ProofPilot Labs`
- Program: `ProofPilot Partner Growth`
- Program ID: `f67232dd-665f-42bd-93bf-8419c9459e7d`
- Slug: `proofpilot-partner-growth`
- Outcome: `ACTIVATED_USER`
- Target: `100`
- Budget cap: `500 USDC`
- Verified CAC ceiling: `10 USDC`
- Reward ceiling: `8 USDC`
- Operator: `SHADOW`
- Funding: `UNFUNDED`
- Participant: `ProofPilot Pilot Partner`
- Participant type: `REFERRAL_PARTNER`
- Participant status: `ACTIVE`
- Public attribution code: `ref_f5861afb3d6e5efa`

The public hosted program configuration and attribution endpoint resolved successfully. The public program response exposed no private identifiers or secrets.

## External proof path

The existing `scripts/proofpilot-shadow-pilot.ts` was used without internal database or service imports for mutation. The path was:

`server SDK / HTTP → thesma.vercel.app → production API → production DB → Growth Program pipeline`

The script requires an explicit confirmation value and reads the API key only from the process environment. The key was not printed, returned, written to disk, or committed.

## Synthetic production event

- External event: `proofpilot_shadow_pilot_001`
- External subject: `proofpilot_test_user_001`
- Outcome: `ACTIVATED_USER`
- Attribution: `ref_f5861afb3d6e5efa`
- Synthetic: `YES`
- Real customer: `NO`
- Real traction: `NO`
- Occurred at: `2026-11-02T20:00:00.000Z`

Evidence submitted through the SDK:

```json
{
  "userId": "proofpilot_test_user_001",
  "accountCreatedAt": "2026-11-02T19:00:00.000Z",
  "onboardingCompletedAt": "2026-11-02T19:20:00.000Z",
  "firstMeaningfulActionAt": "2026-11-02T19:45:00.000Z"
}
```

## Actual production evaluation

- Attribution: `DIRECT_ATTRIBUTION`
- Verification: `VERIFIED`
- Verification reasons: `SCHEMA_VALID`, `DETERMINISTIC_POLICY_SATISFIED`, `ATTRIBUTION_ACCEPTED`, `SHADOW_MODE_EVALUATED`
- Procurement: `NO_CHECK`
- Paid verification: `0 USDC`
- Frozen reward: `8 USDC`
- Reward eligibility: `ON_HOLD`
- CAC ceiling: `10 USDC`
- CAC decision: `INSUFFICIENT_DATA` (target ceiling `10 USDC`; the reward was within the configured CAC ceiling)
- Hold: `ACTIVE` (`HOLD_ACTIVE`)
- Funding: `UNFUNDED`
- Settlement eligibility: `NOT_READY` (`HOLD_ACTIVE`)
- Operator decision: `HOLD`
- Operator mode: `SHADOW`
- Execution: `BLOCKED_BY_SHADOW`
- Actual paid: `0 USDC`
- Financial transaction: `NONE`

The hold was reported until `2026-11-04T07:00:23.616Z`. No settlement or payout was requested.

## Production receipt

- Receipt ID: `receipt_c7a6f45d-91dd-415d-b5b5-26097da34c27`
- Event ID: `e54cec06-8be2-4fa4-b2c2-d07870f28491`
- Program: `ProofPilot Partner Growth`
- Participant: `ProofPilot Pilot Partner`
- Attribution: `DIRECT_ATTRIBUTION` via `ref_f5861afb3d6e5efa`
- Evidence hash: `0x5274ae41bc77b8d60ced77e236e074894e97c924e5b649ecf18811cdd68abdb7`
- Verification: `VERIFIED`
- Verification reasons: `SCHEMA_VALID`, `DETERMINISTIC_POLICY_SATISFIED`, `ATTRIBUTION_ACCEPTED`, `SHADOW_MODE_EVALUATED`
- Procurement decision: `NO_CHECK`
- Reward: `8 USDC`
- Reward eligibility: `ON_HOLD`
- CAC decision: `INSUFFICIENT_DATA`; policy reason `WITHIN_CAC_CEILING`
- Hold: `ACTIVE`
- Funding: `UNFUNDED`
- Settlement eligibility: `NOT_READY`
- Operator decision: `HOLD`
- Operator mode: `SHADOW`
- Execution status: `BLOCKED_BY_SHADOW`
- Paid: `NO`
- Transaction: `NONE`

## Idempotency proof

The script replayed the exact same event with the same external IDs, attribution, evidence and idempotency key. The retry returned the original event and receipt IDs.

- Duplicate event: `NO`
- Duplicate reward exposure: `NO`
- Duplicate receipt: `NO`
- Duplicate economic outcome: `NO`

## Hard zero-spend assertion

- Circle calls: `0`
- x402 paid calls: `0`
- Mainnet transactions: `0`
- Testnet transactions: `0`
- Vault funding: `0`
- Payout: `0`
- Real USDC moved: `0`
- Test USDC moved: `0`
- Transaction hash: `NONE`

The receipt reported `actualPaidMicroUsdc: 0`, `financialTransaction: null`, `circleCalls: 0`, `x402PaidCalls: 0`, `execution: BLOCKED_BY_SHADOW`, and program funding `NOT_FUNDED`.

## Public / hosted readback

- Hosted route: `https://thesma.vercel.app/g/proofpilot-partner-growth`
- HTTP: `200`
- Public program API: `200`
- Attribution readback: `ATTRIBUTED`
- Private data leak: `NO`
- Secret exposed: `NO`

## Safe rerun

Use the existing script with the local process environment and explicit non-secret pilot parameters. Do not place the API key in this document or in shell history:

```powershell
$env:THESMA_BASE_URL = "https://thesma.vercel.app"
$env:THESMA_ATTRIBUTION_CODE = "ref_f5861afb3d6e5efa"
$env:THESMA_PROOF_CONFIRM = "PROOFPILOT_SHADOW_001"
npx tsx scripts/proofpilot-shadow-pilot.ts
```

## Verification

- Full: `npm test` — 969 passed, 2 skipped
- Typecheck: `npm run typecheck` — PASS
- Lint: `npm run lint` — PASS
- Build: `npm run build` — PASS
- Browser: `npm run test:browser` — PASS
- Secret hygiene: `npm run secret:hygiene` — PASS

## Milestone

- Slice 5: `DONE`
- **BUILD WITH THESMA — EMBEDDED GROWTH INFRASTRUCTURE: COMPLETE**
