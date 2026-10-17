import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { getMarketState } from "@/server/services/markets";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const result = await getMarketState(wired.deps, { campaignId: id, userId: user.userId });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
