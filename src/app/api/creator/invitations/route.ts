import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { listCreatorOpportunities } from "@/server/services/invitations";

/**
 * GET /api/creator/invitations — the caller's own opportunity inbox.
 * Frozen economics + current campaign display context. Session-scoped.
 */
export async function GET() {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const opportunities = await listCreatorOpportunities(wired.deps, { creatorUserId: user.userId });
    return Response.json({ opportunities });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
