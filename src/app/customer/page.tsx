import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HomeShell } from "@/components/start/HomeShell";
import { getSessionUser } from "@/server/auth/guard";
import { getPersonaByUserId, personaFromEnum } from "@/server/services/personas";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = { title: "For you" };

export default async function CustomerHomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/customer");

  const row = await getPersonaByUserId(user.userId);
  const persona = row ? personaFromEnum(row.persona) : null;
  if (!row) redirect("/onboarding/customer");
  if (!row.onboardingCompletedAt) redirect("/onboarding/customer");
  if (persona && persona !== "customer") redirect("/welcome");

  return (
    <HomeShell
      eyebrow="Customer"
      title="For you"
      copy={`Welcome${user.name ? `, ${user.name}` : ""} — campaigns from creators you trust will appear here.`}
      homeHref="/customer"
    >
      <div className={styles.homeGrid}>
        <section className={styles.panel}>
          <h2>For you</h2>
          <p>Campaigns matched to the creators you follow. Nothing yet — discovery starts on the public market.</p>
          <div className={styles.panelEmpty}>No recommendations yet. Follow creators to shape this feed.</div>
          <div className={styles.panelActions}>
            <Link href="/markets" className="btn btn-primary btn-sm">
              Browse live markets
            </Link>
          </div>
        </section>
        <section className={styles.panel}>
          <h2>Creators you follow</h2>
          <p>People whose campaigns you track. Following opens with the creator marketplace next.</p>
          <div className={styles.panelEmpty}>You don&apos;t follow any creators yet.</div>
        </section>
      </div>
      <div className={styles.homeGrid}>
        <section className={styles.panel}>
          <h2>Your activity</h2>
          <p>Qualifying actions, verified outcomes and receipts — recorded only when they really happen.</p>
          <div className={styles.panelEmpty}>No activity yet. Your completed outcomes will show up here.</div>
        </section>
        <section className={styles.panel}>
          <h2>How it works</h2>
          <p>Shop through a creator&apos;s link. Thesma verifies the result before anything is paid — your proof stays public.</p>
          <div className={styles.panelActions}>
            <Link href="/markets#completed" className="btn btn-sm">
              See completed proof
            </Link>
          </div>
        </section>
      </div>
    </HomeShell>
  );
}
