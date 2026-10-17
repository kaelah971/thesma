import { payoutWorkerDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { requireInternalSecret } from "@/server/api/internalAuth";
import { reconcilePayout } from "@/server/services/payouts";

const WORKER_SECRETS = ["PAYOUT_WORKER_SECRET", "VERIFIER_INTERNAL_SECRET"];

/** Reconcile one payout against canonical chain evidence. Never resends. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const denied = requireInternalSecret(req, WORKER_SECRETS);
    if (denied) return denied;
    const wired = payoutWorkerDepsOr503();
    if ("response" in wired) return wired.response;
    const { id } = await ctx.params;
    const result = await reconcilePayout(wired.deps, { payoutId: id });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
