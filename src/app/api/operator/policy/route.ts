import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { recordAuditEvent } from "@/server/services/audit";
import { setOperatorPolicy } from "@/server/services/operator";

const policySchema = z.object({
  workspaceId: z.string().min(1),
  minReserveMicroUsdc: z.string().regex(/^\d+$/),
  maxAutonomousPaymentMicroUsdc: z.string().regex(/^\d+$/),
  maxAutonomousSpendPerPeriodMicroUsdc: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional(),
});

/** PUT /api/operator/policy — human sets autonomous authority (owner only). */
export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    const parsed = policySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid policy");
    const { workspaceId, ...p } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    await setOperatorPolicy(
      workspaceId,
      {
        minReserveMicroUsdc: BigInt(p.minReserveMicroUsdc),
        maxAutonomousPaymentMicroUsdc: BigInt(p.maxAutonomousPaymentMicroUsdc),
        maxAutonomousSpendPerPeriodMicroUsdc: p.maxAutonomousSpendPerPeriodMicroUsdc ? BigInt(p.maxAutonomousSpendPerPeriodMicroUsdc) : null,
      },
      user.userId,
    );
    await recordAuditEvent(getDb(), {
      actorType: "USER",
      actorId: user.userId,
      workspaceId,
      action: "operator.policy.updated",
      metadata: { ...p },
    });
    return Response.json({ ok: true });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
