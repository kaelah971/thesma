import { getMembership, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import {
  buildOrganizationLadder,
  deriveEscalations,
  listLedgerAuditRows,
  queryLedger,
  summarizeAutonomy,
} from "@/server/services/autonomy";
import { DEFAULT_GROWTH_POLICY, getGrowthPolicy } from "@/server/services/growth";
import { DEFAULT_OPERATOR_POLICY, getOperatorPolicy } from "@/server/services/operator";
import { getProcurementSigner } from "@/server/services/verification";

/**
 * GET /api/operator/autonomy?workspaceId= — authority ladder + metrics + open escalations.
 * Member-readable. Reads audit truth only; creates zero audit rows and moves no funds.
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

    const growthPolicy = (await getGrowthPolicy(workspaceId).catch(() => null)) ?? { ...DEFAULT_GROWTH_POLICY };
    const operatorPolicy = (await getOperatorPolicy(workspaceId).catch(() => null)) ?? { ...DEFAULT_OPERATOR_POLICY };
    const procurementPolicy = await wired.deps.store.getProcurementPolicy(workspaceId).catch(() => null);
    let procurementSignerConfigured = false;
    try {
      getProcurementSigner();
      procurementSignerConfigured = true;
    } catch {
      procurementSignerConfigured = false;
    }
    const ladder = buildOrganizationLadder({
      growthEnabled: growthPolicy.optimizationEnabled,
      maxBountyChangePct: growthPolicy.maxBountyChangePct,
      minimumEvidence: growthPolicy.minimumEvidence,
      operatorMaxPaymentMicroUsdc: operatorPolicy.maxAutonomousPaymentMicroUsdc,
      procurementEnabled: procurementPolicy?.enabled ?? false,
      procurementAllowlisted:
        Array.isArray(procurementPolicy?.allowedProvidersJson) && (procurementPolicy.allowedProvidersJson as unknown[]).length > 0,
      procurementSignerConfigured,
      procurementMaxPerCheckMicroUsdc: procurementPolicy?.maxCostPerCheckMicroUsdc ?? null,
    });

    const rows = await listLedgerAuditRows(workspaceId, 500).catch(() => []);
    const { decisions } = queryLedger(rows, { workspaceId });
    const metrics = summarizeAutonomy(decisions);
    const escalations = deriveEscalations(decisions).filter((e) => e.status === "OPEN");

    return Response.json(
      {
        ladder,
        metrics,
        openEscalations: escalations,
        policyRefs: ["Growth policy", "Operator policy", "Verification procurement policy", "ThesmaMarketVault (onchain)"],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toApiError(err);
  }
}
