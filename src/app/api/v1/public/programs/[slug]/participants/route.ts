import { isDbConfigured } from "@/server/db/client";
import { requireUser } from "@/server/auth/guard";
import { toApiError, unconfigured } from "@/server/api/errors";
import { createProductionGrowthProgramParticipationService, type SafeGrowthProgramParticipant } from "@/server/services/growthProgramParticipation";
import { createProductionPublicGrowthProgramService } from "@/server/services/publicGrowthPrograms";
import { publicError, publicJson, withPublicCors } from "../../../_helpers";

function publicParticipant(participant: SafeGrowthProgramParticipant) {
  return {
    id: participant.id,
    growthProgramId: participant.growthProgramId,
    participantType: participant.participantType,
    displayName: participant.displayName,
    handle: participant.handle,
    status: participant.status,
    attribution: participant.attribution ? { id: participant.attribution.id, code: participant.attribution.code, status: participant.attribution.status } : null,
    joinedAt: participant.joinedAt,
    approvedAt: participant.approvedAt,
    stats: participant.stats,
  };
}

export { publicParticipant };

export async function OPTIONS() {
  return withPublicCors(new Response(null, { status: 204 }));
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body)) return Response.json({ error: { code: "INVALID_REQUEST", message: "Request body must be a JSON object." } }, { status: 400 });
    const { slug } = await ctx.params;
    const program = await createProductionPublicGrowthProgramService().getPrivateProgramBySlug(slug);
    const participantType = body.participantType === undefined ? "REFERRAL_PARTNER" : body.participantType;
    if (participantType === "CREATOR") {
      const user = await requireUser();
      const participant = await createProductionGrowthProgramParticipationService().createParticipant({
        workspaceId: program.workspaceId,
        growthProgramId: program.id,
        actorId: user.userId,
        participantType,
        creatorUserId: user.userId,
        handle: body.handle,
        participationSource: "OPEN_JOIN",
      });
      return Response.json({ participant: publicParticipant(participant) }, { status: 201 });
    }
    if (participantType !== "REFERRAL_PARTNER") return Response.json({ error: { code: "UNSUPPORTED_PARTICIPANT_TYPE", message: "Only creators and referral partners can join." } }, { status: 400 });
    const participant = await createProductionGrowthProgramParticipationService().createParticipant({
      workspaceId: program.workspaceId,
      growthProgramId: program.id,
      actorId: null,
      participantType,
      externalPartnerId: body.externalPartnerId,
      displayName: body.displayName,
      handle: body.handle,
      participationSource: "EXTERNAL",
    });
    return Response.json({ participant: publicParticipant(participant) }, { status: 201 });
  } catch (error) {
    return toApiError(error);
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    if (!isDbConfigured()) return withPublicCors(unconfigured());
    const participantId = new URL(req.url).searchParams.get("participantId");
    if (!participantId) return publicJson({ error: { code: "INVALID_REQUEST", message: "participantId is required." } }, { status: 400 });
    const { slug } = await ctx.params;
    const program = await createProductionPublicGrowthProgramService().getPrivateProgramBySlug(slug);
    const participant = await createProductionGrowthProgramParticipationService().getParticipant({ workspaceId: program.workspaceId, growthProgramId: program.id, participantId });
    return publicJson({ participant: publicParticipant(participant) });
  } catch (error) {
    return publicError(error);
  }
}
