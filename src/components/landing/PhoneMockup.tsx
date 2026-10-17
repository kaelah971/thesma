import { LogoMark } from "@/components/brand/Logo";
import { Rail } from "@/components/ui/Rail";
import styles from "./landing.module.css";

/**
 * Presentation-only preview of the Thesma campaign dashboard.
 * Demo numbers are internally consistent: 5,000 funded; 19 settled × 60 =
 * 1,140; 2 reserved × 60 = 120; available = 5,000 − 1,260 = 3,740.
 */
export function PhoneMockup() {
  return (
    <div className={styles.phoneWrap} aria-label="Preview of a Thesma campaign dashboard" role="img">
      <div className={styles.phone}>
        <div className={styles.screen} aria-hidden="true">
          <div className={styles.statusBar}>
            <span className="tnum">9:41</span>
            <span className={styles.island} />
            <span className={styles.statusIcons}>
              <i />
              <i />
              <i />
              <b />
            </span>
          </div>

          <div className={styles.phHeader}>
            <LogoMark size={22} />
            <div className={styles.phTitle}>
              <span>Growth Campaign</span>
              <small>Paid customers · Arc USDC</small>
            </div>
            <span className="pill" data-tone="mint">
              LIVE
            </span>
          </div>

          <div className={styles.phBudget}>
            <span className={styles.phLabel}>Available budget</span>
            <div className={styles.phAmount}>
              <strong className="tnum">3,740</strong>
              <span>USDC</span>
            </div>
            <div className={styles.phBar}>
              <i style={{ width: "22.8%", background: "var(--ink)" }} />
              <i style={{ width: "2.4%", background: "var(--lav-ink)" }} />
            </div>
            <div className={styles.phBarLegend}>
              <span>
                <i style={{ background: "var(--ink)" }} />
                Settled 1,140
              </span>
              <span>
                <i style={{ background: "var(--lav-ink)" }} />
                Reserved 120
              </span>
              <span className="tnum">of 5,000</span>
            </div>
          </div>

          <div className={styles.phStats}>
            <div>
              <span className={styles.phLabel}>Budget funded</span>
              <strong className="tnum">5,000</strong>
            </div>
            <div>
              <span className={styles.phLabel}>Verified outcomes</span>
              <strong className="tnum">
                22<small>/50</small>
              </strong>
            </div>
            <div>
              <span className={styles.phLabel}>Settled payouts</span>
              <strong className="tnum">19</strong>
            </div>
            <div>
              <span className={styles.phLabel}>Price / outcome</span>
              <strong className="tnum">60</strong>
            </div>
          </div>

          <div className={styles.phProgress}>
            <div className={styles.phRow}>
              <span className={styles.phLabel}>Campaign progress</span>
              <span className={`${styles.phLabel} tnum`}>44%</span>
            </div>
            <div className={styles.phTrack}>
              <i style={{ width: "44%" }} />
            </div>
          </div>

          <div className={styles.phActivity}>
            <span className={styles.phLabel}>Recent activity</span>
            <ul>
              <li>
                <span className={styles.dot} data-tone="blue" />
                <div>
                  <b>Outcome verified</b>
                  <small className="mono">proof 0x91c4…e0a2</small>
                </div>
                <em>2m</em>
              </li>
              <li>
                <span className={styles.dot} data-tone="lav" />
                <div>
                  <b>Budget reserved</b>
                  <small>60 USDC · frozen price</small>
                </div>
                <em>14m</em>
              </li>
              <li>
                <span className={styles.dot} data-tone="mint" />
                <div>
                  <b>Payout settled</b>
                  <small>Reconciled onchain</small>
                </div>
                <em>1h</em>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className={`${styles.floatCard} ${styles.floatDark}`} aria-hidden="true">
        <div className={styles.floatTop}>
          <span className={styles.floatIcon}>
            <svg width="14" height="14" viewBox="0 0 14 14">
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M7 4v3.2l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <b>Payout in safety hold</b>
            <small>Eligible in 42m</small>
          </div>
          <strong className="tnum">60 USDC</strong>
        </div>
        <Rail steps={["Verify", "Hold", "Reserve", "Settle"]} current={1} size="sm" tone="cream" label="Payout progress" />
      </div>

      <div className={`${styles.floatCard} ${styles.floatLight}`} aria-hidden="true">
        <span className={styles.floatIcon} data-light>
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M3 1.5h8v11l-2-1.2-2 1.2-2-1.2-2 1.2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M5 5h4M5 7.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <div>
          <b>Receipt · settled</b>
          <small className="mono">tx 0x7a3e…41bf</small>
        </div>
        <div className={styles.floatRight}>
          <strong className="tnum">60.00</strong>
          <small>USDC</small>
        </div>
      </div>
    </div>
  );
}
