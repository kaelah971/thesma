import type { Metadata } from "next";
import Link from "next/link";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Events" };

export default async function DeveloperEventsPage() {
  const context = await getDeveloperContext();
  if (!context.workspace) return <section className={styles.card}><h1>Events</h1><p className={styles.pageDesc}>Create your developer project from the overview first.</p></section>;
  const statuses = await createProductionOutcomeApiService().listEventStatuses(context.workspace.id).catch(() => []);
  return (
    <div>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>OUTCOME INTAKE</div><h1>Events</h1><p className={styles.pageDesc}>Submitted API events, safe verification state, evidence hashes and settlement boundaries.</p></div><div className={styles.pageActions}><Link href="/build/docs" className="btn btn-primary btn-sm">Submit from your backend</Link></div></header>
      <section className={styles.card}>
        {statuses.length === 0 ? <div><h2>No events yet</h2><p className={styles.pageDesc}>Create an integration and outcome definition, then use the quickstart request from your product backend. API submissions require Idempotency-Key.</p></div> : <div className={styles.stack}>{statuses.map((status) => { const evaluation = status.receipt.programEvaluation; return <article key={status.event.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><strong>{status.event.externalEventId}</strong><span className="mono" style={{ fontSize: 12 }}>{status.event.verificationState}</span></div><p style={{ margin: "6px 0", color: "var(--ink-2)" }}>{status.event.externalSubjectId} · {status.event.definition.slug} · submitted {new Date(status.event.submittedAt).toLocaleString()}</p>{evaluation ? <div style={{ margin: "8px 0", color: "var(--ink-2)", fontSize: 13 }}>Program: <strong>{evaluation.program.name}</strong> · Participant: {evaluation.attribution.participantName ?? "—"} · Reward: {evaluation.reward.eligibility} · Settlement: {evaluation.settlementEligibility.status === "READY" ? "READY" : `NOT READY · ${evaluation.settlementEligibility.reasonCode ?? "POLICY"}`}</div> : null}<div className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>evidence {status.event.evidenceHash} · hold {status.event.holdState} · settlement {status.event.settlementState}</div><div style={{ marginTop: 8 }}><Link href={`/build/receipts/${status.event.id}`} className={styles.cardLink}>Open receipt →</Link></div></article>; })}</div>}
      </section>
    </div>
  );
}
