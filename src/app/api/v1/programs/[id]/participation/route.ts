import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.participationStatus !== "string") return badRequest("participationStatus is required");
    const projectId = typeof body.projectId === "string" ? body.projectId : null;
    if (!projectId) return badRequest("projectId is required");
    const user = await requireUser();
    await requireOwner(projectId, user.userId);
    const { id } = await ctx.params;
    const participationStatus = body.participationStatus.toUpperCase();
    if (!["CLOSED", "INVITE_ONLY", "OPEN"].includes(participationStatus)) return badRequest("participationStatus must be CLOSED, INVITE_ONLY or OPEN");
    const program = await createProductionGrowthProgramParticipationService().setParticipationMode({ workspaceId: projectId, growthProgramId: id, participationStatus: participationStatus as "CLOSED" | "INVITE_ONLY" | "OPEN", actorId: user.userId });
    return Response.json({ program });
  } catch (err) {
    return toApiError(err);
  }
}
