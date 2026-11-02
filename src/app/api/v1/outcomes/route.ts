import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const service = createProductionOutcomeApiService();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return badRequest("Request body must be a JSON object");
    const authorization = req.headers.get("authorization");
    let workspaceId: string;
    let actorId: string | null = null;
    if (authorization) {
      const principal = await service.authenticate(req);
      workspaceId = principal.workspaceId;
    } else {
      const projectId = body.projectId ?? body.workspaceId;
      if (typeof projectId !== "string") return badRequest("projectId is required when registering from the dashboard");
      const user = await requireUser();
      await requireOwner(projectId, user.userId);
      workspaceId = projectId;
      actorId = user.userId;
    }
    const { workspaceId: _workspaceId, projectId: _projectId, ...definitionInput } = body;
    return Response.json({ outcome: await service.createDefinition({ workspaceId, input: definitionInput, actorId }) }, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
