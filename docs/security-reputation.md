# Thesma wallet reputation audit

Domain: https://thesma.vercel.app
GitHub: https://github.com/kaelah971/thesma
Arc Mainnet chain ID: 5042
Campaign vault (ThesmaMarketVault, non-upgradeable): `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`
Canonical USDC: `0x3600000000000000000000000000000000000000`
Sourcify: `exact_match` (creation + runtime), verified 2026-10-22 —
`https://sourcify.dev/server/v2/contract/5042/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`
Explorer: `https://explorer.arc.io/address/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`

Status: **no malicious behavior found.** The MetaMask site-level phishing
warning is assessed as a false positive (see below). No wallet-drainer
patterns exist in this codebase.

## Wallet interaction inventory (complete)

All wallet RPCs in `src/` (nothing else touches a provider):

| RPC | Call sites | Gesture |
|---|---|---|
| `eth_requestAccounts` | `src/lib/wallet.ts` `connectWallet` (used by Fund campaign, Register company wallet, checkout Pay) | explicit button click only; never on load, never in effects |
| `eth_accounts` (silent, no prompt) | `getWalletState`, registration consistency checks | read-only, no prompt |
| `eth_chainId` (silent) | network checks | read-only |
| `wallet_switchEthereumChain` | "Switch to Arc Mainnet" button | explicit click; `CHAIN_NOT_ADDED` surfaces manual-add guidance, never invents RPC URLs |
| `eth_signTypedData_v4` | company-wallet registration only | explicit "Sign ownership proof" click, then an explicit "Register wallet" confirmation |
| `eth_sendTransaction` | exactly 3 call sites: `CampaignFunding.execute` (1), `BuyCheckout` (2) | each behind an explicit confirmation click AND a pre-signature preview (amount, network, asset, destination); receipts awaited, reverts recorded, never retried silently |

Explicitly absent from `src/`: `personal_sign`, `eth_sign`, `wallet_watchAsset`,
Permit/Permit2 signing, `approve` calldata builders, unlimited approvals,
`<iframe>`, `window.open` wallet flows, location-based redirects into wallet
actions, third-party scripts (CSP `script-src 'self' 'nonce-…' 'strict-dynamic'`,
no `unsafe-eval`, no wildcard origins; `connect-src 'self'`; no analytics SDKs).

## Proof that registration moves no funds

- `CompanyWalletRegistration` calls only `eth_requestAccounts` (connect),
  `eth_accounts`/`eth_chainId` (reads), and one `eth_signTypedData_v4`
  (structured registration proof). No transaction method exists on that path
  (asserted in `tests/company-wallet-proof.test.ts` and browser smoke).
- The EIP-712 payload registers identity only: domain `Thesma/1/5042`,
  fields `workspaceId, purpose, nonce, issuedAt, expiresAt` — no wallet,
  token, amount, spender, or deadline-for-funds fields exist to approve.
  The recovered signer IS the identity; confirmation registers only that.
- The server stores only the public address; the challenge is single-use
  with a 10-minute expiry and binds user + workspace.
- No private keys, seed phrases, or signing secrets are ever requested,
  logged, or stored (asserted in `tests/security-trust.test.ts`).

## Proof that funding cannot trigger automatically

- Funding intents are server-prepared unsigned calls; `execute()` runs only
  from the "Start signing" click after the preflight preview.
- `prepareFundingIntent` fails closed without a registered company wallet
  (`COMPANY_WALLET_REQUIRED`); the UI gates earlier with a Settings CTA.
- Rejected/reverted/unknown transactions are never retried automatically.

## Trust surfaces

- `/security`, `/privacy`, `/terms` ship with the app.
- `/.well-known/security.txt` (RFC 9116) points at `/security`.
- `/demo` shows only real settled campaigns or an honest unavailable card —
  never fixtures.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, full tests,
  DB-independent builds, real-browser smoke (CSP/hydration/menu/gateway),
  dependency audit, contract tests, and secret hygiene on every push.

## Why the warning is a false positive

1. The flagged behavior (typed-data signature + transaction preview) is the
   standard, user-initiated funding flow above — no obfuscation, no
   auto-prompts, no third-party code that could inject drainer behavior.
2. `*.vercel.app` subdomains are frequently abused by actual scammers, so
   shared-hosting domain reputation is the likely trigger, not this app's
   code or contracts (verified, non-upgradeable vault; exact-match Sourcify).
3. Static inventory (`tests/wallet-reputation.test.ts`) pins the absence of
   every drainer-like pattern on every CI run; any regression fails the build.

## Review links for MetaMask / Blockaid

- Repository (auditable history): https://github.com/kaelah971/thesma
- Contract verification: https://sourcify.dev/server/v2/contract/5042/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79
- Explorer: https://explorer.arc.io/address/0x0fA826256a58F19Ad24Fc9384d81D313f2266F79
- Security contact: https://thesma.vercel.app/security
- This file: `docs/security-reputation.md` (versioned with the code it describes)
