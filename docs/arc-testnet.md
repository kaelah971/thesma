# Arc / Canteen Testnet — Safe Setup & Operator Proof

How Thesma develops and proves its autonomous operator on the Arc testnet
without touching production. For judges and future contributors.

Related: [`proof/operator-testnet.md`](proof/operator-testnet.md) (live
evidence log) · [README](../README.md) (product walkthrough).

## Network (public values only)

- Arc / Canteen testnet, chain ID **5042002**
- Explorer: https://testnet.arcscan.app
- USDC as the Arc native gas token: pays transaction gas (18 decimals)
- ERC-20 USDC for contract payment flows:
  `0x3600000000000000000000000000000000000000` (6 decimals)
- Native and ERC-20 are different accountings — do not imply ETH is
  required for Arc testnet gas. It is not.

## RPC architecture (safe by construction)

Thesma reads chain config from explicit environment variables:

```
ARC_NETWORK=testnet
ARC_TESTNET_CHAIN_ID=5042002
ARC_TESTNET_RPC_URL=<private personal Canteen RPC>
ARC_TESTNET_USDC_ADDRESS=0x3600000000000000000000000000000000000000
ARC_TESTNET_VAULT_ADDRESS=<deployed operator vault>
ARC_TESTNET_EXPLORER_BASE_URL=https://testnet.arcscan.app
```

Rules the code enforces:

- `ARC_TESTNET_RPC_URL` is secret and personal — never committed, never
  pasted into issues, docs, screenshots, or chat.
- Testnet keys are never committed (`.env.local` and forge
  broadcast/cache artifacts stay ignored).
- Mainnet and testnet config are intentionally separate: testnet settings
  never inherit mainnet secrets, and testnet identities never leak into
  mainnet config.
- Unknown or mismatched chain configuration fails closed
  (`ARC_NETWORK` accepts only `mainnet`/`testnet`).
- Operator execution refuses mainnet for the testnet demo path
  (`MAINNET_FORBIDDEN` before any store or chain access).

## Canteen CLI workflow (public commands only)

```bash
arc-canteen login
arc-canteen status
arc-canteen rpc eth_chainId
arc-canteen rpc eth_blockNumber
arc-canteen wallet
arc-canteen rotate-rpc-key
```

What this means:

- Authenticated with GitHub; Canteen provides personal Arc testnet RPC access.
- The generated testnet wallet receives test USDC (faucet top-ups are a
  manual human step: https://faucet.circle.com).
- RPC tokens and private keys stay local.

> WARNING: `arc-canteen status` may display the full personal RPC token.
> Never paste its complete output into issues, docs, screenshots, or
> public chat.

## Hardened operator vault (testnet-only)

- `ThesmaOperatorVault`:
  `0x429cf51fabb5dee3c137e6590549bce0b012f478`
- Explorer:
  https://testnet.arcscan.app/address/0x429cf51fabb5dee3c137e6590549bce0b012f478
- Deployment tx:
  `0xb2a6e6be9bfd521d9cd6167c2a29218deab42115e9b498cff24c99d5961bec36`
- The v1 production/mainnet vault was not modified.
- Owner, executor, and verifier are distinct testnet-only wallets.
- Autonomous limits (reserve floor, per-payment cap, period cap) are
  enforced by the contract itself — see
  [`proof/operator-testnet.md`](proof/operator-testnet.md).

## RFB 04 proof, condensed

AI proposes. Policy permits or refuses. Thesma executes. The ledger
proves it. Full log: [`proof/operator-testnet.md`](proof/operator-testnet.md).

- **Autonomous case** — real 0.08 test purchase → 0.3 obligation →
  PAY_NOW → `payoutAutonomous` →
  `0x447b03f68aecaff24d5d6ebebd2f586f33ff4a45198268030a7a9a48ba2a90ac`
  → reconciled SETTLED.
  ([explorer](https://testnet.arcscan.app/tx/0x447b03f68aecaff24d5d6ebebd2f586f33ff4a45198268030a7a9a48ba2a90ac))
- **Policy refusal** — 1.4 obligation vs 0.5 cap → ESCALATE_APPROVAL,
  zero broadcasts; direct autonomous simulation reverted, state unchanged.
- **Human approval** — exact one-time approval
  `0x812d3b6ea403c4a28721e8f055aec7f6b7bc5bb1dc9f1f9ee649a787222f8e9d`
  → approved payout
  `0xc1ff3f79f4fd60272892c760c64fe3d02cb8b93a09bc3af082a0ecc578b79cde`
  → reconciled SETTLED → replay rejected, approval consumed.
  ([explorer](https://testnet.arcscan.app/tx/0xc1ff3f79f4fd60272892c760c64fe3d02cb8b93a09bc3af082a0ecc578b79cde))

Revenue / funded liquidity → assess obligations → autonomous payment
within authority → contract refusal outside authority → human exact
approval → settlement → durable evidence.
