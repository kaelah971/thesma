import { payoutWorkerDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { requireInternalSecret } from "@/server/api/internalAuth";
import { processPayoutsSchema } from "@/server/domain/payout";
import { processEligiblePayouts } from "@/server/services/payouts";

const WORKER_SECRETS = ["PAYOUT_WORKER_SECRET", "VERIFIER_INTERNAL_SECRET"];
// Vercel Cron calls this route with GET + `Authorization: Bearer <CRON_SECRET>`.
const CRON_SECRETS = ["CRON_SECRET", ...WORKER_SECRETS];
const DEFAULT_LIMIT = 25;

/** Single shared entry into the existing worker. No payout logic lives here. */
async function runWorker(limit: number) {
  const wired = payoutWorkerDepsOr503();
  if ("response" in wired) return wired.response;
  const summary = await processEligiblePayouts(wired.deps, { limit });
  return Response.json(summary);
}

/** Automatic payout worker trigger. No per-outcome approval; authority comes from funding. */
export async function POST(req: Request) {
  try {
    const denied = requireInternalSecret(req, WORKER_SECRETS);
    if (denied) return denied;
    const body = await req.json().catch(() => ({}));
    const parsed = processPayoutsSchema.safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid worker request", parsed.error.flatten());
    return runWorker(parsed.data.limit ?? DEFAULT_LIMIT);
  } catch (err) {
    return toApiError(err);
  }
}

/** Production scheduler adapter (Vercel Cron, GET). Same worker, same guarantees. */
export async function GET(req: Request) {
  try {
    const denied = requireInternalSecret(req, CRON_SECRETS);
    if (denied) return denied;
    return runWorker(DEFAULT_LIMIT);
  } catch (err) {
    return toApiError(err);
  }
}
