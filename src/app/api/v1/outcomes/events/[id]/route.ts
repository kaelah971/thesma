import { isDbConfigured } from "@/server/db/client";
import { toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const service = createProductionOutcomeApiService();
    const principal = await service.authenticate(req);
    const { id } = await ctx.params;
    return Response.json(await service.getStatus({ workspaceId: principal.workspaceId, eventId: id }));
  } catch (err) {
    return toApiError(err);
  }
}
