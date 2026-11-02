import { isDbConfigured } from "@/server/db/client";
import { getMembership, requireOwner, requireUser } from "@/server/auth/guard";
import { badRequest, forbidden, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

export async function GET(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) return badRequest("workspaceId is required");
    await requireOwner(workspaceId, user.userId);
    const service = createProductionOutcomeApiService();
    return Response.json({ integrations: await service.listIntegrations(workspaceId) });
  } catch (err) {
    return toApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const body = await req.json().catch(() => null) as { workspaceId?: unknown; name?: unknown } | null;
    if (!body || typeof body.workspaceId !== "string" || typeof body.name !== "string") return badRequest("workspaceId and name are required");
    const membership = await getMembership(body.workspaceId, user.userId);
    if (!membership) return forbidden("Not a workspace member");
    await requireOwner(body.workspaceId, user.userId);
    const service = createProductionOutcomeApiService();
    const created = await service.createIntegration({ workspaceId: body.workspaceId, name: body.name, actorId: user.userId });
    return Response.json(created, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
