import { requireUser } from "@/server/auth/guard";
import { fundingDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { companyWalletProveRequestSchema } from "@/server/domain/funding";
import { proveCompanyWalletChallenge } from "@/server/services/fundings";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = fundingDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = companyWalletProveRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid proof request", parsed.error.flatten());
    const proof = await proveCompanyWalletChallenge(wired.deps, {
      workspaceId: id,
      userId: user.userId,
      nonce: parsed.data.nonce,
      signature: parsed.data.signature,
    });
    return Response.json({ provedWallet: proof.provedWallet, typedDataHash: proof.typedDataHash });
  } catch (err) {
    return toApiError(err);
  }
}
