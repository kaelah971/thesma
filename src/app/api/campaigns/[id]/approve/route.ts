import { requireUser } from "@/server/auth/guard";
import { campaignDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { expectedVersionSchema, serializeCampaign, serializePolicyVersion } from "@/server/domain/campaign";
import { approvePolicy } from "@/server/services/campaigns";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = campaignDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = expectedVersionSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("expectedVersion is required", parsed.error.flatten());
    const result = await approvePolicy(wired.deps, {
      campaignId: id,
      userId: user.userId,
      expectedVersion: parsed.data.expectedVersion,
    });
    return Response.json({
      campaign: serializeCampaign(result.campaign),
      version: serializePolicyVersion(result.version),
      alreadyApproved: result.alreadyApproved,
    });
  } catch (err) {
    return toApiError(err);
  }
}
