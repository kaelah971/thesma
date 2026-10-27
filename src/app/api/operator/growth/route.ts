import { getMembership, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import {
  buildGrowthPlan,
  decideBountyChange,
  DEFAULT_GROWTH_POLICY,
  forecastLiquidity,
  getGrowthPolicy,
  loadCreatorPerformance,
  loadPace,
  recommendAllocation,
  type CreatorPerformance,
  type PaceSnapshot,
} from "@/server/services/growth";
import { getDb } from "@/server/db/client";
import { outcomes } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * GET /api/operator/growth?workspaceId=&campaignId= — growth briefing.
 * Member-readable, read-only: pace, performance, bounty preview,
 * allocation, forecast, and plan. Nothing executes here.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const workspaceId = params.get("workspaceId");
    const campaignId = params.get("campaignId");
    if (!workspaceId || !campaignId) return badRequest("workspaceId and campaignId are required");
    const membership = await getMembership(workspaceId, user.userId);
    if (!membership) return forbidden();
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;

    const policy = (await getGrowthPolicy(workspaceId).catch(() => null)) ?? { ...DEFAULT_GROWTH_POLICY };
    const { pace, kernelInputs, recentJoins, recentVerified } = await loadPace(
      wired.deps.store,
      campaignId,
      policy.evaluationWindowDays,
    );
    const performances = await loadCreatorPerformance(campaignId, policy.evaluationWindowDays).catch(() => []);
    const available = kernelInputs.fundedMicroUsdc - kernelInputs.committedMicroUsdc;
    const bounty = decideBountyChange({
      pace,
      kernelInputs,
      recentJoins,
      recentVerified,
      availableMicroUsdc: available > 0n ? available : 0n,
      bounds: { bountyFloorMicroUsdc: kernelInputs.bountyFloorMicroUsdc, bountyCeilingMicroUsdc: kernelInputs.bountyCeilingMicroUsdc },
      policy,
    });
    const allocation = recommendAllocation(performances);
    // Slice 7: quality-adjusted view (read-only; no audit writes on render).
    let quality: Record<string, unknown> = { evaluated: false };
    try {
      const { loadCampaignQuality } = await import("@/server/services/reliability");
      const q = await loadCampaignQuality(wired.deps.store, campaignId);
      const ser = (s: { window: string; eligible: number; matured: number; qualified: number; pending: number; missed: number; review: number; unsupported: number; rate: number | null }) => ({
        window: s.window, eligible: s.eligible, matured: s.matured, qualified: s.qualified,
        pending: s.pending, missed: s.missed, review: s.review, unsupported: s.unsupported, rate: s.rate,
      });
      quality = {
        evaluated: true,
        verifiedAcquisitions: q.verifiedAcquisitions,
        d7: ser(q.d7),
        d30: ser(q.d30),
        overallConfidence: q.overallConfidence,
        anomalySignals: q.anomalySignals.slice(0, 10).map((a) => ({
          type: a.type, severity: a.severity, partnerId: a.partnerId,
          evidenceRefCount: a.evidenceRefs.length, reason: a.reason,
        })),
        readiness: { recommendedAction: q.readiness.recommendedAction, reason: q.readiness.reason },
      };
    } catch {
      // Quality evidence never breaks the briefing.
    }
    const verifiedAtMs = await getDb()
      .select({ verifiedAt: outcomes.verifiedAt })
      .from(outcomes)
      .where(and(eq(outcomes.campaignId, campaignId), eq(outcomes.status, "VERIFIED")))
      .then((rows) => rows.map((r) => r.verifiedAt?.getTime() ?? Date.now()))
      .catch(() => [] as number[]);
    const forecast = forecastLiquidity({
      verifiedAtMs,
      nowMs: Date.now(),
      averageObligationMicroUsdc: kernelInputs.publicBountyMicroUsdc,
      currentCommittedMicroUsdc: kernelInputs.committedMicroUsdc,
      currentReserveMicroUsdc: 0n,
      availableLiquidityMicroUsdc: available > 0n ? available : 0n,
    });
    const plan = buildGrowthPlan({ pace, bounty, allocation, forecast, policy });
    return Response.json({
      policy,
      pace: serializePace(pace),
      performances: performances.map(serializePerformance),
      bounty,
      allocation,
      forecast,
      plan,
      quality,
    });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}

function serializePace(p: PaceSnapshot) {
  return {
    ...p,
    publicBountyMicroUsdc: p.publicBountyMicroUsdc.toString(),
    fundedMicroUsdc: p.fundedMicroUsdc.toString(),
    committedMicroUsdc: p.committedMicroUsdc.toString(),
    availableMicroUsdc: p.availableMicroUsdc.toString(),
  };
}

function serializePerformance(p: CreatorPerformance) {
  return {
    ...p,
    settledPayoutMicroUsdc: p.settledPayoutMicroUsdc.toString(),
  };
}
