# Arc Mainnet Readiness Preflight (S8)

**Status: READ-ONLY preflight. Nothing broadcast, deployed, signed, or moved.**
**Chain exercise: Arc mainnet RPC read-only. No testnet/mainnet transactions exist.**

All values below were observed live from `https://rpc.mainnet.arc.io` unless noted.
No secrets are recorded here — see `.env.example` for variable names only.

## 1. Contracts requiring deployment

| Contract | Deploy? | Constructor | Notes |
|---|---|---|---|
| `ThesmaMarketVault` | **YES — the only deployment** | `(address usdc)` | Non-upgradeable, no proxy, no init txs, no roles |
| Arc USDC token | NO — external dependency | — | Verified live at `0x3600...0000` (code + `decimals()==6` + `symbol()=="USDC"`) |
| `MockUSDC` | NO — test-only fixture | — | Never referenced by vault or deploy script; Anvil/forge only |

### Deployment dependency order

1. Deploy `ThesmaMarketVault` with `usdc = 0x3600000000000000000000000000000000000000`.
2. Nothing else. There are no initialization, role-grant, wiring, or token-config transactions: per-campaign `owner`/`executor`/`verifier` are bound at each `createCampaign` call by the company owner, not at deploy time. The deployer retains **zero** privileges (no admin role exists).

## 2. Arc mainnet configuration (verified)

| Item | Value | Source |
|---|---|---|
| Chain ID | **5042** (`0x13b2`) | live `eth_chainId` on `rpc.mainnet.arc.io` |
| Testnet chain ID (for contrast) | 5042002 (`0x4cef52`) | live `eth_chainId` on `rpc.testnet.arc.io` + Arc docs |
| RPC (public) | `https://rpc.mainnet.arc.io` | Arc docs |
| USDC | `0x3600000000000000000000000000000000000000` | live `eth_getCode` + `decimals()` + `symbol()` |
| USDC decimals (token) | 6 | live `decimals()` |
| Gas unit | USDC, **18-decimal precision** | Arc docs, gas-and-fees reference |
| Fee mechanism | EIP-1559 + base fee | live `eth_gasPrice`; observed base 20 gwei |
| Explorer | none configured in repo | `ARC_EXPLORER_BASE_URL` unset |

Repo default `ARC_USDC_DEFAULT` matches the live token. No CCTP/Gateway/Circle addresses are configured anywhere (nothing to conflict).

## 3. Signer/role readiness (public addresses only)

| Identity | Address | Status |
|---|---|---|
| Owner (EOA, per user) | `0x76D7a718CcDc1c132c52D4C05eA0c2FA8e657486` | KNOWN, onchain nonce `0x0` (fresh) |
| Deployer | assumed owner, **UNCONFIRMED** | owner decision pending; gate enforces `EXPECTED_DEPLOYER` |
| Verifier key | — | MISSING (no key in env; backend fails closed to 503) |
| Executor key | — | MISSING (same) |
| Worker secrets | — | MISSING (all internal routes fail closed to 503/401) |

Key material is never printed, logged, or returned. Mismatches fail closed by tested code paths.

## 4. Bytecode sanity

- `ThesmaMarketVault` creation bytecode: **7404 bytes**, non-empty, compiled from the exact S2 source (forge 1.8.5, solc 0.8.28).
- Constructor args encode: single `address` (USDC) — proven by the dry-run simulation executing `createCampaign`-free deployment successfully.
- No mock/test artifact in the deploy path (`MockUSDC` unreferenced outside tests).
- 34/34 forge tests green against this configuration.

## 5. Gas estimation (read-only simulation, chain 5042)

Simulated with `forge script --rpc-url https://rpc.mainnet.arc.io` (NO `--broadcast`):

| Action | Est. gas | Est. USDC @20 gwei base | Est. USDC @41.5 gwei max | Required? |
|---|---|---|---|---|
| Deploy `ThesmaMarketVault` | 1,991,741 | **0.0398** | **0.0827** | YES |
| Post-deploy init/setup txs | 0 | 0 | 0 | — (none exist) |
| Reference: USDC `transfer` (demo scale) | 49,338 | 0.0010 | 0.0020 | NO (demo only) |

Fee math: `gas × gasPrice / 1e18` (18-decimal gas USDC per Arc docs).

**TOTAL REQUIRED DEPLOYMENT COST: ≈ 0.04–0.08 USDC.**
**Recommended safety buffer: hold ≥ 0.50 USDC** (covers deploy + several demo txs at >6× margin).

## 6. Owner balance vs cost (observed live)

| Balance | Value |
|---|---|
| Native gas balance | `0x29a2241af62c0000` ≈ **3.0 USDC** (18-decimal gas units) |
| ERC-20 USDC `balanceOf` | `0x2dc6c0` = **3.00 USDC** (6-decimal) |
| Account nonce | `0x0` (fresh) |

**Verdict: SUFFICIENT with large buffer** — required ~0.08 USDC worst-case vs ~3.0 USDC available (~37×).

## 7. Deployment config plan (to persist after approval)

PUBLIC (safe to commit): chain ID `5042`, RPC identifier `https://rpc.mainnet.arc.io`,
vault address (from deploy receipt), USDC `0x3600…0000`, verifier/executor/owner
addresses, explorer base if adopted.
SECRET (never commit): `THESMA_VERIFIER_PRIVATE_KEY`, `THESMA_EXECUTOR_PRIVATE_KEY`,
`VERIFIER_INTERNAL_SECRET`, `PAYOUT_WORKER_SECRET`.

## 8. Safety gates status

- [x] No mock token in deploy path; no Anvil-only dependency in `Deploy.s.sol`
- [x] No test verifier/executor configured (all absent → fail closed)
- [x] No `NEXT_PUBLIC` secrets anywhere
- [x] Workers are on-demand secret-gated POST routes; nothing auto-starts, no schedulers
- [x] Payout idempotency survives restart (unique constraints + reconcile; tested)
- [x] Emergency pause exists per campaign (`pauseCampaign`, owner-only); no global kill-switch by design
- [x] Deployer intentionality enforced by `EXPECTED_DEPLOYER` gate (added S8)
- [x] Chain mismatch aborts (`EXPECTED_CHAIN_ID` gate, proven live: simulation printed `Chain 5042`)
- [ ] Backend + worker secrets must be provisioned before any live operation (currently MISSING — correct pre-deployment state)

## 9. Tiny live-proof plan (PLAN ONLY — not executed)

1. Fund check: owner holds ≥ 0.5 USDC gas balance. (~0 cost, read-only)
2. Deploy vault (~0.08 USDC max) → record address + tx hash.
3. `createCampaign` with a **tiny** policy (e.g. target 1, budget 1 USDC, ceiling 1 USDC) from the owner wallet.
4. Fund 1 USDC via `approve` + `fundCampaign`.
5. Backend `funding-confirm` reconciles → campaign LIVE (read-only verification).
6. Second owner wallet or test partner joins; referral click recorded offchain.
7. Micro purchase (e.g. 1 USDC) customer→company; verifier marks VERIFIED.
8. Hold expiry → worker reserve → executor payout → reconcile SETTLED.
9. Assert partner +1 USDC (minus nothing — exact bounty), vault spent == 1 USDC.
10. Abort rule: stop at the first step whose tx hash, event, or state differs from expectation; never retry-blind; reconcile before any resend.
- Estimated extra gas beyond deployment: ~5–8 simple txs ≈ 0.5–1M gas ≈ **≤ 0.05 USDC**.
- Double-pay protection: unique outcome/tx/payout constraints + `outcomeUsed` replay guard (all tested).

## 10. Circle/Arc integration reality (code truth)

IMPLEMENTED: Arc EVM compatibility (viem client, chain-ID gating, receipt/log reconciliation),
USDC ERC-20 flows (`approve`/`transfer`/`transferFrom` calldata + clang evidence), EIP-712
verifier proofs verified against the vault, `eth_*` read patterns, explorer-link receipts.
NOT YET IMPLEMENTED: Gateway, CCTP, x402, Circle Wallets / App Kit, Circle Agent Stack,
paymaster/sponsored fees, fiat on/off-ramps. None are claimed in code; roadmap only.

## 11. Deployment command (prepared, NOT executed)

```bash
USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
EXPECTED_CHAIN_ID=5042 \
EXPECTED_DEPLOYER=0x76D7a718CcDc1c132c52D4C05eA0c2FA8e657486 \
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$ARC_RPC_URL" --account <owner-account> --broadcast
```

Dry-run the identical command **without** `--broadcast` first; it must print the plan
(`Chain 5042`, deployer, USDC) and `SIMULATION COMPLETE` with no broadcast. Only add
`--broadcast` after explicit owner approval. Requires `forge` + a funded `--account`.
