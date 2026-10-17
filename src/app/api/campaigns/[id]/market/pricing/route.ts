import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { getMarketPricingState } from "@/server/services/pricing";

/** Read model: current price, live pace, last decision, cooldown state. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    await requireUser();
    const { id } = await ctx.params;
    const result = await getMarketPricingState(wired.deps, { campaignId: id });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
