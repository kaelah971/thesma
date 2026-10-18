"use client";

import { useCallback, useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import styles from "./operator.module.css";

interface PreviewDecision {
  decision: string;
  amountMicroUsdc: string;
  reason: string;
  rule: string;
  autonomous: boolean;
}

interface SnapshotObligation {
  outcomeId: string;
  campaignId: string;
  partnerId: string;
  amountMicroUsdc: string;
  state: string;
  holdUntil: string | null;
  recommended: boolean;
  preview: PreviewDecision;
}

interface OperatorBriefing {
  policy: { minReserveMicroUsdc: string; maxAutonomousPaymentMicroUsdc: string; maxAutonomousSpendPerPeriodMicroUsdc: string | null };
  snapshot: {
    availableToDeployMicroUsdc: string;
    committedMicroUsdc: string;
    eligibleMicroUsdc: string;
    heldMicroUsdc: string;
    remainingObligations: number;
    nextDueAt: string | null;
    obligations: SnapshotObligation[];
  };
  recommendation: { outcomeId: string | null; rationale: string };
  metrics: {
    decisions: number;
    escalated: number;
    approved: number;
    rejected: number;
    autonomousPaidMicroUsdc: string;
    obligationsSettledAutonomously: number;
    autonomousSettlementRate: number | null;
  };
  pendingEscalations: { id: string; createdAt: string; metadata: Record<string, unknown> }[];
  decisions: { id: string; action: string; createdAt: string; metadata: Record<string, unknown> }[];
}

/**
 * Autonomy panel: real liquidity, authority, approvals and decision history.
 * Every value comes from GET /api/operator/snapshot — nothing is invented.
 * Owners can run a pass or rule on escalations; all else is read-only.
 */
export function OperatorAutonomy({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const [brief, setBrief] = useState<OperatorBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getJson<OperatorBriefing>(`/api/operator/snapshot?workspaceId=${workspaceId}`);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setBrief(res.data);
    setError(null);
  }, [workspaceId]);

  useEffect(() => {
    let live = true;
    getJson<OperatorBriefing>(`/api/operator/snapshot?workspaceId=${workspaceId}`).then((res) => {
      if (!live) return;
      if (!res.ok) setError(res.error);
      else {
        setBrief(res.data);
        setError(null);
      }
    });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  async function run() {
    setRunning(true);
    setError(null);
    const res = await postJson<{ results: unknown[] }>(`/api/operator/run`, { workspaceId });
    setRunning(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await load();
  }

  async function rule(escalationId: string, outcomeId: string | undefined, approved: boolean) {
    setVerdict(escalationId);
    setError(null);
    const res = await postJson(`/api/operator/escalations`, { workspaceId, escalationId, outcomeId, approved });
    setVerdict(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await load();
  }

  return (
    <div className={styles.card} aria-label="Autonomous operator">
      <h2>Autonomy</h2>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!brief && !error && <p className={styles.muted}>Loading operator briefing…</p>}
      {brief && (
        <>
          <p className={styles.summary}>{summaryLine(brief)}</p>
          <dl className={styles.ctxFacts}>
            <div>
              <dt>Available to deploy</dt>
              <dd className="tnum">{formatUsdc(brief.snapshot.availableToDeployMicroUsdc)} USDC</dd>
            </div>
            <div>
              <dt>Committed</dt>
              <dd className="tnum">{formatUsdc(brief.snapshot.committedMicroUsdc)} USDC</dd>
            </div>
            <div>
              <dt>Eligible now</dt>
              <dd className="tnum">{formatUsdc(brief.snapshot.eligibleMicroUsdc)} USDC</dd>
            </div>
            <div>
              <dt>In safety hold</dt>
              <dd className="tnum">{formatUsdc(brief.snapshot.heldMicroUsdc)} USDC</dd>
            </div>
            <div>
              <dt>Autonomous cap</dt>
              <dd className="tnum">{formatUsdc(brief.policy.maxAutonomousPaymentMicroUsdc)} USDC / payment</dd>
            </div>
            <div>
              <dt>Reserve</dt>
              <dd className="tnum">{formatUsdc(brief.policy.minReserveMicroUsdc)} USDC</dd>
            </div>
          </dl>
          {brief.pendingEscalations.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <span className={styles.ctxLabel}>Needs your approval</span>
              <ul className={styles.history} style={{ marginTop: 6 }}>
                {brief.pendingEscalations.map((e) => (
                  <li key={e.id}>
                    <strong className="tnum">{formatUsdc(String(e.metadata.amountMicroUsdc ?? "0"))} USDC</strong>
                    <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                      {String(e.metadata.whyHuman ?? e.metadata.policyRule ?? "Over authority")}
                    </span>
                    {isOwner && (
                      <span style={{ display: "flex", gap: 8, marginTop: 6 }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={verdict !== null}
                          onClick={() => rule(String(e.metadata.escalationId ?? e.id), e.metadata.outcomeId as string | undefined, true)}
                        >
                          {verdict ? "Working…" : "Approve"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={verdict !== null}
                          onClick={() => rule(String(e.metadata.escalationId ?? e.id), undefined, false)}
                        >
                          Reject
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {brief.decisions.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <span className={styles.ctxLabel}>Recent operator decisions</span>
              <ul className={styles.history} style={{ marginTop: 6 }}>
                {brief.decisions.slice(0, 5).map((d) => (
                  <li key={d.id}>
                    <strong>{actionLabel(String(d.action))}</strong>
                    <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                      {String((d.metadata.reason as string | undefined) ?? (d.metadata.decision as string | undefined) ?? "")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className={styles.muted} style={{ marginTop: 12 }}>
            {brief.metrics.decisions} decisions · {brief.metrics.escalated} escalated ·{" "}
            {formatUsdc(brief.metrics.autonomousPaidMicroUsdc)} USDC paid autonomously
            {brief.metrics.autonomousSettlementRate !== null &&
              ` · ${Math.round(brief.metrics.autonomousSettlementRate * 100)}% autonomous settlement`}
          </p>
          {isOwner && (
            <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={run} style={{ marginTop: 8 }}>
              {running ? "Running…" : "Run operator pass"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function actionLabel(action: string): string {
  if (action === "operator.decision") return "Decision";
  if (action === "operator.escalation") return "Escalated";
  if (action === "operator.escalation.decision") return "Human verdict";
  if (action === "operator.policy.updated") return "Policy updated";
  return action;
}

/** Operator voice over real numbers — never a template with fake values. */
function summaryLine(brief: OperatorBriefing): string {
  const eligible = brief.snapshot.remainingObligations;
  const eligibleUsdc = formatUsdc(brief.snapshot.eligibleMicroUsdc);
  const above = formatUsdc(
    (BigInt(brief.snapshot.availableToDeployMicroUsdc) - BigInt(brief.snapshot.eligibleMicroUsdc)).toString(),
  );
  const pending = brief.pendingEscalations.length;
  if (pending > 0) {
    const first = brief.pendingEscalations[0].metadata;
    return `This ${formatUsdc(String(first.amountMicroUsdc ?? "0"))} USDC obligation exceeds my ${formatUsdc(brief.policy.maxAutonomousPaymentMicroUsdc)} USDC autonomous limit. I need your approval${pending > 1 ? ` (${pending} waiting)` : ""}.`;
  }
  if (eligible === 0) {
    return brief.snapshot.heldMicroUsdc !== "0"
      ? `${formatUsdc(brief.snapshot.heldMicroUsdc)} USDC is verified and serving its safety hold. Nothing is payable yet — I’ll act when holds clear.`
      : "Nothing is due. All verified obligations are settled and no new outcomes await.";
  }
  return `${eligible} creator obligation${eligible === 1 ? " is" : "s totaling " + eligibleUsdc + " USDC are"} eligible. Paying ${eligible === 1 ? "it" : "them"} leaves ${above} USDC above your reserve, so I can settle without approval.`;
}
