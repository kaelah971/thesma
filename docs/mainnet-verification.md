# ThesmaMarketVault — Mainnet Source-Verification Plan (chain 5042)

Status: **deployed, NOT yet source-verified** (checked 2026-10-22).

- Blockscout (`explorer.arc.io` API): `"is_verified": false` for
  `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`.
- Sourcify v2 (`/v2/contract/5042/0x0fA8…6F79`): `"match": null`.

Bytecode **is** proven deployed (exact runtime match modulo the immutable USDC
slot — see `contracts/deployments/arc-mainnet.json`). Bytecode match is not
source verification. Do not confuse the two.

## Exact build truth (do not guess — read from the repo)

- Source: `contracts/src/ThesmaMarketVault.sol` (SPDX `MIT`, `pragma solidity 0.8.28`)
- `contracts/foundry.toml`: `solc_version = "0.8.28"`, `evm_version = "cancun"`,
  `optimizer = true`, `optimizer_runs = 200`
- Dependencies (pinned): OpenZeppelin Contracts `v5.7.0`
  (`cab19933c33c2ad1d4c7a84864a3601dddfd16f3`), forge-std `v1.17.0`
  (see `contracts/foundry.lock`, `contracts/remappings.txt`)
- Constructor: `constructor(address usdc)` called with exactly one argument:
  `0x3600000000000000000000000000000000000000` (Arc canonical USDC).
  Confirmed in `contracts/broadcast/Deploy.s.sol/5042/run-1792250631795.json`
  (`arguments: ["0x3600…0000"]`, `contractAddress: 0x0fa8…6f79`).
- No proxies, no libraries, one immutable (`USDC`).

## Safest verification path (no redeploy, no transaction, no secrets)

Verification submits source offchain — it never broadcasts and never touches
the production database. Either route works; both use the exact config above.

### Option A — Foundry (recommended, exact settings)

```bash
cd contracts
forge verify-contract \
  --chain-id 5042 \
  --compiler-version 0.8.28 \
  --evm-version cancun \
  --num-of-optimizations 200 \
  --constructor-args $(cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000) \
  0x0fA826256a58F19Ad24Fc9384d81D313f2266F79 \
  src/ThesmaMarketVault.sol:ThesmaMarketVault \
  --verifier blockscout \
  --verifier-url https://explorer.arc.io/api/
```

If the explorer expects Sourcify instead, submit the same exact standard-json
(foundry emits it via `forge build --extra-output-files`) to Sourcify for
chain 5042 — same compiler, optimizer, EVM version, and constructor argument.

### Option B — Blockscout web UI (manual, same data)

1. Open `https://explorer.arc.io/address/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`
   → Contract → Verify & Publish.
2. Compiler `v0.8.28+commit.71c99c77`, EVM `cancun`, optimization `true / 200 runs`.
3. Paste the flattened `ThesmaMarketVault.sol` **or** the standard-json input
   with the OZ `v5.7.0` sources at `lib/openzeppelin-contracts/contracts/`.
4. Constructor argument (ABI-encoded `address`):
   `0000000000000000000000003600000000000000000000000000000000000000`.

## After verification succeeds

- Re-check: Blockscout address API should report `"is_verified": true`, and
  Sourcify `/v2/contract/5042/<address>` should report a `match`.
- Update `README.md` (Arc Mainnet deployment block) and `docs/mainnet-proof.md`
  with the verified-contract link.
- Re-run `arc-canteen submit-showcase` so the entry carries the verified link
  and the X post URL for the Mainnet Bounty.
