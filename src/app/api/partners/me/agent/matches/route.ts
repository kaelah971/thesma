import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { findMatches } from "@/server/services/supplyAgent";

/** Ranked matching markets with fit explanations. Read-only. */
export async function GET() {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const result = await findMatches(wired.deps, { userId: user.userId });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
