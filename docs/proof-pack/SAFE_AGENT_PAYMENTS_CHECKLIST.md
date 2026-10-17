# Safe Agent Payments Checklist
### The product purchased in the Thesma Mainnet Proof Pack ($1.00 USDC)

> This checklist is the actual digital deliverable a customer receives when
> buying the Thesma Mainnet Proof Pack. It distills the exact safety rules the
> Thesma live-money loop itself follows. No delivery has occurred yet — this
> file is the product definition, not a delivery receipt.

## 1. Bound every agent with a hard budget
Give the agent a campaign-scoped budget ceiling it cannot rewrite, separate
from any treasury or revenue balance. An agent that can touch general funds
is not autonomous — it is unsupervised.

## 2. Never pay for activity, only for verified outcomes
Clicks, impressions, signups, and drafts are signals, not settlements. A payout
fires only after independent evidence proves the agreed result happened.

## 3. Make every financial action idempotent
Duplicate requests, retried workers, and crashed processes must converge on
one outcome, never two payments. Enforce it with unique constraints and
reconciliation — not with hope that retries won't happen.

## 4. Reconcile before you retry
An uncertain transaction is resolved by reading the chain, never by sending
again. A blind resend turns one ambiguous payment into two real ones.

## 5. Separate money paths by construction
Customer revenue and acquisition budget must never share an account, a vault,
or a code path. If one flow can accidentally spend the other's money, the
separation is documentation, not architecture.

## 6. Hold before you settle
Quarantine every verified outcome behind a refund/chargeback window. A result
can be real at noon and refunded by evening — settlement must respect that.

## 7. Keep humans on the boundaries, agents in the middle
Humans set goals, budgets, ceilings, and deadlines. Agents optimize price,
timing, and allocation inside them. No agent should be able to move a boundary.

## 8. Leave a receipt for every decision
Each price change, pause, reservation, and payout must record what was known,
what was decided, why, and what chain evidence confirms it. If it isn't
inspectable afterward, it wasn't safe to automate.

## 9. Fail closed, escalate loudly
Missing evidence, mismatched chains, unknown signers, and ambiguous receipts
must halt action and page a human — never degrade into optimistic execution.

## 10. Prove it on a tiny loop first
Before trusting an agent with real budgets, run one complete
purchase → verify → hold → pay → reconcile cycle with the smallest
meaningful amount, and demand exact balance reconciliation afterward.

---

*Thesma practices this checklist on itself: every rule above maps to an
enforced invariant in the ThesmaMarketVault and its backend services, and the
mainnet proof (S8.2) demonstrates all ten end to end for exactly $1.00 USDC.*
