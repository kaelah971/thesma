import { requireUser } from "@/server/auth/guard";
import { fundingDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { resumeFundingIntent } from "@/server/services/fundings";

/**
 * GET resume: return the canonical REMAINING unsigned funding actions for an
 * in-flight (PREPARED/SUBMITTED) funding flow. Read-only: no new rows, no
 * binding changes, no hash clearing. Already-completed steps are omitted;
 * ambiguous/reverted recorded transactions fail closed (409).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = fundingDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const v = Number.parseInt(url.searchParams.get("expectedVersion") ?? "", 10);
    if (!Number.isInteger(v) || v < 1) return badRequest("expectedVersion query param is required");
    const result = await resumeFundingIntent(wired.deps, {
      campaignId: id,
      userId: user.userId,
      expectedVersion: v,
    });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
