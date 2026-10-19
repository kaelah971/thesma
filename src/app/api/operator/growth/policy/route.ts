import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { recordAuditEvent } from "@/server/services/audit";
import { getDb } from "@/server/db/client";
import { setGrowthPolicy } from "@/server/services/growth";

const policySchema = z.object({
  workspaceId: z.string().min(1),
  optimizationEnabled: z.boolean(),
  maxBountyChangePct: z.number().int().min(1).max(100),
  minimumEvidence: z.number().int().min(0).max(1000),
  evaluationWindowDays: z.number().int().min(1).max(90),
});

/** PUT /api/operator/growth/policy — human sets growth authority (owner only). */
export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    const parsed = policySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("Invalid growth policy");
    const { workspaceId, ...p } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    await setGrowthPolicy(workspaceId, p, user.userId);
    await recordAuditEvent(getDb(), {
      actorType: "USER",
      actorId: user.userId,
      workspaceId,
      action: "operator.growth.policy.updated",
      metadata: { ...p },
    });
    return Response.json({ ok: true });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
