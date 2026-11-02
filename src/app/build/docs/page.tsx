import type { Metadata } from "next";
import { headers } from "next/headers";
import { getDeveloperContext } from "../data";
import styles from "@/components/app/app.module.css";

export const metadata: Metadata = { title: "Docs and quickstart" };

export default async function DeveloperDocsPage() {
  await getDeveloperContext();
  const requestHeaders = await headers();
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "thesma.vercel.app").split(",")[0]!.trim();
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${protocol}://${host}`;
  return (
    <div>
      <header className={styles.pageHeader}><div className={styles.pageHeaderText}><div className={styles.pageEyebrow}>DEVELOPER QUICKSTART</div><h1>Build with Thesma</h1><p className={styles.pageDesc}>Define the outcome, submit evidence, inspect the receipt. No financial setup or chain connection is required for API intake.</p></div></header>
      <div className={styles.grid2}>
        <section className={styles.card} data-tone="cream"><div className={styles.cardHead}><h2>1. Register an outcome</h2></div><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{`curl -X POST ${origin}/api/v1/outcomes \\
  -H 'Authorization: Bearer ths_api_<your-key>' \\
  -H 'Content-Type: application/json' \\
  --data '{
    "slug": "activated-user",
    "name": "Activated user",
    "outcomeType": "ACTIVATED_USER",
    "unitValueMicroUsdc": "8000000",
    "evidenceSchemaVersion": 1,
    "requiredEvidenceFields": ["userId","accountCreatedAt","onboardingCompletedAt","firstMeaningfulActionAt"],
    "holdSeconds": 86400
  }'`}</pre></section>
        <section className={styles.card}><div className={styles.cardHead}><h2>2. Submit an event</h2></div><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.6 }}>{`curl -X POST ${origin}/api/v1/outcomes/activated-user/events \\
  -H 'Authorization: Bearer ths_api_<your-key>' \\
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
  }'`}</pre></section>
      </div>
      <section className={styles.card}><div className={styles.cardHead}><h2>3. Read the receipt</h2></div><p className={styles.pageDesc}>Use <code>GET {origin}/api/v1/outcomes/events/&lt;event-id&gt;</code>. Retrying the same request with the same Idempotency-Key returns the original event. A different payload returns <code>IDEMPOTENCY_CONFLICT</code>; reusing an external event id returns <code>REPLAY_DETECTED</code>.</p><p className={styles.pageDesc}>The receipt preserves <code>SUBMITTED ≠ VERIFIED</code>, <code>VERIFIED ≠ PAID</code> and <code>SHADOW_BLOCKED</code> when the project is in Shadow Mode.</p></section>
    </div>
  );
}
