import { z } from "zod";
import { requireOwner, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { getDb } from "@/server/db/client";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { evaluateMarket } from "@/server/services/pricing";
import {
  buildGrowthPlan,
  decideBountyChange,
  DEFAULT_GROWTH_POLICY,
  forecastLiquidity,
  getGrowthPolicy,
  loadCreatorPerformance,
  loadPace,
  recommendAllocation,
  recordGrowthEvent,
} from "@/server/services/growth";
import { outcomes } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

const evaluateSchema = z.object({ workspaceId: z.string().min(1), campaignId: z.string().min(1) });

/**
 * POST /api/operator/growth/evaluate — one growth pass (owner only).
 * The growth gate disposes; only a bounded INCREASE/DECREASE reaches the
 * existing S6 execution path (evaluateMarket: versioned bump, frozen
 * terms intact). Everything is ledgered; escalations never execute.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const parsed = evaluateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("workspaceId and campaignId are required");
    const { workspaceId, campaignId } = parsed.data;
    try {
      await requireOwner(workspaceId, user.userId);
    } catch {
      return forbidden();
    }
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const db = getDb();
    const now = new Date();

    const policy = (await getGrowthPolicy(workspaceId).catch(() => null)) ?? { ...DEFAULT_GROWTH_POLICY };
    const { pace, kernelInputs, recentJoins, recentVerified } = await loadPace(
      wired.deps.store,
      campaignId,
      policy.evaluationWindowDays,
      now,
    );
    const performances = await loadCreatorPerformance(campaignId, policy.evaluationWindowDays, now).catch(() => []);
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
    const verifiedAtMs = await db
      .select({ verifiedAt: outcomes.verifiedAt })
      .from(outcomes)
      .where(and(eq(outcomes.campaignId, campaignId), eq(outcomes.status, "VERIFIED")))
      .then((rows) => rows.map((r) => r.verifiedAt?.getTime() ?? now.getTime()))
      .catch(() => [] as number[]);
    const forecast = forecastLiquidity({
      verifiedAtMs,
      nowMs: now.getTime(),
      averageObligationMicroUsdc: kernelInputs.publicBountyMicroUsdc,
      currentCommittedMicroUsdc: kernelInputs.committedMicroUsdc,
      currentReserveMicroUsdc: 0n,
      availableLiquidityMicroUsdc: available > 0n ? available : 0n,
    });
    const plan = buildGrowthPlan({ pace, bounty, allocation, forecast, policy });
    const windowMeta = {
      campaignId,
      evaluationWindowDays: policy.evaluationWindowDays,
      pace: pace.paceStatus,
      targetProgressPct: pace.targetProgressPct,
      oldBountyMicroUsdc: bounty.currentBountyMicroUsdc,
      recommendedBountyMicroUsdc: bounty.recommendedBountyMicroUsdc,
      policyBounds: { floor: kernelInputs.bountyFloorMicroUsdc.toString(), ceiling: kernelInputs.bountyCeilingMicroUsdc.toString(), maxStepPct: policy.maxBountyChangePct },
      liquidityForecast: { available: forecast.availableLiquidityMicroUsdc, next24h: forecast.next24hExpectedObligationsMicroUsdc, confidence: forecast.confidence },
      creatorEvidence: allocation.slice(0, 5).map((a) => ({ partnerId: a.partnerId, sharePct: a.sharePct, confidence: a.confidence, sampleSize: a.sampleSize })),
      reason: bounty.reason,
      rule: bounty.rule,
      confidence: plan.confidence,
    };

    let execution: Record<string, unknown> = { executed: false };
    if (bounty.action === "INCREASE_BOUNTY" || bounty.action === "DECREASE_BOUNTY") {
      const result = await evaluateMarket(
        { store: wired.deps.store, audit: wired.deps.audit, now: () => now, policy: { maxStepBps: Math.max(1, Math.round(policy.maxBountyChangePct * 100)) } },
        { campaignId },
      );
      execution = {
        executed: result.autoExecuted,
        decision: result.decision,
        pace: result.pace,
        oldBountyMicroUsdc: result.oldBountyMicroUsdc,
        newBountyMicroUsdc: result.newBountyMicroUsdc,
        alreadyRecorded: result.alreadyRecorded,
      };
      await recordGrowthEvent(db, workspaceId, "operator.bounty.changed", {
        campaignId,
        metadata: { ...windowMeta, execution },
      });
    } else if (bounty.action === "ESCALATE_BOUNTY") {
      await recordGrowthEvent(db, workspaceId, "operator.bounty.escalated", { campaignId, metadata: windowMeta });
    }
    await recordGrowthEvent(db, workspaceId, "operator.growth.evaluated", { campaignId, metadata: { ...windowMeta, execution } });
    await recordGrowthEvent(db, workspaceId, "operator.allocation.recommended", {
      campaignId,
      metadata: { allocation: allocation.map((a) => ({ partnerId: a.partnerId, priority: a.priority, sharePct: a.sharePct, confidence: a.confidence })) },
    });
    // Slice 7: quality review flags (bounded, audited — never auto-rejecting).
    // Signals are REVIEW FIRST, never verdicts; payout paths are untouched.
    let quality: Record<string, unknown> = { evaluated: false };
    try {
      const { loadCampaignQuality } = await import("@/server/services/reliability");
      const q = await loadCampaignQuality(wired.deps.store, campaignId, now);
      quality = {
        evaluated: true,
        verifiedAcquisitions: q.verifiedAcquisitions,
        d7: { qualified: q.d7.qualified, matured: q.d7.qualified + q.d7.missed, rate: q.d7.rate, pending: q.d7.pending, review: q.d7.review },
        d30: { qualified: q.d30.qualified, matured: q.d30.qualified + q.d30.missed, rate: q.d30.rate, pending: q.d30.pending, review: q.d30.review },
        anomalyCount: q.anomalySignals.length,
        readiness: q.readiness.recommendedAction,
      };
      for (const signal of q.anomalySignals.slice(0, 10)) {
        await recordGrowthEvent(db, workspaceId, "outcome.quality.review_flagged", {
          campaignId,
          metadata: {
            campaignId,
            type: signal.type,
            severity: signal.severity,
            partnerId: signal.partnerId,
            evidenceRefs: signal.evidenceRefs.slice(0, 10),
            reason: signal.reason,
          },
        });
      }
    } catch {
      // Quality evidence never breaks the growth evaluation.
    }
    return Response.json({ pace: pace.paceStatus, bounty, plan, execution, quality });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
