import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { evaluateVerificationCheck } from "@/server/services/verificationProcurement";

const evaluateSchema = z.object({
  workspaceId: z.string().min(1),
  campaignId: z.string().min(1),
  outcomeId: z.string().min(1).optional(),
  providerId: z.string().min(1).max(80).optional(),
  checkType: z.enum(["TRANSACTION_RISK", "ATTRIBUTION_INTEGRITY", "SUBJECT_DUPLICATION", "PAYMENT_REFERENCE_CHECK", "OUTCOME_ENRICHMENT"]).optional(),
});

/**
 * POST /api/operator/verification/evaluate — owner-triggered verification decision (Slice 8).
 * Evaluates Slice-7 quality state → procurement policy → BUY/REFUSE/ESCALATE/NO_CHECK.
 * Spending happens ONLY on BUY_CHECK with a configured provider (local-test in
 * this slice; real providers need configuration). Renders never spend.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = evaluateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("workspaceId and campaignId are required");
    const { workspaceId, campaignId, outcomeId, providerId, checkType } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const result = await evaluateVerificationCheck(wired.deps, { workspaceId, campaignId, outcomeId, providerId, checkType });
    return Response.json(result);
  } catch (err) {
    return toApiError(err);
  }
}
