import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { getDeveloperContext } from "../../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Receipt" };

export default async function DeveloperReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getDeveloperContext();
  if (!context.workspace) return <section className={styles.card}><h1>Receipt</h1><p className={styles.pageDesc}>Create your developer project from the overview first.</p></section>;
  const { id } = await params;
  const status = await createProductionOutcomeApiService().getStatus({ workspaceId: context.workspace.id, eventId: id }).catch(() => null);
  if (!status) notFound();
  const { receipt } = status;
  const evaluation = receipt.programEvaluation;
  return (
    <div>
      <Link href="/build/receipts" className={styles.back}>← Receipts</Link>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>OUTCOME RECEIPT</div><h1>{receipt.outcome.name}</h1><p className={styles.pageDesc}>{receipt.externalEventId} · {receipt.externalSubjectId}</p></div><span className="mono">{receipt.verificationDecision}</span></header>
      <div className={styles.grid2}>
        <section className={styles.card} data-tone="cream"><div className={styles.cardHead}><h2>Decision</h2></div><dl className={styles.stack}><div><dt>Integration</dt><dd>{receipt.submittedByIntegrationId}</dd></div><div><dt>Schema</dt><dd>v{receipt.schemaVersion}</dd></div><div><dt>Evidence hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{receipt.evidenceHash}</dd></div><div><dt>Reasons</dt><dd>{receipt.reasons.join(" · ") || "—"}</dd></div></dl></section>
        <section className={styles.card}><div className={styles.cardHead}><h2>Authority boundary</h2></div><dl className={styles.stack}><div><dt>Hold</dt><dd>{receipt.holdState}{receipt.holdUntil ? ` until ${receipt.holdUntil}` : ""}</dd></div><div><dt>Settlement</dt><dd>{receipt.settlementState}</dd></div><div><dt>Execution</dt><dd>{receipt.executionState}</dd></div><div><dt>Procurement</dt><dd>{receipt.procurementRecommendation}</dd></div></dl></section>
      </div>
      {evaluation ? <div className={styles.grid2} style={{ marginTop: 12 }}><section className={styles.card} data-tone="mint"><div className={styles.cardHead}><h2>Embedded program</h2><span className="badge badge-blue">{evaluation.operatorDecision.mode}</span></div><dl className={styles.stack}><div><dt>Program</dt><dd>{evaluation.program.name}</dd></div><div><dt>Participant</dt><dd>{evaluation.attribution.participantName ?? "—"}</dd></div><div><dt>Attribution</dt><dd>{evaluation.attribution.status} · {evaluation.attribution.identityId ?? "—"}</dd></div><div><dt>Reward</dt><dd>{evaluation.reward.amountMicroUsdc} micro-USDC · {evaluation.reward.eligibility}</dd></div><div><dt>Operator</dt><dd>{evaluation.operatorDecision.recommendation} · {evaluation.operatorDecision.reasonCodes.join(" · ")}</dd></div></dl></section><section className={styles.card}><div className={styles.cardHead}><h2>Economics / settlement</h2></div><dl className={styles.stack}><div><dt>Budget remaining</dt><dd>{evaluation.economics.remainingAllocatableBudgetMicroUsdc} micro-USDC</dd></div><div><dt>Verified CAC</dt><dd>{evaluation.economics.effectiveVerifiedCacMicroUsdc ?? "INSUFFICIENT_DATA"} · target {evaluation.economics.targetCacMicroUsdc}</dd></div><div><dt>Hold</dt><dd>{evaluation.hold.state}{evaluation.hold.until ? ` until ${evaluation.hold.until}` : ""}</dd></div><div><dt>Settlement eligibility</dt><dd>{evaluation.settlementEligibility.status} · {evaluation.settlementEligibility.reasonCode ?? "—"}</dd></div><div><dt>Execution</dt><dd>{evaluation.execution.status} · paid {evaluation.execution.actualPaidMicroUsdc}</dd></div></dl></section></div> : null}
      <section className={styles.card}><div className={styles.cardHead}><h2>Decision trail</h2></div><div className={styles.stack}>{status.decisionTrail.map((entry) => <div key={`${entry.action}-${entry.createdAt}`} style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>{entry.action}</strong><div className="mono" style={{ color: "var(--ink-3)", fontSize: 12 }}>{entry.createdAt}</div></div>)}</div></section>
    </div>
  );
}
