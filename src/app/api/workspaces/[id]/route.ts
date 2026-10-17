import { isDbConfigured } from "@/server/db/client";
import { getMembership, requireUser } from "@/server/auth/guard";
import { getWorkspaceById } from "@/server/services/workspaces";
import { forbidden, notFound, toApiError, unconfigured } from "@/server/api/errors";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const { id } = await ctx.params;
    // Workspace isolation: caller must be a member, otherwise 403 (not 404 leak).
    const membership = await getMembership(id, user.userId);
    if (!membership) return forbidden("Not a workspace member");
    const workspace = await getWorkspaceById(id);
    if (!workspace) return notFound("Workspace not found");
    return Response.json({ workspace, role: membership.role });
  } catch (err) {
    return toApiError(err);
  }
}
