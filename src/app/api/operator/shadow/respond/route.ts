import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { listShadowDecisions, recordShadowResponse } from "@/server/services/shadowOperator";

const responseSchema = z.object({
  workspaceId: z.string().min(1),
  decisionId: z.string().min(1),
  response: z.enum(["AGREE", "OVERRIDE", "IGNORE"]),
  reason: z.string().trim().max(500).optional(),
});

/** POST /api/operator/shadow/respond — append one human review event. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = responseSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("workspaceId, decisionId and response are required", parsed.error.flatten());
    const { workspaceId, decisionId, response, reason } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const decision = (await listShadowDecisions(workspaceId, 500)).find((item) => item.id === decisionId);
    if (!decision) return Response.json({ error: "Shadow decision not found.", code: "NOT_FOUND" }, { status: 404 });
    if (decision.response) return Response.json({ error: "Shadow decision already reviewed.", code: "ALREADY_REVIEWED" }, { status: 409 });
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const recorded = await recordShadowResponse(wired.deps.audit, decision, {
      response,
      reason,
      userId: user.userId,
    });
    return Response.json({ decisionId, response: recorded, executionStatus: "NOT_EXECUTED" });
  } catch (err) {
    return toApiError(err);
  }
}
