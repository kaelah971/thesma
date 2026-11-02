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

## Slice 2 shipped

The program detail page now manages project-scoped participation at `/build/programs/:id`:

1. choose `CLOSED`, `INVITE_ONLY` or `OPEN` participation;
2. register creator requests and referral partners with bounded participant types;
3. approve, pause, remove or decline participants;
4. snapshot the program's reward policy at enrollment time;
5. issue a stable `ref_…` attribution identity only when a participant becomes `ACTIVE`;
6. resolve attribution through the program-scoped API and show attributed, verified, review and refused analytics;
7. discover creator candidates through the existing capability/matching kernel.

Creator invitations remain an execution boundary: a program in `SHADOW` cannot create an invitation or send a notification. `OPEN` enrollment can create an `APPLIED` request without external side effects, and an owner can activate it. A creator acceptance route is ownership-checked against the invited creator. Referral identities are embedded Growth Program primitives; they do not create legacy campaign terms, payouts or a second referral authority.

The participant API is available at:

- `GET/POST /api/v1/programs/:id/participants`
- `GET /api/v1/programs/:id/participants/:participantId`
- `GET /api/v1/programs/:id/analytics`
- `POST /api/v1/programs/:id/participants/:participantId` with `APPROVE`, `PAUSE`, `REMOVE` or `DECLINE`
- `POST /api/v1/programs/:id/participants/:participantId/accept`
- `POST /api/v1/programs/:id/participation`
- `GET /api/v1/programs/:id/participants/candidates`
- `POST /api/v1/programs/:id/attribution/resolve`
- `GET /api/v1/programs/:id/attribution/:code`

Outcome events can include `growthProgramId` and `attributionId`. A valid active identity produces `DIRECT_ATTRIBUTION`; missing attribution is `UNATTRIBUTED`; revoked, cross-project, cross-program or inactive identities are `INVALID_ATTRIBUTION`; an ambiguous resolver result is `AMBIGUOUS`. Invalid attribution refuses the event and ambiguous attribution enters review. Attribution is evidence, not authority to procure, pay, settle or move capital.

## What remains

- **SDK and hosted components:** the existing API key and event surface remains available; an embedded SDK or hosted partner component is not claimed.
- **Live settlement:** existing payout, hold, reconciliation and authority boundaries remain the source of truth. Slice 2 does not fund or settle a program.
- **Real ProofPilot integration:** ProofPilot remains a sandbox/quickstart fixture; no production tenant is seeded or claimed.

## Migration

Slice 2 adds `drizzle/0020_salty_sunspot.sql`. It creates participant and attribution identity tables and adds attribution fields to external outcome events. It has not been applied automatically; review it with the existing production migration process.

## ProofPilot fixture

The UI defaults are a sandbox fixture for ProofPilot Labs. Slice 2 adds empty participant and attribution states; it does not silently seed production fixtures:

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
