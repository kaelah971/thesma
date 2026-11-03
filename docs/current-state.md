# Thesma — Current Production State
_Last updated: November 3, 2026_

## Current checkpoint

Thesma is live as an autonomous growth-finance operator and multi-sided outcome marketplace on Arc Mainnet.

### Shipped product surfaces

- Creator capability matching with explainable fit/evidence/economics scoring.
- Organization creator discovery and frozen invitations before funding.
- Creator opportunity inbox with pre-funding visibility and truthful acceptance gating.
- Creator Scout and policy-bound auto-accept/auto-join.
- Hybrid creator deal economics.
- Creator reliability, outcome quality and retention scoring.
- Campaign CFO and prospective capital allocation.
- Outcome Portfolio Operator: deterministic next-dollar recommendations above campaigns, with reserve, concentration, evidence and all-in verified CAC controls.
- Shadow Operator Mode: owner-controlled organization shadow posture for portfolio, verification and settlement recommendations, immutable input/policy snapshots, human agreement/override telemetry, and a central no-execution boundary.
- Build with Thesma embedded growth foundation: project-scoped Growth Programs compose existing campaign/policy drafts with bounded outcome definitions, exact bigint economics, supported creator/referral participant classes, product integrations and default Shadow posture; Slice 2 adds enrollment, frozen participant terms, attribution identities, creator discovery and program-scoped attribution analytics; Slice 3 adds public program config, hosted participation, browser attribution capture, a server-only Outcome API client and generated integration snippets; Slice 4 adds the deterministic program outcome pipeline, frozen reward eligibility, budget/CAC exposure accounting, existing hold/settlement mapping, Campaign CFO mapping, Shadow operator recommendations and embedded receipt/UI context; the existing Outcome API remains the event/evidence/receipt plumbing.
- Verification procurement logic that fails closed when a provider is unavailable.
- Autonomy ladder and unified decision ledger.
- Public markets, creator profiles and zero-login mainnet proof.

### Outcome Portfolio Operator

The organization CFO now exposes an Outcome Portfolio section. It composes existing campaign policies, vault accounting, settled payouts, verified outcomes, reliability/retention evidence, hybrid obligations and production verification procurement expense into one prospective capital plan.

The operator answers:

- objective and remaining verified outcomes
- budget and maximum verified CAC
- allocatable capital and required reserve
- each eligible campaign's `INCREASE`, `HOLD`, `REDUCE`, `PAUSE` or `REVIEW` recommendation
- recommended next allocation, reasons and evidence confidence

All recommendations are deterministic and ledgered. `chainMovement` remains `UNAVAILABLE` and `executionStatus` remains `RECOMMENDED`: the current vault cannot physically move capital between campaigns. The full model and constraints are in [`docs/outcome-portfolio-operator.md`](outcome-portfolio-operator.md).

### Build with Thesma Outcome API

The developer surface at `/build` now starts with **BUILD GROWTH INTO YOUR PRODUCT** and `/build/programs`. Slice 1 creates project-scoped Growth Programs from a business objective, composes an underlying campaign/policy draft with `PURCHASE`, `ACTIVATED_USER`, `QUALIFIED_REFERRAL` or `SUBSCRIPTION_STARTED`, and binds optional integrations without funding. Slice 2 adds `CLOSED` / `INVITE_ONLY` / `OPEN` participation, creator/referral enrollment, frozen reward-policy snapshots, candidate discovery, creator acceptance semantics and stable `ref_…` attribution identities. Programs expose exact bigint budget/CAC/reward values, bounded `CREATORS` / `REFERRAL_PARTNERS`, `SHADOW` default, and honest readiness states.

The API adapter normalizes evidence, computes a stable evidence hash, records `SUBMITTED`/`REVIEW`/`VERIFIED`/`REFUSED` decisions and appends the decision trail to the existing audit ledger. Events may remain legacy-unbound or carry a validated `growthProgramId` and attribution identity. `DIRECT_ATTRIBUTION`, `UNATTRIBUTED`, `INVALID_ATTRIBUTION` and `AMBIGUOUS` are explicit event states. `VERIFIED` is not `PAID`: hold, budget, authority and reconciliation remain separate. Slice 4 program-bound events now expose a deterministic evaluation of frozen reward eligibility, exposure, remaining budget, verified CAC, hold, settlement readiness, operator decision and execution boundary. The program maps to its existing campaign id; no parallel payout or settlement engine is introduced. Program-bound Shadow events can be evaluated but execution and settlement remain blocked; creator invitations are also blocked in Shadow and open enrollment remains a no-notification request. Slice 3 adds public safe config, `/g/:slug`, browser local attribution storage, a server-only SDK with explicit idempotency and receipt reads. Ambiguous evidence can record `WOULD_BUY` without an x402 purchase. The built-in ProofPilot example remains a sandbox/quickstart surface; the separate production Shadow proof is synthetic and not external traction. See [`proofpilot-shadow-pilot.md`](proofpilot-shadow-pilot.md).

See [`build-with-thesma.md`](build-with-thesma.md) for request examples, error codes, limits and known limitations.

### Production schema reconciliation

On November 2, 2026, production was manually reconciled to the shipped Build with Thesma schema without using `npm run db:migrate` and without modifying the untrusted Drizzle migration journal.

- Minimum proven chain: `0018_stormy_sprite.sql` → `0019_safe_stranger.sql` → `0020_salty_sunspot.sql` → `0021_abnormal_eternals.sql`.
- `0018` depends only on the already-present `workspaces` table; `0019` additionally uses existing campaigns, campaign policy versions and users; `0020` and `0021` depend on the preceding Growth Program objects.
- A 51-statement transactional rehearsal passed schema assertions and rollback. The same exact SQL then committed in one transaction; no drops, deletes, rewrites or seed rows were used.
- Post-apply verification reports all Outcome API, Growth Program, participant and attribution tables, columns, indexes and constraints present. PostgreSQL-truncated constraint identifiers were verified against their actual names.
- The reconciled schema remains present and healthy. The pre-provisioned ProofPilot program, participant and attribution resolved through the public API.
- One synthetic production event (`proofpilot_shadow_pilot_001`) created one production receipt under Shadow Mode; no funding, payout or chain execution occurred.
- `/api/health` remains HTTP 200 with `database: ok`; the ProofPilot hosted route and public program API both returned HTTP 200.

This resolves the production schema blocker and completes Slice 5. The proof used the external server SDK/API path, created and read a real production receipt, proved idempotency, and confirmed zero financial execution.

### Slice 5 production Shadow proof

- Program: `ProofPilot Partner Growth` (`proofpilot-partner-growth`)
- Program ID: `f67232dd-665f-42bd-93bf-8419c9459e7d`
- Outcome: `ACTIVATED_USER`; target `100`
- Budget cap: `500 USDC`; verified CAC ceiling: `10 USDC`; reward ceiling: `8 USDC`
- Participant: `ProofPilot Pilot Partner` (`REFERRAL_PARTNER`, `ACTIVE`)
- Attribution: `ref_f5861afb3d6e5efa` → `DIRECT_ATTRIBUTION`
- Event: `e54cec06-8be2-4fa4-b2c2-d07870f28491`; receipt: `receipt_c7a6f45d-91dd-415d-b5b5-26097da34c27`
- Verification: `VERIFIED`; reward: frozen `8 USDC`, `ON_HOLD`; settlement: `NOT_READY`; operator: `HOLD` in `SHADOW`; execution: `BLOCKED_BY_SHADOW`
- Procurement: `NO_CHECK`; paid verification: `0 USDC`; paid: `NO`; transaction: `NONE`
- Zero spend: Circle `0`, x402 `0`, mainnet `0`, testnet `0`, vault funding `0`, payout `0`, real USDC `0`, test USDC `0`

This was a synthetic production integration test under Shadow Mode. It is not customer traction, not a real acquired user, and not a creator payout.

### Northstar production truth

Campaign: `307eb746-dcd6-4f92-b640-cff9764a84f2`

- Workspace: `northstar`
- State: `FUNDING`
- Funding intent: `PREPARED`
- Budget: `50 USDC`
- Funded: `0 USDC`
- Funding transaction: none
- Market: closed until funding is independently confirmed
- Deadline: November 30, 2026
- Company wallet: cryptographically ownership-proven and registered
- Creator invitation: `@bgirl`, frozen at `5 USDC` per verified purchase
- Creator can see the invitation before funding; acceptance remains disabled until the market is live

### Wallet and funding safety

Organization company-wallet registration uses a server-issued, workspace-bound EIP-712 challenge with nonce, expiry, replay protection, recovered-signer verification and explicit confirmation.

The raw `eth_signTypedData_v4` payload includes `types.EIP712Domain`; cross-library viem ↔ MetaMask digest/sign/recover tests pin compatibility.

Funding performs a read-only Arc USDC balance preflight before signing:
- `eth_chainId`
- `eth_call balanceOf`

Insufficient or unavailable balance fails closed. No approval, signature, transaction, or new funding intent is created by the balance check.

### Mainnet proof

The canonical Aster lifecycle is permanent real-money proof:

`FUNDED → PURCHASED → VERIFIED → HELD → SETTLED`

Public zero-login proof: https://thesma.vercel.app/demo

Canonical vault:
`0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`

Arc Mainnet chain ID: `5042`

Canonical Arc USDC:
`0x3600000000000000000000000000000000000000`

### Release gate

- 969 tests passing
- 2 intentional Anvil/env-gated skips
- GitHub Actions: 6 required repository checks
- critical/high npm audit findings: 0
- DB-independent builds
- browser smoke across desktop + mobile
- Foundry contracts
- tracked-secret hygiene

## Current development rule

No additional mainnet spending is required for product proof. The Outcome Portfolio Operator, Shadow Operator and Build with Thesma slices make no mainnet transactions or real-money purchases. This slice makes no x402 procurement call; public config, hosted enrollment requests, SDK capture and external event decisions remain no-spend operations, and shadow recommendations remain `NOT_EXECUTED`.

See [`shadow-operator.md`](shadow-operator.md) for the activation, review, telemetry and hard-boundary contract, and [`build-with-thesma.md`](build-with-thesma.md) for the external API contract.

Use:
- Northstar for organization → creator → invitation → funding-preparation UX
- Aster for real Arc Mainnet settled evidence
- deterministic/local/Anvil verification for flows that would otherwise require additional funds
