"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeveloperProjectForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const projectName = name.trim();
    if (!projectName) {
      setError("Add a project name to continue.");
      return;
    }
    setPending(true);
    setError(null);
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: projectName, category: "developer" }),
    });
    const data = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(data?.error?.message ?? "Could not create the project.");
      return;
    }
    router.replace("/build");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14, maxWidth: 520 }}>
      <div className="field">
        <label htmlFor="developer-project-name">Project name</label>
        <input id="developer-project-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="ProofPilot Labs" maxLength={100} required aria-invalid={Boolean(error)} aria-describedby={error ? "developer-project-error" : undefined} />
      </div>
      {error && <p id="developer-project-error" role="alert" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Creating…" : "Create developer project"}</button>
      </div>
    </form>
  );
}
