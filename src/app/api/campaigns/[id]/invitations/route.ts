import { z } from "zod";
import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { cancelInvitation, inviteCreators, listInvitations } from "@/server/services/invitations";

const inviteSchema = z.union([
  z.object({ creatorUserId: z.string().trim().min(1).max(100) }),
  z.object({ creatorUserIds: z.array(z.string().trim().min(1).max(100)).min(1).max(20) }),
]);

const cancelSchema = z.object({ invitationId: z.string().trim().min(1).max(100) });

/**
 * GET — invitation statuses for an owned campaign.
 * POST — invite one ({creatorUserId}) or many ({creatorUserIds}, max 20).
 *   Idempotent per (campaign, creator) while an INVITED row stands.
 * DELETE — cancel an invitation ({invitationId}); owning org only.
 * No invite path creates terms, referrals, payouts or notifications.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const invitations = await listInvitations(wired.deps, { callerUserId: user.userId, campaignId: id });
    return Response.json({ campaignId: id, invitations });
  } catch (err) {
    return toApiError(err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const parsed = inviteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid invite request", parsed.error.flatten());
    const body = parsed.data;
    const creatorUserIds = "creatorUserIds" in body ? [...new Set(body.creatorUserIds)] : [body.creatorUserId];
    const result = await inviteCreators(
      wired.deps,
      { callerUserId: user.userId, campaignId: id, creatorUserIds },
    );
    return Response.json(result, { status: result.invited > 0 ? 201 : 200 });
  } catch (err) {
    return toApiError(err);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    await ctx.params;
    const parsed = cancelSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid cancel request", parsed.error.flatten());
    const invitation = await cancelInvitation(wired.deps, {
      callerUserId: user.userId,
      invitationId: parsed.data.invitationId,
    });
    return Response.json({ invitation });
  } catch (err) {
    return toApiError(err);
  }
}
