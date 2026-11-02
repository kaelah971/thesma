import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; participantId: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const { id, participantId } = await ctx.params;
    const projectId = new URL(req.url).searchParams.get("projectId");
    const authorization = req.headers.get("authorization");
    let workspaceId: string;
    if (authorization) {
      const principal = await createProductionOutcomeApiService().authenticate(req);
      const program = await createProductionGrowthProgramService().getProgram({ workspaceId: principal.workspaceId, id });
      if (program.integration?.id !== principal.integration.id) throw Object.assign(new Error("This API key is not bound to the Growth Program."), { status: 403, code: "PROGRAM_INTEGRATION_MISMATCH" });
      workspaceId = principal.workspaceId;
    } else {
      if (!projectId) return badRequest("projectId is required");
      const user = await requireUser();
      await requireOwner(projectId, user.userId);
      workspaceId = projectId;
    }
    const participant = await createProductionGrowthProgramParticipationService().getParticipant({ workspaceId, growthProgramId: id, participantId });
    return Response.json({ participant });
  } catch (err) {
    return toApiError(err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string; participantId: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body.action !== "string") return badRequest("action is required");
    const { id, participantId } = await ctx.params;
    const projectId = typeof body.projectId === "string" ? body.projectId : new URL(req.url).searchParams.get("projectId");
    const authorization = req.headers.get("authorization");
    let workspaceId: string;
    let actorId: string | null;
    if (authorization) {
      const principal = await createProductionOutcomeApiService().authenticate(req);
      const program = await createProductionGrowthProgramService().getProgram({ workspaceId: principal.workspaceId, id });
      if (program.integration?.id !== principal.integration.id) throw Object.assign(new Error("This API key is not bound to the Growth Program."), { status: 403, code: "PROGRAM_INTEGRATION_MISMATCH" });
      workspaceId = principal.workspaceId;
      actorId = null;
    } else {
      if (!projectId) return badRequest("projectId is required");
      const user = await requireUser();
      await requireOwner(projectId, user.userId);
      workspaceId = projectId;
      actorId = user.userId;
    }
    const action = body.action.toUpperCase();
    if (!["APPROVE", "PAUSE", "REMOVE", "DECLINE"].includes(action)) return badRequest("action must be APPROVE, PAUSE, REMOVE or DECLINE");
    const participant = await createProductionGrowthProgramParticipationService().transitionParticipant({ workspaceId, growthProgramId: id, participantId, action: action as "APPROVE" | "PAUSE" | "REMOVE" | "DECLINE", actorId });
    return Response.json({ participant });
  } catch (err) {
    return toApiError(err);
  }
}
