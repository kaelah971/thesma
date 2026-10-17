import { requireUser } from "@/server/auth/guard";
import { campaignDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { reviseDraftRequestSchema, serializeCampaign, serializePolicyVersion } from "@/server/domain/campaign";
import { reviseDraft } from "@/server/services/campaigns";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = campaignDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = reviseDraftRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid draft revision request", parsed.error.flatten());
    const result = await reviseDraft(wired.deps, {
      campaignId: id,
      userId: user.userId,
      expectedVersion: parsed.data.expectedVersion,
      patch: parsed.data.patch,
    });
    return Response.json({
      campaign: serializeCampaign(result.campaign),
      version: serializePolicyVersion(result.version),
      createdNewVersion: result.createdNewVersion,
    });
  } catch (err) {
    return toApiError(err);
  }
}
