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

## Slice 3 shipped

A developer can now connect another product without rebuilding the attribution or verification authority:

- public config: `GET /api/v1/public/programs/:slug`;
- public attribution resolution: `GET /api/v1/public/programs/:slug/attribution/:code`;
- hosted participant surface: `/g/:programSlug`;
- public referral-partner request and authenticated creator request routes;
- browser SDK at `src/sdk/browser.ts` for `?ref=` capture, namespaced local persistence, safe retrieval/clear and referral URL construction;
- server SDK at `src/sdk/server.ts` for API-key-authenticated event submission, status and receipt reads;
- generated hosted/browser/server snippets on the program detail page.

The browser client never accepts an API key. The server client requires an explicit `idempotencyKey` and reuses the existing Outcome API, attribution resolver, receipt and Shadow boundaries. Public responses omit budgets, CAC ceilings, policy internals, integration identifiers, wallets, API keys and private creator data.

`productUrl` is optional, validated as a credential-free HTTP(S) URL and required to use HTTPS in production. It is used only for referral-link examples and return-to-product context.

## Slice 4 shipped

Embedded outcomes now flow through one deterministic internal evaluation after Outcome API intake:

```text
attribution → existing evidence verification → value-of-information recommendation
→ frozen participant reward eligibility → program budget/CAC accounting
→ existing hold state → campaign settlement eligibility → Shadow operator decision
→ safe receipt / audit decision
```

The evaluation is advisory and composes existing Thesma records. It does not create a parallel payout, verification, procurement, receipt, ledger or settlement engine. The Growth Program's `campaignId` is the mapping into existing campaign CFO and settlement authority. Performance-only rewards use the supported campaign representation; hybrid base/milestone legs are explicitly `UNSUPPORTED_SETTLEMENT_PATH`.

For a verified attributed outcome the private receipt can show the program, participant, attribution identity, evidence hash, frozen reward, eligible/held/settled exposure, remaining budget, verified CAC state, hold, settlement eligibility, operator reason codes and execution status. In Shadow, `WOULD_SETTLE` can be computed while execution remains `BLOCKED_BY_SHADOW`, paid amount is `0`, and Circle/x402 calls remain `0`. Existing Shadow review responses remain the human `AGREE` / `OVERRIDE` / `IGNORE` telemetry path.

- **Real ProofPilot integration:** ProofPilot remains a sandbox/quickstart fixture; no production tenant is seeded or claimed.
- **Published package:** the SDK is local source only; npm publishing and release infrastructure are intentionally out of scope.
- **Slice 5:** reviewed production migrations and a real ProofPilot-style Shadow pilot remain next; this slice does not apply migrations or enable financial execution.

## Migration

Slice 2 adds `drizzle/0020_salty_sunspot.sql`. Slice 3 adds `drizzle/0021_abnormal_eternals.sql` for the optional product URL. Slice 4 adds no migration: pipeline economics are derived from the existing event, program, participant, campaign funding, audit and settlement records. Migrations `0019`, `0020` and `0021` create no production data and have not been applied automatically; review them with the existing production migration process.

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
