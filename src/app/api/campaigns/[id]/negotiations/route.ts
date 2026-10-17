import { requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { proposeNegotiationSchema } from "@/server/domain/negotiation";
import { proposeNegotiation } from "@/server/services/negotiations";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = proposeNegotiationSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid negotiation proposal", parsed.error.flatten());
    const result = await proposeNegotiation(wired.deps, {
      campaignId: id,
      userId: user.userId,
      askMicroUsdc: parsed.data.askMicroUsdc,
      allocationCount: parsed.data.allocationCount,
      expiresAt: parsed.data.expiresAt,
    });
    return Response.json(result, { status: result.alreadyRecorded ? 200 : 201 });
  } catch (err) {
    return toApiError(err);
  }
}
