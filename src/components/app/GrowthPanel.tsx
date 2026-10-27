"use client";

import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import styles from "./operator.module.css";

interface Briefing {
  policy: { optimizationEnabled: boolean; maxBountyChangePct: number; minimumEvidence: number; evaluationWindowDays: number };
  pace: {
    paceStatus: string; targetProgressPct: number; timeProgressPct: number;
    projectedOutcomesAtCurrentPace: number; publicBountyMicroUsdc: string;
    verifiedOutcomeCount: number; targetOutcomeCount: number;
  };
  bounty: { action: string; currentBountyMicroUsdc: string; recommendedBountyMicroUsdc: string | null; reason: string; rule: string };
  allocation: { partnerId: string; label: string; priority: number; sharePct: number; reason: string; confidence: string; sampleSize: number }[];
  forecast: {
    next24hExpectedObligationsMicroUsdc: string; next7dExpectedObligationsMicroUsdc: string;
    availableLiquidityMicroUsdc: string; currentReserveMicroUsdc: string; confidence: string; basis: string;
  };
  plan: { situation: string; recommendedAction: string; why: string; expectedEffect: string; confidence: string; policyStatus: string };
  quality?: {
    evaluated: boolean;
    verifiedAcquisitions?: number;
    d7?: { qualified: number; matured: number; rate: number | null; pending: number; review: number };
    d30?: { qualified: number; matured: number; rate: number | null; pending: number; review: number };
    overallConfidence?: string;
    anomalySignals?: { type: string; severity: string; partnerId: string | null; evidenceRefCount: number; reason: string }[];
    readiness?: { recommendedAction: string; reason: string };
  };
}

/** Growth intelligence: pace, bounty decision, allocation, forecast — real numbers only. */
export function GrowthPanel({ workspaceId, campaignId, isOwner }: { workspaceId: string; campaignId: string | null; isOwner: boolean }) {
  const [brief, setBrief] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!campaignId) return;
    let live = true;
    getJson<Briefing>(`/api/operator/growth?workspaceId=${workspaceId}&campaignId=${campaignId}`).then((res) => {
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
  }, [workspaceId, campaignId]);

  async function evaluate() {
    if (!campaignId) return;
    setRunning(true);
    setError(null);
    const res = await postJson(`/api/operator/growth/evaluate`, { workspaceId, campaignId });
    setRunning(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const fresh = await getJson<Briefing>(`/api/operator/growth?workspaceId=${workspaceId}&campaignId=${campaignId}`);
    if (fresh.ok) setBrief(fresh.data);
  }

  return (
    <div className={styles.card} aria-label="Growth intelligence">
      <h2>Growth</h2>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!campaignId && <p className={styles.muted}>No campaign to evaluate yet.</p>}
      {campaignId && !brief && !error && <p className={styles.muted}>Loading growth briefing…</p>}
      {brief && (
        <>
          <span className={styles.ctxLabel}>Campaign pace · {brief.pace.paceStatus}</span>
          <p className={styles.summary}>
            {brief.pace.verifiedOutcomeCount}/{brief.pace.targetOutcomeCount} verified ({brief.pace.targetProgressPct}%)
            in {brief.pace.timeProgressPct}% of time — projecting {brief.pace.projectedOutcomesAtCurrentPace}.
          </p>
          <span className={styles.ctxLabel}>Growth decision · {brief.bounty.action}</span>
          <p className={styles.summary}>
            {formatUsdc(brief.bounty.currentBountyMicroUsdc)} USDC
            {brief.bounty.recommendedBountyMicroUsdc ? ` → ${formatUsdc(brief.bounty.recommendedBountyMicroUsdc)} USDC` : ""} —{" "}
            {brief.bounty.reason}
          </p>
          {brief.allocation.length > 0 && (
            <>
              <span className={styles.ctxLabel}>Creator allocation</span>
              <ul className={styles.history} style={{ marginTop: 6 }}>
                {brief.allocation.slice(0, 4).map((a) => (
                  <li key={a.partnerId}>
                    <strong>
                      #{a.priority} {a.label} · {a.sharePct}%
                    </strong>
                    <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                      {a.reason} Confidence {a.confidence} (n={a.sampleSize}).
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <span className={styles.ctxLabel}>Liquidity forecast · {brief.forecast.confidence} (estimate)</span>
          <p className={styles.muted} style={{ marginTop: 6 }}>
            Next 24h {formatUsdc(brief.forecast.next24hExpectedObligationsMicroUsdc)} · 7d{" "}
            {formatUsdc(brief.forecast.next7dExpectedObligationsMicroUsdc)} USDC · {brief.forecast.basis}
          </p>
          {brief.quality?.evaluated && (
            <>
              <span className={styles.ctxLabel}>Outcome quality · {brief.quality.overallConfidence}</span>
              <p className={styles.summary}>
                {brief.quality.verifiedAcquisitions} verified acquisitions · D7{" "}
                {brief.quality.d7?.matured ? `${brief.quality.d7.qualified}/${brief.quality.d7.matured} retained${brief.quality.d7.rate !== null ? ` (${brief.quality.d7.rate}%)` : ""}` : "window still maturing"} · D30{" "}
                {brief.quality.d30?.matured ? `${brief.quality.d30.qualified}/${brief.quality.d30.matured} retained${brief.quality.d30.rate !== null ? ` (${brief.quality.d30.rate}%)` : ""}` : "window still maturing"}
              </p>
              {(brief.quality.anomalySignals?.length ?? 0) > 0 && (
                <p className={styles.muted} style={{ marginTop: 4 }}>
                  {brief.quality.anomalySignals!.length} review signal(s):{" "}
                  {brief.quality.anomalySignals!.slice(0, 3).map((a) => a.type.replaceAll("_", " ")).join(" · ")}
                  {brief.quality.readiness ? ` — next step: ${brief.quality.readiness.recommendedAction}` : ""}
                </p>
              )}
            </>
          )}
          <p className={styles.muted} style={{ marginTop: 8 }}>
            {brief.plan.policyStatus} Recent growth actions are in the workspace activity log.
          </p>
          {isOwner && (
            <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={evaluate} style={{ marginTop: 8 }}>
              {running ? "Evaluating…" : "Run growth evaluation"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
