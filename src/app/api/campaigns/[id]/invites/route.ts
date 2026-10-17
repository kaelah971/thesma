import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { createInviteRequestSchema } from "@/server/domain/market";
import { createInvite } from "@/server/services/markets";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = createInviteRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid invite request", parsed.error.flatten());
    const result = await createInvite(wired.deps, {
      campaignId: id,
      userId: user.userId,
      expiresAt: parsed.data.expiresAt,
      maxUses: parsed.data.maxUses,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
