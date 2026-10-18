import { checkoutDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { verifyCheckoutIntent } from "@/server/services/checkout";

/**
 * Public reconciliation trigger. Accepts no verification facts and performs
 * no signing: it only runs the existing deterministic verifier, which reads
 * Arc independently and is idempotent (already-verified returns as-is).
 * The service itself refuses intents with no submitted transaction, so this
 * endpoint can never verify an unpaid purchase.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = checkoutDepsOr503();
    if ("response" in wired) return wired.response;
    const { id } = await ctx.params;
    const result = await verifyCheckoutIntent(wired.deps, { intentId: id });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
