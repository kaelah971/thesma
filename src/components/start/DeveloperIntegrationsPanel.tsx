"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./start.module.css";

interface Integration {
  id: string;
  name: string;
  status: "ACTIVE" | "REVOKED";
  apiKeyId: string;
  apiKeyPrefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export function DeveloperIntegrationsPanel({ workspaceId, initialIntegrations }: { workspaceId: string; initialIntegrations: Integration[] }) {
  const router = useRouter();
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  async function createIntegration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNewKey(null);
    const response = await fetch("/api/v1/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, name }),
    });
    const data = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(data?.error?.message ?? "Could not create integration.");
      return;
    }
    setIntegrations((current) => [data.integration, ...current]);
    setNewKey(data.apiKey);
    setName("");
    router.refresh();
  }

  async function revoke(id: string) {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/integrations/${id}`, {
      method: "DELETE",
      headers: { "x-thesma-workspace-id": workspaceId },
    });
    const data = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(data?.error?.message ?? "Could not revoke integration.");
      return;
    }
    setIntegrations((current) => current.map((item) => item.id === id ? data.integration : item));
    router.refresh();
  }

  return (
    <section className={styles.panel} aria-labelledby="developer-integrations-title">
      <h2 id="developer-integrations-title">Integrations &amp; API keys</h2>
      <p>Use one key per product or environment. Keys are shown once and stored only as a digest.</p>
      <form onSubmit={createIntegration} className={styles.panelActions} style={{ alignItems: "end", flexWrap: "wrap" }}>
        <label htmlFor="integration-name" style={{ flex: "1 1 240px" }}>
          <span className="sr-only">Integration name</span>
          <input id="integration-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme Productivity" maxLength={120} required aria-invalid={Boolean(error)} aria-describedby={error ? "integration-error" : undefined} />
        </label>
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>{pending ? "Creating…" : "Create integration"}</button>
      </form>
      {newKey && (
        <div role="status" style={{ marginTop: 14, padding: 14, border: "1px solid var(--line-strong)", background: "var(--surface-2)" }}>
          <strong>Store this key now. Thesma will not show it again.</strong>
          <code style={{ display: "block", marginTop: 8, overflowWrap: "anywhere" }}>{newKey}</code>
          <button className="btn btn-sm" type="button" style={{ marginTop: 10 }} onClick={() => void navigator.clipboard?.writeText(newKey)}>Copy key</button>
        </div>
      )}
      {error && <p id="integration-error" role="alert" style={{ color: "var(--danger)", marginTop: 12 }}>{error}</p>}
      {integrations.length === 0 ? (
        <div className={styles.panelEmpty}>No integrations yet. Create one to receive an organization-scoped API key.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "18px 0 0", display: "grid", gap: 10 }}>
          {integrations.map((integration) => (
            <li key={integration.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div>
                <strong>{integration.name}</strong>
                <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>{integration.apiKeyPrefix} · {integration.status}</div>
              </div>
              {integration.status === "ACTIVE" && <button className="btn btn-sm" type="button" onClick={() => void revoke(integration.id)} disabled={pending}>Revoke</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
