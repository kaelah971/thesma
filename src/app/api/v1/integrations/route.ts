import { isDbConfigured } from "@/server/db/client";
import { getMembership, requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, forbidden, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

export async function GET(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const query = new URL(req.url).searchParams;
    const projectId = query.get("projectId") ?? query.get("workspaceId");
    if (!projectId) return badRequest("projectId is required");
    await requireOwner(projectId, user.userId);
    const service = createProductionOutcomeApiService();
    return Response.json({ integrations: await service.listIntegrations(projectId) });
  } catch (err) {
    return toApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const body = await req.json().catch(() => null) as { projectId?: unknown; workspaceId?: unknown; name?: unknown } | null;
    const projectId = body?.projectId ?? body?.workspaceId;
    if (!body || typeof projectId !== "string" || typeof body.name !== "string") return badRequest("projectId and name are required");
    const membership = await getMembership(projectId, user.userId);
    if (!membership) return forbidden("Not a project member");
    await requireOwner(projectId, user.userId);
    const service = createProductionOutcomeApiService();
    const created = await service.createIntegration({ workspaceId: projectId, name: body.name, actorId: user.userId });
    return Response.json(created, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
