import type { SafeGrowthProgram } from "@/server/services/growthPrograms";
import styles from "@/components/app/app.module.css";

function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://thesma.vercel.app").replace(/\/$/, "");
}

export function DeveloperProgramIntegrationPanel({ program }: { program: SafeGrowthProgram }) {
  const hostedUrl = `${baseUrl()}/g/${encodeURIComponent(program.slug)}`;
  const destination = program.productUrl ?? "https://your-product.example";
  const browserSnippet = `import { createThesmaBrowserClient } from "@thesma/sdk/browser";

const thesma = createThesmaBrowserClient({
  baseUrl: "${baseUrl()}",
  program: "${program.slug}"
});

const attribution = await thesma.captureAttribution();`;
  const serverSnippet = `import { createThesmaServerClient } from "@thesma/sdk/server";

const thesma = createThesmaServerClient({
  baseUrl: "${baseUrl()}",
  apiKey: process.env.THESMA_API_KEY
});

const result = await thesma.submitOutcomeEvent({
  program: "${program.slug}",
  outcome: "${program.outcomeDefinition.slug}",
  externalEventId: "activation_001",
  externalSubjectId: "user_123",
  attributionId: "ref_from_browser",
  occurredAt: new Date(),
  evidence: { /* product-owned evidence */ },
  idempotencyKey: "${program.slug}:activation_001"
});`;
  const referralExample = `${destination}${destination.includes("?") ? "&" : "?"}ref=ref_<participant-code>`;

  return (
    <section className={styles.card} style={{ marginTop: 12 }}>
      <div className={styles.cardHead}><h2>Integrate this program</h2><span className="badge badge-blue">SDK AVAILABLE</span></div>
      <p className={styles.pageDesc}>Use the hosted page for a fast start, the browser client for safe attribution capture, and the server client for API-key-authenticated outcome submission. API keys never belong in browser code.</p>
      <div className={styles.stack}>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><strong>Hosted participation</strong><div className="mono" style={{ fontSize: 12, marginTop: 6, overflowWrap: "anywhere" }}>{hostedUrl}</div><div style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 5 }}>OPEN requests, INVITE_ONLY explanation, CLOSED truth. No wallet, payout or settlement action.</div></div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><strong>Referral-link example</strong><div className="mono" style={{ fontSize: 12, marginTop: 6, overflowWrap: "anywhere" }}>{referralExample}</div></div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><strong>Browser attribution</strong><pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{browserSnippet}</pre></div>
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><strong>Server outcome submission</strong><pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{serverSnippet}</pre><div style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 6 }}>Set <code>THESMA_API_KEY</code> on the external product server only. Reuse the same idempotency key when retrying one economic event.</div></div>
      </div>
    </section>
  );
}
