import { isDbConfigured } from "@/server/db/client";
import { unconfigured } from "@/server/api/errors";
import { createProductionPublicGrowthProgramService } from "@/server/services/publicGrowthPrograms";
import { publicError, publicJson, withPublicCors } from "../../_helpers";

export async function OPTIONS() {
  return withPublicCors(new Response(null, { status: 204 }));
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    if (!isDbConfigured()) return withPublicCors(unconfigured());
    const { slug } = await ctx.params;
    const program = await createProductionPublicGrowthProgramService().getProgramBySlug(slug, new URL(req.url).origin);
    return publicJson({ program });
  } catch (error) {
    return publicError(error);
  }
}
