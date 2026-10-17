import Link from "next/link";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { Rail } from "@/components/ui/Rail";
import styles from "./landing.module.css";

/* ---------------- Product value ---------------- */

export function ValueSection() {
  return (
    <section id="product" className={styles.section} aria-labelledby="product-title">
      <div className="container">
        <div className={styles.sectionHead}>
          <p className="eyebrow">Product</p>
          <h2 id="product-title">Spend moves only when the result is real.</h2>
          <p>Thesma turns a business goal into a funded market with hard rules, independent verification and receipts for every state change.</p>
        </div>

        <div className={styles.valueGrid}>
          <article className={styles.valueCard} data-tone="blue">
            <div className={styles.valueVisual}>
              <div className={styles.ruleCard}>
                <span className={styles.ruleKey}>Outcome</span>
                <span>Paid customer</span>
                <span className={styles.ruleKey}>Qualifies at</span>
                <span className="tnum">≥ 30 USDC purchase</span>
                <span className={styles.ruleKey}>Price range</span>
                <span className="tnum">40 – 80 USDC</span>
              </div>
            </div>
            <h3>Outcome campaigns</h3>
            <p>Define exactly which business result is worth paying for.</p>
          </article>

          <article id="verified-outcomes" className={styles.valueCard} data-tone="mint">
            <div className={styles.valueVisual}>
              <ul className={styles.checkList}>
                <li>Payment reached company wallet</li>
                <li>Amount meets the minimum</li>
                <li>Customer is new to the campaign</li>
                <li>Not self-referred</li>
              </ul>
            </div>
            <h3>Verified evidence</h3>
            <p>Every payable outcome must pass verification.</p>
          </article>

          <article className={styles.valueCard} data-tone="cream">
            <div className={styles.valueVisual}>
              <div className={styles.holdVisual}>
                <span className={styles.ruleKey}>Safety hold</span>
                <strong className="tnum">00:42:10</strong>
                <Rail steps={["Verify", "Hold", "Reserve", "Settle"]} current={1} size="sm" />
              </div>
            </div>
            <h3>Protected settlement</h3>
            <p>Safety holds and reconciliation protect payouts.</p>
          </article>

          <article className={styles.valueCard} data-tone="lav">
            <div className={styles.valueVisual}>
              <dl className={styles.receiptMini}>
                <div>
                  <dt>Payout</dt>
                  <dd className="tnum">60.00 USDC</dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>
                    <span className="pill" data-tone="mint">
                      Settled
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Proof</dt>
                  <dd className="mono">0x91c4…e0a2</dd>
                </div>
              </dl>
            </div>
            <h3>Transparent receipts</h3>
            <p>Important financial states remain inspectable.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ---------------- How it works ---------------- */

const STEPS = [
  {
    n: "01",
    title: "Create a campaign",
    body: "Define the business outcome, price and eligibility rules.",
    detail: "Owner approves the policy",
    tone: "blue",
  },
  {
    n: "02",
    title: "Fund the budget",
    body: "Commit USDC against the campaign.",
    detail: "Held in the campaign vault",
    tone: "lav",
  },
  {
    n: "03",
    title: "Verify the result",
    body: "Real customer activity and evidence are checked before becoming payable.",
    detail: "Read independently onchain",
    tone: "mint",
  },
  {
    n: "04",
    title: "Settle the payout",
    body: "After the safety hold, eligible payouts are reserved, submitted and reconciled onchain.",
    detail: "Receipt for every payout",
    tone: "cream",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className={`${styles.section} ${styles.howSection}`} aria-labelledby="how-title">
      <div className="container">
        <div className={styles.sectionHead}>
          <p className="eyebrow">How it works</p>
          <h2 id="how-title">Four steps from goal to receipt.</h2>
          <p>Money moves in one direction and only after proof. Every step leaves a record you can open.</p>
        </div>

        <ol className={styles.steps}>
          {STEPS.map((s) => (
            <li key={s.n} className={styles.step} data-tone={s.tone}>
              <div className={styles.stepTop}>
                <span className={`${styles.stepNum} tnum`}>{s.n}</span>
                <span className={styles.stepNode} aria-hidden="true" />
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <span className={styles.stepDetail}>{s.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ---------------- Operator showcase (illustrative example) ---------------- */

const APP_NAV = ["Overview", "Campaigns", "Outcomes", "Payouts", "Operator", "Activity", "Settings"];
const PROMPTS = ["Show campaign status", "What is awaiting verification?", "Explain this payout", "Show available budget", "List verified outcomes", "Draft a campaign"];

export function OperatorShowcase() {
  return (
    <section id="operator" className={styles.section} aria-labelledby="operator-title">
      <div className="container">
        <div className={styles.sectionHead}>
          <p className="eyebrow">Operator</p>
          <h2 id="operator-title">Ask the market what it&apos;s doing.</h2>
          <p>The operator answers from live campaign state — holds, budget, evidence and receipts — in plain language, with the numbers attached.</p>
        </div>

        <div className={styles.opFrame}>
          <div className={styles.opTopbar}>
            <LogoMark size={26} />
            <div className={styles.opTabs} aria-hidden="true">
              <span data-active>Operator</span>
              <span>Campaigns</span>
              <span>Outcomes</span>
              <span>Payouts</span>
            </div>
            <div className={styles.opUser} aria-hidden="true">
              <span className={styles.avatar}>MK</span>
              <span>Northwind Goods</span>
            </div>
          </div>

          <div className={styles.opBody}>
            <nav className={styles.opNav} aria-label="Example app navigation">
              {APP_NAV.map((item) => (
                <span key={item} data-active={item === "Operator" || undefined}>
                  {item}
                </span>
              ))}
            </nav>

            <div className={styles.opChat}>
              <div className={styles.opChatHead}>
                <h3>Operator</h3>
                <span className="pill" data-tone="mint">
                  Growth Campaign · LIVE
                </span>
              </div>

              <div className={styles.opMessages}>
                <div className={styles.msgUser}>
                  <span className={styles.avatar}>MK</span>
                  <p>Show me campaign status.</p>
                </div>
                <div className={styles.msgThesma}>
                  <LogoMark size={26} />
                  <div className={styles.msgBody}>
                    <p>
                      1 verified outcome is currently in its safety hold. Payout becomes eligible in <b>42 minutes</b>.
                    </p>
                    <div className={styles.msgFacts}>
                      <div>
                        <span>Verified</span>
                        <b className="tnum">22 of 50</b>
                      </div>
                      <div>
                        <span>Available</span>
                        <b className="tnum">3,740 USDC</b>
                      </div>
                      <div>
                        <span>Settled</span>
                        <b className="tnum">1,140 USDC</b>
                      </div>
                    </div>
                  </div>
                </div>
                <div className={styles.msgUser}>
                  <span className={styles.avatar}>MK</span>
                  <p>Why hasn&apos;t it paid?</p>
                </div>
                <div className={styles.msgThesma}>
                  <LogoMark size={26} />
                  <div className={styles.msgBody}>
                    <p>The outcome is verified, but settlement is intentionally blocked until the campaign hold expires.</p>
                    <div className={styles.msgRail}>
                      <Rail steps={["Verify", "Hold", "Reserve", "Submit", "Settle"]} current={1} size="sm" />
                    </div>
                    <div className={styles.msgActions} aria-hidden="true">
                      <span>Open outcome</span>
                      <span>View hold rules</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.opComposer} aria-hidden="true">
                <span className={styles.opPlaceholder}>Ask about campaigns, outcomes or payouts…</span>
                <div className={styles.opComposerRow}>
                  <div className={styles.opChips}>
                    {PROMPTS.slice(0, 3).map((p) => (
                      <span key={p}>{p}</span>
                    ))}
                  </div>
                  <span className={styles.sendBtn}>
                    <svg width="14" height="14" viewBox="0 0 14 14">
                      <path d="M7 12V2M2.5 6.5 7 2l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </div>
              </div>
            </div>

            <aside className={styles.opSide} aria-label="Example context panel">
              <div className={styles.opCard}>
                <h4>Suggested</h4>
                <ul className={styles.opHistory}>
                  {PROMPTS.slice(1).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
              <div className={`${styles.opCard} ${styles.opHold}`}>
                <span className={styles.ruleKey}>Next payout eligible</span>
                <strong className="tnum">42m</strong>
                <p>Outcome 7f3a91c2 · 60 USDC · hold set by campaign policy</p>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Trust / principles ---------------- */

const PRINCIPLES = [
  { title: "Verified-only payouts", body: "No evidence, no payout. Clicks and signups never earn on their own.", rule: "outcome.status = VERIFIED" },
  { title: "Budget-bound execution", body: "Payouts reserve against funded budget, so concurrent outcomes can't overspend.", rule: "funded − committed ≥ price" },
  { title: "Safety & refund holds", body: "Each campaign sets a hold window that must pass before money moves.", rule: "now ≥ holdUntil" },
  { title: "Reconcile before retry", body: "Unclear chain results are reconciled first. Payments are never resent blindly.", rule: "AMBIGUOUS → reconcile" },
  { title: "Duplicate-payment protection", body: "One reservation and one payout per outcome, for life.", rule: "unique(outcome_id)" },
  { title: "Onchain settlement receipts", body: "Settled means a matching payout event was found onchain.", rule: "OutcomePaid ✓" },
];

export function TrustSection() {
  return (
    <section className={styles.section} aria-labelledby="trust-title">
      <div className="container">
        <div className={styles.trustPanel}>
          <div className={styles.trustHead}>
            <p className="eyebrow">System principles</p>
            <h2 id="trust-title">Rules the market can&apos;t talk its way around.</h2>
          </div>
          <ul className={styles.trustGrid}>
            {PRINCIPLES.map((p) => (
              <li key={p.title}>
                <code className="mono">{p.rule}</code>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Developers ---------------- */

export function DevelopersSection() {
  return (
    <section id="developers" className={styles.section} aria-labelledby="dev-title">
      <div className={`container ${styles.devGrid}`}>
        <div className={styles.devCopy}>
          <p className="eyebrow">Developers</p>
          <h2 id="dev-title">Every payout has a receipt you can fetch.</h2>
          <p>
            Receipts recompute their checks live — funding, frozen terms, recipient wallet and hold — and only report settled after chain reconciliation.
          </p>
          <ul className={styles.devList}>
            <li>
              <code className="mono">GET /api/markets</code>
              <span>Public live markets</span>
            </li>
            <li>
              <code className="mono">GET /api/campaigns/:id/market/pricing</code>
              <span>Price, pace and last decision</span>
            </li>
            <li>
              <code className="mono">GET /api/receipts/payouts/:id</code>
              <span>Payout receipt with live checks</span>
            </li>
          </ul>
        </div>
        <figure className={styles.codeCard}>
          <figcaption>
            <span className="mono">GET /api/receipts/payouts/:id</span>
            <span className={styles.codeNote}>Example response</span>
          </figcaption>
          <pre className="mono">
            <code>{`{
  "payout": {
    "state": "SETTLED",
    "amountMicroUsdc": "60000000",
    "txHash": "0x7a3e…41bf",
    "reconciledAt": "2026-10-17T11:02:14Z"
  },
  "checks": {
    "policyFunded": true,
    "amountMatchesTerms": true,
    "recipientMatchesWallet": true,
    "holdCleared": true
  },
  "settledMeansReconciled": true
}`}</code>
          </pre>
        </figure>
      </div>
    </section>
  );
}

/* ---------------- FAQ ---------------- */

const FAQS = [
  {
    q: "What counts as an outcome?",
    a: "The outcome you define in the campaign policy. Today that is a qualifying paid customer: a purchase that reaches your company wallet, meets the minimum amount, and comes from a new customer through a partner's referral.",
  },
  {
    q: "When does a partner get paid?",
    a: "Only after the outcome is verified and the campaign's safety hold has passed. Then the payout is reserved against funded budget, submitted onchain and reconciled before it's marked settled.",
  },
  {
    q: "What prevents double payments?",
    a: "Each outcome can have exactly one reservation and one payout for life. If a chain result is unclear, Thesma reconciles it instead of sending again.",
  },
  {
    q: "Where does the money sit?",
    a: "Customer revenue goes straight to your company wallet. Only the campaign budget is held in the campaign vault, and it can only leave as a verified payout or be returned to you.",
  },
  {
    q: "Can pricing change my budget or limits?",
    a: "No. Budget, floor, ceiling, minimum purchase, deadline and hold are owner-controlled. Pricing can move only inside the range you approved.",
  },
];

export function FaqSection() {
  return (
    <section id="faq" className={styles.section} aria-labelledby="faq-title">
      <div className={`container ${styles.faqGrid}`}>
        <div className={styles.sectionHead} data-align="left">
          <p className="eyebrow">FAQ</p>
          <h2 id="faq-title">Questions, answered plainly.</h2>
        </div>
        <div className={styles.faqList}>
          {FAQS.map((f) => (
            <details key={f.q} className={styles.faqItem}>
              <summary>
                {f.q}
                <span aria-hidden="true" className={styles.faqIcon} />
              </summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------- Closing CTA + footer ---------------- */

export function ClosingCta() {
  return (
    <section className={styles.section} aria-labelledby="cta-title">
      <div className="container">
        <div className={styles.cta}>
          <h2 id="cta-title">Define the outcome. Pay when it&apos;s proven.</h2>
          <div className={styles.heroCtas}>
            <Link href="/signin?next=/app/campaigns/new" className="btn btn-primary">
              Launch a campaign
            </Link>
            <Link href="/signin" className="btn btn-ghost">
              Open app
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className="container">
        <div className={styles.footerCard}>
          <div className={styles.footerBrand}>
            <Logo />
            <p>Thesma — verified outcomes, accountable settlement.</p>
          </div>
          <nav className={styles.footerCols} aria-label="Footer">
            <div>
              <h3>Product</h3>
              <a href="#product">Campaigns</a>
              <a href="#verified-outcomes">Outcomes</a>
              <a href="#how-it-works">Settlement</a>
              <a href="#operator">Operator</a>
            </div>
            <div>
              <h3>Learn</h3>
              <a href="#how-it-works">How it works</a>
              <a href="#developers">Developers</a>
              <a href="#faq">FAQ</a>
            </div>
            <div>
              <h3>Get started</h3>
              <Link href="/signin?next=/app/campaigns/new">Launch campaign</Link>
              <Link href="/signin">Open app</Link>
            </div>
          </nav>
        </div>
        <p className={styles.footerLegal}>© {new Date().getFullYear()} Thesma. Settlement in USDC on Arc.</p>
      </div>
    </footer>
  );
}
