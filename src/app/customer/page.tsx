import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { HomeShell } from "@/components/start/HomeShell";
import { getSessionUser } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { userPersonas, users } from "@/server/db/schema";
import { getPersonaByUserId, personaFromEnum } from "@/server/services/personas";
import { createDrizzleFollowStore } from "@/server/services/creatorProfiles";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { listCreatorLiveCampaigns } from "@/server/services/markets";
import { getPartnerByUserId } from "@/server/services/partners";
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

  const follows = createDrizzleFollowStore();
  const followedIds = await follows.followingList(user.userId).catch(() => []);
  const followed: { userId: string; name: string | null; handle: string | null; category: string | null; liveCount: number }[] = [];
  if (followedIds.length > 0) {
    const db = getDb();
    const [userRows, personaRows] = await Promise.all([
      db.select().from(users).where(inArray(users.id, followedIds)).catch(() => []),
      db.select().from(userPersonas).where(inArray(userPersonas.userId, followedIds)).catch(() => []),
    ]);
    const store = createDrizzleCampaignStore();
    for (const id of followedIds) {
      const u = userRows.find((r) => r.id === id);
      const p = personaRows.find((r) => r.userId === id);
      if (!u) continue;
      const partner = await getPartnerByUserId(id).catch(() => null);
      const live = partner
        ? await listCreatorLiveCampaigns({ store, audit: async () => ({}) }, { partnerId: partner.id }).then((r) => r.campaigns.length).catch(() => 0)
        : 0;
      followed.push({ userId: id, name: u.name, handle: p?.handle ?? null, category: p?.category ?? null, liveCount: live });
    }
  }

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
          <h2>Following</h2>
          <p>Creators you follow — with their live campaigns where factual.</p>
          {followed.length === 0 ? (
            <div className={styles.panelEmpty}>You don&apos;t follow any creators yet.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 8 }}>
              {followed.map((c) => (
                <li key={c.userId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>
                    {c.name ?? (c.handle ? `@${c.handle}` : "Creator")}
                    {c.category ? <span style={{ fontWeight: 400, color: "var(--ink-2)" }}> · {c.category}</span> : null}
                  </strong>
                  <span className="tnum" style={{ fontSize: 12, color: "var(--ink-2)" }}>
                    {c.liveCount} live campaign{c.liveCount === 1 ? "" : "s"}
                  </span>
                  {c.handle && (
                    <Link href={`/${c.handle}`} className="btn btn-sm">
                      View profile
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
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
