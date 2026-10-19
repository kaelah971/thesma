import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { requireInternalSecret } from "@/server/api/internalAuth";
import { runBackgroundScout } from "@/server/services/scout";

const WORKER_SECRETS = ["SCOUT_WORKER_SECRET"];
// Vercel Cron calls this route with GET + `Authorization: Bearer <CRON_SECRET>`.
const CRON_SECRETS = ["CRON_SECRET", ...WORKER_SECRETS];

/**
 * Background Creator Scout trigger. Same Scout snapshot, same creator
 * authority, same idempotent join path as manual Run Scout — the only
 * difference is no human click. One creator failure never aborts the batch.
 */
async function runWorker() {
  const wired = marketDepsOr503();
  if ("response" in wired) return wired.response;
  const summary = await runBackgroundScout(wired.deps);
  return Response.json(summary);
}

/** Operator/manual trigger with the worker secret. No facts accepted. */
export async function POST(req: Request) {
  try {
    const denied = requireInternalSecret(req, WORKER_SECRETS);
    if (denied) return denied;
    return runWorker();
  } catch (err) {
    return toApiError(err);
  }
}

/** Production scheduler adapter (Vercel Cron, GET). Same worker, same gates. */
export async function GET(req: Request) {
  try {
    const denied = requireInternalSecret(req, CRON_SECRETS);
    if (denied) return denied;
    return runWorker();
  } catch (err) {
    return toApiError(err);
  }
}
