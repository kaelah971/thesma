import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { joinCampaignRequestSchema } from "@/server/domain/market";
import { joinCampaign } from "@/server/services/markets";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = joinCampaignRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid join request", parsed.error.flatten());
    const result = await joinCampaign(wired.deps, {
      campaignId: id,
      userId: user.userId,
      allocationCount: parsed.data.allocationCount,
      expectedMarketVersion: parsed.data.expectedMarketVersion,
      inviteToken: parsed.data.inviteToken,
    });
    return Response.json(result, { status: result.alreadyJoined ? 200 : 201 });
  } catch (err) {
    return toApiError(err);
  }
}
