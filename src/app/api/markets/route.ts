import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { listCompletedMarkets, listPublicMarkets } from "@/server/services/markets";

/**
 * Public discovery feed. No auth required; PUBLIC campaigns only.
 * ?status=live (default, unchanged) or ?status=completed (history/proof).
 */
export async function GET(req: Request) {
  try {
    const status = new URL(req.url).searchParams.get("status") ?? "live";
    if (status !== "live" && status !== "completed") {
      return badRequest("Invalid status filter", { allowed: ["live", "completed"] });
    }
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const result =
      status === "completed" ? await listCompletedMarkets(wired.deps) : await listPublicMarkets(wired.deps);
    return Response.json({ status, ...result });
  } catch (err) {
    return toApiError(err);
  }
}
