import { payoutWorkerDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { requireInternalSecret } from "@/server/api/internalAuth";
import { processPayoutsSchema } from "@/server/domain/payout";
import { processEligiblePayouts } from "@/server/services/payouts";

const WORKER_SECRETS = ["PAYOUT_WORKER_SECRET", "VERIFIER_INTERNAL_SECRET"];

/** Automatic payout worker trigger. No per-outcome approval; authority comes from funding. */
export async function POST(req: Request) {
  try {
    const denied = requireInternalSecret(req, WORKER_SECRETS);
    if (denied) return denied;
    const wired = payoutWorkerDepsOr503();
    if ("response" in wired) return wired.response;
    const body = await req.json().catch(() => ({}));
    const parsed = processPayoutsSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid worker request", parsed.error.flatten());
    const summary = await processEligiblePayouts(wired.deps, { limit: parsed.data.limit ?? 25 });
    return Response.json(summary);
  } catch (err) {
    return toApiError(err);
  }
}
