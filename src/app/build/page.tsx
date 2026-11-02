import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { DeveloperIntegrationsPanel } from "@/components/start/DeveloperIntegrationsPanel";
import { DeveloperProjectForm } from "@/components/build/DeveloperProjectForm";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { getDeveloperContext } from "./data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Overview" };

function stepState(complete: boolean, ready: boolean): "COMPLETE" | "READY" | "NOT STARTED" {
  if (complete) return "COMPLETE";
  if (ready) return "READY";
  return "NOT STARTED";
}

export default async function BuildHomePage() {
  const context = await getDeveloperContext();
  const service = context.workspace ? createProductionOutcomeApiService() : null;
  const integrations = context.workspace ? await service!.listIntegrations(context.workspace.id).catch(() => []) : [];
  const definitions = context.workspace ? await service!.listDefinitions(context.workspace.id).catch(() => []) : [];
  const statuses = context.workspace ? await service!.listEventStatuses(context.workspace.id).catch(() => []) : [];
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "thesma.vercel.app";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${protocol}://${forwardedHost.split(",")[0]!.trim()}`;
  const activeDefinitions = definitions.filter((definition) => definition.active);
  const steps = [
    { n: "01", title: "Create an integration", href: "/build/integrations", state: stepState(integrations.length > 0, Boolean(context.workspace)) },
    { n: "02", title: "Generate an API key", href: "/build/integrations", state: stepState(integrations.length > 0, integrations.length === 0 && Boolean(context.workspace)) },
    { n: "03", title: "Define an outcome", href: "/build/outcomes", state: stepState(activeDefinitions.length > 0, integrations.length > 0) },
    { n: "04", title: "Submit your first event", href: "/build/events", state: stepState(statuses.length > 0, activeDefinitions.length > 0) },
    { n: "05", title: "Inspect the receipt", href: "/build/receipts", state: stepState(statuses.length > 0, statuses.length > 0) },
  ];

  return (
    <div>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderText}>
          <div className={styles.pageEyebrow}>BUILD WITH THESMA</div>
          <h1>{context.projectName ?? "Your developer project"}</h1>
          <p className={styles.pageDesc}>{context.productDescription ?? "Connect your product to Thesma's verification, receipt and settlement infrastructure."}</p>
        </div>
        <div className={styles.pageActions}>
          <Link href="/build/docs" className="btn btn-primary btn-sm">Open quickstart</Link>
          <Link href="/build/settings" className="btn btn-sm">Project settings</Link>
        </div>
      </header>

      {!context.workspace ? (
        <div className={styles.grid2}>
          <section className={styles.card} data-tone="cream">
            <div className={styles.cardHead}><h2>Create a developer project</h2></div>
            <p className={styles.pageDesc}>Your project groups integrations, API keys, outcome definitions, events, receipts and telemetry. It is ready for API work without financial or chain setup.</p>
            <DeveloperProjectForm initialName={context.productDescription?.split(" ").slice(0, 3).join(" ") ?? ""} />
          </section>
          <section className={styles.card}>
            <div className={styles.cardHead}><h2>Developer infrastructure</h2></div>
            <p className={styles.pageDesc}>Define what your product values, submit evidence, and inspect deterministic VERIFIED, REVIEW or REFUSED decisions.</p>
            <Link href="/build/docs" className="btn btn-sm">Read the API quickstart</Link>
          </section>
        </div>
      ) : (
        <>
          <section className={styles.card} data-tone="cream" style={{ marginBottom: 12 }}>
            <div className={styles.cardHead}><h2>Onboarding checklist</h2><span className={styles.cardLink}>Project: {context.projectName}</span></div>
            <div className={styles.stack}>
              {steps.map((step) => (
                <Link key={step.n} href={step.href} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                  <strong className="mono" style={{ color: "var(--ink-3)", minWidth: 28 }}>{step.n}</strong>
                  <span style={{ flex: 1 }}>{step.title}</span>
                  <span className="mono" style={{ fontSize: 11, color: step.state === "COMPLETE" ? "var(--mint-ink)" : step.state === "READY" ? "var(--blue-ink)" : "var(--ink-3)" }}>{step.state}</span>
                </Link>
              ))}
            </div>
          </section>
          <div className={styles.kpis}>
            <div className={styles.kpi}><span className={styles.kpiLabel}>Integrations</span><span className={styles.kpiValue}><strong>{integrations.length}</strong></span><span className={styles.kpiHint}>credentials and prefixes</span></div>
            <div className={styles.kpi} data-tone="lav"><span className={styles.kpiLabel}>Active outcomes</span><span className={styles.kpiValue}><strong>{activeDefinitions.length}</strong></span><span className={styles.kpiHint}>versioned definitions</span></div>
            <div className={styles.kpi} data-tone="mint"><span className={styles.kpiLabel}>Events</span><span className={styles.kpiValue}><strong>{statuses.length}</strong></span><span className={styles.kpiHint}>safe status records</span></div>
            <div className={styles.kpi} data-tone="cream"><span className={styles.kpiLabel}>Receipts</span><span className={styles.kpiValue}><strong>{statuses.length}</strong></span><span className={styles.kpiHint}>decision trails</span></div>
          </div>
          <div className={styles.grid2}>
            <section className={styles.card}>
              <div className={styles.cardHead}><h2>Start building</h2></div>
              <p className={styles.pageDesc}>Create an integration, register an outcome, then submit evidence from your backend with an API key and Idempotency-Key.</p>
              <div className={styles.pageActions}>
                <Link href="/build/integrations" className="btn btn-primary btn-sm">Manage integrations</Link>
                <Link href="/build/outcomes" className="btn btn-sm">Define an outcome</Link>
                <Link href="/build/events" className="btn btn-sm">View events</Link>
              </div>
            </section>
            <section className={styles.card}>
              <div className={styles.cardHead}><h2>Hosted quickstart</h2></div>
              <p className={styles.pageDesc}>Use the current deployment origin. Local and self-hosted copies can replace it with their own origin.</p>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{`curl -X POST ${origin}/api/v1/outcomes/activated-user/events \\
  -H 'Authorization: Bearer ths_api_<your-key>' \\
  -H 'Idempotency-Key: activation_001_v1'`}</pre>
              <Link href="/build/docs" className={styles.cardLink}>See the complete request →</Link>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
