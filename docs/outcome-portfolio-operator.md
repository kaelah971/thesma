# Outcome Portfolio Operator

## Problem

Campaigns are implementation details. An organization needs one answer above them:

> Where should the next dollar of growth capital go?

The Outcome Portfolio Operator reuses the Campaign CFO, campaign policy, verified outcome, reliability, hybrid-deal and verification-procurement truth to compare eligible campaign destinations. It produces a deterministic prospective recommendation; it does not create campaigns or move funds.

## Objective model

`OutcomePortfolioObjective` is composed from existing organization campaign policies rather than creating a second accounting model:

- organization ID
- existing campaign intent label(s) as the target outcome type
- target outcome count
- maximum verified CAC in micro-USDC, from the existing campaign CAC/bounty ceiling
- policy budget in micro-USDC
- reserve floor in basis points
- maximum allocation per channel/member in basis points
- minimum evidence sample
- optional deadline, retention requirement and quality threshold

V1 supports `CAMPAIGN` portfolio members only. Campaigns are the existing capital destinations for which Thesma has a complete policy, vault funding, payout and outcome record. Creator, referral and deal-level members are not shown until their capacity and all-in economics can be derived without guessing.

## Verified economics

The kernel uses settled, verified economics only:

- gross creator cost = `SETTLED` payout amounts
- verification expense = terminal production procurement records (`PURCHASED` or `RESULT_RECEIVED`) for the member
- all-in verified CAC = `(settled payout cost + production verification expense) / VERIFIED outcomes`

`PENDING`, `HELD`, `SUBMITTED`, `ACCEPTED`, unverified outcomes and unresolved procurement states do not count as settled acquisition cost. Hybrid base and milestone obligations continue to use the existing CFO accounting and remain protected from prospective allocation.

Retention is optional and evidence-backed. When the objective requires retention, the operator uses real matured D7 evidence. When it is absent, the decision is `REVIEW` and the UI says **RETENTION DATA UNAVAILABLE**; no retention value is manufactured.

The live Arc-Testnet x402 purchase is infrastructure proof paid in test USDC. Any terminal procurement spend on `eip155:5042002` is reported separately as excluded testnet proof spend and is not mixed into production CAC.

## Evidence confidence

- `INSUFFICIENT` — zero verified outcomes
- `PROVISIONAL` — a non-zero but below-policy sample
- `ESTABLISHED` — the typed minimum evidence sample is met

`INSUFFICIENT` and `PROVISIONAL` members receive `REVIEW`, not a blind funding recommendation. Reasons describe what current verified evidence supports; they do not predict that a creator or channel will definitely convert.

## Next-dollar allocation

The deterministic policy kernel returns one of:

- `INCREASE` — established all-in verified CAC is materially inside the ceiling and capacity remains
- `HOLD` — economics are acceptable but there is no strong next-dollar case, or capacity is saturated
- `REDUCE` — near-ceiling economics reduce future prospective allocation without clawing back existing funds
- `PAUSE` — established CAC exceeds the ceiling, reliability fails hard policy, or the member is ineligible
- `REVIEW` — evidence is insufficient, conflicting, ambiguous or unresolved

All money is integer micro-USDC / `bigint` in the kernel. Allocation is bounded by:

- available capital after existing CFO obligations
- the reserve floor
- maximum member/channel concentration
- member capacity
- the remaining target
- existing campaign/deal policy

The output reconciles:

```text
recommended allocations + reserve + intentionally unallocated <= available capital
```

## Reserve policy

Reserve is first-class. The operator calculates the larger of the configured operator reserve and the objective reserve floor, then retains it before any prospective recommendation. For example, a 500 USDC policy budget with a 20% floor retains 100 USDC before considering new allocations.

The UI labels the residual explicitly as intentionally unallocated. A recommendation such as `INCREASE 50 USDC` means:

> Direct the next 50 USDC of still-uncommitted capital here.

It never means taking 50 USDC from another funded campaign.

## Ledger and autonomy boundary

The existing append-only audit ledger records:

- objective and policy snapshot
- portfolio snapshot hash
- decision timestamp and `AUTONOMOUS` mode
- member recommendations, reason codes and evidence confidence
- recommended amounts and reserve
- accounting/protection fields
- `chainMovement: UNAVAILABLE`
- `executionStatus: RECOMMENDED`

Recommendation generation is deterministic and autonomous. Actual prospective allocation state mutation is not silently executed. There is no cross-campaign vault transfer primitive in the current contract surface.

## Known constraints

- V1 evaluates campaigns, not fabricated creator/referral/developer channels.
- A campaign objective is composed from existing campaign intent, target, budget and CAC policy fields; there is no separate mutable portfolio-objective table yet.
- What-if inputs are not persisted and are not part of the V1 UI slice.
- Cross-campaign onchain capital movement remains unavailable with the current vault.
- Northstar remains `PREPARED / UNFUNDED`; Aster remains the canonical mainnet settled proof; Beaconfield remains historical verified/held proof.
- This slice performs no production DB mutation, mainnet funding, payout or transfer.

## Demo framing

> Thesma doesn't merely run campaigns. It continuously compares every eligible way the business can buy a verified outcome and decides where the next dollar should go.

> Campaigns are implementation details. The operator manages an outcome portfolio.
