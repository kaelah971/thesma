import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HomeShell } from "@/components/start/HomeShell";
import { getSessionUser } from "@/server/auth/guard";
import { getPersonaByUserId } from "@/server/services/personas";
import { listUserWorkspaces } from "@/server/services/workspaces";
import { createProductionOutcomeApiService } from "@/server/services/buildWithThesma";
import { DeveloperIntegrationsPanel } from "@/components/start/DeveloperIntegrationsPanel";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = { title: "Build with Thesma" };

const STEPS = [
  {
    n: "01",
    title: "Define the outcome",
    body: "Register a bounded business outcome such as ACTIVATED_USER and pin its USDC value, evidence schema and hold policy.",
    status: "Available",
  },
  {
    n: "02",
    title: "Submit evidence",
    body: "Send a stable subject, event id, timestamp and JSON evidence with an API key and Idempotency-Key.",
    status: "Available",
  },
  {
    n: "03",
    title: "Thesma verifies",
    body: "The adapter validates and normalizes evidence before the deterministic outcome policy decides VERIFIED or REVIEW.",
    status: "Available",
  },
  {
    n: "04",
    title: "Policy, hold, receipt",
    body: "The decision records its reasons, policy snapshot, hold state and settlement eligibility in an immutable receipt trail.",
    status: "Available",
  },
  {
    n: "05",
    title: "Settlement stays bounded",
    body: "VERIFIED is not PAID. Budget, authority, holds and reconciliation still govern any future settlement; Shadow Mode executes nothing.",
    status: "Existing infrastructure",
  },
];

export default async function BuildHomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/signin?next=/build");

  const row = await getPersonaByUserId(user.userId);
  if (row && !row.onboardingCompletedAt) redirect("/onboarding/developer");
  if (!row) redirect("/onboarding/developer");
  const workspaces = await listUserWorkspaces(user.userId);
  const workspace = workspaces.find((item) => item.role === "ORGANIZATION_OWNER");
  const integrations = workspace
    ? await createProductionOutcomeApiService().listIntegrations(workspace.workspace.id).catch(() => [])
    : [];

  return (
    <HomeShell
      eyebrow="Developer"
      title="Build with Thesma"
      copy="Use Thesma's verification, receipts and payout infrastructure in your own product."
      homeHref="/build"
    >
      {row?.project && (
        <p style={{ marginTop: 4, fontSize: 13.5, color: "var(--ink-2)" }}>
          You&apos;re building: {row.project}
        </p>
      )}
      <div className={styles.steps} style={{ marginTop: 18 }}>
        {STEPS.map((s) => (
          <div key={s.n} className={styles.step}>
            <span className={styles.stepNum}>{s.n}</span>
            <div>
              <h3>
                {s.title} · <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>{s.status}</span>
              </h3>
              <p>{s.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className={styles.homeGrid}>
        {workspace ? (
          <DeveloperIntegrationsPanel workspaceId={workspace.workspace.id} initialIntegrations={integrations} />
        ) : (
          <section className={styles.panel}>
            <h2>Choose an organization workspace</h2>
            <p>API integrations are organization-scoped. Create an organization workspace first, then return here to issue a key.</p>
            <Link href="/onboarding/organization" className="btn btn-primary btn-sm">Create workspace</Link>
          </section>
        )}
        <section className={styles.panel}>
          <h2>Developer quickstart</h2>
          <p>Keys are placeholders here; the dashboard shows a real key only once after creation.</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6, marginTop: 14 }}>{`curl -X POST https://your-thesma-host/api/v1/outcomes/activated-user/events \\
  -H 'Authorization: Bearer ths_api_…' \\
  -H 'Idempotency-Key: activation_001_v1' \\
  -H 'Content-Type: application/json' \\
  --data '{
    "externalEventId": "activation_001",
    "externalSubjectId": "user_123",
    "occurredAt": "2026-01-15T12:00:00Z",
    "evidence": {
      "userId": "user_123",
      "accountCreatedAt": "2026-01-15T11:00:00Z",
      "onboardingCompletedAt": "2026-01-15T11:20:00Z",
      "firstMeaningfulActionAt": "2026-01-15T12:00:00Z"
    }
  }'`}</pre>
          <div className={styles.panelActions}>
            <Link href="/markets" className="btn btn-primary btn-sm">Inspect live markets</Link>
            <Link href="/markets#completed" className="btn btn-sm">View receipts</Link>
          </div>
        </section>
      </div>
    </HomeShell>
  );
}
