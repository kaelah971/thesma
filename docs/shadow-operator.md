# Shadow Operator Mode

Shadow Operator Mode answers the same deterministic operator questions as the live authority paths while removing execution authority for one organization.

## Contract

An organization can be in `AUTONOMOUS` or `SHADOW` mode. Mode changes are append-only `operator.mode.changed` audit events and owner-only. Shadow is not a second financial kernel: it reuses the Campaign CFO, Outcome Portfolio, verification procurement, and settlement decision kernels.

A shadow run records an immutable `shadow.decision.generated` event containing:

- recommendation, target, amount and evidence confidence
- exact input snapshot used by the kernel
- exact policy snapshot used by the kernel
- generation time and run ID
- `executionStatus: NOT_EXECUTED`

The response is another immutable event, `shadow.decision.responded`. A reviewer can respond once with:

- `AGREE`
- `OVERRIDE` — requires a reason such as `BUSINESS_CONTEXT_MISSING`
- `IGNORE`

No generated event is updated in place.

## No-execution boundary

When the organization is in `SHADOW` mode, the operator boundary blocks:

- payments and payout settlement
- x402 signing or purchases
- capital movement and funding execution intents
- creator invites
- production settlement-worker processing

Verification shadow evaluation may read a provider quote, but it exits before procurement-row approval, signer resolution, payment, or provider purchase. Settlement shadow evaluation may calculate `PAY_NOW` or `HOLD`, but it never calls reserve, payout, signer, executor, or reconciliation paths.

The UI states this boundary directly. Shadow recommendations are not receipts, approvals, transfers, purchases, or settlements.

## Telemetry

`GET /api/operator/shadow?workspaceId=...` returns generated/reviewed counts, `AGREE`/`OVERRIDE`/`IGNORE`, organization agreement rate in basis points, and breakdowns by decision family and confidence when available. Agreement uses nearest-basis-point rounding, so two agreements out of three reviewed decisions is `6667` bps.

Supported V1 families:

- `OUTCOME_PORTFOLIO`
- `VERIFICATION_PROCUREMENT`
- `FINANCIAL_SETTLEMENT`

The portfolio remains campaign-only until creator, referral and developer members have normalized capacity and all-in economics.

## Safe judge/demo path

1. Enable Shadow mode from the Operator workspace.
2. Run recommendations.
3. Review each generated recommendation.
4. Use `AGREE`, `OVERRIDE` with a business reason, or `IGNORE`.
5. Show the telemetry and `NOT EXECUTED` boundary.

This path requires no real-money spend, no mainnet transaction, no x402 payment, and no capital transfer.
