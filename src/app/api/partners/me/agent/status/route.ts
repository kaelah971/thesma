import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { getAgentStatus } from "@/server/services/supplyAgent";

/** Real automation state for the Partner dashboard. */
export async function GET() {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const result = await getAgentStatus(wired.deps, { userId: user.userId });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
