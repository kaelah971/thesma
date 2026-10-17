import { requireUser } from "@/server/auth/guard";
import { fundingDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { companyWalletRequestSchema } from "@/server/domain/funding";
import { registerCompanyWallet } from "@/server/services/fundings";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = fundingDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = companyWalletRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid company wallet request", parsed.error.flatten());
    const result = await registerCompanyWallet(wired.deps, {
      workspaceId: id,
      userId: user.userId,
      address: parsed.data.address,
    });
    return Response.json({ workspace: result.workspace });
  } catch (err) {
    return toApiError(err);
  }
}
