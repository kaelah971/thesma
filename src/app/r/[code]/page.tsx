import type { Metadata } from "next";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { getDb, isDbConfigured } from "@/server/db/client";
import { userPersonas, users } from "@/server/db/schema";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { resolveReferral } from "@/server/services/markets";
import { mintAttributionSession } from "@/server/services/checkout";
import { assertSafeDestinationUrl, REFERRAL_EVENT_CLICK } from "@/server/domain/market";
import {
  ATTRIBUTION_COOKIE_NAME,
  attributionSecretFromEnv,
  signAttribution,
} from "@/server/attribution/tokens";
import { newId } from "@/server/auth/session";
import { formatCalendarDate, formatUsdc } from "@/lib/format";
import { eq } from "drizzle-orm";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = { title: "Campaign" };

/**
 * GET /r/:code — customer campaign landing + first-party attribution.
 * Resolves participant + campaign, rejects invalid/inactive links with 404,
 * records a CLICK (analytics only — a click is never an outcome), mints a
 * signed attribution cookie (+ portable ?thesma_attribution= handle) when
 * the market is still attributable, and renders the campaign experience.
 * No login required. The outbound CTA always comes from storage, never input.
 */
export default async function ReferralLandingPage({ params }: { params: Promise<{ code: string }> }) {
  if (!isDbConfigured()) notFound();
  const secret = attributionSecretFromEnv();
  const { code } = await params;
  const store = createDrizzleCampaignStore();
  const deps = { store, audit: async () => ({}) } as const;
  const now = new Date();

  const resolved = await resolveReferral(deps, { code }).catch(() => null);
  if (!resolved) notFound();

  // Refresh guard: one counted visit per visitor per day. Repeat views still
  // render — they just don't inflate click analytics.
  const jar = await cookies();
  const seenCookie = `thesma_r_${code}`;
  const alreadySeen = jar.get(seenCookie)?.value === "1";
  const hdrs = await headers();
  const forwarded = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ua = hdrs.get("user-agent") ?? "";
  const visitorHash =
    forwarded || ua
      ? createHash("sha256")
          .update(`${forwarded}|${ua}|${now.toISOString().slice(0, 10)}`, "utf8")
          .digest("hex")
      : null;
  if (!alreadySeen) {
    await store
      .insertReferralEvent({
        id: newId(),
        referralId: resolved.referral.id,
        eventType: REFERRAL_EVENT_CLICK,
        anonymousVisitorHash: visitorHash,
        metadata: { attributable: resolved.attributable },
      })
      .catch(() => null);
    jar.set(seenCookie, "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 });
  }

  let destination = assertSafeDestinationUrl(resolved.destinationUrl, {
    allowLocalhost: process.env.NODE_ENV !== "production",
  });
  if (resolved.attributable) {
    try {
      const session = await mintAttributionSession(deps, {
        referralId: resolved.referral.id,
        campaignId: resolved.campaignId,
        partnerId: resolved.partnerId,
        partnerTermsId: resolved.terms.id,
        expiresAt: new Date(
          Math.min(new Date(resolved.terms.expiresAt).getTime(), now.getTime() + 24 * 60 * 60 * 1000),
        ),
      });
      const url = new URL(destination);
      url.searchParams.set("thesma_attribution", session.handle);
      destination = url.toString();
    } catch {
      // Portable handle is best-effort: the signed cookie path still works.
    }
    const exp = Math.min(
      new Date(resolved.terms.expiresAt).getTime(),
      now.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
    const token = signAttribution(
      {
        referralId: resolved.referral.id,
        campaignId: resolved.campaignId,
        partnerId: resolved.partnerId,
        exp,
      },
      secret,
    );
    jar.set(ATTRIBUTION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.max(60, Math.floor((exp - now.getTime()) / 1000)),
    });
  }

  // Display truth: campaign + organization + referring creator. No policy jargon.
  const [campaign, workspace, version] = await Promise.all([
    store.getCampaign(resolved.campaignId),
    store.getCampaign(resolved.campaignId).then((c) => (c ? store.getWorkspace(c.workspaceId) : null)),
    store.getVersion(resolved.campaignId, resolved.terms.policyVersion),
  ]);
  const partner = await store.getPartnerById(resolved.partnerId).catch(() => null);
  let creatorName: string | null = null;
  let creatorHandle: string | null = null;
  if (partner) {
    const db = getDb();
    const [u] = await db.select().from(users).where(eq(users.id, partner.userId)).limit(1).catch(() => []);
    const [persona] = await db
      .select()
      .from(userPersonas)
      .where(eq(userPersonas.userId, partner.userId))
      .limit(1)
      .catch(() => []);
    creatorName = u?.name ?? null;
    creatorHandle = persona?.handle ?? null;
  }
  const minPurchase = version?.minQualifyingPurchaseMicroUsdc ?? null;

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.topbar}>
          <Logo />
          <div className={styles.topbarRight}>
            <Link href="/markets">Live markets</Link>
          </div>
        </div>
        <div className={styles.hero} style={{ textAlign: "left", marginLeft: 0, marginRight: 0 }}>
          <span className={styles.eyebrow}>{workspace?.name ?? "Thesma campaign"}</span>
          <h1>{version?.intentText || "Campaign"}</h1>
          {(creatorName || creatorHandle) && (
            <p style={{ margin: 0 }}>
              Referred by{" "}
              {creatorHandle ? (
                <Link href={`/${creatorHandle}`} style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
                  @{creatorHandle}
                </Link>
              ) : (
                creatorName
              )}
              {creatorHandle && creatorName ? ` (${creatorName})` : ""}
            </p>
          )}
        </div>
        <div className={styles.homeGrid}>
          <section className={styles.panel}>
            <h2>What you get</h2>
            <p>
              {formatUsdc(resolved.market.publicBountyMicroUsdc.toString())} USDC funds this outcome once it is
              verified — the result, not the click, is what counts.
            </p>
            {minPurchase !== null && (
              <p>Purchases of at least {formatUsdc(minPurchase.toString())} USDC qualify for this campaign.</p>
            )}
            {version?.deadline && <p>Ends {formatCalendarDate(version.deadline.toISOString())}.</p>}
            {resolved.attributable ? (
              <div className={styles.panelActions}>
                <a href={destination} className="btn btn-primary">
                  Continue
                </a>
              </div>
            ) : (
              <div className={styles.panelEmpty}>This campaign is no longer live, so the action is closed.</div>
            )}
          </section>
          <section className={styles.panel}>
            <h2>How it works</h2>
            <p>
              Continue to {workspace?.name ?? "the organization"} and complete the action. Thesma verifies the
              result independently before anything is paid — your proof stays public.
            </p>
            <div className={styles.panelActions}>
              <Link href="/markets" className="btn btn-sm">
                Browse live markets
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
