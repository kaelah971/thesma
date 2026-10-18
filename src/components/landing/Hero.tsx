import Link from "next/link";
import { PhoneMockup } from "./PhoneMockup";
import { SiteNav } from "./SiteNav";
import styles from "./landing.module.css";

const LEFT = [
  { title: "Set the outcome", body: "The result, the price, the rules.", tone: "blue", glyph: "target" },
  { title: "Fund it upfront", body: "Your budget is set aside first.", tone: "lav", glyph: "stack" },
] as const;

const RIGHT = [
  { title: "Verify every result", body: "Checked before it can be paid.", tone: "mint", glyph: "seal" },
  { title: "Release on proof", body: "Hold, payout, receipt. In order.", tone: "cream", glyph: "receipt" },
] as const;

const enter = (i: number) => ({ ["--i" as string]: i }) as React.CSSProperties;

export function ArrowIcon() {
  return (
    <svg className="btn-arrow" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7h8.5M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export type Glyph = (typeof LEFT)[number]["glyph"] | (typeof RIGHT)[number]["glyph"] | "clock" | "shield" | "repeat" | "one";

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
      {glyph === "clock" && (
        <>
          <circle cx="9" cy="9" r="6.5" {...common} />
          <path d="M9 5.5V9l2.4 1.6" {...common} />
        </>
      )}
      {glyph === "shield" && (
        <>
          <path d="M9 1.8 15 4v4.6c0 3.6-2.6 6.4-6 7.6-3.4-1.2-6-4-6-7.6V4z" {...common} />
          <path d="M6.3 9.1 8.2 11l3.5-3.7" {...common} />
        </>
      )}
      {glyph === "repeat" && (
        <>
          <path d="M3 8.2V7a3 3 0 0 1 3-3h8.5M12.3 1.8 14.5 4l-2.2 2.2" {...common} />
          <path d="M15 9.8V11a3 3 0 0 1-3 3H3.5M5.7 16.2 3.5 14l2.2-2.2" {...common} />
        </>
      )}
      {glyph === "one" && (
        <>
          <rect x="2.5" y="2.5" width="13" height="13" rx="3.5" {...common} />
          <path d="M7.6 6.6 9.4 5.4v7.2M7.4 12.6h4" {...common} />
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
        </p>
        <h1 id="hero-title" className={`${styles.heroTitle} ${styles.enter}`} style={enter(1)}>
          Pay for <span className={styles.spectrumText}>proof</span>,<br /> not promises.
        </h1>
        <p className={`${styles.heroLede} ${styles.enter}`} style={enter(2)}>
          Thesma&apos;s autonomous operators run your growth campaigns and release payment only when a real customer result is verified.
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
        <span className={`${styles.splitWord} ${styles.enterFade}`} data-half="start" aria-hidden="true" style={enter(3)}>
          Veri
        </span>
        <div className={styles.center}>
          <div className={`${styles.phoneRise} ${styles.enterRise}`} style={enter(4)}>
            <PhoneMockup />
          </div>
        </div>
        <span className={`${styles.splitWord} ${styles.enterFade}`} data-half="end" aria-hidden="true" style={enter(4)}>
          fied
        </span>
        <div className={styles.calloutCol} data-side="left">
          {LEFT.map((item, i) => (
            <Callout key={item.title} item={item} side="left" i={6 + i} />
          ))}
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
