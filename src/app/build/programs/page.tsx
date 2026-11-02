import type { Metadata } from "next";
import Link from "next/link";
import { DeveloperGrowthProgramForm } from "@/components/build/DeveloperGrowthProgramForm";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Growth Programs" };

export default async function DeveloperProgramsPage() {
  const context = await getDeveloperContext();
  if (!context.workspace) {
    return <section className={styles.card}><h1>Growth Programs</h1><p className={styles.pageDesc}>Create your developer project from the overview first.</p></section>;
  }
  const outcomeApi = createProductionOutcomeApiService();
  const [programs, definitions, integrations] = await Promise.all([
    createProductionGrowthProgramService().listPrograms(context.workspace.id).catch(() => []),
    outcomeApi.listDefinitions(context.workspace.id).catch(() => []),
    outcomeApi.listIntegrations(context.workspace.id).catch(() => []),
  ]);

  return (
    <div>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderText}>
          <div className={styles.pageEyebrow}>BUILD WITH THESMA · GROWTH PROGRAMS</div>
          <h1>Set the outcome. Thesma runs the growth infrastructure.</h1>
          <p className={styles.pageDesc}>Create a business growth objective first. API keys, evidence and receipts stay underneath the program.</p>
        </div>
        <Link href="/build/docs" className="btn btn-sm">View integration guide</Link>
      </header>
      <div className={styles.grid2}>
        <section className={styles.card} data-tone="cream">
          <div className={styles.cardHead}><h2>Create a Growth Program</h2><span className={styles.cardLink}>No funding required</span></div>
          <DeveloperGrowthProgramForm projectId={context.workspace.id} definitions={definitions} integrations={integrations} />
        </section>
        <section className={styles.card}>
          <div className={styles.cardHead}><h2>Your programs</h2><span className={styles.cardLink}>{programs.length} configured</span></div>
          {programs.length === 0 ? <p className={styles.pageDesc}>No Growth Programs yet. Start with the outcome your product wants to grow.</p> : <div className={styles.stack}>{programs.map((program) => <Link key={program.id} href={`/build/programs/${program.id}`} style={{ display: "block", borderTop: "1px solid var(--line)", padding: "14px 0" }}><strong>{program.name}</strong><div className="mono" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>{program.targetOutcomeCount} {program.objectiveOutcomeType.replaceAll("_", " ").toLowerCase()} · {program.budgetMicroUsdc} micro-USDC budget · {program.operatorMode}</div><div style={{ marginTop: 5, fontSize: 13, color: "var(--ink-2)" }}>{program.integrationReadiness === "CONNECTED" ? "Product connected" : "Connect product later"} · Attribution {program.attributionStatus.replaceAll("_", " ").toLowerCase()}</div></Link>)}</div>}
        </section>
      </div>
    </div>
  );
}
