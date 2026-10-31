import { requireUser } from "@/server/auth/guard";
import { fundingDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { companyWalletChallengeRequestSchema } from "@/server/domain/funding";
import { issueCompanyWalletChallenge } from "@/server/services/fundings";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = fundingDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await _req.json().catch(() => null);
    const parsed = companyWalletChallengeRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid challenge request", parsed.error.flatten());
    const challenge = await issueCompanyWalletChallenge(wired.deps, {
      workspaceId: id,
      userId: user.userId,
    });
    return Response.json({ challenge });
  } catch (err) {
    return toApiError(err);
  }
}
