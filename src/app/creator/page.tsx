import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { HomeShell } from "@/components/start/HomeShell";
import { CreatorCampaignActions } from "@/components/start/CreatorCampaignActions";
import { CreatorPreferencesForm, RunScoutButton } from "@/components/start/CreatorPreferencesForm";
import { AutoJoinToggle } from "@/components/start/AutoJoinToggle";
import { CreatorAutonomyPanel } from "@/components/start/CreatorAutonomyPanel";
import { CreatorNotificationsPanel } from "@/components/start/CreatorNotificationsPanel";
import { OpportunityInbox } from "@/components/start/OpportunityInbox";
import { getSessionUser } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { outcomes, partnerTerms, payouts, referrals } from "@/server/db/schema";
import { getPartnerByUserId } from "@/server/services/partners";
import { getPersonaByUserId } from "@/server/services/personas";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { loadScoutAuthority, loadScoutSnapshot, type AutoJoinVerdict } from "@/server/services/scout";
import { getPartnerRules } from "@/server/services/markets";
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
  const store = createDrizzleCampaignStore();
  const scout = await loadScoutSnapshot(store, user.userId).catch(() => null);
  const scoutCards = scout ? [...scout.plan.topOpportunities.slice(0, 3), ...scout.plan.watchlist.slice(0, 2)] : [];
  const liveOpenCount = await store
    .listMarkets()
    .then((ms) => ms.filter((m) => m.status === "OPEN").length)
    .catch(() => 0);
  const authority = scout
    ? await loadScoutAuthority(store, user.userId, scout.candidates).catch(() => null)
    : null;
  const rules = partner
    ? await getPartnerRules({ store, audit: async () => ({}) }, { userId: user.userId }).then((r) => r.rules).catch(() => null)
    : null;

  const authorityFor = (campaignId: string): { verdict: AutoJoinVerdict; rule: string; reason: string } | null =>
    authority?.byCampaign[campaignId] ?? null;

  return (
    <HomeShell
      eyebrow="Creator / KOL"
      title="Your creator home"
      copy={`Welcome${user.name ? `, ${user.name}` : ""} — live campaigns, your links, and earnings from verified outcomes.`}
      homeHref="/creator"
    >
      {row?.handle && (
        <span className={styles.handle}>
          @{row.handle} · <Link href={`/${row.handle}`}>View public profile →</Link>
        </span>
      )}
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
          <h2>Campaign Scout</h2>
          <p>Ranked by fit, evidence and economics — never by bounty alone, never by followers.</p>
          {rules && (
            <AutoJoinToggle
              initial={{
                autoJoin: rules.autoJoin,
                minimumBountyMicroUsdc: rules.minimumBountyMicroUsdc,
                allowedCategories: rules.allowedCategories,
                blockedCategories: rules.blockedCategories,
                minScoutConfidence: rules.minScoutConfidence as "HIGH" | "MEDIUM" | "LOW",
                maxActiveCampaigns: rules.maxActiveCampaigns,
                maxAutoJoinsPerDay: rules.maxAutoJoinsPerDay,
              }}
            />
          )}
          <CreatorAutonomyPanel />
          {scoutCards.length === 0 ? (
            <div className={styles.panelEmpty}>
              {!scout
                ? "Scout couldn't load right now. Try running it again below."
                : liveOpenCount === 0
                  ? "No live campaigns right now. Scout will check again automatically."
                  : "No campaigns match your current Scout rules."}
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 12 }}>
              {scoutCards.map((c) => (
                <li key={c.facts.campaignId} className={styles.panelEmpty} style={{ borderStyle: "solid" }}>
                  <strong style={{ display: "block", fontSize: 14 }}>
                    {c.facts.workspaceName} · {c.decision === "RECOMMEND" ? "Strong match" : c.decision === "WATCH" ? "Watch" : c.decision === "ALREADY_JOINED" ? "Joined" : "Skipped"}
                  </strong>
                  <span style={{ display: "block", fontSize: 13, marginTop: 2 }}>{c.facts.objective || "Outcome campaign"}</span>
                  <span className="tnum" style={{ display: "block", fontSize: 12.5, marginTop: 6, color: "var(--ink-2)" }}>
                    {formatUsdc(c.facts.bountyMicroUsdc)} USDC per verified outcome
                    {c.facts.deadline ? ` · ends ${formatDate(c.facts.deadline.toISOString())}` : ""}
                  </span>
                  <span style={{ display: "block", fontSize: 12.5, marginTop: 4, color: "var(--ink-2)" }}>{c.reason}</span>
                  <span style={{ display: "block", fontSize: 12, marginTop: 2, color: "var(--ink-2)" }}>
                    {c.confidence} confidence · score {c.score} · {c.evidenceUsed.join(", ")}
                  </span>
                  {c.earningsEstimateMicroUsdc ? (
                    <span className="tnum" style={{ display: "block", fontSize: 12, marginTop: 2, color: "var(--ink-2)" }}>
                      ESTIMATE {formatUsdc(c.earningsEstimateMicroUsdc.low)}–{formatUsdc(c.earningsEstimateMicroUsdc.high)} USDC
                    </span>
                  ) : (
                    <span style={{ display: "block", fontSize: 12, marginTop: 2, color: "var(--ink-2)" }}>{c.earningsNote}</span>
                  )}
                  {(() => {
                    const auth = authorityFor(c.facts.campaignId);
                    if (!auth) return null;
                    const label =
                      auth.verdict === "AUTO_JOIN"
                        ? "Auto-join eligible"
                        : auth.verdict === "RECOMMEND_ONLY"
                          ? "Recommend only"
                          : "Blocked by your rules";
                    return (
                      <span style={{ display: "block", fontSize: 12, marginTop: 2, color: "var(--ink-2)" }}>
                        {label} — {auth.reason}
                      </span>
                    );
                  })()}
                  <div className={styles.panelActions}>
                    <CreatorCampaignActions campaignId={c.facts.campaignId} initialReferralPath={c.facts.referralPath} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {scoutCards.length === 0 && scout && liveOpenCount > 0 && (
            <div className={styles.panelActions}>
              <Link href="#scout-rules" className="btn btn-sm">
                Edit Scout rules
              </Link>
              <Link href="/markets" className="btn btn-sm">
                Browse all live campaigns
              </Link>
            </div>
          )}
          <div className={styles.panelActions}>
            <Link href="/markets" className="btn btn-primary">
              Browse campaigns
            </Link>
            <RunScoutButton />
          </div>
          {scout && scout.plan.joined.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <span style={{ display: "block", fontSize: 12.5, color: "var(--ink-2)", marginBottom: 8 }}>
                Already joined — share these links:
              </span>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {scout.plan.joined.map((c) => (
                  <li key={c.facts.campaignId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <strong style={{ fontSize: 13 }}>{c.facts.workspaceName}</strong>
                    <CreatorCampaignActions campaignId={c.facts.campaignId} initialReferralPath={c.facts.referralPath} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        {rules && (
          <section className={styles.panel} id="scout-rules">
            <h2>Scout rules</h2>
            <p>Thesma can only join campaigns inside these rules.</p>
            <p className="tnum" style={{ fontSize: 13 }}>
              Auto-join: {rules.autoJoin ? "ON" : "OFF"} · Minimum bounty: {formatUsdc(rules.minimumBountyMicroUsdc)} USDC ·
              Confidence: {rules.minScoutConfidence} · Max active: {rules.maxActiveCampaigns ?? "—"} ·
              Max joins/day: {rules.maxAutoJoinsPerDay ?? "—"}
              {rules.allowedCategories.length > 0 ? ` · Categories: ${rules.allowedCategories.join(", ")}` : ""}
            </p>
            <CreatorPreferencesForm
              initial={{
                autoJoin: rules.autoJoin,
                minimumBountyMicroUsdc: rules.minimumBountyMicroUsdc,
                allowedCategories: rules.allowedCategories,
                blockedCategories: rules.blockedCategories,
                minScoutConfidence: rules.minScoutConfidence as "HIGH" | "MEDIUM" | "LOW",
                maxActiveCampaigns: rules.maxActiveCampaigns,
                maxAutoJoinsPerDay: rules.maxAutoJoinsPerDay,
              }}
            />
          </section>
        )}
      </div>
      <div className={styles.homeGrid} style={{ marginTop: 16 }}>
        <section className={styles.panel} id="opportunities">
          <h2>Opportunities</h2>
          <p>Direct invitations from organizations — frozen offers, decided by you. Accepting creates participation; declining changes nothing.</p>
          <OpportunityInbox />
        </section>
      </div>
      <div className={styles.homeGrid} style={{ marginTop: 16 }}>
        <section className={styles.panel}>
          <h2>Notifications &amp; Scout activity</h2>
          <p>Scout checks automatically each day. You can also run it anytime.</p>
          <CreatorNotificationsPanel />
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
