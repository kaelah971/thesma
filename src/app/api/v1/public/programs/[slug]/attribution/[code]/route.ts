import { isDbConfigured } from "@/server/db/client";
import { unconfigured } from "@/server/api/errors";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";
import { createProductionPublicGrowthProgramService } from "@/server/services/publicGrowthPrograms";
import { publicError, publicJson, withPublicCors } from "../../../../_helpers";

export async function OPTIONS() {
  return withPublicCors(new Response(null, { status: 204 }));
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string; code: string }> }) {
  try {
    if (!isDbConfigured()) return withPublicCors(unconfigured());
    const { slug, code } = await ctx.params;
    const publicPrograms = createProductionPublicGrowthProgramService();
    const program = await publicPrograms.getPrivateProgramBySlug(slug);
    const resolved = await createProductionGrowthProgramParticipationService().resolveAttribution({ workspaceId: program.workspaceId, growthProgramId: program.id, reference: decodeURIComponent(code) });
    return publicJson({
      attribution: {
        status: "ATTRIBUTED",
        programId: program.id,
        programSlug: program.slug,
        attributionId: resolved.attributionId,
        capturedAt: new Date().toISOString(),
        participant: {
          displayName: resolved.participant.displayName,
          handle: resolved.participant.handle,
          participantType: resolved.participant.participantType,
        },
      },
    });
  } catch (error) {
    return publicError(error);
  }
}
