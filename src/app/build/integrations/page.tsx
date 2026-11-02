import type { Metadata } from "next";
import { DeveloperIntegrationsPanel } from "@/components/start/DeveloperIntegrationsPanel";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Integrations" };

export default async function DeveloperIntegrationsPage() {
  const context = await getDeveloperContext();
  if (!context.workspace) {
    return <section className={styles.card}><h1>Integrations</h1><p className={styles.pageDesc}>Create your developer project from the overview before issuing credentials.</p></section>;
  }
  const integrations = await createProductionOutcomeApiService().listIntegrations(context.workspace.id).catch(() => []);
  return (
    <div>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>DEVELOPER CREDENTIALS</div><h1>Integrations</h1><p className={styles.pageDesc}>Create one integration per product or environment. Full API keys are shown only once.</p></div></header>
      <DeveloperIntegrationsPanel projectId={context.workspace.id} initialIntegrations={integrations} />
    </div>
  );
}
