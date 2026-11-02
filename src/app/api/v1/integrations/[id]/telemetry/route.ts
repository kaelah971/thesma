import { isDbConfigured } from "@/server/db/client";
import { forbidden, toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const service = createProductionOutcomeApiService();
    const principal = await service.authenticate(req);
    const { id } = await ctx.params;
    if (principal.integration.id !== id) return forbidden("An integration can only read its own telemetry");
    return Response.json({ telemetry: await service.telemetry({ workspaceId: principal.workspaceId, integrationId: id }) });
  } catch (err) {
    return toApiError(err);
  }
}
