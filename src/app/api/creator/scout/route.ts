import { requireUser } from "@/server/auth/guard";
import { createDrizzleCampaignStore } from "@/server/services/campaignStore.drizzle";
import { toApiError } from "@/server/api/errors";
import { loadScoutAuthority, loadScoutSnapshot } from "@/server/services/scout";

/**
 * GET /api/creator/scout — the caller's own campaign scout snapshot.
 * Always scoped to the session user; client-supplied creator IDs are
 * never trusted.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const store = createDrizzleCampaignStore();
    const snapshot = await loadScoutSnapshot(store, user.userId).catch(() => null);
    if (!snapshot) return Response.json({ candidates: [], plan: null, authority: null });
    const authority = await loadScoutAuthority(store, user.userId, snapshot.candidates).catch(() => null);
    return Response.json({
      authority,
      candidates: snapshot.candidates.map((c) => ({
        ...c,
        facts: { ...c.facts, deadline: c.facts.deadline?.toISOString() ?? null },
      })),
      plan: {
        ...snapshot.plan,
        topOpportunities: snapshot.plan.topOpportunities.map((c) => ({
          ...c,
          facts: { ...c.facts, deadline: c.facts.deadline?.toISOString() ?? null },
        })),
        watchlist: snapshot.plan.watchlist.map((c) => ({
          ...c,
          facts: { ...c.facts, deadline: c.facts.deadline?.toISOString() ?? null },
        })),
        joined: snapshot.plan.joined.map((c) => ({
          ...c,
          facts: { ...c.facts, deadline: c.facts.deadline?.toISOString() ?? null },
        })),
        notEligible: snapshot.plan.notEligible.map((c) => ({
          ...c,
          facts: { ...c.facts, deadline: c.facts.deadline?.toISOString() ?? null },
        })),
      },
    });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
