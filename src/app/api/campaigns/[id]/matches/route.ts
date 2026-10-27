import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { findCreatorMatches } from "@/server/services/matching";

/**
 * GET /api/campaigns/[id]/matches — ranked creator matches for an owned
 * campaign. Organization-authorized inside the service; the DTO carries
 * no private creator data.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const report = await findCreatorMatches(wired.deps, { callerUserId: user.userId, campaignId: id }, { allowPreview: true });
    return Response.json(report);
  } catch (err) {
    return toApiError(err);
  }
}

/** POST is not supported here — invitations live under /invitations. */
export async function POST() {
  return badRequest("Use POST /api/campaigns/[id]/invitations to invite");
}
