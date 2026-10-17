"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api";
import { DRAFT_EXAMPLE } from "@/lib/operator";
import styles from "./app.module.css";

const EXAMPLE = DRAFT_EXAMPLE.replace(/^Draft:\s*/, "");

export function NewCampaignForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await postJson<{ campaign: { id: string } }>("/api/campaigns/draft", { workspaceId, intentText: text.trim() });
    if (!res.ok) {
      setPending(false);
      return setError(res.error);
    }
    router.push(`/app/campaigns/${res.data.campaign.id}?drafted=1`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className={styles.formGrid}>
      <div className="field">
        <label htmlFor="intent">Campaign description</label>
        <textarea
          id="intent"
          name="intentText"
          className="textarea"
          required
          maxLength={2000}
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Acquire 50 paying customers with a budget of…"
        />
      </div>
      <div className={styles.example}>
        <div>{EXAMPLE}</div>
        <button type="button" onClick={() => setText(EXAMPLE)}>
          Use this example
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending || text.trim().length === 0}>
          {pending ? "Preparing draft…" : "Prepare draft"}
        </button>
      </div>
    </form>
  );
}
