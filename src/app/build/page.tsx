import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HomeShell } from "@/components/start/HomeShell";
import { getSessionUser } from "@/server/auth/guard";
import { getPersonaByUserId } from "@/server/services/personas";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = { title: "Build with Thesma" };

const STEPS = [
  {
    n: "01",
    title: "Connect your product",
    body: "Point your checkout or conversion event at Thesma. API keys and a sandbox are coming next — nothing to copy yet.",
    status: "Coming next",
  },
  {
    n: "02",
    title: "Send outcomes",
    body: "Report the customer result you want verified — purchases today, more event types as the network grows.",
    status: "Coming next",
  },
  {
    n: "03",
    title: "Verify results",
    body: "Every outcome is checked against campaign rules and proof before it can move anywhere near money.",
    status: "Live on Thesma markets",
  },
  {
    n: "04",
    title: "Receive receipts",
    body: "Each settlement produces a public receipt with proof, policy and amounts — auditable by anyone.",
    status: "Live on Thesma markets",
  },
  {
    n: "05",
    title: "Use payout infrastructure",
    body: "Fund once, hold per verified outcome, release on proof. Safety holds and reconciliation are built in.",
    status: "Live on Thesma markets",
  },
];

export default async function BuildHomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/build");

  const row = await getPersonaByUserId(user.userId);
  if (row && !row.onboardingCompletedAt) redirect("/onboarding/developer");
  if (!row) redirect("/onboarding/developer");

  return (
    <HomeShell
      eyebrow="Developer"
      title="Build with Thesma"
      copy="Use Thesma's verification, receipts and payout infrastructure in your own product."
      homeHref="/build"
    >
      {row?.project && (
        <p style={{ marginTop: 4, fontSize: 13.5, color: "var(--ink-2)" }}>
          You&apos;re building: {row.project}
        </p>
      )}
      <div className={styles.steps} style={{ marginTop: 18 }}>
        {STEPS.map((s) => (
          <div key={s.n} className={styles.step}>
            <span className={styles.stepNum}>{s.n}</span>
            <div>
              <h3>
                {s.title} · <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>{s.status}</span>
              </h3>
              <p>{s.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className={styles.homeGrid}>
        <section className={styles.panel}>
          <h2>API keys &amp; webhooks</h2>
          <p>Not issued yet. Keys, test events and webhook deliveries arrive with the developer preview.</p>
          <div className={styles.panelEmpty}>No API keys on your account. This section will list them when the preview opens.</div>
        </section>
        <section className={styles.panel}>
          <h2>See the infrastructure working</h2>
          <p>Verification, holds, payouts and receipts are already running on public markets — inspect real proof today.</p>
          <div className={styles.panelActions}>
            <Link href="/markets" className="btn btn-primary btn-sm">
              Inspect live markets
            </Link>
            <Link href="/markets#completed" className="btn btn-sm">
              View receipts
            </Link>
          </div>
        </section>
      </div>
    </HomeShell>
  );
}
