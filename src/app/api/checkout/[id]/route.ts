import { checkoutDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { submitCheckoutSchema } from "@/server/domain/checkout";
import { getCheckoutPublicState, submitCheckoutTx } from "@/server/services/checkout";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = checkoutDepsOr503();
    if ("response" in wired) return wired.response;
    const { id } = await ctx.params;
    const result = await getCheckoutPublicState(wired.deps, { intentId: id });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}

/** Customer supplies only a tx hash. Recorded, never trusted as success. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = checkoutDepsOr503();
    if ("response" in wired) return wired.response;
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = submitCheckoutSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid submission request", parsed.error.flatten());
    const result = await submitCheckoutTx(wired.deps, { intentId: id, txHash: parsed.data.txHash });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
