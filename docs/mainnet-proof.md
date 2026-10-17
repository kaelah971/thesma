# Thesma S8.2 Full Mainnet Proof — $1.00 Purchase → Verify → Hold → Payout → Reconcile

Live end-to-end proof on Arc Mainnet. Exactly **1.00 USDC** of campaign funding,
one verified purchase, one payout of exactly **1,000,000 micro-USDC**, reconciled
against canonical onchain evidence, plus a live second-run no-double-pay proof.

No secrets in this document. All hashes/addresses below are public onchain data.

## Canonical chain facts

- Arc chain ID: **5042**
- Arc RPC: `https://rpc.mainnet.arc.io`
- USDC (Arc canonical): `0x3600000000000000000000000000000000000000`
- ThesmaMarketVault (canonical, unchanged): `0x0fA826256a58F19Ad24Fc9384d81D313f2266F79`
- Vault deployment tx: `0xe3c1536f0f13467eea293cb68b8b4b15fdbc4ee06e715f7c32ea7f87b711c558` (block 26454958)

## Roles (public addresses only)

- Owner / company / deployer: `0x76D7a718CcDc1c132c52D4C05eA0c2FA8e657486`
- Customer payer: `0x15b8605e7ce72E114aBeAF1D8b3315C0874B53E7`
- Executor (backend submitter): `0x85386a1927B3532D8D08fe5DEE53003cEeA56c75`
- Verifier (backend EIP-712 signer): `0x2557CEc7968a565EbF2f5E54A54A65Bf0396a36A`
- Partner recipient (already-configured wallet, payout destination): `0xeBB551653815900D6886d2eeEea2325d86275173`

## Campaign

- Campaign ID: `5571f328-ceeb-4712-8671-a72be1966ffb`
- Campaign key (bytes32): `0x28bfb4381fc8feb2af0e93d9b42eb2276d24631c762c4cd195f9f918b655f0b9`
- Policy hash (bytes32): `0x83d2b960ce5156e3989179baf2893cbab8d864851c597c7ae84051dc8944e007`
- Policy: version 1, APPROVED, budget 1,000,000 micro-USDC, bounty ceiling 1,000,000 micro-USDC, `refundHoldSeconds: 3600`
- Campaign state at payout time: **LIVE** (still LIVE after settlement)
- Campaign creation tx: `0xb126f24e96b8ea9cebeb6b8f67bf2cd059cdc5fa0955b06481342d78e5701255`
- USDC approval tx (vault, 1.00 USDC): `0x1a65c18d1c27ee42b56cff3bb0e8b806d3ce811d1390f7a884bbf4ae94af488a`
- Funding tx (1.00 USDC): `0x5302634da4500b29338a14739917aff66d22e902f1d8dcf910f91a4f1cec05a3` (block 26472422)
- Funding record: CONFIRMED, expected 1,000,000 / observed 1,000,000 micro-USDC, chainId 5042

## Purchase (customer pays company, not the vault)

- Checkout order: `ord_58365ae101af7d821cf3b613`
- Customer purchase tx: `0xddf1fd01f815b69c5e30487d2916c6e91186f58af293fd38b5bfef15473aa5ad` (block 26484112)
- Amount: 1,000,000 micro-USDC (1.00 USDC), payer → company merchant
- Checkout intent: CONFIRMED

## Outcome + proof binding

- Outcome ID: `8232083c-3b1b-4394-a03e-0e15714beece`
- OutcomeId (bytes32, `keccak256("thesma:outcome:<uuid>")`): `0x815415031f329b9ee6578b6b2a959cf1b71b376afdb03a70e9a352a77e208637`
- Proof hash (bytes32): `0xca8a726ab92366eade1acd4186e5aa01e9b120e94a5da18eb6587e5703a8c9e2`
- Status: **VERIFIED**
- VERIFIED at: `2026-10-17T19:48:17.123Z`
- occurredAt: `2026-10-17T19:46:12.000Z`
- Hold start: `2026-10-17T19:48:17.123Z` (verification time; 3600-second refund hold)
- Payout-eligible at: `2026-10-17T20:48:17.123Z`
- Hold legitimately expired before payout: **yes** (payout executed ~2026-10-17T21:4xZ, well after eligibility)

## Pre-payout reconciliation (read-only, all passed)

1. RPC `eth_chainId` == 5042: **pass**
2. Vault address == canonical `0x0fA8…6F79`: **pass**
3. Campaign still LIVE: **pass**
4. Funding still CONFIRMED at exactly 1,000,000 micro-USDC: **pass**
5. Outcome still VERIFIED: **pass**
6. Proof binding unchanged (`proofHash` matches funding terms path): **pass**
7. Hold genuinely expired (now > `2026-10-17T20:48:17.123Z`): **pass**
8. Partner USDC balance still 0 before payout: **pass** (`0`)
9. Executor still funded (USDC 20,000 micro + native gas before submit): **pass**
10. Zero existing payout for this outcome (DB 0 payouts, `outcomeUsed == false`): **pass**
11. Zero conflicting reservation (DB 0 reservations): **pass**
12. Vault/campaign still has sufficient payable funds (`funded - spent == 1,000,000`): **pass**

Onchain pre-state: `funded = 1000000`, `spent = 0`, `outcomeUsed = false`, vault USDC `1000000`.

## Payout execution (existing production worker path only)

Path used (no manual state, no bypasses, no weakened guards):

```
VERIFIED → reserveOutcomePayout → RESERVED/PREPARED
→ sign existing EIP-712 outcome proof → submit exactly once → SUBMITTED
→ reconcilePayout(receipt/event) → SETTLED
```

Implementation: existing `processEligiblePayouts` (reserve → settle → reconcile),
same code path as `POST /internal/payouts/process`. First invocation result:

```json
{ "scanned": 1, "reserved": 1, "submitted": 1, "settled": 1, "skipped": [], "failed": [] }
```

- Reservation ID: `9bb3e86f-42d6-4057-9526-89662dbdb854` — state **SETTLED**
- Payout ID: `c9bd4065-3f5e-40ee-a215-627a34e1f6d0` — state **SETTLED**
- Payout tx (submitted exactly once): `0xec3ab9e2bd8ad1ce1412fc0c2c4a65897dc598ddc221c3ef18cd148f350cb6b0`
- Payout block: `26497832`, receipt status `success`, `to` == vault, `from` == executor
- Recipient: `0xeBB551653815900D6886d2eeEea2325d86275173` (already-configured partner wallet)
- Amount: **1,000,000 micro-USDC (1.00 USDC)**

## Settlement evidence (matching OutcomePaid event)

`OutcomePaid` in the payout receipt:

- campaignKey: `0x28bfb4381fc8feb2af0e93d9b42eb2276d24631c762c4cd195f9f918b655f0b9` — matches funding
- policyHash: `0x83d2b960ce5156e3989179baf2893cbab8d864851c597c7ae84051dc8944e007` — matches funding
- outcomeId: `0x815415031f329b9ee6578b6b2a959cf1b71b376afdb03a70e9a352a77e208637` — matches outcome
- recipient: `0xeBB551653815900D6886d2eeEea2325d86275173` — matches partner wallet
- amount: `1000000` — exact 1.00 USDC
- proofHash: `0xca8a726ab92366eade1acd4186e5aa01e9b120e94a5da18eb6587e5703a8c9e2` — matches outcome
- Campaign binding correct: **yes**
- Outcome/proof binding correct: **yes**
- Recipient correct: **yes**
- Amount exact 1,000,000 micro-USDC: **yes**
- Partner balance actually increased (0 → 1,000,000): **yes**
- DB marked SETTLED only after matching onchain evidence: **yes**
- Matching OutcomePaid event: **yes**
- Reconciliation result: **SETTLED**

Post-state onchain: `funded = 1000000`, `spent = 1000000`, `outcomeUsed = true`, vault USDC `0`.

## Live idempotency test (second worker run, same outcome)

Ran the normal payout processing path a second time for the same outcome.
Second invocation result:

```json
{ "scanned": 1, "reserved": 0, "submitted": 0, "settled": 0,
  "skipped": [{ "outcomeId": "8232083c-3b1b-4394-a03e-0e15714beece", "reason": "ALREADY_SETTLED" }],
  "failed": [] }
```

- Duplicate reservation created: **no** (reservation count still **1**)
- Duplicate payout created: **no** (payout count still **1**)
- Second transaction submitted: **no** (single tx `0xec3ab9e2…cb6b0`; audit shows exactly one each of `payout.reserved`, `payout.prepared`, `payout.submitted`, `payout.settled`)
- Additional partner balance increase: **no** (partner USDC still `1000000` after second run)
- Domain state after second run: reservation SETTLED, payout SETTLED (unchanged)

## Final accounting / balances (USDC micro-units)

- Campaign funding in: 1,000,000 (exactly 1.00 USDC, one funding tx)
- Campaign paid out: 1,000,000 (exactly 1.00 USDC, one payout tx)
- Vault USDC: `0` (funded 1,000,000 − spent 1,000,000)
- Partner: `1000000` (0 before → 1,000,000 after; no further increase on rerun)
- Owner/company: `1934464` (~1.93 USDC; funded proof + gas, received 1.00 USDC purchase)
- Customer: `3947` (dust remainder)
- Executor: `16486` (~0.016 USDC; started 20,000, ~3,514 micro-USDC of Arc USDC-gas for the payout submit)
- Verifier: `0` (never holds funds; offchain signer only)
- Campaign state: LIVE; funding CONFIRMED; outcome VERIFIED; reservation SETTLED; payout SETTLED

## S8.2 full mainnet proof: COMPLETE

Purchase → verify → 3600s hold → reserve → sign → submit once → reconcile →
SETTLED → second-run no-double-pay. All on Arc mainnet (chain 5042) through the
production payout/domain path with reservation and reconciliation enforced.
