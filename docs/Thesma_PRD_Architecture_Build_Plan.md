# THESMA — PRD, ARCHITECTURE AND BUILD PLAN

**Master brand:** Thesma  
**Category:** Autonomous market for verified business outcomes  
**First market:** Verified paid-customer acquisition on Arc  
**Primary line:** Set the outcome. Let the agent find the price.  
**Document status:** Target architecture and build plan. No section in this document is evidence that the feature is already shipped.

> This document is an editable Thesma replacement reconstructed from the supplied PRD/architecture/build-plan PDF. The original PDF remains unchanged.

## Status vocabulary

- **Shipped** — implemented and exercised in the current build.
- **Target** — specified for the MVP or current build phase.
- **Roadmap** — intentionally deferred beyond the MVP.
- **Hypothesis** — requires product, market or performance validation.

---

# 1. PRD snapshot

## 1.1 Product definition

Thesma is a two-sided autonomous market for measurable business results. A company’s Demand Agent continuously prices and allocates a bounded campaign budget. Partner Supply Agents evaluate live opportunities, join or skip them and negotiate within Partner-defined rules. A deterministic verifier establishes whether the agreed outcome happened. A policy and contract layer enforces authority. Arc settles USDC when the supported implementation path is available.

## 1.2 Primary demand user

Organization owner or growth operator with:

- An Arc wallet or supported wallet adapter.
- A measurable customer-acquisition goal.
- A bounded campaign budget.
- Authority to approve a campaign policy.

## 1.3 Primary supply user

Creator or distribution Partner with:

- A payout wallet or supported wallet adapter.
- A distribution surface.
- Minimum price, category and capacity rules.
- Authority to accept or reject opportunities.

## 1.4 Core job

Let a company delegate bounded acquisition economics to a Demand Agent while a Partner delegates market selection and negotiation to a Supply Agent.

## 1.5 Core outcome

A verified paid customer attributed to a Partner referral route and satisfying the campaign’s qualification rule.

## 1.6 Settlement model

- Customer revenue goes directly to the company wallet.
- Campaign bounty budget funds Partner payouts.
- Partner payout is made in Arc USDC when the target implementation and network support are live.
- The platform must not mix customer revenue with the acquisition budget.

## 1.7 MVP success definition

The MVP succeeds when one real or explicitly labelled test company:

1. Funds a campaign.
2. Has multiple Partners join.
3. Receives an attributed qualifying purchase.
4. Produces a single verified outcome.
5. Causes at least one payout to settle automatically inside hard limits.
6. Shows a reviewable decision and outcome receipt.

The evidence must state what is real, test, seeded or simulated.

## 1.8 Non-negotiable product rule

> **Human sets the objective and hard boundaries. The agent controls strategy inside them. Deterministic systems establish truth. Smart-contract or policy controls enforce authority.**

---

# 2. Goals, non-goals and personas

## 2.1 Goals

- Make campaign creation conversational while keeping authority explicit and structured.
- Allow a Demand Agent to make real, bounded financial decisions without per-payment approval.
- Give every Partner a Supply Agent that watches markets and can join or negotiate inside personal rules.
- Prove outcomes from attributed purchase data plus Arc transaction evidence.
- Make repricing, negotiation, pause and payout explainable and auditable.
- Produce a genuine USDC flow or a clearly labelled testnet flow for the demo.
- Give a reviewer a complete money loop that can be understood without private narration.
- Keep customer revenue separate from acquisition budget.

## 2.2 Non-goals for V1

- Crosschain funding or Gateway routing.
- Fiat on-ramp or off-ramp.
- Automated public posting to creator social accounts.
- Generic content or task bounties.
- Broad creator discovery and research operating system.
- Multi-touch attribution or ad-network integrations.
- Full KYC and compliance suite.
- Unbounded agent access to a company treasury.
- Every possible outcome type.
- Multi-agent swarm architecture.
- Guaranteed acquisition performance.

## 2.3 Personas

### Company owner

**Needs:** Fast customer acquisition, clear CAC, bounded spend and an explanation for why the agent changed price.  
**Hard concern:** The agent must not touch revenue or overspend.

### Growth operator

**Needs:** A live view of pace, supply, conversion and remaining economics.  
**Hard concern:** A static commission or an opaque recommendation does not help them act.

### Creator or Partner

**Needs:** Good opportunities, fair price, transparent attribution and fast payout.  
**Hard concern:** Do not waste scarce audience attention on low-fit or low-return campaigns.

### Customer

**Needs:** A simple purchase flow.  
**Hard concern:** The customer should not need to understand agents, bounties or payout logic.

### Judge or reviewer

**Needs:** A fast demonstration of genuine agentic economic decision-making.  
**Hard concern:** A decorative chat interface must not masquerade as autonomy.

---

# 3. Core functional requirements

## 3.1 Organization side

### ORG-01 — Create workspace and connect wallet

**Requirement:** The organization creates a workspace and connects an Arc wallet or supported adapter.  
**Acceptance:** Wallet identity is persisted; chain mismatch is blocked; balance is readable; no raw private key reaches the model or browser client.

### ORG-02 — Define campaign intent

**Requirement:** Owner chats with the Demand Agent to define goal, target count, budget, maximum bounty or CAC, minimum qualifying purchase, deadline, visibility and escalation rules.  
**Acceptance:** Agent produces a structured draft and asks only for missing required fields.

### ORG-03 — Review and approve policy

**Requirement:** Owner reviews the structured campaign policy.  
**Acceptance:** No campaign can become live before explicit policy confirmation. Owner-controlled fields cannot be changed by the Demand Agent.

### ORG-04 — Fund campaign

**Requirement:** Owner funds the campaign from the connected wallet.  
**Acceptance:** On-chain funding is confirmed before the agent can reserve or pay budget. The UI clearly distinguishes wallet approval, funding submitted and funding confirmed.

### ORG-05 — View live market state

**Requirement:** Owner sees target progress, remaining budget, public price, pace state, active Partners, verified revenue and realized CAC.  
**Acceptance:** Values are tied to a current market-state version and update after relevant events.

### ORG-06 — View decisions and escalations

**Requirement:** Owner can inspect reprices, pauses, counters, reservations, payouts and escalations.  
**Acceptance:** Each decision stores inputs, reason, before-state, after-state, policy result, actor and timestamp.

### ORG-07 — Pause, close and recover

**Requirement:** Owner can pause or close a market and recover unspent funds safely.  
**Acceptance:** Owner-only action; pending and reserved payout states are respected; funds cannot be returned while an unresolved obligation would be invalidated.

## 3.2 Partner and customer side

### PAR-01 — Create Partner profile and payout wallet

**Requirement:** Partner creates a profile and connects a payout wallet or supported adapter.  
**Acceptance:** Wallet is proven or connected; self-referral checks can compare payout and purchasing identities where available.

### PAR-02 — Configure Supply Agent rules

**Requirement:** Partner sets minimum bounty, allowed and blocked categories, maximum active campaigns, auto-join and auto-negotiate toggles.  
**Acceptance:** Rules persist and are applied before agent action.

### PAR-03 — Browse ranked live markets

**Requirement:** Partner sees live markets ranked by Supply Agent fit.  
**Acceptance:** Each market exposes public bounty, fit explanation, expected return estimate, deadline and remaining supply signal.

### PAR-04 — Join campaign

**Requirement:** Partner joins manually or Supply Agent auto-joins within rules.  
**Acceptance:** Unique referral code is created; terms snapshot is stored; allocation and expiry are explicit.

### PAR-05 — Negotiate private terms

**Requirement:** Partner can request a private price or allocation.  
**Acceptance:** Structured offer, counter, accept, reject and expiry flow; maximum two counter rounds; both parties’ limits are checked.

### PAR-06 — View funnel and earnings

**Requirement:** Partner sees clicks, signups, purchases, verified and pending outcomes, earned USDC and payout receipts.  
**Acceptance:** The UI separates funnel activity from payable outcomes and pending holds from settled funds.

### CUS-01 — Referral-aware purchase

**Requirement:** Referral attribution survives redirect or session into checkout.  
**Acceptance:** Attribution is bound to campaign, Partner and expiry without exposing unnecessary customer identity.

### CUS-02 — Pay company directly

**Requirement:** Customer pays the company in Arc USDC when the supported purchase path is live.  
**Acceptance:** Company wallet receives revenue directly; the platform does not custody sale proceeds in the acquisition loop.

### CUS-03 — Convert purchase into outcome

**Requirement:** A purchase becomes payable only after verification.  
**Acceptance:** Successful chain evidence, correct merchant and amount, attribution, uniqueness and campaign timing checks pass.

---

# 4. Agent requirements and authority

## 4.1 Agent tool boundary

| Tool or action | Demand Agent | Supply Agent |
|---|---:|---:|
| Read public market state | Yes | Yes |
| Read participating Partner state | Yes | Own state only |
| Prepare campaign draft | Yes | No |
| Set public bounty | Yes, inside safe range and policy | No |
| Pause a Partner | Yes, campaign scope only | No |
| Request private terms | Counter a Partner offer | Yes |
| Accept offer | Inside company policy | Inside Partner policy |
| Join campaign | No | Yes |
| Reserve budget | Yes, after policy check | No |
| Trigger payout | Yes, verified outcome only | No |
| Change hard policy | Propose only | Propose only |
| Publish social content | No | No in MVP |

## 4.2 Runtime rule

The language model never receives a raw private key and never writes directly to the chain. It calls typed tools. Each financial tool revalidates deterministic policy at execution time.

## 4.3 Action states

Every agent action must resolve to one of:

- `RECOMMEND` — suggestion only; no state change.
- `PREPARE` — draft or payment intent prepared for review.
- `EXECUTE` — submitted after authority checks pass.
- `HOLD` — paused because evidence, timing, budget or authority is insufficient.
- `REFUSE` — blocked by rule or safety boundary.
- `ESCALATE` — routed to a responsible human.

## 4.4 Authority invariants

- Agent cannot change `targetOutcomeCount`.
- Agent cannot change funded `budgetUSDC`.
- Agent cannot raise `bountyCeiling` without owner approval.
- Agent cannot lower `bountyFloor` without owner approval.
- Agent cannot change `minQualifyingPurchase` after a market is live.
- Agent cannot change deadline or visibility without owner approval.
- Agent cannot pay an unverified outcome.
- Agent cannot pay an outcome twice.
- Agent cannot pay an unapproved recipient.
- Agent cannot withdraw general treasury funds.

---

# 5. Decision engine

## 5.1 Purpose

The decision engine makes price actions defensible, reproducible and bounded. The language model may select and explain an action, but it does not invent the economic range.

## 5.2 Inputs and derived signals

| Input | Derived signal | Use |
|---|---|---|
| Remaining outcomes and time | Required acquisition rate | How fast the market must move to reach the deadline |
| Recent verified outcomes and time | Observed acquisition rate | Whether current price and supply are keeping pace |
| Remaining budget and outcomes | Budget capacity per next outcome | Maximum affordable pressure before the campaign becomes impossible |
| Active Partners and join/skip rate | Supply pressure | Whether price is attracting enough distribution |
| Clicks, signups and purchases | Conversion efficiency and confidence | Private price and allocation decisions |
| Verified purchase value and refunds | Outcome quality | Avoid rewarding low-value or refunded customers |
| Pending reservations | Free spendable budget | Prevent concurrent payouts from overspending |

## 5.3 Pricing kernel

Suggested sequence:

1. Compute pace ratio: observed rate divided by required rate.
2. Compute safe budget per remaining outcome after pending reservations.
3. Create candidate price band from previous price, pace pressure, supply pressure and budget pressure.
4. Clamp the band to campaign floor, ceiling and affordability constraints.
5. For a Partner, apply a bounded private adjustment based on conversion quality, average purchase value, refund rate and sample confidence.
6. Give the Demand Agent only the allowed action range.
7. Store action, reason code, inputs snapshot and before/after state.
8. Revalidate at execution time.

## 5.4 Allowed decisions

- `HOLD` — no material change.
- `RAISE` — increase price inside the safe range.
- `LOWER` — reduce price inside the safe range.
- `PAUSE` — stop new allocation to a source or Partner.
- `REALLOCATE` — change allowed allocation within budget.
- `COUNTER` — submit a structured private offer.
- `ESCALATE` — request a hard policy change.

## 5.5 Reprice cadence

Event-driven first:

- Verified outcome.
- Meaningful Partner join or leave.
- Refund.
- Offer or counter.
- Policy state change.

A periodic checkpoint may catch time-based pace drift, for example every 30–60 minutes, but it must not create uncontrolled noisy repricing.

---

# 6. Campaign policy model

Hard limits live outside the prompt.

| Policy field | Owner sets | Agent may change? |
|---|---:|---:|
| `targetOutcomeCount` | Yes | No |
| `budgetUSDC` | Yes, funded on-chain | No |
| `bountyFloor` | Yes | No |
| `bountyCeiling` / `maxCAC` | Yes | No; may request increase |
| `minQualifyingPurchase` | Yes | No |
| `deadline` | Yes | No; may request extension |
| `marketVisibility` | Yes | No |
| `allowedPartnerRules` | Yes | No |
| `refundHold` | Owner or system | No |
| `publicBounty` | Opening price may be suggested | Yes, inside bounds |
| `partnerPrivatePrice` | No | Yes, inside both sides’ bounds |
| `partnerAllocation` | Optional maximum | Yes, inside budget and policy |

## Policy lifecycle

1. `DRAFT` — agent is interpreting intent.
2. `REVIEW` — owner sees structured fields and missing information.
3. `APPROVED` — owner confirms policy.
4. `FUNDING` — wallet funding is pending.
5. `LIVE` — campaign budget is confirmed and market is open.
6. `PAUSED` — new decisions or joins are blocked.
7. `CLOSING` — pending outcomes and holds resolve.
8. `CLOSED` — no new outcomes or commitments; unspent funds can return.

---

# 7. Money and contract architecture

## 7.1 Recommended contract

**Target contract name:** `ThesmaMarketVault`

The vault is the hard economic cage for a campaign. It is not a general treasury wallet.

## 7.2 Contract capabilities

### `createCampaign`

Owner creates a campaign policy reference and approves executor and verifier identities.

### `fundCampaign`

Owner deposits the campaign’s Arc USDC budget. Funding must settle before the campaign becomes `LIVE`.

### `reserve`

Payout amount is reserved only when it is:

- At or below the bounty ceiling.
- At or below free funded balance.
- Tied to a unique verified outcome.
- Bound to an approved Partner and recipient.

### `payout`

Settles the reserved amount to the exact Partner recipient after verification and policy checks.

### `replayProtection`

An outcome ID, purchase hash and proof hash can be used only once.

### `authorizedExecutor`

Only the configured campaign executor may request a payout. The executor has no general withdrawal ability.

### `verificationGate`

Preferred path: verifier signs an EIP-712-style outcome proof and the contract validates the configured signer before payout. If a time-constrained first slice uses an off-chain gate, preserve the interface and ship signature verification before treating the system as production-ready.

### `pause` and `close`

Owner can pause or close. The Demand Agent can stop the market logically but cannot withdraw owner funds.

### `returnUnspent`

Owner recovers the remaining balance after close or deadline when pending holds are resolved.

## 7.3 Money separation invariant

- Customer payment goes to company wallet.
- Campaign funding goes into `ThesmaMarketVault`.
- Partner payout goes from the campaign vault to the Partner wallet.
- The platform must not use customer revenue as an implicit campaign budget.

---

# 8. Attribution and outcome verification

## 8.1 Referral route

1. Partner receives a unique route such as `/r/<code>`.
2. The route records a click and sets a signed first-party attribution token containing campaign ID, Partner ID and expiry.
3. An optional signup event is recorded for funnel visibility; it never earns money by itself.
4. Hosted checkout or merchant adapter creates a payment intent bound to company wallet, amount, campaign, attribution and order ID.
5. Customer signs the Arc USDC payment.
6. Verifier reads the chain receipt and matches destination, amount, success, timing and payment intent.
7. Verifier checks uniqueness, new-customer or self-referral rules and refund hold.
8. Verifier produces `VERIFIED` or `REJECTED`.
9. Demand Agent applies the terms snapshot and requests payout.
10. Vault and policy layer validate amount, recipient and replay state.
11. Partner receives the payout and the receipt is reconciled.

## 8.2 Privacy

Partners do not need customer names, email addresses or phone numbers. The Partner dashboard should use:

- Anonymized customer or order IDs.
- Shortened wallet addresses only where useful and appropriate.
- Funnel state.
- Proof status.
- Payout state.

---

# 9. System architecture

## 9.1 Reference stack

| Layer | Recommendation | Reason |
|---|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind 4 | Fast full-stack iteration and familiar hackathon stack |
| Wallet and chain | wagmi and viem; Circle App Kit adapter where useful | Direct EVM control with ecosystem integration boundary |
| Database | Postgres via Neon or Supabase, with Drizzle | Durable market state, idempotency, reservations and audit logs |
| Agent runtime | Provider-agnostic structured tool-calling layer | Keeps model replaceable and tools enforce permissions |
| Contracts | Solidity, Foundry, OpenZeppelin | Small auditable vault with invariant and fuzz tests |
| Jobs | Database-backed queue or cron drain | Verifier, repricing and reconciliation without a required Redis dependency |
| Observability | Structured event log, receipts and explorer links | Asynchronous judging, debugging and auditability |

## 9.2 Service boundaries

### Web application

- Authentication and role access.
- Company and Partner workspaces.
- Policy review and approvals.
- Market and receipt views.
- Customer purchase path.

### Agent service

- Intent parsing.
- Structured drafts.
- Tool planning.
- Explanation generation.
- Action selection inside received safe ranges.

### Deterministic policy service

- Validates hard limits.
- Computes safe price bands.
- Checks permissions.
- Produces reason codes.
- Rejects invalid tool calls.

### Market state service

- Stores campaigns, prices, terms, allocations, pace and versions.
- Serializes state-changing decisions.
- Prevents stale writes.

### Verification service

- Reads payment evidence.
- Checks attribution, amount, timing, uniqueness and refunds.
- Produces signed or auditable proofs.

### Executor and reconciliation service

- Reserves budget.
- Calls the target contract or supported payment adapter.
- Tracks submitted, confirmed, settled, failed and ambiguous states.
- Reconciles before retrying.

### Contract layer

- Holds campaign budget.
- Enforces recipient, amount, replay and executor constraints.
- Returns unspent funds after safe close.

## 9.3 Adapter boundaries

Build adapters for:

- Wallet connection.
- Arc RPC and explorer.
- Circle wallet or App Kit where supported.
- Payment intent and checkout provider.
- Verifier signer.

The campaign domain model must not depend directly on one provider’s SDK object shape.

---

# 10. Core data model

## `workspace`

- `id`
- `ownerUserId`
- `name`
- `companyWallet`
- `category`
- `createdAt`

## `partner`

- `id`
- `userId`
- `payoutWallet`
- `categories`
- `rulesJson`
- `reputationSummary`

## `campaign`

- `id`
- `workspaceId`
- `goalCount`
- `budget`
- `floor`
- `ceiling`
- `minPurchase`
- `deadline`
- `visibility`
- `state`
- `vaultRef`
- `policyVersion`

## `market_state`

- `campaignId`
- `publicBounty`
- `paceState`
- `remainingBudget`
- `remainingGoal`
- `updatedAt`
- `version`

## `partner_terms`

- `campaignId`
- `partnerId`
- `price`
- `allocation`
- `source` — public or private
- `expiresAt`
- `version`

## `offer`

- `id`
- `campaignId`
- `partnerId`
- `side`
- `amount`
- `allocation`
- `state`
- `round`
- `expiresAt`
- `rationaleCode`

## `referral`

- `code`
- `campaignId`
- `partnerId`
- `createdAt`
- `status`

## `event`

- `idempotencyKey`
- `referralId`
- `type` — click, signup, purchase or refund
- `customerKeyHash`
- `amount`
- `txHash`
- `observedAt`

## `outcome`

- `id`
- `campaignId`
- `partnerId`
- `customerKeyHash`
- `purchaseTx`
- `amount`
- `status`
- `verifiedAt`
- `proofHash`

## `spend_reservation`

- `id`
- `campaignId`
- `outcomeId`
- `partnerId`
- `amount`
- `state`
- `expiresAt`

## `payout`

- `id`
- `outcomeId`
- `amount`
- `recipient`
- `txHash`
- `state`
- `reconciledAt`

## `agent_decision`

- `id`
- `agentType`
- `scopeId`
- `action`
- `inputsSnapshot`
- `beforeState`
- `afterState`
- `reasonCode`
- `explanation`
- `createdAt`

## Idempotency constraints

- Purchase transaction hash is single-use.
- Outcome proof hash is single-use.
- Payout `outcomeId` is single-use.
- Financial retries reconcile ambiguous chain state before sending again.
- Concurrent reservations exclude already reserved funds from free budget.

---

# 11. Key sequences

## 11.1 Funding flow

1. Company connects wallet.
2. App reads supported network and balance.
3. Demand Agent prepares policy.
4. Owner chooses `Approve & Fund`.
5. UI requests only the minimum actions needed by the vault design.
6. Funding transaction is submitted.
7. App waits for chain confirmation.
8. Campaign becomes `LIVE` only after confirmation.
9. Market and agent cannot advertise spendable budget before confirmation.

## 11.2 Customer and payout flow

1. Partner receives referral route.
2. Customer enters through referral route.
3. Attribution token is created.
4. Customer completes qualifying payment.
5. Company wallet receives revenue.
6. Event is queued for verification.
7. Verifier checks chain, amount, merchant, timing, attribution and uniqueness.
8. Outcome becomes `VERIFIED` or `REJECTED`.
9. Refund hold is applied where required.
10. Terms snapshot is loaded.
11. Budget reservation is created transactionally.
12. Policy and contract checks run.
13. Payout is submitted.
14. Chain state is reconciled.
15. Receipt becomes settled or failed.

## 11.3 Repricing flow

1. Event triggers market-state evaluation.
2. State version is locked.
3. Pricing kernel computes allowed band.
4. Demand Agent receives the band and relevant summary.
5. Agent chooses an action and reason code.
6. Policy engine validates action against current state.
7. Market state and decision record are written atomically.
8. Any chain or external action uses an idempotency key.
9. Receipt explains before and after state.

## 11.4 Negotiation flow

1. Supply Agent requests private terms.
2. Demand Agent checks market state and remaining budget.
3. Offer includes amount, allocation, expiry and reason.
4. Supply Agent accepts, rejects or counters.
5. Maximum two counter rounds.
6. Accepted terms are versioned and reserved.
7. Next qualifying outcome uses the terms snapshot.
8. Expiry or failed overlap closes the negotiation without payment.

---

# 12. Safety, fraud and failure handling

| Risk | MVP control |
|---|---|
| Self-referral | Partner payout wallet cannot equal purchasing wallet; add customer identity hash or merchant rule when available |
| Duplicate purchase or replay | Unique transaction hash, outcome ID and contract replay protection |
| Refund after reward | Pending refund hold or reversible reservation before final settlement |
| Fake webhook | Webhook cannot create `VERIFIED`; chain receipt must match intent |
| Overspend race | Transactional reservation; free budget excludes reservations |
| Hallucinated price | Pricing kernel creates allowed band; policy clamps or rejects |
| Negotiation loop | Two counter rounds maximum; offers expire |
| Wrong recipient | Partner ID is bound to payout wallet; payout verifies exact recipient |
| Ambiguous transaction retry | Reconcile chain state before retrying; never blindly resend |
| Campaign cancelled mid-flight | Pause new joins and pricing; honor or expire existing reservations according to policy, then return free funds |
| Stale market state | Versioned writes and optimistic concurrency checks |
| Unauthorized tool call | Tool registry and execution-time policy validation |
| Hidden customer data | Use hashed or anonymized customer keys in Partner views |

Bad paths are product requirements, not cleanup tasks.

---

# 13. API and tool surface

## 13.1 HTTP endpoints

- `POST /api/campaigns/draft` — parse organization intent into validated `CampaignDraft`.
- `POST /api/campaigns/:id/approve` — record owner approval of immutable or owner-controlled policy.
- `POST /api/campaigns/:id/funding-intent` — prepare owner funding flow; never auto-sign for the user.
- `GET /api/markets` — public live-market feed for Partner agents.
- `POST /api/campaigns/:id/join` — create Partner terms and referral code.
- `POST /api/offers` — submit structured private offer or counter.
- `GET /r/:code` — referral redirect and signed attribution cookie.
- `POST /api/checkout/intents` — create referral-bound payment intent.
- `POST /api/checkout/:id/confirm` — attach transaction hash and queue verification.
- `POST /internal/outcomes/:id/verify` — verifier-only transition to `VERIFIED` or `REJECTED`.
- `POST /internal/agent/reprice` — Demand Agent market-state run.
- `POST /internal/payouts` — reserve and execute payout for a verified outcome.
- `GET /api/receipts/:id` — human-readable decision, outcome and payout evidence.

## 13.2 Demand Agent tools

- `get_market_state`
- `get_partner_stats`
- `quote_safe_price_band`
- `set_public_bounty`
- `pause_partner`
- `counter_offer`
- `reserve_outcome_payout`
- `settle_verified_outcome`
- `request_policy_change`

## 13.3 Supply Agent tools

- `list_live_markets`
- `score_market_fit`
- `join_market`
- `submit_offer`
- `accept_counter`
- `skip_market`
- `get_my_performance`

Tool schemas must use typed amounts, IDs, enums and policy references. Do not expose free-form recipient or amount fields for financial execution.

---

# 14. Build plan

Each slice must end in a usable, testable product state. Do not build generic infrastructure before the money loop works.

## S0 — Foundation

**Build:** Next.js application, authentication, Postgres schema, Arc configuration, design shell and company/Partner roles.  
**Exit criteria:** Two users can sign in as company and Partner; migrations and CI pass; role access works.

## S1 — Wallet and campaign policy

**Build:** Wallet connection, company workspace, Demand Agent intent-to-draft flow and policy review.  
**Exit criteria:** A real or test wallet can create an approved campaign draft; no money moves yet.

## S2 — Campaign vault

**Build:** `ThesmaMarketVault` contract, tests, funding UI and chain confirmation.  
**Exit criteria:** Owner funds a small test budget; app reads vault balance; ceiling and budget invariants pass; agent cannot exceed configured limits.

## S3 — Live market and Partner

**Build:** Public market feed, Partner profile and rules, join flow and referral links.  
**Exit criteria:** A Partner joins and receives a unique referral route; company sees the active Partner and terms snapshot.

## S4 — Customer purchase and verifier

**Build:** Hosted checkout or payment intent, Arc payment confirmation, referral attribution and outcome verification.  
**Exit criteria:** A customer purchase reaches the company wallet and becomes `VERIFIED` for the correct Partner exactly once.

## S5 — Automatic payout

**Build:** Spend reservation, payout tool, vault executor, receipt and reconciliation.  
**Exit criteria:** Verified outcome causes Partner payout without per-payout human approval; duplicate retry cannot pay twice.

## S6 — Dynamic Demand Agent

**Build:** Pricing kernel, pace states, repricing and pause actions, decision log.  
**Exit criteria:** A change in pace or performance produces a bounded, visible and explainable price or pause action.

## S7 — Supply Agent and negotiation

**Build:** Market ranking, Partner rules, auto-join, structured offer, counter and accept flow.  
**Exit criteria:** A Supply Agent negotiates one private price inside both sides’ limits and the next verified outcome uses that price.

## S8 — Demo and traction polish

**Build:** Receipts, explorer links, stats, real or disclosed test campaign, failure states and a sub-three-minute walkthrough.  
**Exit criteria:** A reviewer can run the core flow without the builder; repository documents real, test, seeded and simulated evidence clearly.

---

# 15. Priority and cut line

## P0 — submission-critical

Keep:

- Funded campaign.
- Partner join and referral.
- Real or explicitly labelled test Arc purchase.
- Verified outcome.
- Automatic USDC payout.
- Hard budget and ceiling.
- Decision receipt.

Nothing in this row should be cut without changing the thesis.

## P1 — differentiation-critical

Keep if possible:

- Dynamic repricing.
- Demand Agent reasoning.
- Supply Agent ranking.
- One bounded negotiation.

Defer:

- Advanced reputation.
- Many negotiation strategies.
- Multiple outcome types.

## P2 — polish

Keep if time allows:

- Creator funnel analytics.
- Live feeds.
- Beautiful market board.
- Escalation UX.

Defer:

- Deep charts.
- Complex notifications.
- Large admin surface.

## Post-hackathon

- Crosschain funding.
- Gateway and CCTP.
- Circle Agent Wallet mainnet adapter where supported.
- More outcome types.
- Automated supply agents.
- Richer quality-adjusted pricing.

> Cut breadth, not agency. A small product where the agent truly reprices and pays within hard limits is stronger than a large dashboard with a decorative chat box.

---

# 16. Verification plan

## Contract tests

- Cannot pay above ceiling.
- Cannot exceed funded cap.
- Cannot replay an outcome.
- Unauthorized executor fails.
- Owner pause and close work.
- Unspent return rules work.
- Exact recipient is enforced.

## Policy tests

- Boundary tests at floor, ceiling, deadline and budget.
- Actions outside safe range are rejected.
- Agent cannot change immutable or owner-controlled fields.
- Stale policy version is rejected.

## Attribution tests

- Referral survives redirect and checkout.
- No attribution means no Partner payout.
- Expired code is rejected.
- Wrong campaign or Partner is rejected.
- Self-referral rule is enforced where data exists.

## Verifier tests

- Wrong merchant rejects.
- Wrong amount rejects.
- Failed transaction rejects.
- Duplicate transaction rejects.
- Late transaction rejects.
- Refunded outcome enters hold or rejects according to policy.
- Missing evidence remains pending, not verified.

## Reservation tests

- Concurrent verified outcomes cannot overcommit remaining budget.
- Expired reservation releases funds safely.
- Closing a campaign respects pending obligations.

## Payout tests

- Submitted and settled are separate states.
- Exact recipient and amount reconcile against Arc.
- Ambiguous state triggers reconciliation, not blind retry.
- Duplicate callback is idempotent.

## Agent tests

- Tools unavailable outside permissions.
- No free-form payment recipient or amount.
- Negotiation cannot exceed either side’s rules.
- Hard-policy change becomes escalation.
- Explanations match the stored reason code and state snapshot.

## E2E — End-to-end test

> Company funds → Partner joins → customer pays → verifier verifies → current terms apply → Partner is paid → receipt links proof.

---

# 17. Demo and launch checklist

- Mainnet or testnet mode labelled everywhere.
- No secret or private key in client, repository, logs or screenshots.
- Contract references and explorer links documented where public.
- README states what is real, test, seeded or simulated.
- Fallback demo data never masquerades as traction.
- Demo opens with the product thesis, not setup instructions.
- First 90 seconds show agent decisions, not only navigation.
- At least one external user or business interaction is recorded if claimed.
- Campaign budget and customer revenue remain visibly separate.
- Receipt can be opened from the final dashboard.
- Failure path is demonstrated or documented.
- Current competition submission schema and deadline are rechecked before submission.

---

# 18. Risks and open decisions

## Network support risk

Arc mainnet and Circle wallet support may evolve at different speeds. Keep a wallet and executor adapter boundary, and do not make an unverified SDK assumption part of the core product contract.

## Verification risk

A real customer purchase must be attributable without collecting unnecessary personal information. Start with a narrow first-party route and a single checkout path.

## Economic risk

Dynamic pricing can overfit sparse data. Use conservative bands, minimum sample confidence and human-visible reason codes.

## Fraud risk

Self-referral, duplicate purchases, refunds and fake webhooks can undermine trust. Treat them as first-class test cases.

## Category risk

If the product looks like an affiliate dashboard, the main innovation disappears. The demo must show a live price decision and an actual payout boundary.

## Traction risk

A technically strong demo without genuine or clearly labelled usage will be weaker on the traction dimension. Recruit one narrow business and document the baseline before the event window closes.

## Compliance risk

Stablecoin payments, marketing attribution, customer data and Partner payouts can trigger legal and regulatory requirements. This document is not legal advice and does not establish compliance.

---

# 19. Definition of done

The target MVP is ready to present when:

- A company can state and approve a campaign policy.
- The campaign budget is funded and bounded.
- A Partner can join and receive a referral route.
- A customer can purchase through that route.
- The verifier can prove or reject the outcome.
- A verified outcome can trigger one automatic payout.
- The Demand Agent can make at least one bounded repricing or pause decision.
- The Supply Agent can make at least one bounded join, skip or negotiation decision.
- Every important action has a receipt.
- The application recovers safely from duplicate, failed, refunded and ambiguous events.
- The demo and repository distinguish shipped evidence from target architecture and simulation.

## Final engineering recommendation

Implement the full vertical slice before adding breadth:

> **Policy → Fund → Market → Refer → Purchase → Verify → Reprice → Pay → Reconcile.**

Everything else is secondary until this loop is true.

## Sources

- User-supplied PRD/architecture/build-plan PDF and refined product-idea PDF; original source artifacts remain unchanged.
- Tameion Agents Hackathon — Canteen × Circle: https://tameion.thecanteenapp.com/
- Circle Agent Stack: https://www.circle.com/agent-stack
- Arc mainnet launch information: https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet
- Circle EVM transaction signing documentation: https://developers.circle.com/wallets/sign-tx-evm
- Arc App Kit and developer documentation: https://docs.arc.network/
- Circle Arc e-commerce example: https://github.com/circlefin/arc-ecommerce-payments
