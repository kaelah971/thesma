import { requireUser } from "@/server/auth/guard";
import { fundingDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { fundingConfirmRequestSchema } from "@/server/domain/funding";
import { confirmFunding } from "@/server/services/fundings";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = fundingDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = fundingConfirmRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid funding-confirm request", parsed.error.flatten());
    const result = await confirmFunding(wired.deps, {
      campaignId: id,
      userId: user.userId,
      expectedVersion: parsed.data.expectedVersion,
    });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
