import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { declineInvitation } from "@/server/services/invitations";

/**
 * POST /api/creator/invitations/[id]/decline — decline own invitation.
 * INVITED → DECLINED. No participation, referral, or payout. Idempotent.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const invitation = await declineInvitation(wired.deps, { creatorUserId: user.userId, invitationId: id });
    return Response.json({ invitation });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
