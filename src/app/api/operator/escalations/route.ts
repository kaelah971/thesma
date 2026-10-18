import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { payoutWorkerDepsOr503 } from "@/server/api/campaignDeps";
import { getDb } from "@/server/db/client";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import {
  decideEscalation,
  DEFAULT_OPERATOR_POLICY,
  executeApprovedObligation,
  getOperatorPolicy,
  recordOperatorDecision,
} from "@/server/services/operator";

const escalationSchema = z.object({
  workspaceId: z.string().min(1),
  escalationId: z.string().min(1),
  outcomeId: z.string().min(1).optional(),
  approved: z.boolean(),
});

/**
 * POST /api/operator/escalations — human verdict (owner only). Approvals
 * append a USER row (history preserved) and approved obligations still
 * execute through full settlement validation.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = escalationSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid escalation verdict");
    const { workspaceId, escalationId, outcomeId, approved } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const db = getDb();
    await decideEscalation(db, { escalationId, workspaceId, decidedByUserId: user.userId, approved });
    if (approved && outcomeId) {
      const worker = payoutWorkerDepsOr503();
      if ("response" in worker) return worker.response;
      const execution = await executeApprovedObligation(worker.deps, outcomeId);
      await recordOperatorDecision(db, workspaceId, {
        decision: {
          decision: "PAY_NOW",
          outcomeId,
          amountMicroUsdc: "0",
          reason: `Human-approved escalation ${escalationId}; settlement validators re-ran.`,
          rule: "HUMAN_APPROVED",
          liquidityBeforeMicroUsdc: "0",
          liquidityAfterMicroUsdc: "0",
          autonomous: false,
        },
        campaignId: null,
        partnerId: null,
        plannerRationale: null,
        policy: (await getOperatorPolicy(workspaceId).catch(() => null)) ?? {
          minReserveMicroUsdc: DEFAULT_OPERATOR_POLICY.minReserveMicroUsdc,
          maxAutonomousPaymentMicroUsdc: DEFAULT_OPERATOR_POLICY.maxAutonomousPaymentMicroUsdc,
          maxAutonomousSpendPerPeriodMicroUsdc: DEFAULT_OPERATOR_POLICY.maxAutonomousSpendPerPeriodMicroUsdc,
        },
        execution: {
          status: execution.executed ? "EXECUTED" : "SKIPPED",
          payoutId: execution.payoutId,
          txHash: execution.txHash,
          settled: execution.settled,
          reason: execution.reason,
        },
        escalationId,
      });
      return Response.json({ approved: true, execution });
    }
    return Response.json({ approved });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
