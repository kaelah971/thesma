import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { confirmOnboarding } from "@/server/services/supplyAgent";

/** Explicit confirmation only. Chat drafts never become active on their own. */
export async function POST(req: Request) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const result = await confirmOnboarding(wired.deps, {
      userId: user.userId,
      rules: (body?.rules ?? {}) as Record<string, unknown>,
      confirmed: body?.confirmed,
    });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
