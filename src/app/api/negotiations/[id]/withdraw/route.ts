import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { withdrawNegotiation } from "@/server/services/negotiations";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await withdrawNegotiation(wired.deps, { negotiationId: id, userId: user.userId });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
