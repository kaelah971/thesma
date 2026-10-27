import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { auditEvents } from "../db/schema";

/**
 * Autonomy ladder + unified decision ledger (Slice 9).
 *
 * This layer grants NOTHING. It summarizes EXISTING authority from creator
 * rules, organization policies, campaign policy and onchain enforcement,
 * and normalizes existing audit truth into one queryable decision ledger.
 * Every domain engine keeps its own authority; the vocabulary here is
 * explanatory and deterministic — never an LLM summary.
 *
 * Envelope truth rules:
 * - EXECUTED != SETTLED (SUBMITTED stays EXECUTED until reconciliation proves SETTLED).
 * - PURCHASED (payment acknowledged) != RESULT_RECEIVED (resource returned).
 * - INVITATION ACCEPTED != PAYOUT. Recommendation-only rows never execute.
 * - Manual/human actions keep their actor; authority describes what
 *   permitted the execution, not who clicked.
 */

export type AgentType =
  | "CREATOR_SCOUT"
  | "CREATOR_INVITATION_AGENT"
  | "CREATOR_MATCH_AGENT"
  | "CAMPAIGN_CFO"
  | "GROWTH_OPTIMIZER"
  | "FINANCIAL_OPERATOR"
  | "VERIFICATION_AGENT"
  | "QUALITY_AGENT";

export type AuthorityState =
  | "ADVISORY"
  | "AUTONOMOUS_ALLOWED"
  | "REQUIRES_APPROVAL"
  | "REFUSED_BY_POLICY"
  | "NOT_CONFIGURED"
  | "UNSUPPORTED";

export type ExecutionState =
  | "PROPOSED"
  | "AUTHORIZED"
  | "EXECUTED"
  | "WAITING"
  | "ESCALATED"
  | "REFUSED"
  | "FAILED"
  | "AMBIGUOUS"
  | "SETTLED"
  | "NO_ACTION";

export type ExecutionMode = "AUTONOMOUS" | "HUMAN" | "SYSTEM";

export interface DecisionEnvelope {
  id: string;
  organizationId: string | null;
  creatorUserId: string | null;
  campaignId: string | null;
  outcomeId: string | null;
  invitationId: string | null;
  agentType: AgentType;
  decisionType: string;
  decision: string;
  authorityState: AuthorityState;
  executionState: ExecutionState;
  confidence: string | null;
  amountMicroUsdc: string | null;
  asset: string | null;
  policyRefs: string[];
  evidenceRefs: string[];
  reasons: string[];
  warnings: string[];
  proposedAt: string | null;
  authorizedAt: string | null;
  executedAt: string | null;
  settledAt: string | null;
  escalatedAt: string | null;
  actor: string;
  executionMode: ExecutionMode;
  provenance: { auditId: string; action: string };
  enforcement: "ONCHAIN_ENFORCED" | "APPLICATION_POLICY";
  receipt: { txHash: string | null; paymentReference: string | null; event: string | null };
}

export interface LedgerAuditRow {
  id: string;
  actorType: string | null;
  actorId: string | null;
  workspaceId: string | null;
  partnerId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | Date | null;
}

const iso = (v: string | Date | null | undefined): string | null => {
  if (!v) return null;
  try {
    return new Date(v).toISOString();
  } catch {
    return null;
  }
};
const str = (m: Record<string, unknown>, k: string): string | null =>
  typeof m[k] === "string" ? (m[k] as string) : null;
const strArr = (m: Record<string, unknown>, k: string): string[] =>
  Array.isArray(m[k]) ? (m[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];

interface EnvelopeDraft extends Omit<DecisionEnvelope, "id" | "proposedAt" | "provenance"> {}

function base(row: LedgerAuditRow, draft: Partial<EnvelopeDraft> & Pick<EnvelopeDraft, "agentType" | "decisionType" | "decision" | "authorityState" | "executionState">): DecisionEnvelope {
  const at = iso(row.createdAt);
  const terminal = draft.executionState === "EXECUTED" || draft.executionState === "SETTLED" || draft.executionState === "FAILED";
  return {
    id: `env:${row.id}`,
    organizationId: row.workspaceId,
    creatorUserId: typeof row.metadata.creatorUserId === "string" ? row.metadata.creatorUserId : null,
    campaignId: typeof row.metadata.campaignId === "string" ? row.metadata.campaignId : null,
    outcomeId: null,
    invitationId: typeof row.metadata.invitationId === "string" ? row.metadata.invitationId : null,
    confidence: typeof row.metadata.confidence === "string" ? row.metadata.confidence : null,
    amountMicroUsdc: null,
    asset: null,
    policyRefs: [],
    evidenceRefs: [],
    reasons: [],
    warnings: [],
    proposedAt: at,
    authorizedAt: null,
    executedAt: terminal ? at : null,
    settledAt: draft.executionState === "SETTLED" ? at : null,
    escalatedAt: draft.executionState === "ESCALATED" ? at : null,
    actor: row.actorType === "AGENT" ? "AGENT" : row.actorType === "USER" ? "USER" : "SYSTEM",
    executionMode: row.actorType === "AGENT" ? "AUTONOMOUS" : row.actorType === "USER" ? "HUMAN" : "SYSTEM",
    provenance: { auditId: row.id, action: row.action },
    enforcement: "APPLICATION_POLICY",
    receipt: { txHash: null, paymentReference: null, event: null },
    ...draft,
  };
}

/**
 * Deterministic audit → envelope mapping. Unmapped (non-decision) actions
 * return null. Same rows always produce the same envelopes; missing
 * structured metadata yields a truthful generic fallback, never invention.
 */
export function normalizeAuditRow(row: LedgerAuditRow): DecisionEnvelope | null {
  const m = row.metadata ?? {};
  const reasons = strArr(m, "reasons");
  const generic = (action: string): string[] => [`Recorded as ${action}; see source audit row for full detail.`];
  switch (row.action) {
    case "match_engine.run":
      return base(row, {
        agentType: "CREATOR_MATCH_AGENT", decisionType: "MATCH_RANKING", decision: "RANKED",
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : [`Ranked ${typeof m.evaluated === "number" ? m.evaluated : "unknown"} creators; recommendations only.`],
        policyRefs: ["Match engine"],
      });
    case "creator.invitation.created":
      return base(row, {
        agentType: "CREATOR_INVITATION_AGENT", decisionType: "INVITATION", decision: "INVITED",
        authorityState: "REQUIRES_APPROVAL", executionState: "WAITING",
        amountMicroUsdc: typeof m.offeredBountyMicroUsdc === "string" ? m.offeredBountyMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : [`Frozen offer ${str(m, "offeredBountyMicroUsdc") ?? "?"} micro-USDC awaits creator decision.`],
        policyRefs: ["Organization membership", typeof m.offeredPolicyVersion === "number" ? `Campaign policy v${m.offeredPolicyVersion}` : "Campaign policy"],
      });
    case "creator.invitation.agent_evaluated": {
      const result = str(m, "result") ?? "UNKNOWN";
      return base(row, {
        agentType: "CREATOR_INVITATION_AGENT", decisionType: "INVITATION_AUTHORITY", decision: result,
        authorityState: result === "AUTO_ACCEPT" ? "AUTONOMOUS_ALLOWED" : result === "REVIEW" ? "REQUIRES_APPROVAL" : "REFUSED_BY_POLICY",
        executionState: "PROPOSED",
        amountMicroUsdc: typeof m.frozenBountyMicroUsdc === "string" ? m.frozenBountyMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Creator Scout rules"],
      });
    }
    case "creator.invitation.accepted": {
      const agent = str(m, "mode") === "AGENT";
      return base(row, {
        agentType: "CREATOR_INVITATION_AGENT", decisionType: "INVITATION", decision: "ACCEPTED",
        authorityState: agent ? "AUTONOMOUS_ALLOWED" : "REQUIRES_APPROVAL",
        executionState: "EXECUTED",
        actor: agent ? "AGENT" : "USER",
        executionMode: agent ? "AUTONOMOUS" : "HUMAN",
        evidenceRefs: typeof m.termsId === "string" ? [m.termsId] : [],
        reasons: reasons.length ? reasons : [agent ? "Agent acceptance within creator Scout rules." : "Creator accepted manually; acceptance is not payment."],
        policyRefs: ["Creator Scout rules", typeof m.offeredPolicyVersion === "number" ? `Campaign policy v${m.offeredPolicyVersion}` : "Campaign policy"],
      });
    }
    case "creator.invitation.declined":
    case "creator.invitation.cancelled":
      return base(row, {
        agentType: "CREATOR_INVITATION_AGENT", decisionType: "INVITATION",
        decision: row.action === "creator.invitation.declined" ? "DECLINED" : "CANCELLED",
        authorityState: "REQUIRES_APPROVAL", executionState: "NO_ACTION",
        reasons: [`Human decision; no participation, referral, payout or reservation created.`],
      });
    case "creator.autojoin.evaluated":
      return base(row, {
        agentType: "CREATOR_SCOUT", decisionType: "AUTO_JOIN", decision: "EVALUATED",
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : [`Scout evaluated ${typeof m.evaluated === "number" ? m.evaluated : "unknown"} opportunities.`],
        policyRefs: ["Creator Scout rules"],
      });
    case "creator.autojoin.executed":
      return base(row, {
        agentType: "CREATOR_SCOUT", decisionType: "AUTO_JOIN", decision: "JOINED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "EXECUTED",
        evidenceRefs: [...strArr(m, "joined")],
        reasons: reasons.length ? reasons : [`Joined ${strArr(m, "joined").length} campaigns within creator rules.`],
        policyRefs: ["Creator Scout rules"],
      });
    case "creator.reliability.evaluated":
      return base(row, {
        agentType: "QUALITY_AGENT", decisionType: "RELIABILITY", decision: String(str(m, "level") ?? "EVALUATED"),
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        confidence: str(m, "confidence"),
        reasons: reasons.length ? reasons : [`Reliability ${str(m, "reliabilityScore") ?? "?"} (${str(m, "confidence") ?? "?"}) over ${str(m, "verifiedOutcomes") ?? "?"} verified outcomes.`],
      });
    case "creator.scout.background.completed":
      return base(row, {
        agentType: "CREATOR_SCOUT", decisionType: "BACKGROUND_RUN", decision: "COMPLETED",
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : generic(row.action),
      });
    case "operator.growth.evaluated":
      return base(row, {
        agentType: "GROWTH_OPTIMIZER", decisionType: "GROWTH_EVALUATION", decision: "EVALUATED",
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Growth policy"],
      });
    case "operator.bounty.changed": {
      const executed = (m.execution as { executed?: boolean } | undefined)?.executed === true;
      return base(row, {
        agentType: "GROWTH_OPTIMIZER", decisionType: "BOUNTY", decision: String((m.execution as { decision?: string } | undefined)?.decision ?? str(m, "decision") ?? "ADJUSTED"),
        authorityState: executed ? "AUTONOMOUS_ALLOWED" : "ADVISORY",
        executionState: executed ? "EXECUTED" : "PROPOSED",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Growth policy"],
      });
    }
    case "operator.bounty.escalated":
      return base(row, {
        agentType: "GROWTH_OPTIMIZER", decisionType: "BOUNTY", decision: "ESCALATE_BOUNTY",
        authorityState: "REQUIRES_APPROVAL", executionState: "ESCALATED",
        reasons: reasons.length ? reasons : [`Bounty move exceeds autonomous bounds — owner decision required.`],
        policyRefs: ["Growth policy"],
      });
    case "operator.allocation.recommended":
      return base(row, {
        agentType: "GROWTH_OPTIMIZER", decisionType: "CREATOR_ALLOCATION", decision: "RECOMMENDED",
        authorityState: "ADVISORY", executionState: "PROPOSED",
        reasons: reasons.length ? reasons : [`Creator allocation is priority-only; it never pays.`],
      });
    case "pricing.decision":
      return base(row, {
        agentType: "GROWTH_OPTIMIZER", decisionType: "PRICING", decision: String(str(m, "decision") ?? "EVALUATED"),
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Growth policy"],
      });
    case "cfo.plan.generated":
      return base(row, {
        agentType: "CAMPAIGN_CFO", decisionType: "CAPITAL_PLAN", decision: "PLANNED",
        authorityState: "ADVISORY", executionState: "PROPOSED",
        reasons: reasons.length ? reasons : [`Capital plan is prospective — no chain movement primitive exists.`],
        policyRefs: ["Operator policy", "Growth policy"],
      });
    case "cfo.campaign.decision":
      return base(row, {
        agentType: "CAMPAIGN_CFO", decisionType: "SPEND_DECISION",
        decision: String(str(m, "spendAction") ?? "EVALUATED"),
        authorityState: "ADVISORY", executionState: "PROPOSED",
        reasons: [...reasons, ...(reasons.length ? [] : [`Spend ${str(m, "spendAction") ?? "?"}; capital ${str(m, "capitalAction") ?? "?"}.`])],
        warnings: strArr(m, "warnings"),
        policyRefs: ["Operator policy", "Growth policy"],
      });
    case "cfo.escalated":
      return base(row, {
        agentType: "CAMPAIGN_CFO", decisionType: "SPEND_DECISION", decision: "ESCALATED",
        authorityState: "REQUIRES_APPROVAL", executionState: "ESCALATED",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Operator policy"],
      });
    case "operator.decision": {
      const d = String(str(m, "decision") ?? "UNKNOWN");
      if (d === "PAY_NOW") {
        return base(row, {
          agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT_DECISION", decision: d,
          authorityState: "AUTONOMOUS_ALLOWED", executionState: "EXECUTED",
          amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
          asset: "USDC",
          reasons: reasons.length ? reasons : [`Autonomous payment within operator bounds.`],
          policyRefs: ["Operator policy", "ThesmaMarketVault (onchain)"],
          enforcement: "ONCHAIN_ENFORCED",
        });
      }
      if (d === "WAIT_FOR_HOLD" || d === "HOLD_FOR_LIQUIDITY") {
        return base(row, {
          agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT_DECISION", decision: d,
          authorityState: "AUTONOMOUS_ALLOWED", executionState: "WAITING",
          amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
          asset: "USDC",
          reasons: reasons.length ? reasons : [`Payout held by operator rule; funds stay reserved.`],
          policyRefs: ["Operator policy"],
        });
      }
      if (d === "ESCALATE_APPROVAL") {
        return base(row, {
          agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT_DECISION", decision: d,
          authorityState: "REQUIRES_APPROVAL", executionState: "ESCALATED",
          amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
          asset: "USDC",
          reasons: reasons.length ? reasons : [`Above autonomous payment authority — owner approval required.`],
          policyRefs: ["Operator policy"],
        });
      }
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT_DECISION", decision: d,
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Operator policy"],
      });
    }
    case "operator.escalation":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "ESCALATION", decision: "OPEN",
        authorityState: "REQUIRES_APPROVAL", executionState: "ESCALATED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Operator policy"],
      });
    case "operator.escalation.decision": {
      const approved = str(m, "decision") === "APPROVED" || m.approved === true;
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "ESCALATION",
        decision: approved ? "APPROVED" : "REJECTED",
        authorityState: "REQUIRES_APPROVAL",
        executionState: approved ? "AUTHORIZED" : "REFUSED",
        reasons: reasons.length ? reasons : [`Human ${approved ? "approved" : "rejected"} the escalation.`],
        policyRefs: ["Operator policy"],
      });
    }
    case "payout.prepared":
    case "payout.reserved":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT",
        decision: row.action === "payout.prepared" ? "PREPARED" : "RESERVED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "AUTHORIZED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Budget reserved; nothing has moved onchain.`],
        policyRefs: ["Operator policy"],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "payout.submitted":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT", decision: "SUBMITTED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "EXECUTED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Broadcast submitted; settlement unproven until reconciliation.`],
        policyRefs: ["Operator policy", "ThesmaMarketVault (onchain)"],
        enforcement: "ONCHAIN_ENFORCED",
        receipt: { txHash: typeof m.txHash === "string" ? m.txHash : null, paymentReference: null, event: null },
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "payout.settled":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT", decision: "SETTLED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "SETTLED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Reconciliation proved onchain settlement.`],
        policyRefs: ["Operator policy", "ThesmaMarketVault (onchain)"],
        enforcement: "ONCHAIN_ENFORCED",
        receipt: {
          txHash: typeof m.txHash === "string" ? m.txHash : null,
          paymentReference: null,
          event: typeof m.event === "string" ? m.event : "OutcomePaid",
        },
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "payout.failed":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT", decision: "FAILED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "FAILED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Payout failed (${str(m, "failureCode") ?? "unknown reason"}); funds released, never double-sent.`],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "payout.ambiguous":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT", decision: "AMBIGUOUS",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "AMBIGUOUS",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Settlement state uncertain — no retry broadcast without reconciliation.`],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "payout.released":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "PAYOUT", decision: "RELEASED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : [`Reservation released; capital freed without moving.`],
      });
    case "campaign.funding_prepared":
    case "campaign.funding_submitted":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "FUNDING",
        decision: row.action === "campaign.funding_prepared" ? "PREPARED" : "SUBMITTED",
        authorityState: "REQUIRES_APPROVAL", executionState: row.action === "campaign.funding_prepared" ? "PROPOSED" : "EXECUTED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["ThesmaMarketVault (onchain)"],
        enforcement: "ONCHAIN_ENFORCED",
        receipt: { txHash: typeof m.txHash === "string" ? m.txHash : null, paymentReference: null, event: null },
      });
    case "campaign.funding_confirmed":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "FUNDING", decision: "CONFIRMED",
        authorityState: "REQUIRES_APPROVAL", executionState: "SETTLED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : [`Onchain funding confirmed.`],
        policyRefs: ["ThesmaMarketVault (onchain)"],
        enforcement: "ONCHAIN_ENFORCED",
        receipt: { txHash: typeof m.txHash === "string" ? m.txHash : null, paymentReference: null, event: null },
      });
    case "campaign.funding_failed":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "FUNDING", decision: "FAILED",
        authorityState: "REQUIRES_APPROVAL", executionState: "FAILED",
        reasons: reasons.length ? reasons : generic(row.action),
      });
    case "campaign.funding_ambiguous":
      return base(row, {
        agentType: "FINANCIAL_OPERATOR", decisionType: "FUNDING", decision: "AMBIGUOUS",
        authorityState: "REQUIRES_APPROVAL", executionState: "AMBIGUOUS",
        reasons: reasons.length ? reasons : [`Funding settlement uncertain — reconcile before retry.`],
      });
    case "verification.procurement.evaluated": {
      const d = String(str(m, "decision") ?? "UNKNOWN");
      return base(row, {
        agentType: "VERIFICATION_AGENT", decisionType: "VERIFICATION_CHECK", decision: d,
        authorityState: d === "BUY_CHECK" ? "AUTONOMOUS_ALLOWED" : d === "REFUSE" ? "REFUSED_BY_POLICY" : d === "ESCALATE" ? "REQUIRES_APPROVAL" : "ADVISORY",
        executionState: "PROPOSED",
        amountMicroUsdc: typeof m.costMicroUsdc === "string" ? m.costMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: strArr(m, "reasons").length ? strArr(m, "reasons") : generic(row.action),
        policyRefs: ["Verification procurement policy"],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    }
    case "verification.procurement.approved":
      return base(row, {
        agentType: "VERIFICATION_AGENT", decisionType: "VERIFICATION_CHECK", decision: "APPROVED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "AUTHORIZED",
        amountMicroUsdc: typeof m.costMicroUsdc === "string" ? m.costMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Approved within procurement policy; exact terms bound before signing.`],
        policyRefs: ["Verification procurement policy"],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "verification.procurement.refused":
      return base(row, {
        agentType: "VERIFICATION_AGENT", decisionType: "VERIFICATION_CHECK", decision: "REFUSED",
        authorityState: "REFUSED_BY_POLICY", executionState: "REFUSED",
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Verification procurement policy"],
      });
    case "verification.procurement.purchased":
      return base(row, {
        agentType: "VERIFICATION_AGENT", decisionType: "VERIFICATION_CHECK", decision: "PURCHASED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "EXECUTED",
        amountMicroUsdc: typeof m.costMicroUsdc === "string" ? m.costMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Payment acknowledged; result not yet received — not a completed check.`],
        policyRefs: ["Verification procurement policy"],
        receipt: { txHash: null, paymentReference: typeof m.paymentReference === "string" ? m.paymentReference : null, event: null },
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "verification.procurement.result_received":
      return base(row, {
        agentType: "VERIFICATION_AGENT", decisionType: "VERIFICATION_CHECK",
        decision: typeof m.result === "string" ? m.result : "RESULT_RECEIVED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "EXECUTED",
        amountMicroUsdc: typeof m.costMicroUsdc === "string" ? m.costMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Provider returned ${typeof m.result === "string" ? m.result : "a result"} — evidence only, never payment authority.`],
        policyRefs: ["Verification procurement policy"],
        receipt: { txHash: null, paymentReference: typeof m.paymentReference === "string" ? m.paymentReference : null, event: null },
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "verification.procurement.ambiguous":
      return base(row, {
        agentType: "VERIFICATION_AGENT", decisionType: "VERIFICATION_CHECK", decision: "AMBIGUOUS",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "AMBIGUOUS",
        amountMicroUsdc: typeof m.costMicroUsdc === "string" ? m.costMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : [`Post-sign state uncertain — no blind repay; reconcile first.`],
        policyRefs: ["Verification procurement policy"],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "verification.procurement.escalated":
      return base(row, {
        agentType: "VERIFICATION_AGENT", decisionType: "VERIFICATION_CHECK", decision: "ESCALATED",
        authorityState: "REQUIRES_APPROVAL", executionState: "ESCALATED",
        amountMicroUsdc: typeof m.costMicroUsdc === "string" ? m.costMicroUsdc : null,
        asset: "USDC",
        evidenceRefs: typeof m.outcomeId === "string" ? [m.outcomeId] : [],
        reasons: reasons.length ? reasons : generic(row.action),
        policyRefs: ["Verification procurement policy"],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "creator.deal.accepted":
      return base(row, {
        agentType: "CREATOR_INVITATION_AGENT", decisionType: "HYBRID_DEAL", decision: "ACCEPTED",
        authorityState: "REQUIRES_APPROVAL", executionState: "EXECUTED",
        amountMicroUsdc: typeof m.baseAmountMicroUsdc === "string" ? m.baseAmountMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : [`Hybrid extension recorded PENDING — acceptance earned nothing.`],
        warnings: [`Base/milestone settlement unsupported onchain.`],
      });
    case "creator.deal.milestone.awarded":
      return base(row, {
        agentType: "CREATOR_INVITATION_AGENT", decisionType: "MILESTONE", decision: "AWARDED",
        authorityState: "AUTONOMOUS_ALLOWED", executionState: "EXECUTED",
        amountMicroUsdc: typeof m.amountMicroUsdc === "string" ? m.amountMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : [`Milestone fired from canonical VERIFIED counts; recorded payable without onchain settlement.`],
        warnings: [`Milestone settlement unsupported onchain.`],
        policyRefs: ["Campaign policy"],
      });
    case "creator.deal.base.verified":
      return base(row, {
        agentType: "CREATOR_INVITATION_AGENT", decisionType: "HYBRID_DEAL", decision: "BASE_VERIFIED",
        authorityState: "REQUIRES_APPROVAL", executionState: "EXECUTED",
        amountMicroUsdc: typeof m.baseAmountMicroUsdc === "string" ? m.baseAmountMicroUsdc : null,
        asset: "USDC",
        reasons: reasons.length ? reasons : [`Owner verified the deliverable; recorded without onchain settlement.`],
        warnings: [`Base settlement unsupported onchain.`],
      });
    case "outcome.quality.review_flagged":
      return base(row, {
        agentType: "QUALITY_AGENT", decisionType: "QUALITY_REVIEW", decision: String(str(m, "type") ?? "FLAGGED"),
        authorityState: "ADVISORY", executionState: "WAITING",
        evidenceRefs: [...strArr(m, "evidenceRefs")],
        reasons: reasons.length ? reasons : [str(m, "reason") ?? "Quality signal requires human review."],
        outcomeId: typeof m.outcomeId === "string" ? m.outcomeId : null,
      });
    case "retention.qualified":
      return base(row, {
        agentType: "QUALITY_AGENT", decisionType: "RETENTION", decision: `QUALIFIED_${str(m, "window") ?? ""}`,
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        evidenceRefs: [str(m, "originalOutcomeId"), str(m, "qualifyingOutcomeId")].filter((x): x is string => !!x),
        reasons: reasons.length ? reasons : [`Same subject verified again inside the window.`],
        outcomeId: typeof m.originalOutcomeId === "string" ? m.originalOutcomeId : null,
      });
    case "outcome.verified":
      return base(row, {
        agentType: "QUALITY_AGENT", decisionType: "OUTCOME_VERIFICATION", decision: "VERIFIED",
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        evidenceRefs: typeof m.proofHash === "string" ? [m.proofHash] : [],
        reasons: reasons.length ? reasons : [`Canonical verification; observation, not a payment decision.`],
        outcomeId: row.targetType === "outcome" ? row.targetId : null,
      });
    case "checkout.confirmed":
      return base(row, {
        agentType: "QUALITY_AGENT", decisionType: "OUTCOME_VERIFICATION", decision: "CONFIRMED",
        authorityState: "ADVISORY", executionState: "NO_ACTION",
        reasons: reasons.length ? reasons : generic(row.action),
      });
    default:
      return null;
  }
}

export interface LedgerFilter {
  workspaceId?: string;
  agentType?: AgentType;
  executionState?: ExecutionState;
  decision?: string;
  limit?: number;
  offset?: number;
}

/**
 * Pure ledger query: filter → stable sort (time, then id) → paginate.
 * Deterministic: same rows always normalize and order the same way.
 */
export function queryLedger(rows: LedgerAuditRow[], filter: LedgerFilter = {}): { decisions: DecisionEnvelope[]; total: number } {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const out: DecisionEnvelope[] = [];
  for (const row of rows) {
    if (filter.workspaceId !== undefined && row.workspaceId !== filter.workspaceId) continue;
    const env = normalizeAuditRow(row);
    if (!env) continue;
    if (filter.agentType !== undefined && env.agentType !== filter.agentType) continue;
    if (filter.executionState !== undefined && env.executionState !== filter.executionState) continue;
    if (filter.decision !== undefined && env.decision !== filter.decision) continue;
    out.push(env);
  }
  out.sort((a, b) => {
    const ta = a.proposedAt ?? "";
    const tb = b.proposedAt ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { decisions: out.slice(offset, offset + limit), total: out.length };
}

export interface EscalationView {
  id: string;
  status: "OPEN" | "APPROVED" | "REJECTED" | "RESOLVED" | "EXPIRED";
  agentType: AgentType;
  campaignId: string | null;
  outcomeId: string | null;
  invitationId: string | null;
  action: string;
  decision: string;
  amountMicroUsdc: string | null;
  reason: string;
  policyRefs: string[];
  evidenceRefs: string[];
  openedAt: string | null;
  provenance: { auditId: string; action: string };
}

const RESOLVED_STATES: ExecutionState[] = ["EXECUTED", "SETTLED", "REFUSED", "AUTHORIZED", "FAILED", "NO_ACTION"];

/**
 * Derived escalation inbox. OPEN = escalated/waiting/ambiguous with no later
 * terminal envelope on the same subject. APPROVED/REJECTED come from
 * explicit human decision events. EXPIRED = open longer than 30 days.
 * Deterministic and purely derived — no new rows anywhere.
 */
export function deriveEscalations(decisions: DecisionEnvelope[], nowMs: number = Date.now()): EscalationView[] {
  const bySubject = new Map<string, DecisionEnvelope[]>();
  for (const d of decisions) {
    // Grouped by subject, NOT by audit id: a later terminal envelope for the
    // same campaign/outcome/invitation resolves an earlier escalation.
    const key = [d.campaignId ?? "-", d.outcomeId ?? "-", d.invitationId ?? "-"].join("|");
    const list = bySubject.get(key) ?? [];
    list.push(d);
    bySubject.set(key, list);
  }
  const out: EscalationView[] = [];
  for (const d of decisions) {
    if (d.executionState !== "ESCALATED" && d.executionState !== "WAITING" && d.executionState !== "AMBIGUOUS") continue;
    if (d.decision === "APPROVED") continue;
    const key = [d.campaignId ?? "-", d.outcomeId ?? "-", d.invitationId ?? "-"].join("|");
    const siblings = (bySubject.get(key) ?? []).filter((x) => x.id !== d.id);
    const resolvedBy = siblings.find((x) => RESOLVED_STATES.includes(x.executionState) && (x.proposedAt ?? "") >= (d.proposedAt ?? ""));
    if (d.decision === "REJECTED") {
      out.push(toEscalation(d, "REJECTED"));
      continue;
    }
    if (resolvedBy && (d.executionState === "ESCALATED" || d.executionState === "WAITING" || d.executionState === "AMBIGUOUS")) {
      out.push(toEscalation(d, "RESOLVED"));
      continue;
    }
    const ageMs = d.proposedAt ? nowMs - Date.parse(d.proposedAt) : 0;
    out.push(toEscalation(d, ageMs > 30 * 86_400_000 ? "EXPIRED" : "OPEN"));
  }
  out.sort((a, b) => (a.openedAt ?? "") < (b.openedAt ?? "") ? 1 : -1);
  return out;
}

function toEscalation(d: DecisionEnvelope, status: EscalationView["status"]): EscalationView {
  return {
    id: `esc:${d.id}`,
    status,
    agentType: d.agentType,
    campaignId: d.campaignId,
    outcomeId: d.outcomeId,
    invitationId: d.invitationId,
    action: d.provenance.action,
    decision: d.decision,
    amountMicroUsdc: d.amountMicroUsdc,
    reason: d.reasons[0] ?? d.decision,
    policyRefs: d.policyRefs,
    evidenceRefs: d.evidenceRefs,
    openedAt: d.proposedAt,
    provenance: d.provenance,
  };
}

export interface AutonomyMetrics {
  autonomousDecisions: number;
  autonomousExecutions: number;
  humanEscalations: number;
  policyRefusals: number;
  obligationsSettledAutonomously: number;
  usdcSettledAutonomouslyMicroUsdc: string;
  verificationPurchases: number;
  creatorAutoAccepts: number;
  bountyAdjustments: number;
}

/** Factual counters over normalized envelopes — real events only. */
export function summarizeAutonomy(decisions: DecisionEnvelope[]): AutonomyMetrics {
  let autonomousDecisions = 0;
  let autonomousExecutions = 0;
  let humanEscalations = 0;
  let policyRefusals = 0;
  let obligationsSettledAutonomously = 0;
  let usdcSettled = 0n;
  let verificationPurchases = 0;
  let creatorAutoAccepts = 0;
  let bountyAdjustments = 0;
  for (const d of decisions) {
    if (d.authorityState === "AUTONOMOUS_ALLOWED") autonomousDecisions += 1;
    if (d.executionState === "EXECUTED" || d.executionState === "SETTLED") autonomousExecutions += 1;
    if (d.executionState === "ESCALATED") humanEscalations += 1;
    if (d.executionState === "REFUSED" || d.authorityState === "REFUSED_BY_POLICY") policyRefusals += 1;
    if (d.decision === "SETTLED" && d.decisionType === "PAYOUT") {
      obligationsSettledAutonomously += 1;
      try {
        usdcSettled += BigInt(d.amountMicroUsdc ?? "0");
      } catch {
        // Non-numeric amounts never inflate settled totals.
      }
    }
    if (d.decision === "PURCHASED" && d.agentType === "VERIFICATION_AGENT") verificationPurchases += 1;
    if (d.decision === "ACCEPTED" && d.actor === "AGENT") creatorAutoAccepts += 1;
    if (d.decisionType === "BOUNTY" && (d.decision === "INCREASE_BOUNTY" || d.decision === "DECREASE_BOUNTY")) bountyAdjustments += 1;
  }
  return {
    autonomousDecisions,
    autonomousExecutions,
    humanEscalations,
    policyRefusals,
    obligationsSettledAutonomously,
    usdcSettledAutonomouslyMicroUsdc: usdcSettled.toString(),
    verificationPurchases,
    creatorAutoAccepts,
    bountyAdjustments,
  };
}

/* ---------------- Autonomy ladder ---------------- */

export interface CapabilityRow {
  capability: string;
  authority: AuthorityState | "HUMAN" | "VARIES_BY_CREATOR";
  policySource: string;
  limit: string;
  status: string;
  requiresHumanApproval: string;
  lastDecision: string | null;
}

export interface LadderInputs {
  growthEnabled: boolean;
  maxBountyChangePct: number;
  minimumEvidence: number;
  operatorMaxPaymentMicroUsdc: bigint | null;
  procurementEnabled: boolean;
  procurementAllowlisted: boolean;
  procurementSignerConfigured: boolean;
  procurementMaxPerCheckMicroUsdc: bigint | null;
}

/**
 * Per-capability authority summary. Never grants anything: every row
 * restates an existing policy or product truth.
 */
export function buildOrganizationLadder(input: LadderInputs): CapabilityRow[] {
  return [
    {
      capability: "FIND CREATORS",
      authority: "ADVISORY",
      policySource: "Match engine",
      limit: "Recommendations only; never auto-selects",
      status: "CONFIGURED",
      requiresHumanApproval: "Invitation send",
      lastDecision: null,
    },
    {
      capability: "INVITE CREATORS",
      authority: "HUMAN",
      policySource: "Organization membership",
      limit: "Members invite; no autonomous inviting exists",
      status: "HUMAN",
      requiresHumanApproval: "Every invitation",
      lastDecision: null,
    },
    {
      capability: "ACCEPT CAMPAIGNS FOR CREATOR",
      authority: "AUTONOMOUS_ALLOWED",
      policySource: "Creator Scout rules (per creator)",
      limit: "Within each creator's bounty, confidence, capacity and category rules; hybrid offers always need human review",
      status: "CREATOR_GOVERNED",
      requiresHumanApproval: "Hybrid offers; anything outside Scout rules",
      lastDecision: null,
    },
    {
      capability: "ADJUST BOUNTY",
      authority: input.growthEnabled ? "AUTONOMOUS_ALLOWED" : "ADVISORY",
      policySource: "Growth policy",
      limit: `±${input.maxBountyChangePct}% per move, evidence ≥ ${input.minimumEvidence}`,
      status: input.growthEnabled ? "AUTONOMOUS" : "ADVISORY",
      requiresHumanApproval: "Moves beyond step, bounds or ceiling",
      lastDecision: null,
    },
    {
      capability: "ALLOCATE NEW CAMPAIGN CAPITAL",
      authority: "ADVISORY",
      policySource: "Campaign CFO",
      limit: "Prospective plans only — no cross-campaign transfer primitive exists",
      status: "ADVISORY",
      requiresHumanApproval: "Actual funding moves",
      lastDecision: null,
    },
    {
      capability: "PURCHASE VERIFICATION",
      authority: !input.procurementEnabled ? "REFUSED_BY_POLICY" : !input.procurementAllowlisted || !input.procurementSignerConfigured ? "NOT_CONFIGURED" : "AUTONOMOUS_ALLOWED",
      policySource: "Verification procurement policy",
      limit: input.procurementMaxPerCheckMicroUsdc !== null ? `≤ ${input.procurementMaxPerCheckMicroUsdc.toString()} micro-USDC per check + BPS/period caps` : "Unbounded until configured",
      status: !input.procurementEnabled ? "DISABLED" : !input.procurementAllowlisted || !input.procurementSignerConfigured ? "NOT_CONFIGURED" : "AUTONOMOUS",
      requiresHumanApproval: "Above per-check/period caps, ambiguous payments",
      lastDecision: null,
    },
    {
      capability: "PAY VERIFIED OBLIGATIONS",
      authority: "AUTONOMOUS_ALLOWED",
      policySource: "Operator policy + ThesmaMarketVault (onchain)",
      limit: input.operatorMaxPaymentMicroUsdc !== null ? `≤ ${input.operatorMaxPaymentMicroUsdc.toString()} micro-USDC autonomous per payment` : "Unbounded (testnet default)",
      status: "AUTONOMOUS",
      requiresHumanApproval: "Above-limit payments (existing approvals)",
      lastDecision: null,
    },
    {
      capability: "APPROVE ABOVE-LIMIT PAYMENTS",
      authority: "REQUIRES_APPROVAL",
      policySource: "Operator approvals",
      limit: "Human owner decision; existing approval rows",
      status: "HUMAN",
      requiresHumanApproval: "Every above-limit payment",
      lastDecision: null,
    },
    {
      capability: "SETTLE UNSUPPORTED HYBRID OBLIGATIONS",
      authority: "UNSUPPORTED",
      policySource: "No deliverable registry or milestone schedule onchain",
      limit: "Recorded payable; no settlement path in this product",
      status: "UNSUPPORTED",
      requiresHumanApproval: "N/A — manual offchain handling",
      lastDecision: null,
    },
  ];
}

export interface CreatorAuthorityView {
  campaignDiscovery: "AUTO";
  directInvitations: "AUTO" | "MANUAL";
  minimumBountyMicroUsdc: string;
  minConfidence: string;
  maxActiveCampaigns: string;
  maxAutoJoinsPerDay: string;
  blockedCategories: string[];
  allowedCategories: string[];
  hybridOffers: "REVIEW_REQUIRED";
  autoJoin: boolean;
}

/** Creator view derives strictly from existing partner rules — no new settings. */
export function buildCreatorAutonomy(rules: Partial<{
  autoJoin: boolean;
  minimumBountyMicroUsdc: bigint;
  minScoutConfidence: string;
  maxActiveCampaigns: number | null;
  maxAutoJoinsPerDay: number | null;
  blockedCategories: string[];
  allowedCategories: string[];
}> | null): CreatorAuthorityView {
  const autoJoin = rules?.autoJoin === true;
  return {
    campaignDiscovery: "AUTO",
    directInvitations: autoJoin ? "AUTO" : "MANUAL",
    minimumBountyMicroUsdc: (rules?.minimumBountyMicroUsdc ?? 0n).toString(),
    minConfidence: rules?.minScoutConfidence ?? "MEDIUM",
    maxActiveCampaigns: rules?.maxActiveCampaigns == null ? "unlimited" : String(rules.maxActiveCampaigns),
    maxAutoJoinsPerDay: rules?.maxAutoJoinsPerDay == null ? "unlimited" : String(rules.maxAutoJoinsPerDay),
    blockedCategories: [...(rules?.blockedCategories ?? [])],
    allowedCategories: [...(rules?.allowedCategories ?? [])],
    hybridOffers: "REVIEW_REQUIRED",
    autoJoin,
  };
}

/** Drizzle-backed audit read for the ledger (production path). No writes. */
export async function listLedgerAuditRows(workspaceId: string, limit = 200): Promise<LedgerAuditRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: auditEvents.id,
      actorType: auditEvents.actorType,
      actorId: auditEvents.actorId,
      workspaceId: auditEvents.workspaceId,
      partnerId: auditEvents.partnerId,
      action: auditEvents.action,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, workspaceId)))
    .orderBy(desc(auditEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({
    ...r,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
  }));
}
