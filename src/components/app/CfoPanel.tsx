"use client";

import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import styles from "./operator.module.css";

interface CfoCampaign {
  campaignId: string;
  capitalScore: number;
  confidence: string;
  reasons: string[];
  warnings: string[];
  spendAction: string;
  spendReason: string;
  capitalAction: string;
  executionStatus: string;
  recommendedNewAllocationMicroUsdc: string;
  exploration: boolean;
  currentBountyMicroUsdc: string;
  suggestedBountyMicroUsdc: string | null;
  bountyAction: string;
  bountyReason: string;
  bountyRule: string;
  bountyExecution: string;
}

interface CfoPlan {
  generatedAt: string;
  totals: {
    fundedMicroUsdc: string; spentMicroUsdc: string; committedMicroUsdc: string;
    reservedMicroUsdc: string; verifiedUnpaidMicroUsdc: string; availableMicroUsdc: string;
    reserveMicroUsdc: string; deployableMicroUsdc: string;
    est24hObligationsMicroUsdc: string; est7dObligationsMicroUsdc: string;
    unallocatedMicroUsdc: string;
  };
  overallConfidence: string;
  chainMovement: string;
  campaigns: CfoCampaign[];
  escalations: { campaignId: string; reason: string }[];
}

/** Organization CFO: capital truth, plan, and per-campaign why. Recommendations only — nothing moves. */
export function CfoPanel({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const [plan, setPlan] = useState<CfoPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function load() {
    const res = await getJson<{ plan: CfoPlan }>(`/api/operator/cfo?workspaceId=${workspaceId}`);
    if (!res.ok) setError(res.error);
    else {
      setPlan(res.data.plan);
      setError(null);
    }
  }

  useEffect(() => {
    let live = true;
    (async () => {
      if (!live) return;
      await load();
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function evaluate() {
    setRunning(true);
    setError(null);
    const res = await postJson(`/api/operator/cfo/evaluate`, { workspaceId });
    setRunning(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await load();
  }

  return (
    <div className={styles.card} aria-label="Campaign CFO">
      <h2>Campaign CFO</h2>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!plan && !error && <p className={styles.muted}>Loading capital plan…</p>}
      {plan && (
        <>
          <span className={styles.ctxLabel}>Available capital · {plan.overallConfidence} confidence</span>
          <p className={styles.summary}>
            {formatUsdc(plan.totals.availableMicroUsdc)} USDC available · {formatUsdc(plan.totals.reserveMicroUsdc)}{" "}
            reserve · {formatUsdc(plan.totals.verifiedUnpaidMicroUsdc)} verified-unpaid · 24h{" "}
            {formatUsdc(plan.totals.est24hObligationsMicroUsdc)} expected
          </p>
          <span className={styles.ctxLabel}>Capital plan · deployable {formatUsdc(plan.totals.deployableMicroUsdc)} USDC</span>
          {plan.campaigns.length === 0 && <p className={styles.muted}>No campaigns to allocate yet.</p>}
          <ul className={styles.history} style={{ marginTop: 6 }}>
            {plan.campaigns.map((c) => (
              <li key={c.campaignId}>
                <strong>
                  {c.campaignId.slice(0, 8)} · score {c.capitalScore} ({c.confidence}) · {c.spendAction}
                </strong>
                <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                  {c.capitalAction.replaceAll("_", " ")} · +{formatUsdc(c.recommendedNewAllocationMicroUsdc)} USDC
                  {c.exploration ? " · exploration" : ""} · bounty {formatUsdc(c.currentBountyMicroUsdc)}
                  {c.suggestedBountyMicroUsdc ? ` → ${formatUsdc(c.suggestedBountyMicroUsdc)}` : ""} ({c.bountyAction}) ·{" "}
                  {c.executionStatus}
                </span>
                <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                  Why: {(c.reasons[0] ?? c.spendReason) || "—"}
                  {c.warnings.length > 0 ? ` · Watch: ${c.warnings[0]}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.muted} style={{ marginTop: 6 }}>
            Unallocated {formatUsdc(plan.totals.unallocatedMicroUsdc)} USDC · chain movement: {plan.chainMovement} (no
            cross-campaign transfer primitive — recommendations only)
          </p>
          {plan.escalations.length > 0 && (
            <p className={styles.muted} style={{ marginTop: 4 }}>
              Escalations: {plan.escalations.map((e) => `${e.campaignId.slice(0, 8)} (${e.reason})`).join(" · ")}
            </p>
          )}
          {isOwner && (
            <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={evaluate} style={{ marginTop: 8 }}>
              {running ? "Evaluating…" : "Run CFO evaluation"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
