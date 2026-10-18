import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { requireInternalSecret } from "@/server/api/internalAuth";
import { runSupplyAgentWorker } from "@/server/services/supplyAgent";

const WORKER_SECRETS = ["SUPPLY_AGENT_WORKER_SECRET"];
// Scheduler (Vercel Cron) calls this route with GET + `Authorization: Bearer <CRON_SECRET>`.
const CRON_SECRETS = ["CRON_SECRET", ...WORKER_SECRETS];

/** Single shared entry into the worker. No join logic lives here. */
async function runWorker() {
  const wired = marketDepsOr503();
  if ("response" in wired) return wired.response;
  const summary = await runSupplyAgentWorker(wired.deps);
  return Response.json(summary);
}

/** Background Supply Agent trigger. Authority comes from stored Partner rules. */
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
