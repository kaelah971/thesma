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

- 908 tests passing
- 2 intentional Anvil/env-gated skips
- GitHub Actions: 6 required repository checks
- critical/high npm audit findings: 0
- DB-independent builds
- browser smoke across desktop + mobile
- Foundry contracts
- tracked-secret hygiene

## Current development rule

No additional mainnet spending is required for product proof. The Outcome Portfolio Operator and Shadow Operator slices make no mainnet transactions or real-money purchases. Shadow review persistence is append-only audit data; recommendations remain `NOT_EXECUTED`.

See [`shadow-operator.md`](shadow-operator.md) for the activation, review, telemetry and hard-boundary contract.

Use:
- Northstar for organization → creator → invitation → funding-preparation UX
- Aster for real Arc Mainnet settled evidence
- deterministic/local/Anvil verification for flows that would otherwise require additional funds
