"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import styles from "./operator.module.css";

interface CapabilityRow {
  capability: string;
  authority: string;
  policySource: string;
  limit: string;
  status: string;
  requiresHumanApproval: string;
  lastDecision: string | null;
}

interface AutonomyMetrics {
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

interface Escalation {
  id: string;
  status: string;
  agentType: string;
  campaignId: string | null;
  action: string;
  decision: string;
  amountMicroUsdc: string | null;
  reason: string;
  openedAt: string | null;
}

interface LedgerDecision {
  id: string;
  agentType: string;
  campaignId: string | null;
  decisionType: string;
  decision: string;
  authorityState: string;
  executionState: string;
  amountMicroUsdc: string | null;
  reasons: string[];
  proposedAt: string | null;
  enforcement: string;
}

/** THESMA AUTHORITY + metrics + open escalations + decision ledger. Read-only: never spends, never writes. */
export function AutonomyPanel({ workspaceId }: { workspaceId: string }) {
  const [ladder, setLadder] = useState<CapabilityRow[] | null>(null);
  const [metrics, setMetrics] = useState<AutonomyMetrics | null>(null);
  const [escalations, setEscalations] = useState<Escalation[] | null>(null);
  const [ledger, setLedger] = useState<{ decisions: LedgerDecision[]; total: number } | null>(null);
  const [filter, setFilter] = useState<string>("All");
  const [agent, setAgent] = useState<string>("All");

  async function loadLedger(exec: string, ag: string) {
    const params = new URLSearchParams({ workspaceId, limit: "25", offset: "0" });
    if (exec !== "All") params.set("execution", exec);
    if (ag !== "All") params.set("agent", ag);
    const res = await getJson<{ decisions: LedgerDecision[]; total: number }>(`/api/operator/decisions?${params.toString()}`);
    if (res.ok) setLedger(res.data);
  }

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await getJson<{ ladder: CapabilityRow[]; metrics: AutonomyMetrics; openEscalations: Escalation[] }>(
        `/api/operator/autonomy?workspaceId=${workspaceId}`,
      );
      if (!live || !res.ok) return;
      setLadder(res.data.ladder);
      setMetrics(res.data.metrics);
      setEscalations(res.data.openEscalations);
      await loadLedger(filter, agent);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function refilter(exec: string, ag: string) {
    setFilter(exec);
    setAgent(ag);
    await loadLedger(exec, ag);
  }

  return (
    <div className={styles.card} aria-label="Thesma authority">
      <h2>Thesma authority</h2>
      {!ladder && <p className={styles.muted}>Loading authority…</p>}
      {ladder && (
        <ul className={styles.history} style={{ marginTop: 6 }}>
          {ladder.map((c) => (
            <li key={c.capability}>
              <strong>
                {c.capability} · {c.authority.replaceAll("_", " ")}
              </strong>
              <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                {c.policySource} · {c.limit}
              </span>
              <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                Human approval: {c.requiresHumanApproval} · {c.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {metrics && (
        <>
          <span className={styles.ctxLabel}>Autonomy metrics · real events only</span>
          <p className={styles.summary}>
            {metrics.autonomousExecutions} autonomous executions · {metrics.humanEscalations} escalated ·{" "}
            {metrics.policyRefusals} refused · {metrics.obligationsSettledAutonomously} obligations settled (
            {formatUsdc(metrics.usdcSettledAutonomouslyMicroUsdc)} USDC) · {metrics.creatorAutoAccepts} agent accepts ·{" "}
            {metrics.bountyAdjustments} bounty moves · {metrics.verificationPurchases} verification checks
          </p>
        </>
      )}
      {escalations !== null && (
        <>
          <span className={styles.ctxLabel}>Open escalations ({escalations.length})</span>
          {escalations.length === 0 ? (
            <p className={styles.muted} style={{ marginTop: 4 }}>
              None open.
            </p>
          ) : (
            <ul className={styles.history} style={{ marginTop: 6 }}>
              {escalations.slice(0, 5).map((e) => (
                <li key={e.id}>
                  <strong>
                    {e.agentType.replaceAll("_", " ")} · {e.decision}
                  </strong>
                  <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                    {e.reason}
                    {e.amountMicroUsdc ? ` · ${formatUsdc(e.amountMicroUsdc)} USDC` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <span className={styles.ctxLabel}>Decision ledger</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {(["All", "EXECUTED", "ESCALATED", "REFUSED", "WAITING"] as const).map((f) => (
          <button key={f} type="button" onClick={() => refilter(f, agent)} className={filter === f ? "btn btn-primary btn-sm" : "btn btn-sm"} aria-pressed={filter === f}>
            {f === "All" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
        <select value={agent} onChange={(e) => refilter(filter, e.target.value)} aria-label="Agent filter" style={{ fontSize: 12.5 }}>
          {["All", "CREATOR_SCOUT", "CREATOR_INVITATION_AGENT", "CREATOR_MATCH_AGENT", "CAMPAIGN_CFO", "GROWTH_OPTIMIZER", "FINANCIAL_OPERATOR", "VERIFICATION_AGENT", "QUALITY_AGENT"].map((a) => (
            <option key={a} value={a}>
              {a === "All" ? "All agents" : a.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </div>
      {ledger && ledger.decisions.length === 0 && (
        <p className={styles.muted} style={{ marginTop: 6 }}>
          No decisions in this view yet.
        </p>
      )}
      {ledger && ledger.decisions.length > 0 && (
        <ul className={styles.history} style={{ marginTop: 6 }}>
          {ledger.decisions.slice(0, 10).map((d) => (
            <li key={d.id}>
              <strong>
                {d.agentType.replaceAll("_", " ")} · {d.decision.replaceAll("_", " ")}
              </strong>
              <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                {d.authorityState.replaceAll("_", " ")} · {d.executionState} · {d.enforcement === "ONCHAIN_ENFORCED" ? "onchain" : "app policy"}
                {d.amountMicroUsdc ? ` · ${formatUsdc(d.amountMicroUsdc)} USDC` : ""}
              </span>
              <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>{d.reasons[0] ?? d.decisionType}</span>
            </li>
          ))}
        </ul>
      )}
      {ledger && <p className={styles.muted}>{ledger.total} decisions total · showing {Math.min(ledger.decisions.length, 10)} · recommendations never execute</p>}
    </div>
  );
}
