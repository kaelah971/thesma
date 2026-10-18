import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { HomeShell } from "@/components/start/HomeShell";
import { CreatorCampaignActions } from "@/components/start/CreatorCampaignActions";
import { getSessionUser } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { outcomes, partnerTerms, payouts, referrals } from "@/server/db/schema";
import { getPartnerByUserId } from "@/server/services/partners";
import { getPersonaByUserId } from "@/server/services/personas";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { listCreatorDiscovery } from "@/server/services/markets";
import { formatDate, formatUsdc } from "@/lib/format";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = { title: "Creator home" };

async function creatorStats(partnerId: string | null) {
  if (!partnerId) return { campaigns: 0, referrals: 0, verified: 0, settled: 0 };
  try {
    const db = getDb();
    const [terms, refs, verified, settled] = await Promise.all([
      db.select({ id: partnerTerms.id }).from(partnerTerms).where(eq(partnerTerms.partnerId, partnerId)),
      db.select({ id: referrals.id }).from(referrals).where(eq(referrals.partnerId, partnerId)),
      db
        .select({ id: outcomes.id })
        .from(outcomes)
        .where(and(eq(outcomes.partnerId, partnerId), eq(outcomes.status, "VERIFIED"))),
      db.select({ id: payouts.id }).from(payouts).where(and(eq(payouts.partnerId, partnerId), eq(payouts.state, "SETTLED"))),
    ]);
    return { campaigns: terms.length, referrals: refs.length, verified: verified.length, settled: settled.length };
  } catch {
    return { campaigns: 0, referrals: 0, verified: 0, settled: 0 };
  }
}

export default async function CreatorHomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/creator");

  const row = await getPersonaByUserId(user.userId);
  if (!row) redirect("/onboarding/creator");
  if (!row.onboardingCompletedAt) redirect("/onboarding/creator");

  const partner = await getPartnerByUserId(user.userId).catch(() => null);
  const stats = await creatorStats(partner?.id ?? null);
  const discovery = await listCreatorDiscovery(
    { store: createDrizzleCampaignStore(), audit: async () => ({}) },
    { userId: user.userId },
  ).catch(() => ({ campaigns: [] }));

  return (
    <HomeShell
      eyebrow="Creator / KOL"
      title="Your creator home"
      copy={`Welcome${user.name ? `, ${user.name}` : ""} — live campaigns, your links, and earnings from verified outcomes.`}
      homeHref="/creator"
    >
      {row?.handle && <span className={styles.handle}>@{row.handle} · reserved for your public profile</span>}
      {row?.category && (
        <p style={{ marginTop: 10, fontSize: 13.5, color: "var(--ink-2)" }}>
          {row.category}
          {row.bio ? ` · ${row.bio}` : ""}
        </p>
      )}
      <div className={styles.kpis} style={{ marginTop: 18 }}>
        <div className={styles.kpi}>
          <span>Your campaigns</span>
          <strong className="tnum">{stats.campaigns}</strong>
          <small>Joined campaigns with live terms</small>
        </div>
        <div className={styles.kpi}>
          <span>Referrals</span>
          <strong className="tnum">{stats.referrals}</strong>
          <small>Links customers used</small>
        </div>
        <div className={styles.kpi}>
          <span>Verified · Settled</span>
          <strong className="tnum">
            {stats.verified} · {stats.settled}
          </strong>
          <small>Verified outcomes · settled earnings</small>
        </div>
      </div>
      <div className={styles.homeGrid}>
        <section className={styles.panel}>
          <h2>Live for you</h2>
          <p>Public campaigns you can join. Terms are set per creator — nothing is joined silently.</p>
          {discovery.campaigns.length === 0 ? (
            <div className={styles.panelEmpty}>No live campaigns open right now. Check back soon.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 12 }}>
              {discovery.campaigns.map((c) => (
                <li key={c.campaignId} className={styles.panelEmpty} style={{ borderStyle: "solid" }}>
                  <strong style={{ display: "block", fontSize: 14 }}>{c.workspaceName}</strong>
                  <span style={{ display: "block", fontSize: 13, marginTop: 2 }}>{c.objective || "Outcome campaign"}</span>
                  <span className="tnum" style={{ display: "block", fontSize: 12.5, marginTop: 6, color: "var(--ink-2)" }}>
                    {formatUsdc(c.publicBountyMicroUsdc)} USDC per verified outcome
                    {c.deadline ? ` · ends ${formatDate(c.deadline)}` : ""}
                  </span>
                  <div className={styles.panelActions}>
                    <CreatorCampaignActions campaignId={c.campaignId} initialReferralPath={c.referralPath} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.panelActions}>
            <Link href="/markets" className="btn btn-sm">
              Discover live campaigns
            </Link>
          </div>
        </section>
        <section className={styles.panel}>
          <h2>Referrals &amp; earnings</h2>
          <p>Every number below comes from real referrals, verified outcomes and settled payouts. No placeholders.</p>
          {stats.referrals === 0 && stats.verified === 0 && (
            <div className={styles.panelEmpty}>No referrals or earnings yet. Share a campaign link to start.</div>
          )}
        </section>
      </div>
    </HomeShell>
  );
}
