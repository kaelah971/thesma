import { isDbConfigured } from "@/server/db/client";
import { requireUser } from "@/server/auth/guard";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; participantId: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.projectId !== "string") return badRequest("projectId is required");
    const user = await requireUser();
    const { id, participantId } = await ctx.params;
    const participant = await createProductionGrowthProgramParticipationService().acceptCreatorInvitation({ workspaceId: body.projectId, growthProgramId: id, participantId, creatorUserId: user.userId });
    return Response.json({ participant });
  } catch (err) {
    return toApiError(err);
  }
}
