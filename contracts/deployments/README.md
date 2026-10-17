# Deployments

## Arc mainnet — ThesmaMarketVault DEPLOYED (S8.1B)

- Network: Arc Mainnet, chain ID **5042** (`https://rpc.mainnet.arc.io`)
- Vault: **0x0fA826256a58F19Ad24Fc9384d81D313f2266F79**
- USDC: `0x3600000000000000000000000000000000000000` (verified: code + `decimals()==6` + `symbol()=="USDC"` + onchain `USDC()` getter)
- Deployer: `0x76D7a718CcDc1c132c52D4C05eA0c2FA8e657486` (tx nonce `0x0` — sole transaction)
- Tx: `0xe3c1536f0f13467eea293cb68b8b4b15fdbc4ee06e715f7c32ea7f87b711c558`
- Block **26454958** (2026-10-17T15:40:01Z), status success, no logs (expected)
- Gas used **1,532,109** @ **21,498,868,375** base units → fee **0.03293860972715287 USDC**
- Runtime bytecode verified byte-for-byte against the local forge build, except the 20-byte immutable USDC slot (correctly `0x3600…0000`)
- Machine-readable record: [`arc-mainnet.json`](./arc-mainnet.json)

Runtime wiring: set `THESMA_VAULT_ADDRESS=0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`
(alongside `ARC_CHAIN_ID=5042`, `ARC_RPC_URL`, executor/verifier addresses) to point
the backend at mainnet. Workers stay fail-closed until their secrets are provisioned.
No further onchain setup transaction is required or exists.

Prior state (historical):
- Contract implementation + local Foundry verification: **Shipped** (see `contracts/`).
- Arc testnet deployment/funding: **NOT EXERCISED**.

Never commit private keys or signer mnemonics.
