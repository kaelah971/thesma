import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "@/server/auth/guard";
import { toApiError } from "@/server/api/errors";
import { getDb } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";
import { getPartnerByUserId } from "@/server/services/partners";
import { createDrizzleNotificationStore } from "@/server/services/creatorNotifications";

async function automationState(userId: string, partnerId: string | null) {
  try {
    const db = getDb();
    if (!partnerId) return { autoJoin: null as boolean | null, lastEvaluatedAt: null as string | null, lastAutoJoin: null as { campaignId: string; referralCode: string; at: string } | null };
    const { getPartnerRules } = await import("@/server/services/markets");
    const { createDrizzleCampaignStore } = await import("@/server/services/campaignStore.drizzle");
    const rules = await getPartnerRules(
      { store: createDrizzleCampaignStore(), audit: async () => ({}) },
      { userId },
    )
      .then((r) => r.rules)
      .catch(() => null);
    const [evaluated] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, "creator.autojoin.evaluated")))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1)
      .catch(() => []);
    const [executed] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, "creator.autojoin.executed")))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1)
      .catch(() => []);
    const execMeta = (executed?.metadata ?? {}) as Record<string, unknown>;
    return {
      autoJoin: rules?.autoJoin ?? null,
      lastEvaluatedAt: evaluated?.createdAt?.toISOString() ?? null,
      lastAutoJoin:
        executed && typeof execMeta.campaignId === "string" && typeof execMeta.referralCode === "string"
          ? {
              campaignId: execMeta.campaignId,
              referralCode: execMeta.referralCode,
              at: executed.createdAt.toISOString(),
            }
          : null,
    };
  } catch {
    return { autoJoin: null, lastEvaluatedAt: null, lastAutoJoin: null };
  }
}

/**
 * GET /api/creator/notifications — the caller's own Scout inbox.
 * Always scoped to the session user; client-supplied creator IDs are
 * never trusted.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const store = createDrizzleNotificationStore();
    const [items, unreadCount, partner] = await Promise.all([
      store.listForCreator(user.userId, 100).catch(() => []),
      store.unreadCount(user.userId).catch(() => 0),
      getPartnerByUserId(user.userId).catch(() => null),
    ]);
    return Response.json({
      notifications: items.map((n) => ({
        id: n.id,
        type: n.type,
        campaignId: n.campaignId,
        title: n.title,
        message: n.message,
        metadataJson: n.metadataJson,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unreadCount,
      automation: await automationState(user.userId, partner?.id ?? null),
    });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
