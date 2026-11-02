import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { toApiError, unconfigured } from "@/server/api/errors";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: { code: "INVALID_REQUEST", message: "projectId is required" } }, { status: 400 });
    const user = await requireUser();
    await requireOwner(projectId, user.userId);
    const { id } = await ctx.params;
    const program = await createProductionGrowthProgramService().getProgram({ workspaceId: projectId, id });
    return Response.json({ program });
  } catch (err) {
    return toApiError(err);
  }
}
