import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { isDbConfigured } from "@/server/db/client";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { resolveReferral } from "@/server/services/markets";
import { mintAttributionSession } from "@/server/services/checkout";
import { assertSafeDestinationUrl, REFERRAL_EVENT_CLICK } from "@/server/domain/market";
import {
  ATTRIBUTION_COOKIE_NAME,
  attributionSecretFromEnv,
  signAttribution,
} from "@/server/attribution/tokens";
import { toApiError, unconfigured } from "@/server/api/errors";
import { newId } from "@/server/auth/session";

/**
 * GET /r/:code — referral redirect + first-party attribution.
 * Records a CLICK (no money moves), mints a signed attribution cookie when
 * the market is still attributable, appends a portable opaque handle
 * (?thesma_attribution=...) for external/hosted checkout, and redirects to
 * the stored destination. Unknown codes 404; the destination always comes
 * from storage, never input. The handle carries nothing sensitive.
 */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const secret = attributionSecretFromEnv();
    const { code } = await ctx.params;
    const store = createDrizzleCampaignStore();
    const now = new Date();
    const resolved = await resolveReferral({ store, audit: async () => ({}) }, { code });

    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    const ua = req.headers.get("user-agent") ?? "";
    const visitorHash =
      forwarded || ua
        ? createHash("sha256")
            .update(`${forwarded}|${ua}|${now.toISOString().slice(0, 10)}`, "utf8")
            .digest("hex")
        : null;
    await store.insertReferralEvent({
      id: newId(),
      referralId: resolved.referral.id,
      eventType: REFERRAL_EVENT_CLICK,
      anonymousVisitorHash: visitorHash,
      metadata: { attributable: resolved.attributable },
    });

    let destination = assertSafeDestinationUrl(resolved.destinationUrl, {
      allowLocalhost: process.env.NODE_ENV !== "production",
    });
    if (resolved.attributable) {
      try {
        const session = await mintAttributionSession(
          { store, audit: async () => ({}) },
          {
            referralId: resolved.referral.id,
            campaignId: resolved.campaignId,
            partnerId: resolved.partnerId,
            partnerTermsId: resolved.terms.id,
            expiresAt: new Date(
              Math.min(new Date(resolved.terms.expiresAt).getTime(), now.getTime() + 24 * 60 * 60 * 1000),
            ),
          },
        );
        const url = new URL(destination);
        url.searchParams.set("thesma_attribution", session.handle);
        destination = url.toString();
      } catch {
        // Portable handle is best-effort: the signed cookie path still works.
      }
    }
    const res = NextResponse.redirect(destination, 302);
    if (resolved.attributable) {
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
      res.cookies.set(ATTRIBUTION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: Math.max(60, Math.floor((exp - now.getTime()) / 1000)),
      });
    }
    return res;
  } catch (err) {
    return toApiError(err);
  }
}
