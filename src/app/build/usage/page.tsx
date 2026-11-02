import type { Metadata } from "next";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Usage and telemetry" };

export default async function DeveloperUsagePage() {
  const context = await getDeveloperContext();
  if (!context.workspace) return <section className={styles.card}><h1>Usage / telemetry</h1><p className={styles.pageDesc}>Create your developer project from the overview first.</p></section>;
  const service = createProductionOutcomeApiService();
  const integrations = await service.listIntegrations(context.workspace.id).catch(() => []);
  const telemetry = await Promise.all(integrations.map((integration) => service.telemetry({ workspaceId: context.workspace!.id, integrationId: integration.id }).catch(() => ({ integrationId: integration.id, submitted: 0, verified: 0, review: 0, refused: 0, held: 0, settled: 0 }))));
  const totals = telemetry.reduce((sum, item) => ({ submitted: sum.submitted + item.submitted, verified: sum.verified + item.verified, review: sum.review + item.review, refused: sum.refused + item.refused, held: sum.held + item.held, settled: sum.settled + item.settled }), { submitted: 0, verified: 0, review: 0, refused: 0, held: 0, settled: 0 });
  return (
    <div>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>SAFE INTEGRATION TELEMETRY</div><h1>Usage / telemetry</h1><p className={styles.pageDesc}>Counts come from actual submitted external events. No fixture or test count is presented as traction.</p></div></header>
      <div className={styles.kpis}>{Object.entries(totals).map(([label, value]) => <div key={label} className={styles.kpi}><span className={styles.kpiLabel}>{label}</span><span className={styles.kpiValue}><strong>{value}</strong></span></div>)}</div>
      <section className={styles.card}><div className={styles.cardHead}><h2>By integration</h2></div>{telemetry.length === 0 ? <p className={styles.pageDesc}>No integrations yet.</p> : <div className={styles.stack}>{telemetry.map((item) => <div key={item.integrationId} style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><strong>{integrations.find((integration) => integration.id === item.integrationId)?.name ?? item.integrationId}</strong><div className="mono" style={{ color: "var(--ink-2)", fontSize: 12, marginTop: 4 }}>{item.submitted} submitted · {item.verified} verified · {item.review} review · {item.refused} refused · {item.held} held · {item.settled} settled</div></div>)}</div>}</section>
    </div>
  );
}
