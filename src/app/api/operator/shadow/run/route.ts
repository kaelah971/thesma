import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { getOrganizationOperatorMode } from "@/server/services/operatorMode";
import { runShadowOperator } from "@/server/services/shadowOperator";

const runSchema = z.object({
  workspaceId: z.string().min(1),
  includeSettlement: z.boolean().optional(),
  verificationChecks: z.array(z.object({
    campaignId: z.string().min(1),
    outcomeId: z.string().min(1).optional(),
    providerId: z.string().min(1).max(80).optional(),
    checkType: z.enum(["TRANSACTION_RISK", "ATTRIBUTION_INTEGRITY", "SUBJECT_DUPLICATION", "PAYMENT_REFERENCE_CHECK", "OUTCOME_ENRICHMENT"]).optional(),
    currentConfidenceBps: z.number().int().min(0).max(10_000).optional(),
    requiredConfidenceBps: z.number().int().min(0).max(10_000).optional(),
  })).max(20).optional(),
});

/** POST /api/operator/shadow/run — owner-only deterministic recommendations, never execution. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = runSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("workspaceId is required", parsed.error.flatten());
    const { workspaceId, verificationChecks, includeSettlement } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const mode = await getOrganizationOperatorMode(workspaceId);
    if (mode !== "SHADOW") {
      return Response.json({ error: "Enable SHADOW mode before running shadow recommendations.", code: "SHADOW_MODE_REQUIRED", mode }, { status: 409 });
    }
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const result = await runShadowOperator({
      store: wired.deps.store,
      audit: wired.deps.audit,
      workspaceId,
      verificationChecks,
      includeSettlement,
      verificationDeps: { env: process.env },
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toApiError(err);
  }
}
