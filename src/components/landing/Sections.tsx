import Image from "next/image";
import Link from "next/link";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { Rail } from "@/components/ui/Rail";
import { ArrowIcon, CalloutGlyph, type Glyph } from "./Hero";
import styles from "./landing.module.css";

/** Scroll reveal hook (see RevealObserver). `i` staggers siblings. */
const reveal = (i = 0) => ({ "data-reveal": "", style: { ["--reveal-i" as string]: i } as React.CSSProperties });

/* ---------------- Product value (notched cards) ---------------- */

function ValueCard({ tone, glyph, tag, title, body, i, id, children }: {
  tone: string;
  glyph: Glyph;
  tag: string;
  title: string;
  body: string;
  i: number;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <article id={id} className={styles.valueCard} data-tone={tone} {...reveal(i)}>
      <div className={styles.notchSurface}>
        <span className={styles.valueIcon} aria-hidden="true">
          <CalloutGlyph glyph={glyph} />
        </span>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className={styles.valueVisual}>{children}</div>
      </div>
      <span className={styles.notchTag}>{tag}</span>
    </article>
  );
}

export function ValueSection() {
  return (
    <section id="product" className={styles.section} aria-labelledby="product-title">
      <div className="container">
        <div className={styles.sectionHead} {...reveal()}>
          <p className="eyebrow">Product</p>
          <h2 id="product-title">Spend only on real results.</h2>
          <p>You decide the result, the price and the rules. Thesma checks every claim before any money moves.</p>
        </div>

        <div className={styles.valueGrid}>
          <ValueCard tone="blue" glyph="target" tag="Terms" title="Pay for a result" body="Name the exact result you’ll pay for, and nothing else." i={0}>
            <div className={styles.ruleCard}>
              <span className={styles.ruleKey}>Outcome</span>
              <span>Paid customer</span>
              <span className={styles.ruleKey}>Qualifies at</span>
              <span className="tnum">30 USDC or more</span>
              <span className={styles.ruleKey}>Price range</span>
              <span className="tnum">40 to 80 USDC</span>
            </div>
          </ValueCard>

          <ValueCard id="verified-outcomes" tone="mint" glyph="seal" tag="Checks" title="Every result checked" body="Nothing becomes payable until it passes your rules." i={1}>
            <ul className={styles.checkList}>
              <li>Paid to your wallet</li>
              <li>Above the minimum</li>
              <li>New customer only</li>
              <li>Buyer is not the referrer</li>
            </ul>
          </ValueCard>

          <ValueCard tone="cream" glyph="clock" tag="Hold" title="A safety window" body="Payment waits out a hold, so refunds surface before anyone is paid." i={2}>
            <div className={styles.holdVisual}>
              <span className={styles.ruleKey}>Safety hold</span>
              <strong className="tnum">00:42:10</strong>
              <Rail steps={["Verify", "Hold", "Settle"]} current={1} size="sm" />
            </div>
          </ValueCard>

          <ValueCard tone="lav" glyph="receipt" tag="Receipt" title="Proof for every payment" body="Open any payment and see exactly why it was made." i={3}>
            <dl className={styles.receiptMini}>
              <div>
                <dt>Payout</dt>
                <dd className="tnum">60.00 USDC</dd>
              </div>
              <div>
                <dt>Status</dt>
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
          </ValueCard>
        </div>
      </div>
    </section>
  );
}

/* ---------------- How it works (linked light) ---------------- */

const STEPS = [
  {
    n: "01",
    title: "Create a campaign",
    body: "Choose the result you’ll pay for, the price, and who can earn it.",
    detail: "You approve it before launch",
    tone: "blue",
  },
  {
    n: "02",
    title: "Fund the budget",
    body: "Set money aside for the campaign before any result arrives.",
    detail: "Locked to this campaign",
    tone: "lav",
  },
  {
    n: "03",
    title: "Verify the result",
    body: "Each customer purchase is checked against your rules before anything is payable.",
    detail: "Checked from the payment itself",
    tone: "mint",
  },
  {
    n: "04",
    title: "Pay out on proof",
    body: "After the safety hold, the payout is sent. It only counts as settled once it’s confirmed.",
    detail: "A receipt for every payout",
    tone: "cream",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.section} aria-labelledby="how-title" data-inview-track>
      <div className="container">
        <div className={styles.sectionHead} {...reveal()}>
          <p className="eyebrow">How it works</p>
          <h2 id="how-title">From goal to receipt in four steps.</h2>
          <p>Money moves one way, and only after proof. Each step leaves a record you can open.</p>
        </div>

        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <li key={s.n} className={styles.step} data-tone={s.tone} style={{ ["--step" as string]: i } as React.CSSProperties}>
              <div className={styles.stepCard} {...reveal(i)}>
                <div className={styles.stepTop}>
                  <span className={`${styles.stepNum} tnum`}>{s.n}</span>
                  <span className={styles.stepNode} aria-hidden="true" />
                </div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <span className={styles.stepDetail}>{s.detail}</span>
              </div>
              {i < STEPS.length - 1 && <span className={styles.stepLink} aria-hidden="true" />}
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
    <section id="operator" className={styles.section} aria-labelledby="operator-title" data-inview-track>
      <div className="container">
        <div className={styles.sectionHead} {...reveal()}>
          <p className="eyebrow">Operator</p>
          <h2 id="operator-title">Ask your campaign what it&apos;s doing.</h2>
          <p>Straight answers on holds, budget and payments, with the numbers attached.</p>
        </div>

        <div className={styles.opFrame} {...reveal(1)}>
          <div className={styles.opTopbar}>
            <LogoMark size={28} tile />
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
                <h3 className="display">Operator</h3>
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
                  <LogoMark size={28} tile />
                  <div className={styles.msgBody}>
                    <p>
                      1 verified outcome is in its safety hold. The payout becomes eligible in <b>42 minutes</b>.
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
                  <LogoMark size={28} tile />
                  <div className={styles.msgBody}>
                    <p>The result is verified, but payment waits until the campaign&apos;s safety hold ends. Verified isn&apos;t the same as paid.</p>
                    <div className={styles.msgRail}>
                      <Rail steps={["Verify", "Hold", "Settle"]} current={1} size="sm" />
                    </div>
                    <div className={styles.msgActions} aria-hidden="true">
                      <span>Open outcome</span>
                      <span>View hold rules</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.opComposer} aria-hidden="true">
                <span className="perimeter-light" />
                <span className={styles.opPlaceholder}>Ask about campaigns, outcomes or payouts</span>
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
                <p>60 USDC · hold set by your campaign rules</p>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- Trust / safeguards (agentic light cards) ---------------- */

const PRINCIPLES: { title: string; body: string; glyph: Glyph; tone: string }[] = [
  { title: "Verified results only", body: "Clicks and sign-ups never earn on their own. Only results that pass verification can be paid.", glyph: "seal", tone: "mint" },
  { title: "Never over budget", body: "Every payout comes out of money you’ve already funded, so spend can’t run past your budget.", glyph: "stack", tone: "aqua" },
  { title: "A hold before money moves", body: "Each campaign sets a waiting period, so refunds and reversals surface before anyone is paid.", glyph: "clock", tone: "blue" },
  { title: "Confirmed, never resent", body: "If a payment’s status is unclear, Thesma confirms what happened instead of sending it again.", glyph: "repeat", tone: "lav" },
  { title: "One result, one payment", body: "Each result can be paid exactly once. No duplicates, ever.", glyph: "one", tone: "cream" },
  { title: "Public proof of payment", body: "Settled means the payment is confirmed on a public ledger, not just marked done.", glyph: "shield", tone: "mint" },
];

export function TrustSection() {
  return (
    <section className={styles.section} aria-labelledby="trust-title">
      <div className="container">
        <div className={styles.sectionHead} {...reveal()}>
          <p className="eyebrow">Built-in safeguards</p>
          <h2 id="trust-title">Rules every payment must pass.</h2>
          <p>Enforced on every payout, for every campaign. You never have to take a claim on trust.</p>
        </div>
        <ul className={styles.trustGrid}>
          {PRINCIPLES.map((p, i) => (
            <li key={p.title} className={styles.principle} data-tone={p.tone} {...reveal(i)}>
              <span className={styles.principleIcon} aria-hidden="true">
                <CalloutGlyph glyph={p.glyph} />
              </span>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------------- Receipts ---------------- */

const RECEIPT_CHECKS = ["Campaign budget was funded", "Amount matches the agreed price", "Paid to the partner’s own wallet", "Safety hold completed"];

export function ReceiptsSection() {
  return (
    <section id="receipts" className={styles.section} aria-labelledby="receipts-title">
      <div className={`container ${styles.receiptsGrid}`}>
        <div className={styles.receiptsCopy} {...reveal()}>
          <p className="eyebrow">Receipts</p>
          <h2 id="receipts-title">Every payout comes with proof.</h2>
          <p>
            Each payment has a receipt anyone can open. It re-checks the terms every time it&apos;s viewed, and only says settled once the payment is confirmed. Sent is not the same as settled.
          </p>
          <div className={styles.receiptsActions}>
            <Link href="/markets" className="btn btn-ghost">
              See live proof
              <ArrowIcon />
            </Link>
          </div>
          <p className={styles.receiptsNote}>Building on Thesma? Receipts and live markets are also available through a public, read-only API.</p>
        </div>

        <figure className={styles.receiptCard} {...reveal(1)}>
          <div className={styles.notchSurface}>
            <figcaption className={styles.receiptHead}>
              <span className={styles.ruleKey}>Payout receipt</span>
              <strong className="tnum">
                60.00 <small>USDC</small>
              </strong>
              <span className={styles.receiptMeta}>Paid customer · Growth Campaign</span>
            </figcaption>
            <ul className={styles.receiptChecks}>
              {RECEIPT_CHECKS.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className={styles.receiptFoot}>
              <span>Confirmed on the public ledger</span>
              <span className="mono">0x7a3e…41bf</span>
            </div>
          </div>
          <span className={styles.notchTag} data-tone="mint">
            Settled
          </span>
        </figure>
      </div>
    </section>
  );
}

/* ---------------- FAQ ---------------- */

const FAQS = [
  {
    q: "What counts as an outcome?",
    a: "Whatever your campaign defines. Today that’s a qualifying paid customer: a purchase that reaches your company wallet, meets your minimum amount and comes from a new customer referred by a partner.",
  },
  {
    q: "When does a partner get paid?",
    a: "Only after the result is verified and the campaign’s safety hold has ended. The payment is then set aside from your funded budget, sent, and confirmed before it counts as settled.",
  },
  {
    q: "What prevents double payments?",
    a: "Each result can be paid exactly once. If a payment’s status is ever unclear, Thesma confirms what happened instead of sending it again.",
  },
  {
    q: "Where does the money sit?",
    a: "Customer revenue goes straight to your company wallet. Only the campaign budget is locked to the campaign, and it can leave only as a verified payout or a return to you.",
  },
  {
    q: "Can pricing change my budget or limits?",
    a: "No. You set the budget, the price range, the minimum purchase, the deadline and the hold. Thesma can only adjust the price inside the range you approved.",
  },
];

export function FaqSection() {
  return (
    <section id="faq" className={styles.section} aria-labelledby="faq-title">
      <div className={`container ${styles.faqGrid}`}>
        <div className={styles.sectionHead} data-align="left" {...reveal()}>
          <p className="eyebrow">FAQ</p>
          <h2 id="faq-title">Questions, answered plainly.</h2>
        </div>
        <div className={styles.faqList}>
          {FAQS.map((f, i) => (
            <details key={f.q} className={styles.faqItem} {...reveal(i)}>
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
        <div className={styles.cta} {...reveal()}>
          <h2 id="cta-title">Every payout, backed by proof.</h2>
          <p className={styles.ctaLede}>Set up your first campaign in minutes. Nothing is funded until you approve it.</p>
          <div className={styles.heroCtas}>
            <Link href="/signin?next=/app/campaigns/new" className="btn btn-primary">
              Launch a campaign
              <ArrowIcon />
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
          <div className={styles.footerTop}>
            <div className={styles.footerBrand}>
              <Logo />
              <p>Pay for proof, not promises.</p>
            </div>
            <nav className={styles.footerCols} aria-label="Footer">
              <div>
                <h3>Product</h3>
                <a href="#product">Campaigns</a>
                <a href="#verified-outcomes">Verification</a>
                <a href="#how-it-works">Payouts</a>
                <a href="#operator">Operator</a>
              </div>
              <div>
                <h3>Learn</h3>
                <a href="#how-it-works">How it works</a>
                <a href="#receipts">Receipts</a>
                <Link href="/markets">Live markets</Link>
                <a href="#faq">FAQ</a>
              </div>
              <div>
                <h3>Get started</h3>
                <Link href="/signin?next=/app/campaigns/new">Launch a campaign</Link>
                <Link href="/signin">Open app</Link>
              </div>
            </nav>
          </div>

          <div className={styles.footerWord} aria-hidden="true">
            <Image src="/brand/thesma-wordmark.png" alt="" width={727} height={93} sizes="(max-width: 1200px) 92vw, 1100px" />
          </div>

          <div className={styles.footerBottom}>
            <span>© {new Date().getFullYear()} Thesma</span>
            <span>Payouts settled in USDC</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
