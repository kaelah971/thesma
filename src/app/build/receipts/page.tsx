import type { Metadata } from "next";
import Link from "next/link";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Receipts" };

export default async function DeveloperReceiptsPage() {
  const context = await getDeveloperContext();
  if (!context.workspace) return <section className={styles.card}><h1>Receipts</h1><p className={styles.pageDesc}>Create your developer project from the overview first.</p></section>;
  const statuses = await createProductionOutcomeApiService().listEventStatuses(context.workspace.id).catch(() => []);
  return (
    <div>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>DECISION TRAIL</div><h1>Receipts</h1><p className={styles.pageDesc}>Every submitted event gets a safe receipt showing what was claimed, what Thesma decided and whether anything could execute.</p></div></header>
      <section className={styles.card}>
        {statuses.length === 0 ? <p className={styles.pageDesc}>No receipts yet. Submit an event from your product backend to create the first one.</p> : <div className={styles.stack}>{statuses.map((status) => <Link key={status.receipt.id} href={`/build/receipts/${status.event.id}`} style={{ display: "block", borderTop: "1px solid var(--line)", padding: "14px 0" }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{status.receipt.outcome.slug}</strong><span className="mono" style={{ fontSize: 12 }}>{status.receipt.verificationDecision}</span></div><div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 5 }}>{status.receipt.id} · {status.receipt.evidenceHash}</div><div style={{ marginTop: 5, color: "var(--ink-2)", fontSize: 13 }}>{status.receipt.holdState} · {status.receipt.settlementState} · {status.receipt.executionState}</div></Link>)}</div>}
      </section>
    </div>
  );
}
