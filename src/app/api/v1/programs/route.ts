import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionGrowthProgramService, type CreateGrowthProgramInput } from "@/server/services/growthPrograms";

export async function GET(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) return badRequest("projectId is required");
    const user = await requireUser();
    await requireOwner(projectId, user.userId);
    const programs = await createProductionGrowthProgramService().listPrograms(projectId);
    return Response.json({ programs });
  } catch (err) {
    return toApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return badRequest("Request body must be a JSON object");
    const projectId = body.projectId;
    if (typeof projectId !== "string" || !projectId) return badRequest("projectId is required");
    const user = await requireUser();
    await requireOwner(projectId, user.userId);
    const { projectId: _projectId, ...input } = body;
    const result = await createProductionGrowthProgramService().createProgram({
      ...(input as Partial<CreateGrowthProgramInput>),
      workspaceId: projectId,
      actorId: user.userId,
    } as CreateGrowthProgramInput);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
