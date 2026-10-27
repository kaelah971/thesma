import { getMembership, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { buildCapitalPlan, loadCfoSnapshot } from "@/server/services/cfo";

/**
 * GET /api/operator/cfo?workspaceId= — organization CFO snapshot + capital plan.
 * Member-readable, read-only: aggregates real campaign truth, scores
 * capital, recommends (never executes). No audit writes on render.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) return badRequest("workspaceId is required");
    const membership = await getMembership(workspaceId, user.userId);
    if (!membership) return forbidden();
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const { snapshot, growthPolicy, operatorPolicy } = await loadCfoSnapshot(wired.deps.store, workspaceId);
    const plan = await buildCapitalPlan(snapshot, { store: wired.deps.store, growthPolicy, operatorPolicy });
    return Response.json({ plan });
  } catch (err) {
    return toApiError(err);
  }
}
