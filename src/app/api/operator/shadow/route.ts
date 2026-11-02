import { getMembership, requireUser } from "@/server/auth/guard";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { getOrganizationOperatorMode } from "@/server/services/operatorMode";
import { listShadowDecisions, summarizeShadowTelemetry } from "@/server/services/shadowOperator";

/** GET /api/operator/shadow?workspaceId= — read-only Shadow Operator feed and telemetry. */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) return badRequest("workspaceId is required");
    const membership = await getMembership(workspaceId, user.userId);
    if (!membership) return forbidden();
    const mode = await getOrganizationOperatorMode(workspaceId);
    const decisions = await listShadowDecisions(workspaceId);
    return Response.json(
      { mode, decisions, telemetry: summarizeShadowTelemetry(decisions) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toApiError(err);
  }
}
