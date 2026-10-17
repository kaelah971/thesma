import { requireUser } from "@/server/auth/guard";
import { campaignDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { serializeCampaign, serializePolicyVersion } from "@/server/domain/campaign";
import { getCampaign } from "@/server/services/campaigns";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = campaignDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await getCampaign(wired.deps, { campaignId: id, userId: user.userId });
    return Response.json({
      campaign: serializeCampaign(result.campaign),
      version: serializePolicyVersion(result.version),
    });
  } catch (err) {
    return toApiError(err);
  }
}
