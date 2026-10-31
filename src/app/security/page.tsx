import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { PublicFooter } from "@/components/trust/PublicFooter";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Thesma keeps wallets, payments and proof safe — and how to report a security concern.",
  alternates: { canonical: "/security" },
};

const RULES = [
  {
    title: "Thesma never asks for seed phrases or private keys",
    body: "No page, email, or support flow will ever ask for your seed phrase, private key, or recovery phrase. Anyone who does is not Thesma.",
  },
  {
    title: "Wallets open only when you click",
    body: "MetaMask (or your wallet) opens only after you press an explicit action such as Connect, Sign, or Pay — never on page load, and never silently in the background.",
  },
  {
    title: "Every payment shows before it signs",
    body: "Funding and checkout present the exact recipient, amount, and network before your wallet asks for a signature. Thesma's backend only prepares unsigned transfers and verifies receipts; it never holds your keys.",
  },
  {
    title: "Verification is not payment",
    body: "VERIFIED means the evidence passed — not that anyone was paid. SUBMITTED means a payout transaction exists — not that it settled. Only independent onchain reconciliation settles a payout.",
  },
  {
    title: "Proof is public",
    body: "Live and completed markets, payout receipts, and settlement evidence can be inspected on /markets by anyone, without an account.",
  },
  {
    title: "Referral links stay on Thesma until you click",
    body: "Links like thesma.vercel.app/r/… always open a Thesma page first, showing the organization, the campaign, and the referring creator. The external destination opens only after you press Continue — and destinations are stored server-side, validated to https, and never taken from URL parameters.",
  },
];

export default function SecurityPage() {
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
          <span className={styles.eyebrow}>Trust</span>
          <h1>Security at Thesma</h1>
          <p>Factual rules for staying safe — what Thesma does, and what it will never do.</p>
        </div>
        <div className={styles.homeGrid}>
          {RULES.map((r) => (
            <section key={r.title} className={styles.panel}>
              <h2>{r.title}</h2>
              <p>{r.body}</p>
            </section>
          ))}
        </div>
        <section className={styles.panel} style={{ marginTop: 16 }}>
          <h2>Report a security concern</h2>
          <p>
            Found something suspicious — a phishing copy of Thesma, a strange wallet prompt, or a vulnerability?
            Describe what you saw, including the full URL and (if a payment) the transaction hash, through the
            in-app Operator or the contact channel published on the live site. Include steps to reproduce; never
            include seed phrases or private keys.
          </p>
          <div className={styles.panelActions}>
            <Link href="/markets" className="btn btn-sm">
              Inspect public proof
            </Link>
          </div>
        </section>
        <PublicFooter />
      </div>
    </div>
  );
}
