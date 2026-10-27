import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { verifyBaseDeliverable } from "@/server/services/deals";

/**
 * POST /api/deals/:id/verify-base — owner review of a base deliverable (Slice 6).
 * MANUAL_REVIEW_REQUIRED + PENDING only, idempotent. Records the obligation
 * as SETTLEMENT_NOT_SUPPORTED (payable, no onchain path) — never a payout.
 */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    if (!id) return badRequest("Deal id is required");
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const deal = await wired.deps.store.getHybridDeal(id).catch(() => null);
    if (!deal) return badRequest("Hybrid deal not found");
    const campaign = await wired.deps.store.getCampaign(deal.campaignId).catch(() => null);
    if (!campaign) return badRequest("Campaign not found");
    try {
      await requireOwner(campaign.workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const verified = await verifyBaseDeliverable(wired.deps.store, wired.deps.audit, {
      dealId: id,
      reviewerUserId: user.userId,
      workspaceId: campaign.workspaceId,
    });
    return Response.json({ deal: verified }, { status: 200 });
  } catch (err) {
    return toApiError(err);
  }
}
