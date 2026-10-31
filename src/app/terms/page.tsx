import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { PublicFooter } from "@/components/trust/PublicFooter";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = {
  title: "Terms",
  description: "Thesma terms of use — what the service is and what rules apply.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
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
          <h1>Terms of use</h1>
          <p>Short, plain rules for using Thesma. No corporate entity is claimed here.</p>
        </div>
        <div className={styles.homeGrid}>
          <section className={styles.panel}>
            <h2>What Thesma is</h2>
            <p>
              Thesma is software for running outcome campaigns: organizations fund budgets, creators refer
              customers, purchases are verified against campaign rules, and payouts settle in USDC on Arc
              Mainnet. Campaign and payment rules are governed by the policy displayed in the product and by
              onchain execution — not by marketing copy.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Experimental software</h2>
            <p>
              Thesma is an early product. Features, markets, and availability may change or stop at any time.
              Verified means evidence passed, not that anyone was paid; submitted means a payout transaction
              exists, not that it settled. Only onchain reconciliation settles a payout.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Your responsibilities</h2>
            <p>
              You are responsible for the information you submit and for keeping your account and wallet
              access safe. Thesma never asks for seed phrases or private keys. Campaigns do not guarantee
              performance, customers, or earnings.
            </p>
          </section>
          <section className={styles.panel}>
            <h2>Custody and payments</h2>
            <p>
              Thesma does not claim regulated financial custody. Funding moves into the published vault
              contract, payouts execute through the documented payout path, and every settlement leaves a
              public receipt inspectable on <Link href="/markets">markets</Link> and{" "}
              <Link href="/demo">live proof</Link>.
            </p>
          </section>
        </div>
        <section className={styles.panel} style={{ marginTop: 16 }}>
          <h2>Related pages</h2>
          <p>
            How data is handled: <Link href="/privacy">Privacy</Link>. How wallets, payments, and proof stay
            safe — and how to report a concern: <Link href="/security">Security</Link>.
          </p>
          <div className={styles.panelActions}>
            <Link href="/demo" className="btn btn-sm">
              See the proof
            </Link>
          </div>
        </section>
        <PublicFooter />
      </div>
    </div>
  );
}
