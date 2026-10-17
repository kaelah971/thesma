import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { listPublicMarkets } from "@/server/services/markets";

/** Public discovery feed. No auth required; only PUBLIC + LIVE + OPEN + unexpired. */
export async function GET() {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const result = await listPublicMarkets(wired.deps);
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
