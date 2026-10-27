import { getMembership, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { listCampaignProcurements } from "@/server/services/verificationProcurement";

/**
 * GET /api/operator/verification?workspaceId=&campaignId= — procurement ledger.
 * Member-readable, read-only: lists durable procurement records. Never spends.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const workspaceId = params.get("workspaceId");
    const campaignId = params.get("campaignId");
    if (!workspaceId || !campaignId) return badRequest("workspaceId and campaignId are required");
    const membership = await getMembership(workspaceId, user.userId);
    if (!membership) return forbidden();
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const procurements = await listCampaignProcurements(wired.deps.store, { workspaceId, campaignId });
    return Response.json({ procurements }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toApiError(err);
  }
}
