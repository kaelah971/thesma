import { isDbConfigured } from "@/server/db/client";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.code !== "string") return badRequest("code is required");
    const principal = await createProductionOutcomeApiService().authenticate(req);
    const { id } = await ctx.params;
    const configured = await createProductionGrowthProgramService().getProgram({ workspaceId: principal.workspaceId, id });
    if (configured.integration?.id !== principal.integration.id) return Response.json({ error: { code: "PROGRAM_INTEGRATION_MISMATCH", message: "This API key is not bound to the Growth Program." } }, { status: 403 });
    const program = await createProductionGrowthProgramParticipationService().resolveAttribution({ workspaceId: principal.workspaceId, growthProgramId: id, reference: body.code });
    return Response.json({ attribution: program });
  } catch (err) {
    return toApiError(err);
  }
}
