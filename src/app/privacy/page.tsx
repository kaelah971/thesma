import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { PublicFooter } from "@/components/trust/PublicFooter";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Thesma handles accounts, sessions, wallets, and public data.",
  alternates: { canonical: "/privacy" },
};

/**
 * Every claim below is backed by implementation:
 * - session tokens: sha256-hashed before storage (src/server/auth/session.ts)
 * - passwords: bcrypt-hashed (src/server/auth/password.ts)
 * - database: Postgres via drizzle (src/server/db/client.ts)
 * - cookies: thesma_session / thesma_persona / thesma_attr
 * - attribution: random IDs only, never wallets (src/server/db/schema.ts)
 * - outcomes: customerKeyHash, a hash — never raw customer identity
 * - auditEvents: internal operational log, never public
 * - Arc Mainnet transactions: public by nature of the chain
 * No GDPR/CCPA compliance claims are made.
 */
export default function PrivacyPage() {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.topbar}>
          <Logo />
          <div className={styles.topbarRight}>
            <Link href="/markets">Live markets</Link>
            <Link href="/start">Open app</Link>
          </div>
        </div>
        <div className={styles.hero} style={{ textAlign: "left", marginLeft: 0, marginRight: 0 }}>
          <span className={styles.eyebrow}>Legal</span>
          <h1>Privacy</h1>
          <p>What Thesma stores, what stays public, and what never touches our servers.</p>
        </div>
        <div className={styles.homeGrid}>
          <section className={styles.panel}>
            <h2>Accounts and sessions</h2>
            <p>
              Accounts hold an email and a bcrypt-hashed password — passwords are never stored in readable
              form. Sessions use opaque 30-day tokens; only the SHA-256 hash of a token is stored, and the
              token itself travels in an HttpOnly, SameSite=Lax session cookie that browsers never expose
              to page scripts.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Cookies</h2>
            <p>
              Thesma sets a session cookie for login, a pre-auth role cookie that remembers which product
              experience you chose, and an attribution cookie carrying random referral IDs only — never
              wallets or personal data.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Personas, campaigns, wallets</h2>
            <p>
              Creator personas, campaign definitions, and company or payout wallet addresses you provide are
              stored in the application database (Postgres) to operate the product. Customer outcomes store
              a hashed customer identifier, never raw customer identity.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>What is public</h2>
            <p>
              Public creator profiles, public markets, payout receipts, and settlement evidence are visible
              to anyone without an account. Transactions on Arc Mainnet are public by nature of the
              blockchain — amounts, addresses, and transaction hashes can be inspected in any explorer.
              Internal audit logs exist for security and fraud review and are never published.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Infrastructure</h2>
            <p>
              Thesma is hosted on Vercel with a Postgres database. Thesma never asks for, and never
              receives, your wallet seed phrase or private key — wallets only sign after you press an
              explicit action.
            </p>
          </section>
        </div>
        <section className={styles.panel} style={{ marginTop: 16 }}>
          <h2>Related pages</h2>
          <p>
            Rules for using the service: <Link href="/terms">Terms</Link>. Wallet safety and reporting a
            concern: <Link href="/security">Security</Link>.
          </p>
        </section>
        <PublicFooter />
      </div>
    </div>
  );
}
