# Embedded Growth Programs

## Product definition

**Direct Thesma** uses Thesma's application to run verified-outcome growth programs.

**Build with Thesma** brings Thesma-powered growth underneath another product. A product team starts with a business objective — for example, acquire 100 activated users at a verified CAC ceiling — rather than starting with an event schema.

The intended composition is:

```text
Developer Project
  → Growth Program
  → participants / partners
  → attribution
  → outcome evidence
  → verification
  → holds
  → settlement eligibility
  → receipts
  → operator / portfolio intelligence
```

The existing Outcome API is plumbing inside this path. It is not a second workflow, payout, settlement or financial-authority system.

## Growth Program model

A Growth Program is a developer-facing configuration that composes:

- an existing bounded Outcome API definition;
- an existing or later product integration;
- an underlying Thesma campaign and policy draft;
- target outcomes, budget, verified CAC and reward ceilings stored as bigint policy values;
- supported participant classes: `CREATORS` and `REFERRAL_PARTNERS`;
- operator posture, defaulting to `SHADOW`;
- participation and attribution readiness state.

Creation is project-scoped and ownership-checked. It creates no wallet, requires no funding and makes no payment, x402, Circle or chain call.

## Slice 1 shipped

From `/build`, a developer can:

1. create a Growth Program from a business objective;
2. choose one of the four bounded outcome types;
3. set exact micro-USDC budget, verified CAC and reward ceilings;
4. select supported participant classes;
5. bind an existing outcome definition or let Thesma create a bounded definition for the objective;
6. optionally bind an existing integration or create one through the service boundary;
7. inspect the program detail page and its honest readiness states.

The program detail route is `/build/programs/:id`. The dashboard route is `/build/programs`.

`PROGRAM CONFIGURED`, `NOT FUNDED`, `NOT CONFIGURED` attribution and `NOT CONFIGURED` settlement are deliberately separate states. `SHADOW` evaluates recommendations but does not execute invites, procurement, payouts, capital movement or settlement.

## What remains

- **Participant embedding:** creator / partner enrollment, eligibility and invitations are the next slice.
- **Attribution primitives:** referral links, codes and attribution sessions are prepared by the underlying campaign model but are not opened by Slice 1.
- **SDK and hosted components:** the existing API key and event surface remains available; an embedded SDK or hosted partner component is not claimed.
- **Live settlement:** existing payout, hold, reconciliation and authority boundaries remain the source of truth. Slice 1 does not fund or settle a program.

## ProofPilot fixture

The UI defaults are a sandbox fixture for ProofPilot Labs:

- Program: ProofPilot Partner Growth
- Outcome: `ACTIVATED_USER`
- Target: 100
- Budget: 500 USDC
- Verified CAC ceiling: 10 USDC
- Reward: 8 USDC per verified activation
- Participants: creators / referral partners
- Evidence: account created, onboarding completed, first project created
- Operator: `SHADOW`

This data is not silently seeded into production. It appears only when a developer creates the program.
