"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api";
import styles from "./app.module.css";

export function CreateWorkspaceForm({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const category = String(form.get("category") ?? "").trim();
    setPending(true);
    setError(null);
    const res = await postJson("/api/workspaces", { name: String(form.get("name") ?? "").trim(), category: category || null });
    setPending(false);
    if (!res.ok) return setError(res.error);
    formEl.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className={styles.formGrid} data-compact={compact || undefined}>
      <div className="field">
        <label htmlFor="ws-name">Company name</label>
        <input id="ws-name" name="name" required maxLength={100} className="input" placeholder="Northwind Goods" />
      </div>
      <div className="field">
        <label htmlFor="ws-category">Category (optional)</label>
        <input id="ws-category" name="category" maxLength={100} className="input" placeholder="e.g. Apparel" />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create workspace"}
        </button>
      </div>
    </form>
  );
}
