import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { runAgent } from "@/server/services/supplyAgent";

/** Explicit agent run: executes eligible auto-joins within stored rules. */
export async function POST() {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const result = await runAgent(wired.deps, { userId: user.userId });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
