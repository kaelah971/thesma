import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { openMarketRequestSchema } from "@/server/domain/market";
import { openMarket } from "@/server/services/markets";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = openMarketRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid market-open request", parsed.error.flatten());
    const result = await openMarket(wired.deps, {
      campaignId: id,
      userId: user.userId,
      expectedPolicyVersion: parsed.data.expectedPolicyVersion,
      openingBountyMicroUsdc: parsed.data.openingBountyMicroUsdc,
      destinationUrl: parsed.data.destinationUrl,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
