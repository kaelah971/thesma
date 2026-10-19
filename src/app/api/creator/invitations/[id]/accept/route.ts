import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { acceptInvitation } from "@/server/services/invitations";

/**
 * POST /api/creator/invitations/[id]/accept — accept own invitation.
 * Creates participation through the existing join path countersigned with
 * the invitation's frozen economics. Idempotent; no payout/reservation.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await acceptInvitation(wired.deps, { creatorUserId: user.userId, invitationId: id });
    return Response.json(result, { status: result.alreadyJoined ? 200 : 201 });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
