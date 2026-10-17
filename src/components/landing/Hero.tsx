import Link from "next/link";
import { PhoneMockup } from "./PhoneMockup";
import { SiteNav } from "./SiteNav";
import styles from "./landing.module.css";

const LEFT = [
  { title: "Set the outcome", body: "Choose the result, the price and the rules.", tone: "blue", glyph: "target" },
  { title: "Fund it upfront", body: "The budget is committed before a single result arrives.", tone: "lav", glyph: "stack" },
] as const;

const RIGHT = [
  { title: "Verify every result", body: "Evidence is checked before anything becomes payable.", tone: "mint", glyph: "seal" },
  { title: "Release on proof", body: "Hold, payout, receipt. In that order, every time.", tone: "cream", glyph: "receipt" },
] as const;

const enter = (i: number) => ({ ["--i" as string]: i }) as React.CSSProperties;

export function ArrowIcon() {
  return (
    <svg className="btn-arrow" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7h8.5M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Glyph = (typeof LEFT)[number]["glyph"] | (typeof RIGHT)[number]["glyph"];

export function CalloutGlyph({ glyph }: { glyph: Glyph }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {glyph === "target" && (
        <>
          <circle cx="9" cy="9" r="6.5" {...common} />
          <circle cx="9" cy="9" r="3" {...common} />
        </>
      )}
      {glyph === "stack" && (
        <>
          <ellipse cx="9" cy="5" rx="6" ry="2.4" {...common} />
          <path d="M3 5v4c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5M3 9v4c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V9" {...common} />
        </>
      )}
      {glyph === "seal" && (
        <>
          <path d="M9 1.8l1.9 1.4 2.3-.1.7 2.2 1.9 1.4-.7 2.2.7 2.2-1.9 1.4-.7 2.2-2.3-.1L9 16.2l-1.9-1.4-2.3.1-.7-2.2-1.9-1.4.7-2.2-.7-2.2 1.9-1.4.7-2.2 2.3.1z" {...common} />
          <path d="M6.4 9.2l1.8 1.7 3.4-3.6" {...common} />
        </>
      )}
      {glyph === "receipt" && (
        <>
          <path d="M4 2h10v14l-2.5-1.5L9 16l-2.5-1.5L4 16z" {...common} />
          <path d="M6.5 6h5M6.5 9h5" {...common} />
        </>
      )}
    </svg>
  );
}

function Callout({ item, side, i }: { item: (typeof LEFT)[number] | (typeof RIGHT)[number]; side: "left" | "right"; i: number }) {
  return (
    <div className={`${styles.callout} ${styles.enterFade}`} data-side={side} style={enter(i)}>
      <span className={styles.calloutIcon} data-tone={item.tone}>
        <CalloutGlyph glyph={item.glyph} />
      </span>
      <div>
        <h3>{item.title}</h3>
        <p>{item.body}</p>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title" data-inview-track>
      <div className={styles.heroWash} aria-hidden="true" />
      <SiteNav />

      <div className={styles.heroCopy}>
        <p className={`${styles.heroEyebrow} ${styles.enter}`} style={enter(0)}>
          <span className="pill" data-tone="mint">
            Proof before payout
          </span>
          Outcome campaigns for growing businesses
        </p>
        <h1 id="hero-title" className={`${styles.heroTitle} ${styles.enter}`} style={enter(1)}>
          Autonomous operators for growth campaigns.
          <span className={styles.heroTitleEm}>Pay only for verified results.</span>
        </h1>
        <p className={`${styles.heroLede} ${styles.enter}`} style={enter(2)}>
          Thesma helps teams launch and run outcome campaigns, verify real business results, and control when money moves. Its autonomous operators manage pricing, partner decisions, verification, holds and payouts, while every payment stays bound to proof, budget and policy.
        </p>
        <div className={`${styles.heroCtas} ${styles.enter}`} style={enter(3)}>
          <Link href="/signin?next=/app/campaigns/new" className="btn btn-primary">
            Launch a campaign
            <ArrowIcon />
          </Link>
          <a href="#how-it-works" className="btn btn-ghost">
            See how it works
          </a>
        </div>
      </div>

      <div className={styles.stage}>
        <div className={styles.calloutCol} data-side="left">
          {LEFT.map((item, i) => (
            <Callout key={item.title} item={item} side="left" i={6 + i} />
          ))}
        </div>
        <div className={styles.center}>
          <div className={`${styles.bigWord} ${styles.enterFade}`} aria-hidden="true" style={enter(3)}>
            Verified
          </div>
          <div className={`${styles.phoneRise} ${styles.enterRise}`} style={enter(4)}>
            <PhoneMockup />
          </div>
        </div>
        <div className={styles.calloutCol} data-side="right">
          {RIGHT.map((item, i) => (
            <Callout key={item.title} item={item} side="right" i={6 + i} />
          ))}
        </div>
      </div>
    </section>
  );
}
