import { getMembership, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import {
  decideObligation,
  DEFAULT_OPERATOR_POLICY,
  getOperatorPolicy,
  HeuristicOperatorPlanner,
  listOperatorHistory,
  loadOperatorInput,
  OPERATOR_ESCALATION_ACTION,
  OPERATOR_ESCALATION_DECISION_ACTION,
  sumAutonomousSpentToday,
  summarizeOperatorMetrics,
} from "@/server/services/operator";

/**
 * GET /api/operator/snapshot?workspaceId= — operator briefing for one
 * organization. Member-readable. No execution: each eligible obligation
 * carries its deterministic preview decision.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) return badRequest("workspaceId is required");
    const membership = await getMembership(workspaceId, user.userId);
    if (!membership) return forbidden();
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;

    const policy = (await getOperatorPolicy(workspaceId).catch(() => null)) ?? {
      minReserveMicroUsdc: DEFAULT_OPERATOR_POLICY.minReserveMicroUsdc,
      maxAutonomousPaymentMicroUsdc: DEFAULT_OPERATOR_POLICY.maxAutonomousPaymentMicroUsdc,
      maxAutonomousSpendPerPeriodMicroUsdc: DEFAULT_OPERATOR_POLICY.maxAutonomousSpendPerPeriodMicroUsdc,
    };
    const now = new Date();
    const input = await loadOperatorInput(wired.deps.store, workspaceId, policy, now);
    const history = await listOperatorHistory(workspaceId).catch(() => []);
    const spentToday = sumAutonomousSpentToday(
      history.map((h) => ({ action: h.action, createdAt: h.createdAt, metadata: h.metadata })),
      now,
    );
    const planner = new HeuristicOperatorPlanner();
    const recommendation = await planner.plan(input.snapshot, policy);
    const decided = input.snapshot.obligations.map((o) => ({
      outcomeId: o.outcomeId,
      campaignId: o.campaignId,
      partnerId: o.partnerId,
      amountMicroUsdc: o.amountMicroUsdc.toString(),
      state: o.state,
      holdUntil: o.holdUntil?.toISOString() ?? null,
      recommended: recommendation.outcomeId === o.outcomeId,
      preview: decideObligation(input.snapshot, o, policy, spentToday),
    }));
    const decidedIds = new Set(
      history
        .filter((h) => h.action === OPERATOR_ESCALATION_DECISION_ACTION)
        .map((h) => (h.metadata.escalationId as string | undefined) ?? ""),
    );
    const pendingEscalations = history
      .filter((h) => h.action === OPERATOR_ESCALATION_ACTION)
      .filter((h) => !decidedIds.has((h.metadata.escalationId as string | undefined) ?? ""))
      .map((h) => ({ id: h.id, createdAt: h.createdAt.toISOString(), metadata: h.metadata }));

    return Response.json({
      policy: {
        minReserveMicroUsdc: policy.minReserveMicroUsdc.toString(),
        maxAutonomousPaymentMicroUsdc: policy.maxAutonomousPaymentMicroUsdc.toString(),
        maxAutonomousSpendPerPeriodMicroUsdc: policy.maxAutonomousSpendPerPeriodMicroUsdc?.toString() ?? null,
      },
      snapshot: { ...input.snapshot, obligations: decided },
      recommendation,
      metrics: summarizeOperatorMetrics(history.map((h) => ({ action: h.action, metadata: h.metadata }))),
      pendingEscalations,
      decisions: history
        .filter((h) => h.action.startsWith("operator."))
        .slice(0, 20)
        .map((h) => ({ id: h.id, action: h.action, createdAt: h.createdAt.toISOString(), metadata: h.metadata })),
    });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
