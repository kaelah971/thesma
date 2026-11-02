import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { createProductionGrowthProgramService } from "@/server/services/growthPrograms";
import { createProductionGrowthProgramParticipationService } from "@/server/services/growthProgramParticipation";
import { DeveloperProgramParticipantsPanel } from "@/components/build/DeveloperProgramParticipantsPanel";
import { DeveloperProgramIntegrationPanel } from "@/components/build/DeveloperProgramIntegrationPanel";
import { getDeveloperContext } from "../../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Growth Program" };

const LIFECYCLE = [
  ["01", "CONNECT PRODUCT", "Bind an integration and submit product-owned outcome evidence."],
  ["02", "OPEN PARTICIPATION", "Invite or open the supported partner classes."],
  ["03", "ATTRIBUTE TRAFFIC", "Create referral and attribution primitives for this program."],
  ["04", "VERIFY OUTCOMES", "Evaluate bounded evidence with Thesma's deterministic policies."],
  ["05", "SETTLE VERIFIED RESULTS", "Make eligible results available to existing settlement authority."],
  ["06", "OPTIMIZE ALLOCATION", "Use operator and portfolio recommendations for the next dollar."],
] as const;

function microUsdc(value: string): string {
  return `${(Number(value) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`;
}

export default async function DeveloperProgramDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const context = await getDeveloperContext();
  if (!context.workspace) notFound();
  const { id } = await params;
  const program = await createProductionGrowthProgramService().getProgram({ workspaceId: context.workspace.id, id }).catch(() => null);
  if (!program) notFound();
  const events = await createProductionOutcomeApiService().listEventStatuses(context.workspace.id).catch(() => []);
  const programEvents = events.filter((item) => item.event.growthProgramId === program.id);
  const verified = programEvents.filter((item) => item.event.verificationState === "VERIFIED").length;
  const participation = createProductionGrowthProgramParticipationService();
  const [participants, analytics] = await Promise.all([
    participation.listParticipants({ workspaceId: context.workspace.id, growthProgramId: program.id }).catch(() => []),
    participation.getAnalytics({ workspaceId: context.workspace.id, growthProgramId: program.id }).catch(() => ({ participants: 0, activeParticipants: 0, invited: 0, pendingReview: 0, attributedEvents: 0, verifiedAttributedOutcomes: 0, unattributedOutcomes: 0, attributionConflicts: 0 })),
  ]);

  return (
    <div>
      <header className={styles.pageHeader}>
        <div className={styles.pageHeaderText}>
          <div className={styles.pageEyebrow}>GROWTH PROGRAM · {program.status}</div>
          <h1>{program.name}</h1>
          <p className={styles.pageDesc}>The business objective and the Thesma infrastructure behind it.</p>
        </div>
        <div className={styles.pageActions}><Link href="/build/programs" className="btn btn-sm">All Growth Programs</Link><Link href="/build/docs" className="btn btn-sm">Integration guide</Link></div>
      </header>

      <section className={styles.card} data-tone="cream" style={{ marginBottom: 12 }}>
        <div className={styles.cardHead}><h2>Program objective</h2><span className="badge badge-blue">{program.operatorMode}</span></div>
        <div className={styles.grid2}>
          <div><div className={styles.kpiLabel}>OUTCOME</div><strong style={{ fontSize: 22 }}>{program.targetOutcomeCount} {program.objectiveOutcomeType.replaceAll("_", " ").toLowerCase()} outcomes</strong><p className={styles.pageDesc}>{program.outcomeDefinition.requiredEvidenceFields.join(", ")}</p></div>
          <div><div className={styles.kpiLabel}>VERIFICATION</div><strong>{program.outcomeDefinition.name}</strong><p className={styles.pageDesc}>{program.outcomeDefinition.verificationPolicyId} · {program.outcomeDefinition.holdSeconds}s hold · {verified} verified in this program</p></div>
        </div>
      </section>

      <div className={styles.kpis}>
        <div className={styles.kpi}><span className={styles.kpiLabel}>Budget cap</span><span className={styles.kpiValue}><strong>{microUsdc(program.budgetMicroUsdc)}</strong></span><span className={styles.kpiHint}>configured, not funded</span></div>
        <div className={styles.kpi} data-tone="lav"><span className={styles.kpiLabel}>Verified CAC ceiling</span><span className={styles.kpiValue}><strong>{microUsdc(program.maxVerifiedCacMicroUsdc)}</strong></span><span className={styles.kpiHint}>policy guardrail</span></div>
        <div className={styles.kpi} data-tone="mint"><span className={styles.kpiLabel}>Reward</span><span className={styles.kpiValue}><strong>up to {microUsdc(program.rewardCeilingMicroUsdc)}</strong></span><span className={styles.kpiHint}>{program.rewardStructure.replaceAll("_", " ").toLowerCase()}</span></div>
        <div className={styles.kpi} data-tone="cream"><span className={styles.kpiLabel}>Participants</span><span className={styles.kpiValue}><strong>{analytics.activeParticipants}</strong></span><span className={styles.kpiHint}>{analytics.invited} invited · {analytics.pendingReview} pending</span></div>
      </div>

      <DeveloperProgramParticipantsPanel projectId={context.workspace.id} programId={program.id} participationStatus={program.participationStatus} operatorMode={program.operatorMode} participants={participants} analytics={analytics} />
      <DeveloperProgramIntegrationPanel program={program} />

      <div className={styles.grid2} style={{ marginTop: 12 }}>
        <section className={styles.card}><div className={styles.cardHead}><h2>Readiness</h2></div><div className={styles.stack}><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Integration surface</strong><div className="mono" style={{ fontSize: 12, marginTop: 4, color: "var(--mint-ink)" }}>AVAILABLE · hosted page + browser/server SDK</div><div className="mono" style={{ fontSize: 11, marginTop: 3, color: "var(--ink-3)" }}>API binding: {program.integrationReadiness}{program.integration ? ` · ${program.integration.name}` : " · connect server integration when ready"}</div></div><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Attribution</strong><div className="mono" style={{ fontSize: 12, marginTop: 4, color: program.attributionStatus === "CONFIGURED" ? "var(--mint-ink)" : "var(--ink-3)" }}>{program.attributionStatus === "CONFIGURED" ? `CONFIGURED · ${analytics.activeParticipants} active identit${analytics.activeParticipants === 1 ? "y" : "ies"}` : "NOT CONFIGURED · activate a participant"}</div></div><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Funding</strong><div className="mono" style={{ fontSize: 12, marginTop: 4, color: "var(--ink-3)" }}>PROGRAM CONFIGURED · NOT FUNDED</div></div><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Hosted participation</strong><div className="mono" style={{ fontSize: 12, marginTop: 4, color: "var(--mint-ink)" }}>CONFIGURED · /g/{program.slug}</div></div><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Settlement</strong><div className="mono" style={{ fontSize: 12, marginTop: 4, color: "var(--ink-3)" }}>SHADOW / NOT FUNDED · existing authority boundary preserved</div></div></div></section>
        <section className={styles.card}><div className={styles.cardHead}><h2>Lifecycle</h2></div><div className={styles.stack}>{LIFECYCLE.map(([number, title, copy], index) => <div key={number} style={{ borderTop: "1px solid var(--line)", padding: "12px 0", display: "grid", gridTemplateColumns: "32px 1fr auto", gap: 10, alignItems: "start" }}><strong className="mono" style={{ color: "var(--ink-3)" }}>{number}</strong><div><strong>{title}</strong><div style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 3 }}>{copy}</div></div><span className="mono" style={{ fontSize: 10, color: index === 0 && program.integrationReadiness === "CONNECTED" ? "var(--mint-ink)" : "var(--ink-3)" }}>{index === 0 && program.integrationReadiness === "CONNECTED" ? "READY" : "UPCOMING"}</span></div>)}</div></section>
      </div>

      <section className={styles.card} style={{ marginTop: 12 }}><div className={styles.cardHead}><h2>Outcome API binding</h2><Link href="/build/events" className={styles.cardLink}>View events →</Link></div><p className={styles.pageDesc}>The existing Outcome API remains the plumbing underneath this program. Events may remain unbound for legacy integrations; new submissions can include <code>growthProgramId: &quot;{program.id}&quot;</code> after the program&apos;s definition and integration are connected.</p><div className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>Definition: {program.outcomeDefinition.slug} · Campaign policy: {program.policyVersionId} · Settlement: {program.settlementStatus}</div></section>
    </div>
  );
}
