import { z } from "zod";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { requireInternalSecret } from "@/server/api/internalAuth";
import { processPricingEvaluations } from "@/server/services/pricing";

const WORKER_SECRETS = ["PAYOUT_WORKER_SECRET", "VERIFIER_INTERNAL_SECRET"];

/** Demand-agent evaluation sweep. Duplicate-safe, isolated per market. */
export async function POST(req: Request) {
  try {
    const denied = requireInternalSecret(req, WORKER_SECRETS);
    if (denied) return denied;
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const body = await req.json().catch(() => ({}));
    const parsed = z
      .object({
        campaignIds: z.array(z.string().min(1).max(100)).max(100).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .safeParse(body ?? {});
    if (!parsed.success) return badRequest("Invalid pricing worker request", parsed.error.flatten());
    const summary = await processPricingEvaluations(wired.deps, {
      campaignIds: parsed.data.campaignIds,
      limit: parsed.data.limit ?? 25,
    });
    return Response.json(summary);
  } catch (err) {
    return toApiError(err);
  }
}
