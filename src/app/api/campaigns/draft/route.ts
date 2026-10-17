import { requireUser } from "@/server/auth/guard";
import { campaignDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, toApiError } from "@/server/api/errors";
import { createDraftRequestSchema, serializeCampaign, serializePolicyVersion } from "@/server/domain/campaign";
import { createDraft } from "@/server/services/campaigns";

export async function POST(req: Request) {
  try {
    const wired = campaignDepsOr503();
    if ("response" in wired) return wired.response;
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = createDraftRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid campaign draft request", parsed.error.flatten());
    const result = await createDraft(wired.deps, {
      workspaceId: parsed.data.workspaceId,
      userId: user.userId,
      intentText: parsed.data.intentText,
      overrides: parsed.data.overrides,
    });
    return Response.json(
      {
        campaign: serializeCampaign(result.campaign),
        version: serializePolicyVersion(result.version),
        missing: result.missing,
        notes: result.notes,
      },
      { status: 201 },
    );
  } catch (err) {
    return toApiError(err);
  }
}
