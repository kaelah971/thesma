# Thesma — Current Production State
_Last updated: November 1, 2026_

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
- Build with Thesma embedded growth foundation: project-scoped Growth Programs compose existing campaign/policy drafts with bounded outcome definitions, exact bigint economics, supported creator/referral participant classes, product integrations and default Shadow posture; Slice 2 adds enrollment, frozen participant terms, attribution identities, creator discovery and program-scoped attribution analytics; Slice 3 adds public program config, hosted participation, browser attribution capture, a server-only Outcome API client and generated integration snippets; the existing Outcome API remains the event/evidence/receipt plumbing.
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

The API adapter normalizes evidence, computes a stable evidence hash, records `SUBMITTED`/`REVIEW`/`VERIFIED`/`REFUSED` decisions and appends the decision trail to the existing audit ledger. Events may remain legacy-unbound or carry a validated `growthProgramId` and attribution identity. `DIRECT_ATTRIBUTION`, `UNATTRIBUTED`, `INVALID_ATTRIBUTION` and `AMBIGUOUS` are explicit event states. `VERIFIED` is not `PAID`: hold, budget, authority and reconciliation remain separate. Program-bound Shadow events can be evaluated but execution and settlement are blocked; creator invitations are also blocked in Shadow and open enrollment remains a no-notification request. Slice 3 adds public safe config, `/g/:slug`, browser local attribution storage, a server-only SDK with explicit idempotency and receipt reads. Ambiguous evidence can record `WOULD_BUY` without an x402 purchase. The built-in ProofPilot example is a sandbox/quickstart example, not external traction.

See [`build-with-thesma.md`](build-with-thesma.md) for request examples, error codes, limits and known limitations.

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

- 920 tests passing
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
