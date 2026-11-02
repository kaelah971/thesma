import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";

async function access(req: Request, programId: string, projectId: string | null, method: "read" | "write") {
  const outcomeApi = createProductionOutcomeApiService();
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const principal = await outcomeApi.authenticate(req);
    const program = await createProductionGrowthProgramService().getProgram({ workspaceId: principal.workspaceId, id: programId });
    if (program.integration?.id !== principal.integration.id) {
      throw Object.assign(new Error("This API key is not bound to the Growth Program."), { status: 403, code: "PROGRAM_INTEGRATION_MISMATCH" });
    }
    return { workspaceId: principal.workspaceId, actorId: null, method };
  }
  if (!projectId) throw Object.assign(new Error("projectId is required"), { status: 400, code: "INVALID_REQUEST" });
  const user = await requireUser();
  await requireOwner(projectId, user.userId);
  return { workspaceId: projectId, actorId: user.userId, method };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const { id } = await ctx.params;
    const projectId = new URL(req.url).searchParams.get("projectId");
    const auth = await access(req, id, projectId, "read");
    const service = createProductionGrowthProgramParticipationService();
    const [participants, analytics] = await Promise.all([
      service.listParticipants({ workspaceId: auth.workspaceId, growthProgramId: id }),
      service.getAnalytics({ workspaceId: auth.workspaceId, growthProgramId: id }),
    ]);
    return Response.json({ participants, analytics });
  } catch (err) {
    return toApiError(err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return badRequest("Request body must be a JSON object");
    const { id } = await ctx.params;
    const projectId = typeof body.projectId === "string" ? body.projectId : new URL(req.url).searchParams.get("projectId");
    const auth = await access(req, id, projectId, "write");
    const participant = await createProductionGrowthProgramParticipationService().createParticipant({
      workspaceId: auth.workspaceId,
      growthProgramId: id,
      actorId: auth.actorId,
      participantType: body.participantType,
      creatorUserId: body.creatorUserId,
      externalPartnerId: body.externalPartnerId,
      displayName: body.displayName,
      handle: body.handle,
      participationSource: body.participationSource,
      initialStatus: body.initialStatus,
    });
    return Response.json({ participant }, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
