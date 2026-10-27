import { z } from "zod";
import { getMembership, requireUser } from "@/server/auth/guard";
import { marketDepsOr503 } from "@/server/api/campaignDeps";
import { badRequest, forbidden, toApiError } from "@/server/api/errors";
import { listLedgerAuditRows, queryLedger, type AgentType, type ExecutionState } from "@/server/services/autonomy";

const querySchema = z.object({
  workspaceId: z.string().min(1),
  agent: z.enum(["CREATOR_SCOUT", "CREATOR_INVITATION_AGENT", "CREATOR_MATCH_AGENT", "CAMPAIGN_CFO", "GROWTH_OPTIMIZER", "FINANCIAL_OPERATOR", "VERIFICATION_AGENT", "QUALITY_AGENT"]).optional(),
  execution: z.enum(["PROPOSED", "AUTHORIZED", "EXECUTED", "WAITING", "ESCALATED", "REFUSED", "FAILED", "AMBIGUOUS", "SETTLED", "NO_ACTION"]).optional(),
  decision: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/operator/decisions?... — unified decision ledger (read-only).
 * Normalized, paginated, deterministic. Member-scoped to one workspace.
 * Creates zero audit rows and moves no funds.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const parsed = querySchema.safeParse({
      workspaceId: params.get("workspaceId"),
      agent: params.get("agent") ?? undefined,
      execution: params.get("execution") ?? undefined,
      decision: params.get("decision") ?? undefined,
      limit: params.get("limit") ?? undefined,
      offset: params.get("offset") ?? undefined,
    });
    if (!parsed.success) return badRequest("Invalid ledger query", parsed.error.flatten());
    const { workspaceId, agent, execution, decision, limit, offset } = parsed.data;
    const membership = await getMembership(workspaceId, user.userId);
    if (!membership) return forbidden();
    const wired = marketDepsOr503();
    if ("response" in wired) return wired.response;
    const rows = await listLedgerAuditRows(workspaceId, 500).catch(() => []);
    const { decisions, total } = queryLedger(rows, {
      workspaceId,
      agentType: agent as AgentType | undefined,
      executionState: execution as ExecutionState | undefined,
      decision,
      limit,
      offset,
    });
    return Response.json({ decisions, total, limit, offset }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toApiError(err);
  }
}
