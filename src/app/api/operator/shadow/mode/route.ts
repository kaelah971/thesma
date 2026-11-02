import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import {
  getOrganizationOperatorMode,
  recordOrganizationOperatorMode,
  type OrganizationOperatorMode,
} from "@/server/services/operatorMode";

const modeSchema = z.object({
  workspaceId: z.string().min(1),
  mode: z.enum(["AUTONOMOUS", "SHADOW"]).optional(),
  enabled: z.boolean().optional(),
}).refine((value) => value.mode !== undefined || value.enabled !== undefined, { message: "mode or enabled is required" });

/** POST /api/operator/shadow/mode — owner-only append-only mode switch. */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = modeSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("workspaceId and mode are required", parsed.error.flatten());
    const { workspaceId } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const mode: OrganizationOperatorMode = parsed.data.mode ?? (parsed.data.enabled ? "SHADOW" : "AUTONOMOUS");
    await recordOrganizationOperatorMode(wired.deps.audit, { workspaceId, mode, actorId: user.userId });
    return Response.json({ workspaceId, mode, changed: true, executionStatus: mode === "SHADOW" ? "NOT_EXECUTED" : "AVAILABLE" });
  } catch (err) {
    return toApiError(err);
  }
}

/** GET /api/operator/shadow/mode?workspaceId= — small read-only mode probe. */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) return badRequest("workspaceId is required");
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    return Response.json({ workspaceId, mode: await getOrganizationOperatorMode(workspaceId) });
  } catch (err) {
    return toApiError(err);
  }
}
