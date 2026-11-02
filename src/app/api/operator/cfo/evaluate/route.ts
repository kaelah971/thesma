import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { buildCapitalPlan, loadCfoSnapshot, recordCfoPlan } from "@/server/services/cfo";
import { loadOutcomePortfolioPlan, recordOutcomePortfolioDecision } from "@/server/services/outcomePortfolio";

const evaluateSchema = z.object({ workspaceId: z.string().min(1) });

/**
 * POST /api/operator/cfo/evaluate — one CFO pass (owner only).
 * Builds the org snapshot + capital plan and ledgers it
 * (cfo.plan.generated, cfo.campaign.decision, cfo.escalated).
 * RECOMMENDATIONS ONLY: no capital movement exists onchain to execute,
 * and bounty moves (if any) execute exclusively through the existing
 * growth evaluate endpoint. Every amount reconciles; residual stays
 * unallocated rather than forced.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = evaluateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("workspaceId is required");
    const { workspaceId } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const now = new Date();
    const { snapshot, growthPolicy, operatorPolicy } = await loadCfoSnapshot(wired.deps.store, workspaceId, { now });
    const plan = await buildCapitalPlan(snapshot, { store: wired.deps.store, growthPolicy, operatorPolicy, now });
    const portfolio = await loadOutcomePortfolioPlan(snapshot, { store: wired.deps.store, operatorPolicy, now });
    const planWithPortfolio = { ...plan, portfolio };
    await recordCfoPlan(wired.deps.audit, planWithPortfolio);
    await recordOutcomePortfolioDecision(wired.deps.audit, portfolio);
    return Response.json({
      plan: planWithPortfolio,
      execution: { executed: false, chainMovement: plan.chainMovement, note: "Allocations are prospective funding recommendations. No onchain movement primitive exists; nothing was moved, reserved, or paid." },
    });
  } catch (err) {
    return toApiError(err);
  }
}
