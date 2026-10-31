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
      nonce: parsed.data.nonce,
      signature: parsed.data.signature,
      signingAccount: parsed.data.signingAccount,
      confirmChange: parsed.data.confirmChange,
    });
    return Response.json({ workspace: result.workspace });
  } catch (err) {
    // Scoped diagnostic passthrough: SIGNER_MISMATCH carries four PUBLIC
    // addresses (already owner-authenticated). All other errors keep the
    // default shape — unrelated details must not newly surface.
    if (err !== null && typeof err === "object" && (err as { code?: unknown }).code === "SIGNER_MISMATCH") {
      const e = err as { status?: unknown; message?: unknown; details?: unknown };
      const status = typeof e.status === "number" ? e.status : 403;
      return Response.json(
        { error: { code: "SIGNER_MISMATCH", message: typeof e.message === "string" ? e.message : "Signer mismatch", details: e.details ?? null } },
        { status },
      );
    }
    return toApiError(err);
  }
}
