import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HomeShell } from "@/components/start/HomeShell";
import { FollowButton } from "@/components/start/FollowButton";
import { getSessionUser } from "@/server/auth/guard";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import {
  createDrizzleFollowStore,
  getPublicCreatorProfile,
} from "@/server/services/creatorProfiles";
import { decodeHandleParam, normalizeHandle } from "@/server/services/personas";
import { formatUsdc } from "@/lib/format";
import styles from "@/components/start/start.module.css";

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  const normalized = normalizeHandle(decodeHandleParam(handle));
  if (!normalized) return { title: "Creator" };
  const profile = await getPublicCreatorProfile(normalized, {
    store: createDrizzleCampaignStore(),
    follows: createDrizzleFollowStore(),
  }).catch(() => null);
  if (!profile) return { title: "Creator not found" };
  return {
    title: `@${profile.handle}`,
    description: `${profile.displayName} — verified creator collaborations on Thesma.`,
  };
}

/**
 * GET /@handle — public proof-backed creator profile. No login required.
 * Proof above follower counts: verified outcomes, settled collaborations,
 * live campaigns, and completed history only.
 */
export default async function CreatorProfilePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const normalized = normalizeHandle(decodeHandleParam(handle));
  if (!normalized) notFound();
  const user = await getSessionUser().catch(() => null);
  const profile = await getPublicCreatorProfile(normalized, {
    store: createDrizzleCampaignStore(),
    follows: createDrizzleFollowStore(),
    viewerUserId: user?.userId ?? null,
  }).catch(() => null);
  if (!profile) notFound();
  const isSelf = Boolean(user && user.userId === profile.creatorUserId);

  return (
    <HomeShell
      eyebrow="Creator"
      title={`${profile.displayName} · @${profile.handle}`}
      copy={profile.bio ?? (profile.category ? `Creates about ${profile.category}.` : "Thesma creator.")}
      homeHref="/markets"
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 4 }}>
        {profile.category && <span className={styles.handle}>{profile.category}</span>}
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {profile.followerCount} follower{profile.followerCount === 1 ? "" : "s"}
        </span>
        {isSelf ? (
          <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
            This is your public profile · <Link href="/creator">Back to creator home</Link>
          </span>
        ) : (
          <FollowButton creatorHandle={profile.handle} initialFollowing={profile.isFollowing} signedIn={Boolean(user)} />
        )}
      </div>

      <div className={styles.kpis} style={{ marginTop: 18 }}>
        <div className={styles.kpi}>
          <span>Verified outcomes</span>
          <strong className="tnum">{profile.metrics.verifiedOutcomes}</strong>
          <small>Customer actions that passed verification</small>
        </div>
        <div className={styles.kpi}>
          <span>Settled collaborations</span>
          <strong className="tnum">{profile.metrics.settledCollaborations}</strong>
          <small>Campaigns with completed payment lifecycles</small>
        </div>
        <div className={styles.kpi}>
          <span>Active campaigns</span>
          <strong className="tnum">{profile.metrics.activeCampaigns}</strong>
          <small>Live right now</small>
        </div>
        <div className={styles.kpi}>
          <span>Campaigns with verified results</span>
          <strong className="tnum">{profile.metrics.campaignsWithVerified}</strong>
          <small>Proof across more than one campaign</small>
        </div>
        <div className={styles.kpi}>
          <span>D7 retained outcomes</span>
          <strong className="tnum">
            {profile.metrics.retention ? `${profile.metrics.retention.d7Qualified}/${profile.metrics.retention.d7Matured}` : "—"}
          </strong>
          <small>
            {profile.metrics.retention
              ? `Repeat verified action inside the D7 window${profile.metrics.retention.d7Rate !== null ? ` · ${profile.metrics.retention.d7Rate}%` : ""}`
              : "Not enough retention history yet."}
          </small>
        </div>
      </div>

      <div className={styles.homeGrid}>
        <section className={styles.panel}>
          <h2>Live with this creator</h2>
          {profile.live.length === 0 ? (
            <div className={styles.panelEmpty}>No live campaigns right now.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 12 }}>
              {profile.live.map((c) => (
                <li key={c.campaignId} className={styles.panelEmpty} style={{ borderStyle: "solid" }}>
                  <strong style={{ display: "block", fontSize: 14 }}>{c.workspaceName}</strong>
                  <span style={{ display: "block", fontSize: 13, marginTop: 2 }}>{c.objective || "Outcome campaign"}</span>
                  <span className="tnum" style={{ display: "block", fontSize: 12.5, marginTop: 6, color: "var(--ink-2)" }}>
                    {formatUsdc(c.publicBountyMicroUsdc)} USDC per verified outcome
                  </span>
                  <div className={styles.panelActions}>
                    <Link href={`/r/${c.referralCode}`} className="btn btn-primary btn-sm">
                      Shop through creator
                    </Link>
                    <Link href={`/markets/${c.campaignId}`} className="btn btn-sm">
                      View campaign
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={styles.panel}>
          <h2>Collaboration history</h2>
          {profile.history.length === 0 ? (
            <div className={styles.panelEmpty}>No completed collaborations with verified outcomes yet.</div>
          ) : (
            <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 12 }}>
              {profile.history.map((h) => (
                <li key={h.campaignId} className={styles.panelEmpty} style={{ borderStyle: "solid" }}>
                  <strong style={{ display: "block", fontSize: 14 }}>{h.workspaceName}</strong>
                  <span style={{ display: "block", fontSize: 13, marginTop: 2 }}>{h.objective || "Outcome campaign"}</span>
                  <span className="tnum" style={{ display: "block", fontSize: 12.5, marginTop: 6, color: "var(--ink-2)" }}>
                    {h.verifiedOutcomes} verified · {h.settledOutcomes} settled
                    {h.settledPayoutMicroUsdc !== "0" ? ` · ${formatUsdc(h.settledPayoutMicroUsdc)} USDC settled` : ""}
                  </span>
                  {h.proofPath && (
                    <div className={styles.panelActions}>
                      <Link href={h.proofPath} className="btn btn-sm">
                        View proof
                      </Link>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className={styles.panel} style={{ marginTop: 16 }}>
        <h2>Truth note</h2>
        <p>
          Verified outcomes are customer actions that passed campaign verification. Settled means the corresponding
          payment lifecycle completed. <strong>VERIFIED != PAID.</strong>
        </p>
      </div>
    </HomeShell>
  );
}
