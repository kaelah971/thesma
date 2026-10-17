import { isDbConfigured } from "@/server/db/client";
import { requireUser } from "@/server/auth/guard";
import { createWorkspaceSchema } from "@/server/domain/validation";
import { createWorkspaceWithOwner, listUserWorkspaces } from "@/server/services/workspaces";
import { badRequest, toApiError, unconfigured } from "@/server/api/errors";

export async function GET() {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const rows = await listUserWorkspaces(user.userId);
    return Response.json({
      workspaces: rows.map((r) => ({ ...r.workspace, role: r.role })),
    });
  } catch (err) {
    return toApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    if (!isDbConfigured()) return unconfigured();
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = createWorkspaceSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid workspace request", parsed.error.flatten());
    const workspace = await createWorkspaceWithOwner({
      userId: user.userId,
      name: parsed.data.name,
      category: parsed.data.category ?? null,
    });
    return Response.json({ workspace }, { status: 201 });
  } catch (err) {
    return toApiError(err);
  }
}
