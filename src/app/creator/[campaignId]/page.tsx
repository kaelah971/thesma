import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { HomeShell } from "@/components/start/HomeShell";
import { CopyReferralLink } from "@/components/start/CreatorCampaignActions";
import { getSessionUser } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { outcomes, payouts, referralEvents, referrals } from "@/server/db/schema";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { getPartnerByUserId } from "@/server/services/partners";
import { getPersonaByUserId } from "@/server/services/personas";
import { summarizeFunnel } from "@/server/services/markets";
import { formatUsdc } from "@/lib/format";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = { title: "Campaign workspace" };

/**
 * Creator campaign workspace: the stable referral link plus the real funnel.
 * Every number comes from recorded rows (referral_events → outcomes →
 * payouts). Stages with no data show 0 honestly — never fabricated.
 */
export default async function CreatorCampaignPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=/creator/${campaignId}`);

  const row = await getPersonaByUserId(user.userId);
  if (!row?.onboardingCompletedAt) redirect("/onboarding/creator");
  const partner = await getPartnerByUserId(user.userId).catch(() => null);
  if (!partner) redirect("/creator");

  const store = createDrizzleCampaignStore();
  const [campaign, terms] = await Promise.all([
    store.getCampaign(campaignId).catch(() => null),
    store.getTerms(campaignId, partner.id).catch(() => null),
  ]);
  if (!campaign || !terms || terms.status !== "ACTIVE") redirect("/creator");
  const [referral, workspace, version] = await Promise.all([
    store.getReferralByTerms(terms.id).catch(() => null),
    store.getWorkspace(campaign.workspaceId).catch(() => null),
    store.getVersion(campaignId, terms.policyVersion).catch(() => null),
  ]);
  if (!referral) redirect("/creator");

  const db = getDb();
  const [clickRows, outcomeRows, payoutRows] = await Promise.all([
    db
      .select({ id: referralEvents.id })
      .from(referralEvents)
      .where(and(eq(referralEvents.referralId, referral.id), eq(referralEvents.eventType, "CLICK")))
      .catch(() => []),
    db
      .select({ status: outcomes.status, holdUntil: outcomes.holdUntil })
      .from(outcomes)
      .where(and(eq(outcomes.campaignId, campaignId), eq(outcomes.partnerId, partner.id)))
      .catch(() => []),
    db
      .select({ amount: payouts.amountMicroUsdc, state: payouts.state })
      .from(payouts)
      .where(and(eq(payouts.campaignId, campaignId), eq(payouts.partnerId, partner.id)))
      .catch(() => []),
  ]);
  const funnel = summarizeFunnel(
    {
      clicks: clickRows.length,
      outcomes: outcomeRows.map((o) => ({ status: o.status, holdUntil: o.holdUntil })),
      settledPayoutMicroUsdc: payoutRows.filter((p) => p.state === "SETTLED").map((p) => p.amount),
    },
    new Date(),
  );

  return (
    <HomeShell
      eyebrow={`Creator / KOL · ${workspace?.name ?? "Campaign"}`}
      title={version?.intentText || "Campaign workspace"}
      copy="Your link, your visits, and every verified result attributed to you."
      homeHref="/creator"
    >
      <div className={styles.kpis} style={{ marginTop: 18 }}>
        <div className={styles.kpi}>
          <span>Clicks</span>
          <strong className="tnum">{funnel.clicks}</strong>
          <small>Recorded visits, not outcomes</small>
        </div>
        <div className={styles.kpi}>
          <span>Verified · In hold</span>
          <strong className="tnum">
            {funnel.verified} · {funnel.inHold}
          </strong>
          <small>Evidence passed · waiting out hold</small>
        </div>
        <div className={styles.kpi}>
          <span>Settled earnings</span>
          <strong className="tnum">{formatUsdc(funnel.settledPayoutMicroUsdc)}</strong>
          <small>USDC reconciled onchain</small>
        </div>
      </div>
      <div className={styles.homeGrid}>
        <section className={styles.panel}>
          <h2>Referral link</h2>
          <p>Stable for this campaign — share it anywhere. Visits are counted, nothing else is inferred.</p>
          <div className={styles.panelActions}>
            <CopyReferralLink referralPath={`/r/${referral.code}`} />
            <Link href={`/r/${referral.code}`} className="btn btn-sm">
              Preview landing
            </Link>
          </div>
        </section>
        <section className={styles.panel}>
          <h2>Funnel</h2>
          <p>
            {funnel.clicks} visits · {funnel.conversions} recorded actions · {funnel.verified} verified ·{" "}
            {funnel.settledOutcomes} settled payouts.
          </p>
          {funnel.conversions === 0 && (
            <div className={styles.panelEmpty}>No customer actions attributed yet. Share your link to start.</div>
          )}
        </section>
      </div>
      <div className={styles.panelActions} style={{ marginTop: 18 }}>
        <Link href="/creator" className="btn btn-sm">
          Back to creator home
        </Link>
      </div>
    </HomeShell>
  );
}
