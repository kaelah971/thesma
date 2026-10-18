import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { getPublicMarketDetail } from "@/server/services/markets";

/** Judge-proof public market detail. No auth; PUBLIC campaigns only. */
export async function GET(_req: Request, ctx: { params: Promise<{ campaignId: string }> }) {
  try {
    const { campaignId } = await ctx.params;
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const result = await getPublicMarketDetail(wired.deps, {
      campaignId,
      explorerBaseUrl: process.env.ARC_EXPLORER_BASE_URL ?? null,
    });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
