import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503, payoutWorkerDepsOr503 } from "@/server/api/campaignDeps";
import { getDb } from "@/server/db/client";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import {
  decideObligation,
  DEFAULT_OPERATOR_POLICY,
  executeOperatorDecision,
  getOperatorPolicy,
  HeuristicOperatorPlanner,
  listOperatorHistory,
  loadOperatorInput,
  recordEscalation,
  recordOperatorDecision,
  sumAutonomousSpentToday,
} from "@/server/services/operator";

const runSchema = z.object({ workspaceId: z.string().min(1) });

/**
 * POST /api/operator/run — one autonomous operator pass (owner only).
 * Planner nominates, deterministic validator disposes, PAY_NOW executes
 * through the existing payout workflow (testnet-guarded), over-authority
 * becomes a durable escalation. Every non-trivial decision is ledgered.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = runSchema.safeParse(body);
    if (!parsed.success) return badRequest("workspaceId is required");
    const { workspaceId } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
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
    let spentToday = sumAutonomousSpentToday(
      history.map((h) => ({ action: h.action, createdAt: h.createdAt, metadata: h.metadata })),
      now,
    );
    const planner = new HeuristicOperatorPlanner();
    const recommendation = await planner.plan(input.snapshot, policy);
    const db = getDb();
    const results = [];
    const eligible = input.snapshot.obligations
      .filter((o) => o.state === "ELIGIBLE")
      .sort((a, b) => (a.holdUntil?.getTime() ?? 0) - (b.holdUntil?.getTime() ?? 0))
      .slice(0, 10);

    // Planner-nominated candidate goes first; the validator still disposes all.
    eligible.sort((a, b) => (b.outcomeId === recommendation.outcomeId ? 1 : 0) - (a.outcomeId === recommendation.outcomeId ? 1 : 0));

    for (const o of eligible) {
      const decision = decideObligation(input.snapshot, o, policy, spentToday);
      if (decision.decision === "PAY_NOW") {
        const worker = payoutWorkerDepsOr503();
        if ("response" in worker) {
          await recordOperatorDecision(db, workspaceId, {
            decision,
            campaignId: o.campaignId,
            partnerId: o.partnerId,
            plannerRationale: recommendation.rationale,
            policy,
            execution: { status: "REFUSED", reason: "PAYOUT_WORKER_UNCONFIGURED" },
          });
          results.push({ outcomeId: o.outcomeId, decision: decision.decision, execution: { status: "REFUSED" } });
          continue;
        }
        const execution = await executeOperatorDecision(worker.deps, decision);
        if (execution.executed && decision.autonomous) spentToday += BigInt(decision.amountMicroUsdc);
        await recordOperatorDecision(db, workspaceId, {
          decision,
          campaignId: o.campaignId,
          partnerId: o.partnerId,
          plannerRationale: recommendation.rationale,
          policy,
          execution: {
            status: execution.executed ? "EXECUTED" : "SKIPPED",
            payoutId: execution.payoutId,
            txHash: execution.txHash,
            settled: execution.settled,
            reason: execution.reason,
          },
        });
        results.push({ outcomeId: o.outcomeId, decision: decision.decision, execution });
      } else if (decision.decision === "ESCALATE_APPROVAL") {
        const { escalationId } = await recordEscalation(db, workspaceId, {
          decision,
          campaignId: o.campaignId,
          partnerId: o.partnerId,
          plannerRationale: recommendation.rationale,
          policy,
          liquidityMicroUsdc: decision.liquidityBeforeMicroUsdc,
        });
        await recordOperatorDecision(db, workspaceId, {
          decision,
          campaignId: o.campaignId,
          partnerId: o.partnerId,
          plannerRationale: recommendation.rationale,
          policy,
          execution: { status: "ESCALATED" },
          escalationId,
        });
        results.push({ outcomeId: o.outcomeId, decision: decision.decision, escalationId });
      } else {
        await recordOperatorDecision(db, workspaceId, {
          decision,
          campaignId: o.campaignId,
          partnerId: o.partnerId,
          plannerRationale: recommendation.rationale,
          policy,
          execution: { status: "SKIPPED", reason: decision.decision },
        });
        results.push({ outcomeId: o.outcomeId, decision: decision.decision });
      }
    }
    return Response.json({ recommendation, results });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
