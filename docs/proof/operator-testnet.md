# Autonomous Operator — Canteen Arc Testnet Proof (RFB 04)

Live onchain evidence that Thesma's operator spending authority is enforced
by the vault itself, not just the backend. No mainnet interaction occurred
at any point in this run.

- Chain: Canteen Arc Testnet, **5042002**
- RPC: personal Canteen endpoint (token redacted, never committed)
- Explorer: https://testnet.arcscan.app
- Test USDC (ERC-20): `0x3600000000000000000000000000000000000000` (6 decimals)
- Gas: native USDC, 18 decimals

## Roles (all testnet-only, all distinct)

| Role | Address |
| --- | --- |
| Owner / deployer | `0xa45e9deD087715771d7aDc6E9a050712Dea91Bce` |
| Executor (agent) | `0x2954150d46291229E2b38cD379bbA2AFc119F9CB` |
| Verifier (EIP-712 signer) | `0x98E40692CAAD53975424F329C0a4fed5a1Fc614E` |

Owner deploys, funds, and governs. Executor submits payouts. Verifier signs
proofs offchain. No single key besides the owner can change authority.

## Deployment (real broadcast #1–2)

- Vault: `ThesmaOperatorVault` at
  `0x429cf51fabb5dee3c137e6590549bce0b012f478`
- Deployment tx:
  `0xb2a6e6be9bfd521d9cd6167c2a29218deab42115e9b498cff24c99d5961bec36`
  (`success`, block **67981359**)
- Executor gas funding (0.2 native):
  `0x98684d8e5be911ef256549b9e94f3e506c510b3a74e3f4528fb16ae190dc61c7`
  (`success`, block 67981303)
- Explorer: https://testnet.arcscan.app/address/0x429cf51fabb5dee3c137e6590549bce0b012f478

The v1 mainnet vault (`0x0fA8…2266F79`, chain 5042) was not touched.
No generic `payoutVerifiedOutcome` exists on the new vault — every executor
payout must pass the autonomous gate or an exact human approval.

## Campaign + policy (real broadcasts)

- Campaign key:
  `0x6812607f430cab9eff71454c33f03e97389a684c91b112f47b82c974cba6a2c5`
- Policy hash (read back onchain):
  `0x4f48807ca45d841bca8ba3853de85e4ddec7578fa11379e16eb2d649c669fc2e`
- `createCampaign` (budget 2.0 USDC, ceiling 2.0, 30d):
  `0x94e82c772977e743814165b44a93e720edb570b3519a2d5875d09d202621a891`
- ERC-20 approve + `fundCampaign` (2.0 USDC):
  `0x14f8e30aba462c3ec53096b16f9788d4ef1ea46b2f6248ed5e8d8da32f2ca7e8`,
  `0xb035d4ce3964d61421a6b4e80e77ef8a7ac12f40ac4e2643d7acaca6ce774003`
- `setOperatorPolicy` (reserve 0.2, maxPay 1.0, periodCap 2.0, 24h window):
  `0x1ac98c7c31f7d4cf8ee050002ba000200b70bb67990444cf3656ffbcef3b074b`
- Onchain policy read-back: enabled=true, spentInPeriod=0, values as set.

## Proven live (eth_call, zero broadcasts)

Against the deployed bytecode, all reverted with no state change:

1. Executor calls `setOperatorPolicy` → **reverts** (agent cannot govern;
   exact selector `NotOwner` proven in Foundry).
2. `payoutAutonomous` 1.5 USDC over the 1.0 cap → **reverts**
   (`OverAutonomousPayment` in Foundry).
3. `payoutAutonomous` on an unknown campaign → **reverts**
   (`UnknownCampaign` in Foundry).

(The Canteen node returns bare revert markers without custom-error data;
exact selectors for all three are asserted in
`contracts/test/ThesmaOperatorVault.t.sol` against the same bytecode.)

## Proven on Anvil (47/47 Foundry, same source)

Per-payment cap, period cap + 24h rollover, reserve floor, disabled-policy
and unconfigured-policy fail-closed, budget/ceiling intact, exact approval
executes once, wrong amount/outcome rejected, replay rejected (consumed +
outcome/proof guards), stranger cannot approve, executor cannot govern.

## App-layer dry run (reads only, 0 broadcasts)

Operator snapshot over a scratch DB + live testnet reads:
funded 2000000, available 1800000 (2.0 − 0 committed − 0.2 reserve),
0 obligations → planner nominates nothing → `NO_ACTION`;
onchain policy read `enabled=true, spentInPeriod=0`.
Decision/ledger mechanics for PAY_NOW / ESCALATE / approve / replay are
covered by `tests/operator.test.ts` (mocked chain) — see below for what is
still needed to run them live.

## What is NOT yet proven live (exact unblock list)

1. **Owner native gas is empty** (~0.0007 USDC; contract calls need ~10×
   that). Top up `0xa45e…91Bce` via https://faucet.circle.com (manual)
   for: policy edits, the `approveObligation` broadcast, and any further
   owner transactions.
2. **Fresh executor + verifier keys are required.** A key-handling bug in
   the demo scripts (`account.privateKey` is `undefined` in viem v2 — only
   `generatePrivateKey()` output is persistable) means the bound executor /
   verifier keys were never retained, and a new campaign binding new keys
   is needed (the vault has no re-keying by design). Generate with
   `generatePrivateKey()`, persist the hex immediately, verify lengths.
3. **Owner ERC-20 is ~0.046 USDC.** A second demo campaign needs ~0.5 USDC
   (funding + two qualifying test purchases) — same faucet trip as (1).
4. Then, in order: new campaign + fund + policy → customer test purchases
   → real S4 verification → operator PAY_NOW (`payoutAutonomous`) →
   over-cap obligation → `ESCALATE` + onchain revert → owner
   `approveObligation` → `payoutApproved` → replay rejection →
   reconciliation + ledger.

## Safety notes

- Scratch Postgres + scratch fixtures only; production DB untouched
  (migration 0010 still unapplied in prod — operator API falls back to
  defaults there).
- No RPC tokens, private keys, or wallet files are committed anywhere in
  this slice (`.env.local`, forge broadcast/cache artifacts stay ignored).
- Native gas uses 18 decimals, ERC-20 USDC 6 — confirmed against chain.
