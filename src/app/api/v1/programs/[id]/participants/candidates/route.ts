import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { toApiError } from "@/server/api/errors";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";
import { findCreatorMatches } from "@/server/services/matching";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: { code: "INVALID_REQUEST", message: "projectId is required" } }, { status: 400 });
    const user = await requireUser();
    await requireOwner(projectId, user.userId);
    const { id } = await ctx.params;
    const program = await createProductionGrowthProgramService().getProgram({ workspaceId: projectId, id });
    const matches = await findCreatorMatches(wired.deps, { callerUserId: user.userId, campaignId: program.campaignId }, { allowPreview: true, allowDraftPreview: true });
    return Response.json({ programId: id, candidates: matches });
  } catch (err) {
    return toApiError(err);
  }
}
