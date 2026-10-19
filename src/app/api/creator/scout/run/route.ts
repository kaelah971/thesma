import { requireUser } from "@/server/auth/guard";
import { createDrizzleCampaignStore, drizzleAuditSink } from "@/server/services/campaignStore.drizzle";
import { toApiError } from "@/server/api/errors";
import { runScoutAutoJoin } from "@/server/services/scout";

/**
 * POST /api/creator/scout/run — creator-triggered Scout pass (v1 has no
 * scheduler). Evaluates live candidates through Scout + creator authority,
 * joining ONLY permitted ones via the existing idempotent join path.
 * Scoped to the session user; nothing is trusted from the client.
 */
export async function POST() {
  try {
    const user = await requireUser();
    const store = createDrizzleCampaignStore();
    const summary = await runScoutAutoJoin({ store, audit: drizzleAuditSink }, user.userId);
    return Response.json(summary);
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
