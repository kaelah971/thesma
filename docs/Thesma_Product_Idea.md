# THESMA — PRODUCT IDEA

**Master brand:** Thesma  
**Category:** Autonomous market for verified business outcomes  
**Descriptor:** The autonomous market for verified outcomes  
**Primary line:** Set the outcome. Let the agent find the price.  
**Status:** Product definition and target scope; implementation status must be proven separately.

> This document is an editable Thesma reconstruction of the supplied product-idea source. The supplied PDF remains unchanged.

## Status vocabulary

Use these labels throughout product, engineering, demo and submission materials:

- **Shipped** — implemented and exercised in the current build.
- **Target** — specified for the MVP or current build phase, but not yet proven live.
- **Roadmap** — intentionally deferred beyond the MVP.
- **Hypothesis** — a product, market or performance belief that requires validation.

The source concept does not prove that wallets, contracts, automatic payouts, production verification, mainnet settlement, Circle integrations, customer traction or Partner onboarding are live. Unless an implementation record says otherwise, the capabilities in this document are **Target**, **Roadmap** or **Hypothesis**.

---

# 1. Executive concept

Thesma is a two-sided autonomous market for measurable business results, settled in USDC on Arc when the relevant implementation and network support are available.

A business gives its Demand Agent:

- A measurable outcome.
- A USDC campaign budget.
- A deadline.
- A maximum price or CAC.
- A qualifying rule.
- Hard economic and authority limits.

The Demand Agent opens a live market, prices the next verified outcome, allocates spend across eligible Partners and settles successful outcomes.

Every Partner has a Supply Agent that watches markets, estimates fit, joins opportunities and can negotiate inside that Partner’s own rules.

## The product thesis

- The company buys outcomes, not activity.
- Clicks, posts and impressions may inform decisions, but only the agreed verified result earns the bounty.
- Prices move as campaign pace, supply, budget and performance change.
- Both sides have agents with different objectives.
- Money is bounded: the Demand Agent cannot touch the company’s general revenue treasury.
- Truth is deterministic: the agent decides economics, a verifier establishes whether an outcome happened, policy or contract controls enforce authority and Arc settles USDC.

## Working positioning

> **Set the outcome. Let the agent find the price.**

## Public description

> Thesma lets a business buy verified customer outcomes through a live market where Demand and Supply Agents adjust the economics inside human-set limits.

---

# 2. Why this exists

## The gap

Businesses can automate marketing work, but they still struggle to automate the price of results.

### Fixed affiliate economics

Traditional affiliate programs publish a commission and leave it there even when the deadline, budget, channel quality and campaign pace change.

### Manual performance campaigns

Creator campaign tools can track deliverables and performance bonuses, but the company still operates the economic decisions manually.

### Recommendation without authority

AI growth tools can recommend where to spend, but often stop before they can change price, commit campaign budget and settle outcomes autonomously inside hard policy.

### Supply-side noise

Creators and other distribution Partners face a noisy supply of campaigns. They need help deciding which opportunity is worth using scarce audience attention on.

## Product insight

The missing market is not another campaign manager. It is a machine-operated exchange where:

- The company continuously prices demand for a measurable result.
- Partners continuously price the attention and distribution they are willing to deploy.
- Both sides can delegate bounded decisions to their own agents.
- Payment is attached to a verified outcome rather than an unverified promise.

---

# 3. The first outcome

For the hackathon MVP, the first outcome is:

> **A verified paid customer.**

The customer arrives through a Partner referral route and completes an Arc USDC purchase that satisfies the campaign’s qualification rule.

This is intentionally narrow because it is:

- Objective.
- Financially meaningful.
- Attributable.
- Possible to prove from a payment receipt.
- Suitable for a short hackathon demonstration.

Clicks, signups and impressions remain useful funnel signals. They do not become payable outcomes by themselves.

## Why “Partner” instead of only “creator”

Creators are the first supply persona. The durable product should also support:

- Newsletters.
- Communities.
- Referral sites.
- Applications.
- Recommendation engines.
- AI shopping agents.
- Autonomous distribution systems.

The master product term is therefore **Partner**. The first interface may use creator language where it improves comprehension.

---

# 4. End-to-end experience

## 4.1 Company creates the workspace

The organization creates a workspace and connects an Arc wallet or supported wallet adapter.

**Target result:** The wallet identity and network are persisted; a chain mismatch is blocked; a readable balance is shown.

## 4.2 Company states the goal

The owner tells the Demand Agent what it wants in natural language.

Example:

> Get 20 new paid members by Sunday. Budget 50 USDC. Never pay more than 4 USDC per customer. Only purchases of at least 10 USDC count.

## 4.3 Agent prepares the campaign policy

The agent turns the intent into a structured policy containing:

- Target outcome count.
- Funded budget.
- Bounty floor.
- Bounty ceiling or maximum CAC.
- Minimum qualifying purchase.
- Deadline.
- Market visibility.
- Allowed Partner rules.
- Refund hold.
- Escalation conditions.

The owner reviews and approves the policy. No campaign becomes live before explicit approval.

## 4.4 Owner funds the campaign

The owner funds a campaign vault from the connected Arc wallet.

The campaign remains in `DRAFT` or `FUNDING` until chain confirmation. The agent cannot reserve or pay from an unconfirmed budget.

The campaign budget is not the company’s general revenue treasury.

## 4.5 Demand Agent launches the market

The live market exposes:

- Public campaign page.
- Opening bounty.
- Partner join flow.
- Referral routes.
- Attribution rules.
- Live progress and analytics.
- Market state.
- Decision log.

## 4.6 Partners join

A Partner can accept the public price. A Supply Agent can also:

- Rank fit.
- Skip a market.
- Auto-join permitted opportunities.
- Request private terms.
- Negotiate within a minimum price and allocation boundary.
- Explain why it accepted or skipped.

## 4.7 Customer purchases

The customer travels through a Partner referral route and purchases the company’s product.

Customer revenue goes directly to the company. It does not pass through the acquisition agent or campaign vault.

The customer should not need to understand:

- The existence of two agents.
- The Partner’s private bounty.
- The campaign’s internal budget.
- The Arc settlement architecture.

## 4.8 Outcome is verified

The verifier checks:

- Payment success.
- Correct company destination.
- Minimum purchase amount.
- Campaign timing.
- Referral attribution.
- Unique transaction and outcome ID.
- Self-referral rules.
- Refund hold rules.

Only then does the outcome become `VERIFIED`.

## 4.9 Partner is paid

The Demand Agent applies the applicable terms snapshot. Policy and contract controls validate the recipient, amount, available budget and replay state. The Partner receives the payout in Arc USDC when the required implementation path is live.

## 4.10 Market adapts

The Demand Agent observes:

- Remaining goal.
- Remaining time.
- Remaining free budget.
- Active Partners.
- Join and skip rates.
- Clicks, signups and purchases.
- Verified revenue.
- Conversion efficiency.
- Refunds.
- Pending reservations.

It may reprice, reallocate, pause a source or negotiate within the permitted range.

---

# 5. The agents

## 5.1 Company Demand Agent

### Objective

Acquire the required verified outcomes at acceptable economics.

### Observes

- Remaining target.
- Remaining time.
- Remaining budget.
- Campaign pace.
- Market participation.
- Partner performance.
- Verified revenue.
- Pending outcomes and reservations.
- Refund and quality signals.

### Acts

- Prepare campaign policy.
- Set or reprice public bounty within the safe range.
- Allocate budget.
- Negotiate private Partner terms.
- Pause a Partner or source.
- Reserve outcome payout.
- Settle a verified outcome.
- Request a policy change.
- Escalate when a hard limit must change.

### Cannot do

- Change owner-controlled hard policy.
- Withdraw the owner’s general funds.
- Spend beyond funded campaign budget.
- Pay an unverified outcome.
- Invent a price outside the deterministic range.
- Publish social content in the MVP.

## 5.2 Partner Supply Agent

### Objective

Maximize the Partner’s expected earnings without violating brand, category, capacity or minimum-price rules.

### Observes

- Live markets.
- Public and private prices.
- Historical fit.
- Expected conversion.
- Campaign trust and verification quality.
- Remaining time and budget.
- Partner preferences and capacity.

### Acts

- Rank opportunities.
- Score market fit.
- Join permitted markets.
- Skip low-fit markets.
- Request private terms.
- Accept or reject a counteroffer.
- Set allocation limits.
- Recommend what to promote.
- Explain the decision.

### Cannot do

- Auto-publish public content in the MVP.
- Cross the Partner’s minimum or category rules.
- Guarantee a customer result.
- Hide an offer’s amount, allocation, expiry or reason.

---

# 6. The live market

## Market question

> **What is the next verified customer worth right now?**

## Public market price

The default bounty available to any eligible Partner joining the campaign.

## Private price

A negotiated bounty for a specific Partner when expected value, conversion quality or supply scarcity justifies different economics.

## Allocation

The maximum number of outcomes or budget a Partner may claim at the negotiated price.

## Market states

- `OPEN`
- `THIN SUPPLY`
- `ON PACE`
- `BEHIND PACE`
- `BUDGET PRESSURE`
- `TARGET REACHED`
- `PAUSED`
- `CLOSED`

## Repricing triggers

- Verified outcome.
- Elapsed-time checkpoint.
- Material change in active supply.
- Budget pressure.
- Refund.
- Significant Partner performance update.
- Offer accepted, rejected or expired.
- Owner policy change.

## Illustrative repricing

At launch:

- Target: 20 customers.
- Budget: 50 USDC.
- Deadline: four days.
- Opening price: 2.00 USDC per verified customer.

After six hours:

- Alice is converting well.
- The market is behind pace.
- Alice’s private price can move from 2.00 to 2.80.
- Public price can move from 2.00 to 2.25 if the safe range permits it.

At day two:

- Bayo has traffic but no purchases.
- Allocation can be reduced.
- The source can be paused if the confidence and policy rules allow it.

In the final eight hours:

- Six customers remain.
- Free budget is sufficient.
- The public bounty can rise while projected CAC stays below the ceiling.

At goal:

- The market closes automatically.
- New commitments stop.
- Unspent budget returns after pending holds resolve.

## Deterministic pricing rule

The language model must not invent prices from vibes. A pricing kernel computes a safe candidate range from:

- Required acquisition rate.
- Observed acquisition rate.
- Remaining budget.
- Remaining outcomes.
- Active supply.
- Conversion efficiency.
- Refund rate.
- Sample confidence.
- Campaign floor and ceiling.

The Demand Agent chooses `HOLD`, `RAISE`, `LOWER`, `PAUSE` or `COUNTER` within that range and records a reason code. The policy engine validates the action again before execution.

---

# 7. Agent-to-agent negotiation

Negotiation is structured and bounded, not an open-ended chatbot argument.

## Example

A Supply Agent says:

> My minimum is 3.20 USDC. I can supply up to 10 outcomes.

The Demand Agent checks:

- Partner history.
- Campaign pace.
- Remaining budget.
- Maximum CAC.
- Expected return.

It counters:

> 2.90 USDC for the first three verified outcomes, then 3.25 USDC for outcomes four through ten if verified quality holds.

The Supply Agent checks its rules and accepts or rejects.

## MVP negotiation limits

- Maximum two counter rounds.
- Amount, allocation, expiry and reason code required for every offer.
- No agent can cross its human-set reservation boundary.
- No overlap means the negotiation fails cleanly.
- Private terms change the payout price only; they do not guarantee results.

---

# 8. Product surfaces

## Organization workspace

- Demand Agent chat.
- Structured campaign policy review.
- Company wallet and campaign-vault balances.
- Active market board.
- Goal, pace, budget and CAC.
- Partner table with public/private terms.
- Verified revenue.
- Decision log.
- Outcome and payout receipts.
- Explorer evidence where supported.

## Partner workspace

- Supply Agent and personal rules.
- Live markets ranked by fit and expected return.
- Join, negotiate or skip actions.
- Referral route creation.
- Funnel from clicks to signups to purchases to verified outcomes.
- Earnings and pending holds.
- Payout receipts.
- Agent activity feed.

## Customer experience

- Referral-aware product or checkout page.
- Simple purchase flow.
- No requirement to understand the market.
- Company receives revenue directly.
- Customer does not receive a bounty in the core acquisition loop.

---

# 9. Competitive boundary

## Thesma versus work-verification markets

Some products fund a campaign vault, let a community perform work, ask AI to check the work and automatically pay approved submissions. Thesma does not buy work submissions or grade content. It buys verified revenue outcomes and dynamically prices them.

## Thesma versus growth research and campaign tools

Growth tools may offer research, creator campaigns, attribution and controlled payouts. Thesma’s centre is narrower and more agentic: autonomous live pricing, two-sided agents and outcome-market allocation.

## Thesma versus traditional affiliate platforms

Traditional platforms often use fixed commission and referral tracking. Thesma changes price inside policy as pace, supply, budget and performance change.

## Thesma versus task and bounty markets

A task market pays for a fixed job or deliverable. Thesma continuously buys a measurable business result at a moving price.

## Defensible category

> **Thesma is an autonomous outcome market, not an affiliate manager, creator campaign manager, generic bounty board or AI grader.**

---

# 10. MVP and proof

## Must prove

- Organization workspace.
- Arc wallet connection or supported adapter.
- Natural-language campaign creation.
- Structured policy review.
- Funded campaign budget.
- Public market.
- Partner profile and Supply Agent rules.
- Referral link and attribution.
- Qualifying Arc USDC purchase, real or explicitly labelled test.
- Deterministic verification.
- Dynamic price or pause action.
- At least one structured negotiation.
- Automatic payout and receipt.
- Explorer or transaction proof where supported.
- A demo understandable in under 90 seconds without private narration.

## Do not build now

- Crosschain funding or Gateway routing.
- Fiat off-ramp.
- Automated creator social posting.
- Generic content and task bounties.
- Broad creator discovery.
- Multi-touch attribution.
- Full KYC and compliance suite.
- Unbounded treasury access.
- Every possible outcome type.
- Multi-agent swarm architecture.

## Canonical demo story

1. Company: “Get 5 paying customers. Budget 15 USDC. Max 4 USDC per customer.”
2. Thesma prepares the policy.
3. Owner approves and funds the campaign vault.
4. Three Partner Agents join, negotiate or skip.
5. Customers purchase through referral routes.
6. Company revenue lands directly in the company wallet.
7. A verified purchase triggers an automatic payout.
8. Demand Agent changes price or pauses a weak source.
9. Market reaches 5 of 5 and closes.
10. Dashboard shows revenue, bounty spend, realized CAC and decision receipts.

---

# 11. Business model and expansion

## Initial monetization hypothesis

- Success fee on verified outcome spend; or
- SaaS plan plus a lower settlement fee.

Keep protocol fee at zero in the hackathon MVP if that simplifies money flows and evidence.

## Network effects hypothesis

- More companies create more priced outcome opportunities.
- More Partners create better distribution and price discovery.
- More outcome history improves fit, price and confidence estimates.
- Supply can later include communities, applications, recommendation engines and autonomous agents.

## Expansion path

### V1

Verified paid customer on Arc.

### V1.5

Qualified meeting, subscription activation and repeat purchase outcomes.

### V2

Richer private markets, quality-adjusted outcomes, reputation and automated Partner systems.

### V3

Crosschain campaign funding and settlement through Gateway or CCTP abstractions.

### Long term

A general exchange where autonomous demand agents purchase measurable outcomes from autonomous supply agents.

---

# 12. Arc and Circle fit

Arc is the target settlement environment. USDC is the target settlement asset and gas asset for Arc-native flows.

Circle Agent Stack offers relevant primitives for agent wallets, payment policy and USDC movement. However, the current support path must be rechecked before implementation because Agent Wallet examples may not support the exact Arc mainnet flow required by the product.

Implementation principle:

- Do not make Circle Agent Wallet mainnet support a blocking dependency for the first vertical slice.
- Use connected user wallets, a campaign vault and an executor abstraction where appropriate.
- Keep an adapter boundary so a supported Circle Agent Wallet path can be added later.
- Defer Gateway and CCTP until the Arc-only two-sided market works.

The brand story should lead with verified outcomes and bounded decisions. Arc and Circle are reasons to believe, not the entire customer promise.

---

# 13. Claims and security boundaries

## Claims

No claim of the following should appear as live unless an implementation record proves it:

- Production escrow.
- Automatic mainnet payout.
- Live Circle Agent Wallet support on the target network.
- Customer traction.
- Partner adoption.
- Transaction volume.
- Real business results.
- Full fraud prevention.
- Guaranteed CAC improvement.
- Regulatory approval.

## Security

- The LLM never receives a raw private key.
- The LLM never writes directly to the chain.
- Financial actions use typed tools.
- Policy is revalidated at execution time.
- Secrets are never committed to the repository or documents.
- Wallet addresses and transaction references are redacted from public examples unless intentionally published as non-sensitive evidence.
- If a credential or secret is encountered, replace it with `[REDACTED]`.

## Status vocabulary

- **Shipped:** implemented and tested.
- **Target:** intended for the current build.
- **Roadmap:** deferred.
- **Hypothesis:** not yet validated.

---

## Sources

- User-supplied refined product-idea PDF and PRD/architecture/build-plan PDF; original source artifacts remain unchanged.
- Tameion Agents Hackathon — Canteen × Circle: https://tameion.thecanteenapp.com/
- Circle Agent Stack: https://www.circle.com/agent-stack
- Arc mainnet launch information: https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet
- Circle EVM transaction signing documentation: https://developers.circle.com/wallets/sign-tx-evm
- Arc developer documentation: https://docs.arc.network/
