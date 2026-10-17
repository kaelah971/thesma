import { requireUser } from "@/server/auth/guard";
import { campaignDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { listCampaignsQuerySchema, serializeCampaign } from "@/server/domain/campaign";
import { listWorkspaceCampaigns } from "@/server/services/campaigns";

export async function GET(req: Request) {
  try {
    const wired = campaignDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const parsed = listCampaignsQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!parsed.success) return badRequest("workspaceId query param is required", parsed.error.flatten());
    const result = await listWorkspaceCampaigns(wired.deps, {
      workspaceId: parsed.data.workspaceId,
      userId: user.userId,
    });
    return Response.json({ campaigns: result.campaigns.map(serializeCampaign) });
  } catch (err) {
    return toApiError(err);
  }
}
