import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const { id } = await ctx.params;
    const projectId = new URL(req.url).searchParams.get("projectId");
    const authorization = req.headers.get("authorization");
    let workspaceId: string;
    if (authorization) {
      const principal = await createProductionOutcomeApiService().authenticate(req);
      const program = await createProductionGrowthProgramService().getProgram({ workspaceId: principal.workspaceId, id });
      if (program.integration?.id !== principal.integration.id) throw Object.assign(new Error("This API key is not bound to the Growth Program."), { status: 403, code: "PROGRAM_INTEGRATION_MISMATCH" });
      workspaceId = principal.workspaceId;
    } else {
      if (!projectId) return Response.json({ error: { code: "INVALID_REQUEST", message: "projectId is required" } }, { status: 400 });
      const user = await requireUser();
      await requireOwner(projectId, user.userId);
      workspaceId = projectId;
    }
    const analytics = await createProductionGrowthProgramParticipationService().getAnalytics({ workspaceId, growthProgramId: id });
    return Response.json({ analytics });
  } catch (err) {
    return toApiError(err);
  }
}
