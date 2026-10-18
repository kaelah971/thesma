import { getMembership, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { arcConfigFromEnv, readOperatorPolicyState } from "@/server/chain/arc";
import {
  decideObligation,
  DEFAULT_OPERATOR_POLICY,
  getOperatorPolicy,
  HeuristicOperatorPlanner,
  listOperatorHistory,
  loadOperatorInput,
  OPERATOR_ESCALATION_ACTION,
  OPERATOR_ESCALATION_DECISION_ACTION,
  sumAutonomousSpentToday,
  summarizeOperatorMetrics,
} from "@/server/services/operator";

/**
 * GET /api/operator/snapshot?workspaceId= — operator briefing for one
 * organization. Member-readable. No execution: each eligible obligation
 * carries its deterministic preview decision.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const workspaceId = new URL(req.url).searchParams.get("workspaceId");
    if (!workspaceId) return badRequest("workspaceId is required");
    const membership = await getMembership(workspaceId, user.userId);
    if (!membership) return forbidden();
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;

    const policy = (await getOperatorPolicy(workspaceId).catch(() => null)) ?? {
      minReserveMicroUsdc: DEFAULT_OPERATOR_POLICY.minReserveMicroUsdc,
      maxAutonomousPaymentMicroUsdc: DEFAULT_OPERATOR_POLICY.maxAutonomousPaymentMicroUsdc,
      maxAutonomousSpendPerPeriodMicroUsdc: DEFAULT_OPERATOR_POLICY.maxAutonomousSpendPerPeriodMicroUsdc,
    };
    const now = new Date();
    const input = await loadOperatorInput(wired.deps.store, workspaceId, policy, now);
    const history = await listOperatorHistory(workspaceId).catch(() => []);
    const spentToday = sumAutonomousSpentToday(
      history.map((h) => ({ action: h.action, createdAt: h.createdAt, metadata: h.metadata })),
      now,
    );
    const planner = new HeuristicOperatorPlanner();
    const recommendation = await planner.plan(input.snapshot, policy);
    const decided = input.snapshot.obligations.map((o) => ({
      outcomeId: o.outcomeId,
      campaignId: o.campaignId,
      partnerId: o.partnerId,
      amountMicroUsdc: o.amountMicroUsdc.toString(),
      state: o.state,
      holdUntil: o.holdUntil?.toISOString() ?? null,
      recommended: recommendation.outcomeId === o.outcomeId,
      preview: decideObligation(input.snapshot, o, policy, spentToday),
    }));
    const decidedIds = new Set(
      history
        .filter((h) => h.action === OPERATOR_ESCALATION_DECISION_ACTION)
        .map((h) => (h.metadata.escalationId as string | undefined) ?? ""),
    );
    const pendingEscalations = history
      .filter((h) => h.action === OPERATOR_ESCALATION_ACTION)
      .filter((h) => !decidedIds.has((h.metadata.escalationId as string | undefined) ?? ""))
      .map((h) => ({ id: h.id, createdAt: h.createdAt.toISOString(), metadata: h.metadata }));

    // Onchain authority truth (testnet operator vault only, best-effort).
    // Null = unverified, never permission: execution validity is enforced
    // by the contract itself at payout time.
    let onchain: {
      vaultAddress: string;
      network: string;
      chainId: number;
      explorerBaseUrl: string | null;
      policies: Record<string, unknown>;
    } | null = null;
    try {
      const chain = arcConfigFromEnv();
      if (chain && chain.network === "testnet" && chain.vaultAddress) {
        const campaigns = await wired.deps.store.listCampaigns(workspaceId).catch(() => []);
        const policies: Record<string, unknown> = {};
        for (const c of campaigns.filter((x) => x.state === "LIVE")) {
          const version = await wired.deps.store.getCurrentVersion(c.id).catch(() => null);
          const funding = version ? await wired.deps.store.getFunding(c.id, version.version).catch(() => null) : null;
          const key = (funding as { campaignKey?: string } | null)?.campaignKey;
          if (!key || !key.startsWith("0x")) continue;
          const p = await readOperatorPolicyState(chain.rpcUrl, chain.vaultAddress, key as `0x${string}`).catch(() => null);
          policies[c.id] =
            p === null
              ? null
              : {
                  minReserveMicroUsdc: p.minReserve.toString(),
                  maxAutonomousPaymentMicroUsdc: p.maxAutonomousPayment.toString(),
                  periodSpendCapMicroUsdc: p.periodSpendCap.toString(),
                  periodDurationSeconds: p.periodDuration.toString(),
                  spentInPeriodMicroUsdc: p.spentInPeriod.toString(),
                  enabled: p.enabled,
                };
        }
        onchain = { vaultAddress: chain.vaultAddress, network: chain.network ?? "testnet", chainId: chain.chainId, explorerBaseUrl: chain.explorerBaseUrl, policies };
      }
    } catch {
      onchain = null;
    }

    return Response.json({
      policy: {
        minReserveMicroUsdc: policy.minReserveMicroUsdc.toString(),
        maxAutonomousPaymentMicroUsdc: policy.maxAutonomousPaymentMicroUsdc.toString(),
        maxAutonomousSpendPerPeriodMicroUsdc: policy.maxAutonomousSpendPerPeriodMicroUsdc?.toString() ?? null,
      },
      snapshot: { ...input.snapshot, obligations: decided },
      recommendation,
      metrics: summarizeOperatorMetrics(history.map((h) => ({ action: h.action, metadata: h.metadata }))),
      onchain,
      pendingEscalations,
      decisions: history
        .filter((h) => h.action.startsWith("operator."))
        .slice(0, 20)
        .map((h) => ({ id: h.id, action: h.action, createdAt: h.createdAt.toISOString(), metadata: h.metadata })),
    });
  } catch (err) {
    if ((err as { status?: number }).status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return toApiError(err);
  }
}
