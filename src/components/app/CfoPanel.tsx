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

interface PortfolioMember {
  memberId: string;
  memberType: string;
  label: string;
  verifiedOutcomeCount: number;
  allInVerifiedAcquisitionCostMicro: string | null;
  reliability: string;
  sampleConfidence: string;
  availableCapacityMicro: string;
  recommendation: string;
  recommendedNextAllocationMicro: string;
  humanReadableReasons: string[];
  retainedOutcomeCount: number | null;
  retentionDataAvailable: boolean;
  verificationSpendMicro: string;
  verificationSpendExcludedMicro: string;
}

interface PortfolioPlan {
  objective: {
    targetOutcomeType: string | null;
    targetOutcomeCount: number | null;
    maxVerifiedCacMicro: string | null;
    totalBudgetMicro: string;
    reserveFloorBps: number;
  };
  members: PortfolioMember[];
  remainingTargetOutcomeCount: number | null;
  availableCapitalMicro: string;
  allocatableCapitalMicro: string;
  recommendedCapitalMicro: string;
  reserveMicro: string;
  unallocatedMicro: string;
  verificationSpendMicro: string;
  arcTestnetVerificationSpendExcludedMicro: string;
  retentionDataAvailable: boolean;
  chainMovement: string;
  executionStatus: string;
  accounting: { identityBalanced: boolean };
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
  portfolio?: PortfolioPlan;
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
          {plan.portfolio && (
            <section className={styles.portfolio} aria-labelledby="outcome-portfolio-title">
              <div className={styles.portfolioHead}>
                <div>
                  <span className={styles.ctxLabel}>OUTCOME PORTFOLIO</span>
                  <h3 id="outcome-portfolio-title">Where should the next dollar go?</h3>
                </div>
                <span className={styles.portfolioStatus}>{plan.portfolio.executionStatus}</span>
              </div>
              <p className={styles.portfolioIntro}>
                Campaigns are implementation details. This deterministic operator compares verified economics and recommends the next
                prospective allocation without moving existing funds.
              </p>
              <dl className={styles.portfolioFacts}>
                <div>
                  <dt>Objective</dt>
                  <dd>{plan.portfolio.objective.targetOutcomeType ?? "Existing verified outcomes"}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{plan.portfolio.objective.targetOutcomeCount ?? "—"} outcomes</dd>
                </div>
                <div>
                  <dt>Budget</dt>
                  <dd>{formatUsdc(plan.portfolio.objective.totalBudgetMicro)} USDC</dd>
                </div>
                <div>
                  <dt>Verified CAC ceiling</dt>
                  <dd>{plan.portfolio.objective.maxVerifiedCacMicro === null ? "—" : `${formatUsdc(plan.portfolio.objective.maxVerifiedCacMicro)} USDC`}</dd>
                </div>
                <div>
                  <dt>Remaining target</dt>
                  <dd>{plan.portfolio.remainingTargetOutcomeCount ?? "—"}</dd>
                </div>
                <div>
                  <dt>Allocatable now</dt>
                  <dd>{formatUsdc(plan.portfolio.allocatableCapitalMicro)} USDC</dd>
                </div>
                <div>
                  <dt>Required reserve</dt>
                  <dd>{formatUsdc(plan.portfolio.reserveMicro)} USDC</dd>
                </div>
                <div>
                  <dt>Next-dollar plan</dt>
                  <dd>{formatUsdc(plan.portfolio.recommendedCapitalMicro)} USDC</dd>
                </div>
              </dl>
              <p className={styles.portfolioNext}>
                <strong>NEXT {formatUsdc(plan.portfolio.recommendedCapitalMicro)} USDC</strong>{" "}
                {plan.portfolio.members.filter((member) => BigInt(member.recommendedNextAllocationMicro) > 0n).map((member) => `${formatUsdc(member.recommendedNextAllocationMicro)} → ${member.label}`).join(" · ") || "No member receives new capital until evidence or capacity changes."}
              </p>
              <div className={styles.portfolioMembers}>
                {plan.portfolio.members.length === 0 && <p className={styles.muted}>No eligible portfolio members yet.</p>}
                {plan.portfolio.members.map((member) => (
                  <article className={styles.portfolioMember} key={member.memberId}>
                    <div className={styles.portfolioMemberHead}>
                      <div>
                        <strong>{member.label}</strong>
                        <span>{member.memberType} · {member.verifiedOutcomeCount} verified outcomes</span>
                      </div>
                      <span className={styles.portfolioRecommendation} data-recommendation={member.recommendation}>
                        {member.recommendation}
                      </span>
                    </div>
                    <dl className={styles.portfolioMetrics}>
                      <div>
                        <dt>All-in verified CAC</dt>
                        <dd>{member.allInVerifiedAcquisitionCostMicro === null ? "—" : `${formatUsdc(member.allInVerifiedAcquisitionCostMicro)} USDC`}</dd>
                      </div>
                      <div>
                        <dt>Reliability</dt>
                        <dd>{member.reliability.replaceAll("_", " ")}</dd>
                      </div>
                      <div>
                        <dt>Evidence</dt>
                        <dd>{member.sampleConfidence}</dd>
                      </div>
                      <div>
                        <dt>Capacity</dt>
                        <dd>{formatUsdc(member.availableCapacityMicro)} USDC</dd>
                      </div>
                    </dl>
                    <p className={styles.portfolioReason}>{member.humanReadableReasons[0] ?? "No decision explanation available."}</p>
                    <div className={styles.portfolioMeta}>
                      <span>Next allocation · {formatUsdc(member.recommendedNextAllocationMicro)} USDC</span>
                      <span>{member.retentionDataAvailable ? `${member.retainedOutcomeCount ?? 0} retained` : "RETENTION DATA UNAVAILABLE"}</span>
                    </div>
                  </article>
                ))}
              </div>
              <p className={styles.portfolioFoot}>
                {formatUsdc(plan.portfolio.reserveMicro)} USDC retained as operating reserve · {formatUsdc(plan.portfolio.unallocatedMicro)} USDC intentionally unallocated ·
                verification expense included {formatUsdc(plan.portfolio.verificationSpendMicro)} USDC · Arc-Testnet proof excluded {formatUsdc(plan.portfolio.arcTestnetVerificationSpendExcludedMicro)} USDC.
              </p>
              <p className={styles.portfolioBoundary}>
                Chain movement: {plan.portfolio.chainMovement} · execution: {plan.portfolio.executionStatus} · accounting identity {plan.portfolio.accounting.identityBalanced ? "balanced" : "review required"}.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
