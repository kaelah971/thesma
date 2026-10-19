import { requireUser } from "@/server/auth/guard";
import { badRequest, toApiError } from "@/server/api/errors";
import { createDrizzleNotificationStore } from "@/server/services/creatorNotifications";

/** POST /api/creator/notifications/[id]/read — mark one own alert read. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!id) return badRequest("Notification id is required");
    const store = createDrizzleNotificationStore();
    const ok = await store.markRead(user.userId, id);
    if (!ok) return badRequest("Notification not found");
    return Response.json({ read: true });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
