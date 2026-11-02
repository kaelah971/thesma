import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { DeveloperProjectForm } from "@/components/build/DeveloperProjectForm";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";
import { getDeveloperContext } from "./data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Overview" };

function stepState(complete: boolean, ready: boolean): "COMPLETE" | "READY" | "NOT STARTED" {
  if (complete) return "COMPLETE";
  if (ready) return "READY";
  return "NOT STARTED";
}

function displayMicroUsdc(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

export default async function BuildHomePage() {
  const context = await getDeveloperContext();
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "thesma.vercel.app";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${protocol}://${forwardedHost.split(",")[0]!.trim()}`;

  if (!context.workspace) {
    return (
      <div>
        <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>BUILD WITH THESMA</div><h1>BUILD GROWTH INTO YOUR PRODUCT.</h1><p className={styles.pageDesc}>Run creator, referral and outcome-based growth programs inside your own product, powered by Thesma&apos;s attribution, verification, policy and settlement infrastructure.</p></div></header>
        <div className={styles.grid2}>
          <section className={styles.card} data-tone="cream"><div className={styles.cardHead}><h2>Create a developer project</h2></div><p className={styles.pageDesc}>Start with your product. Growth Programs, integrations, evidence and receipts stay scoped to this project.</p><DeveloperProjectForm initialName={context.productDescription?.split(" ").slice(0, 3).join(" ") ?? ""} /></section>
          <section className={styles.card}><div className={styles.cardHead}><h2>One engine, two surfaces</h2></div><p className={styles.pageDesc}>Direct Thesma runs growth inside Thesma. Build with Thesma brings the same verified-outcome infrastructure underneath your application.</p><Link href="/build/docs" className="btn btn-sm">View integration guide</Link></section>
        </div>
      </div>
    );
  }

  const outcomeApi = createProductionOutcomeApiService();
  const growthPrograms = createProductionGrowthProgramService();
  const [integrations, definitions, statuses, programs] = await Promise.all([
    outcomeApi.listIntegrations(context.workspace.id).catch(() => []),
    outcomeApi.listDefinitions(context.workspace.id).catch(() => []),
    outcomeApi.listEventStatuses(context.workspace.id).catch(() => []),
    growthPrograms.listPrograms(context.workspace.id).catch(() => []),
  ]);
  const activeDefinitions = definitions.filter((definition) => definition.active);
  const verified = statuses.filter((status) => status.event.verificationState === "VERIFIED").length;
  const verificationRate = statuses.length === 0 ? 0 : Math.round((verified / statuses.length) * 100);
  const steps = [
    { n: "01", title: "Set the growth outcome", href: "/build/programs", state: stepState(programs.length > 0, Boolean(context.workspace)) },
    { n: "02", title: "Connect your product", href: "/build/integrations", state: stepState(integrations.length > 0, programs.length > 0) },
    { n: "03", title: "Submit verified evidence", href: "/build/events", state: stepState(statuses.length > 0, integrations.length > 0) },
    { n: "04", title: "Inspect the receipt", href: "/build/receipts", state: stepState(statuses.length > 0, statuses.length > 0) },
  ];

  return (
    <div>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>BUILD WITH THESMA · {context.projectName}</div><h1>BUILD GROWTH INTO YOUR PRODUCT.</h1><p className={styles.pageDesc}>Run creator, referral and outcome-based growth programs inside your own product, powered by Thesma&apos;s attribution, verification, policy and settlement infrastructure.</p></div>
        <div className={styles.pageActions}><Link href="/build/programs" className="btn btn-primary btn-sm">Create Growth Program</Link><Link href="/build/docs" className="btn btn-sm">View integration guide</Link></div>
      </header>

      <section className={styles.card} data-tone="cream" style={{ marginBottom: 12 }}><div className={styles.cardHead}><h2>Growth loop</h2><span className={styles.cardLink}>Project: {context.projectName}</span></div><div className={styles.stack}>{steps.map((step) => <Link key={step.n} href={step.href} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)" }}><strong className="mono" style={{ color: "var(--ink-3)", minWidth: 28 }}>{step.n}</strong><span style={{ flex: 1 }}>{step.title}</span><span className="mono" style={{ fontSize: 11, color: step.state === "COMPLETE" ? "var(--mint-ink)" : step.state === "READY" ? "var(--blue-ink)" : "var(--ink-3)" }}>{step.state}</span></Link>)}</div></section>

      <div className={styles.kpis}>
        <div className={styles.kpi}><span className={styles.kpiLabel}>Growth Programs</span><span className={styles.kpiValue}><strong>{programs.length}</strong></span><span className={styles.kpiHint}>configured objectives</span></div>
        <div className={styles.kpi} data-tone="lav"><span className={styles.kpiLabel}>Verified Outcomes</span><span className={styles.kpiValue}><strong>{verified}</strong></span><span className={styles.kpiHint}>from real event records</span></div>
        <div className={styles.kpi} data-tone="mint"><span className={styles.kpiLabel}>Participants</span><span className={styles.kpiValue}><strong>0</strong></span><span className={styles.kpiHint}>enrollment is next slice</span></div>
        <div className={styles.kpi} data-tone="cream"><span className={styles.kpiLabel}>Verification Rate</span><span className={styles.kpiValue}><strong>{verificationRate}%</strong></span><span className={styles.kpiHint}>{statuses.length} submitted outcomes</span></div>
      </div>

      <div className={styles.grid2} style={{ marginTop: 12 }}>
        <section className={styles.card}><div className={styles.cardHead}><h2>Active Growth Programs</h2><Link href="/build/programs" className={styles.cardLink}>Manage →</Link></div>{programs.length === 0 ? <p className={styles.pageDesc}>No Growth Programs yet. Start from a business objective, not an API schema.</p> : <div className={styles.stack}>{programs.map((program) => <Link key={program.id} href={`/build/programs/${program.id}`} style={{ display: "block", borderTop: "1px solid var(--line)", padding: "12px 0" }}><strong>{program.name}</strong><div className="mono" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>{program.targetOutcomeCount} outcomes · up to {displayMicroUsdc(program.rewardCeilingMicroUsdc)} · {program.operatorMode}</div></Link>)}</div>}</section>
        <section className={styles.card}><div className={styles.cardHead}><h2>Supporting infrastructure</h2></div><p className={styles.pageDesc}>{activeDefinitions.length} active outcome definitions · {integrations.length} product connections · {statuses.length} receipts. These records support the Growth Program; they are not the product entry point.</p><div className={styles.pageActions}><Link href="/build/integrations" className="btn btn-sm">Manage integrations</Link><Link href="/build/outcomes" className="btn btn-sm">Advanced outcome definitions</Link></div></section>
      </div>

      <section className={styles.card} style={{ marginTop: 12 }}><div className={styles.cardHead}><h2>Developer quickstart</h2><Link href="/build/docs" className={styles.cardLink}>Read the guide →</Link></div><p className={styles.pageDesc}>The existing API stays underneath the product: key → evidence → deterministic verification → receipt. No financial setup or chain connection is required to configure a program.</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{`curl -X POST ${origin}/api/v1/outcomes/activated-user/events \\
  -H 'Authorization: Bearer ths_api_<your-key>' \\
  -H 'Idempotency-Key: activation_001_v1'`}</pre></section>
    </div>
  );
}
