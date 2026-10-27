import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { parsePartnerRules } from "@/server/domain/market";
import { buildCreatorAutonomy } from "@/server/services/autonomy";

/**
 * GET /api/creator/autonomy — the signed-in creator's own agent authority.
 * Derives strictly from their existing Scout rules. No financial data,
 * no organization policy, no other creator's state.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const profile = await wired.deps.store.getPartnerByUserId(user.userId).catch(() => null);
    const parsed = profile ? parsePartnerRules(profile.rulesJson) : null;
    const rules = parsed && parsed.ok ? parsed.rules : null;
    return Response.json(
      {
        authority: buildCreatorAutonomy(
          rules
            ? {
                autoJoin: rules.autoJoin,
                minimumBountyMicroUsdc: rules.minimumBountyMicroUsdc,
                minScoutConfidence: rules.minScoutConfidence,
                maxActiveCampaigns: rules.maxActiveCampaigns,
                maxAutoJoinsPerDay: rules.maxAutoJoinsPerDay,
                blockedCategories: rules.blockedCategories,
                allowedCategories: rules.allowedCategories,
              }
            : null,
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toApiError(err);
  }
}
