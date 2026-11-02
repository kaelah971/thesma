import type { Metadata } from "next";
import { DeveloperOutcomeDefinitionForm } from "@/components/build/DeveloperOutcomeDefinitionForm";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Outcome definitions" };

export default async function DeveloperOutcomesPage() {
  const context = await getDeveloperContext();
  if (!context.workspace) return <section className={styles.card}><h1>Outcome definitions</h1><p className={styles.pageDesc}>Create your developer project from the overview first.</p></section>;
  const definitions = await createProductionOutcomeApiService().listDefinitions(context.workspace.id).catch(() => []);
  return (
    <div>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>DEVELOPER INFRASTRUCTURE</div><h1>Outcome definitions</h1><p className={styles.pageDesc}>Define the business result your product cares about. Schemas are bounded and versioned for predictable API behavior.</p></div></header>
      <div className={styles.grid2}>
        <section className={styles.card} data-tone="cream"><div className={styles.cardHead}><h2>Create a definition</h2></div><DeveloperOutcomeDefinitionForm projectId={context.workspace.id} /></section>
        <section className={styles.card}><div className={styles.cardHead}><h2>Registered definitions</h2></div>{definitions.length === 0 ? <p className={styles.pageDesc}>No outcome definitions yet.</p> : <div className={styles.stack}>{definitions.map((definition) => <div key={definition.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><strong>{definition.slug}</strong><div className="mono" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>{definition.outcomeType} · {definition.unitValueMicroUsdc} micro-USDC · schema v{definition.evidenceSchemaVersion}</div><div style={{ marginTop: 4, fontSize: 13, color: definition.active ? "var(--mint-ink)" : "var(--ink-3)" }}>{definition.active ? "ACTIVE" : "INACTIVE"} · {definition.requiredEvidenceFields.join(", ")}</div></div>)}</div>}</section>
      </div>
    </div>
  );
}
