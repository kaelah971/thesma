import { isDbConfigured } from "@/server/db/client";
import { toApiError, unconfigured } from "@/server/api/errors";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const service = createProductionOutcomeApiService();
    const principal = await service.authenticate(req);
    const { slug } = await ctx.params;
    const rawVersion = new URL(req.url).searchParams.get("schemaVersion");
    const schemaVersion = rawVersion === null ? undefined : Number(rawVersion);
    return Response.json({ outcome: await service.getDefinition({ workspaceId: principal.workspaceId, slug, schemaVersion }) });
  } catch (err) {
    return toApiError(err);
  }
}
