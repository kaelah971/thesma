import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { partnerRulesWireSchema } from "@/server/domain/market";
import { getPartnerRules, updatePartnerRules } from "@/server/services/markets";

export async function GET() {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const result = await getPartnerRules(wired.deps, { userId: user.userId });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = partnerRulesWireSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid Partner rules", parsed.error.flatten());
    const result = await updatePartnerRules(wired.deps, { userId: user.userId, rules: body as Record<string, unknown> });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
