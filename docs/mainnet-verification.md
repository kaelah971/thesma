# ThesmaMarketVault — Mainnet Source Verification (chain 5042)

Status: **VERIFIED via Sourcify (exact_match, 2026-10-22T14:48:09Z)**.

- Sourcify v2 (`/v2/contract/5042/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`): `match: exact_match`, `creationMatch: exact_match`, `runtimeMatch: exact_match`, `verifiedAt: 2026-10-22T14:48:09Z`, `matchId: 56720486`.
- Verification job: `b5ed2a95-8669-474c-84aa-fdce7313681b` (HTTP 202 → `isJobCompleted: true`).
- Sourcify lookup: `https://sourcify.dev/server/v2/contract/5042/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79` — Arc mainnet address `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`.
- Blockscout forwarding queued via Sourcify (verificationId `0fa826256a58f19ad24fc9384d81d313f2266f796ada2229`, explorer `https://explorer.arc.io/address/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`); direct Blockscout API check returns Cloudflare 403 from this environment, so Blockscout UI status is not independently confirmed. Bounty accepts Blockscout OR Sourcify; Sourcify `exact_match` is authoritative success.

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

## Verification result (2026-10-22, source-only, no broadcast)

- Sourcify POST `https://sourcify.dev/server/v2/verify/5042/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79` with `stdJsonInput` from `contracts/verification/ThesmaMarketVault-standard-input.json`, `compilerVersion 0.8.28+commit.7893614a`, `contractIdentifier src/ThesmaMarketVault.sol:ThesmaMarketVault`, `creationTransactionHash 0xe3c1536f0f13467eea293cb68b8b4b15fdbc4ee06e715f7c32ea7f87b711c558` → HTTP 202, `verificationId b5ed2a95-8669-474c-84aa-fdce7313681b`.
- Poll `GET /v2/verify/b5ed2a95-8669-474c-84aa-fdce7313681b` → `isJobCompleted: true`, `match: exact_match`, `creationMatch: exact_match`, `runtimeMatch: exact_match`, `verifiedAt: 2026-10-22T14:48:09Z`, `matchId: 56720486`.
- Confirm `GET /v2/contract/5042/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79` → `exact_match` (creation + runtime).
- Sourcify also returned external forwarding refs: Blockscout `https://explorer.arc.io/address/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79` and Etherscan-family `https://arc.etherscan.io/address/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`.
- No redeploy, no broadcast, no gas/USDC spent, no DB touched for verification.

## After verification succeeds (done)

- [x] Sourcify `/v2/contract/5042/<address>` reports `exact_match`.
- [x] Updated `README.md` (Arc Mainnet deployment block) and `docs/mainnet-proof.md` with the verified-contract link.
- [ ] Re-run `arc-canteen submit-showcase` so the entry carries the verified link and the X post URL for the Mainnet Bounty (operator step, not done here).
