import { requireUser } from "@/server/auth/guard";
import { fundingDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { fundingStatusQuerySchema } from "@/server/domain/funding";
import { getFundingStatus } from "@/server/services/fundings";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = fundingDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const parsed = fundingStatusQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!parsed.success) return badRequest("Invalid funding query", parsed.error.flatten());
    const result = await getFundingStatus(wired.deps, {
      campaignId: id,
      userId: user.userId,
      expectedVersion: parsed.data.expectedVersion,
    });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}

