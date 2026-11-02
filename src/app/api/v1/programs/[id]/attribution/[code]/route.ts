import { isDbConfigured } from "@/server/db/client";
import { toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; code: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const principal = await createProductionOutcomeApiService().authenticate(req);
    const { id, code } = await ctx.params;
    const configured = await createProductionGrowthProgramService().getProgram({ workspaceId: principal.workspaceId, id });
    if (configured.integration?.id !== principal.integration.id) return Response.json({ error: { code: "PROGRAM_INTEGRATION_MISMATCH", message: "This API key is not bound to the Growth Program." } }, { status: 403 });
    const attribution = await createProductionGrowthProgramParticipationService().resolveAttribution({ workspaceId: principal.workspaceId, growthProgramId: id, reference: decodeURIComponent(code) });
    return Response.json({ attribution });
  } catch (err) {
    return toApiError(err);
  }
}
