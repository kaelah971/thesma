import { checkoutDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { requireInternalSecret } from "@/server/api/internalAuth";
import { verifyCheckoutIntent } from "@/server/services/checkout";

/**
 * Protected reconciliation trigger. Accepts no verification facts —
 * everything is read from Arc inside the service.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireInternalSecret(req);
    if (denied) return denied;
    const wired = checkoutDepsOr503();
    if ("response" in wired) return wired.response;
    const { id } = await ctx.params;
    const result = await verifyCheckoutIntent(wired.deps, { intentId: id });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
