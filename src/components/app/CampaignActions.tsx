"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api";

/** Policy lifecycle actions via the existing review/approve endpoints. */
export function CampaignActions({
  campaignId,
  state,
  version,
  isOwner,
  ready,
}: {
  campaignId: string;
  state: string;
  version: number;
  isOwner: boolean;
  ready: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Owners approve their own complete draft directly — no self-review
  // roundtrip. Non-owners still request review; only owners can approve.
  const action =
    state === "DRAFT" && isOwner
      ? { path: "approve", label: "Approve campaign", enabled: ready, hint: ready ? "Approving opens creator matching — funding still comes next." : "Complete the required fields first." }
      : state === "DRAFT"
        ? { path: "review", label: "Request review", enabled: ready, hint: ready ? null : "Complete the required fields first." }
        : state === "REVIEW"
          ? { path: "approve", label: "Approve policy", enabled: isOwner, hint: isOwner ? null : "Only the organization owner can approve." }
          : null;
  if (!action) return null;

  async function run() {
    if (!action) return;
    setPending(true);
    setError(null);
    const res = await postJson(`/api/campaigns/${campaignId}/${action.path}`, { expectedVersion: version });
    setPending(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
  }

  return (
    <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
      <button type="button" className="btn btn-primary" onClick={run} disabled={pending || !action.enabled}>
        {pending ? "Working…" : action.label}
      </button>
      {(error || action.hint) && (
        <p className={error ? "form-error" : "form-note"} role={error ? "alert" : undefined}>
          {error ?? action.hint}
        </p>
      )}
    </div>
  );
}
