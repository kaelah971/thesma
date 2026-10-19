import { requireUser } from "@/server/auth/guard";
import { toApiError } from "@/server/api/errors";
import { createDrizzleNotificationStore } from "@/server/services/creatorNotifications";

/** POST /api/creator/notifications/read-all — mark all own alerts read. */
export async function POST() {
  try {
    const user = await requireUser();
    const store = createDrizzleNotificationStore();
    const marked = await store.markAllRead(user.userId);
    return Response.json({ marked });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
