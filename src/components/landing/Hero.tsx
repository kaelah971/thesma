import Link from "next/link";
import { PhoneMockup } from "./PhoneMockup";
import { SiteNav } from "./SiteNav";
import styles from "./landing.module.css";

const LEFT = [
  { title: "Launch campaigns", body: "Define the outcome, price and rules.", tone: "blue", glyph: "target" },
  { title: "Fund the market", body: "Commit the budget before results arrive.", tone: "lav", glyph: "stack" },
] as const;

const RIGHT = [
  { title: "Verify outcomes", body: "Real evidence before payout.", tone: "mint", glyph: "seal" },
  { title: "Settle automatically", body: "Verified outcomes move through hold → payout → receipt.", tone: "cream", glyph: "receipt" },
] as const;

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

function Callout({ item, side }: { item: (typeof LEFT)[number] | (typeof RIGHT)[number]; side: "left" | "right" }) {
  return (
    <div className={styles.callout} data-side={side}>
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
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.heroWash} aria-hidden="true" />
      <SiteNav />

      <div className={styles.heroCopy}>
        <p className={styles.heroEyebrow}>
          <span className="pill" data-tone="mint">
            USDC on Arc
          </span>
          A market for verified business outcomes
        </p>
        <h1 id="hero-title" className={styles.heroTitle}>
          Pay for outcomes.
          <br />
          Not promises.
        </h1>
        <p className={styles.heroLede}>
          Launch outcome-based campaigns, verify real results, and settle payouts only when the proof checks out.
        </p>
        <div className={styles.heroCtas}>
          <Link href="/signin?next=/app/campaigns/new" className="btn btn-primary">
            Launch a campaign
          </Link>
          <a href="#how-it-works" className="btn btn-ghost">
            See how it works
          </a>
        </div>
      </div>

      <div className={styles.stage}>
        <div className={styles.calloutCol} data-side="left">
          {LEFT.map((item) => (
            <Callout key={item.title} item={item} side="left" />
          ))}
        </div>
        <div className={styles.center}>
          <div className={styles.bigWord} aria-hidden="true">
            Verified
          </div>
          <PhoneMockup />
        </div>
        <div className={styles.calloutCol} data-side="right">
          {RIGHT.map((item) => (
            <Callout key={item.title} item={item} side="right" />
          ))}
        </div>
      </div>
    </section>
  );
}
