import { z } from "zod";
import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { cancelInvitation, inviteCreators, listInvitations } from "@/server/services/invitations";

const dealSchema = z.object({
  structure: z.enum(["PERFORMANCE_ONLY", "BASE_PLUS_PERFORMANCE", "MILESTONE_PLUS_PERFORMANCE", "HYBRID_FULL"]),
  baseAmountMicroUsdc: z.string().regex(/^[0-9]+$/).optional(),
  deliverable: z.object({ kind: z.string().trim().min(1).max(60), title: z.string().trim().min(1).max(120) }).optional(),
  performanceBountyMicroUsdc: z.string().regex(/^[0-9]+$/).optional(),
  milestones: z.array(z.object({ threshold: z.number().int().positive(), amountMicroUsdc: z.string().regex(/^[0-9]+$/) })).max(5).optional(),
  allocationCount: z.number().int().positive().nullable().optional(),
});

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
    const raw = await req.json().catch(() => null);
    const parsed = inviteSchema.safeParse(raw);
    if (!parsed.success) return badRequest("Invalid invite request", parsed.error.flatten());
    const body = parsed.data;
    // Optional hybrid economics: strictly validated + capacity-gated downstream;
    // malformed deal payloads are rejected here, never defaulted.
    let deal: z.infer<typeof dealSchema> | undefined;
    if (raw !== null && typeof raw === "object" && "deal" in (raw as Record<string, unknown>)) {
      const dealParsed = dealSchema.safeParse((raw as Record<string, unknown>).deal);
      if (!dealParsed.success) return badRequest("Invalid hybrid deal", dealParsed.error.flatten());
      deal = dealParsed.data;
    }
    const creatorUserIds = "creatorUserIds" in body ? [...new Set(body.creatorUserIds)] : [body.creatorUserId];
    const result = await inviteCreators(
      wired.deps,
      { callerUserId: user.userId, campaignId: id, creatorUserIds },
      deal !== undefined ? { deal } : undefined,
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
