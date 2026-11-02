import { isDbConfigured } from "@/server/db/client";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const { id } = await ctx.params;
    const service = createProductionOutcomeApiService();
    // The service still checks the workspace-scoped row. The UI supplies the
    // workspace as a header/query value, while owner auth prevents cross-org access.
    const workspaceId = new URL(_req.url).searchParams.get("workspaceId") ?? _req.headers.get("x-thesma-workspace-id");
    if (!workspaceId) return Response.json({ error: { code: "BAD_REQUEST", message: "x-thesma-workspace-id is required" } }, { status: 400 });
    await requireOwner(workspaceId, user.userId);
    return Response.json({ integration: await service.revokeIntegration({ workspaceId, integrationId: id, actorId: user.userId }) });
  } catch (err) {
    return toApiError(err);
  }
}
