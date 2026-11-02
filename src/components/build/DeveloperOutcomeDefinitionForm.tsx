"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const TYPES = ["PURCHASE", "ACTIVATED_USER", "QUALIFIED_REFERRAL", "SUBSCRIPTION_STARTED"] as const;
const REQUIRED_FIELDS: Record<(typeof TYPES)[number], string[]> = {
  PURCHASE: ["purchaseId", "amountMicroUsdc", "purchasedAt"],
  ACTIVATED_USER: ["userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt"],
  QUALIFIED_REFERRAL: ["referrerId", "referredSubjectId", "qualifiedAt"],
  SUBSCRIPTION_STARTED: ["subscriptionId", "startedAt"],
};

export function DeveloperOutcomeDefinitionForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [type, setType] = useState<(typeof TYPES)[number]>("ACTIVATED_USER");
  const [slug, setSlug] = useState("activated-user");
  const [name, setName] = useState("Activated user");
  const [value, setValue] = useState("8000000");
  const [holdSeconds, setHoldSeconds] = useState("86400");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createDefinition(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const requiredEvidenceFields = REQUIRED_FIELDS[type];
    const response = await fetch("/api/v1/outcomes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, slug, name, outcomeType: type, unitValueMicroUsdc: value, holdSeconds: Number(holdSeconds), requiredEvidenceFields }),
    });
    const data = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(data?.error?.message ?? "Could not create the outcome definition.");
      return;
    }
    router.refresh();
  }

  function changeType(next: (typeof TYPES)[number]) {
    setType(next);
    if (next === "ACTIVATED_USER") {
      setSlug("activated-user");
      setName("Activated user");
    } else {
      const nextSlug = next.toLowerCase().replaceAll("_", "-");
      setSlug(nextSlug);
      setName(next.replaceAll("_", " ").toLowerCase().replace(/(^| )\w/g, (letter) => letter.toUpperCase()));
    }
  }

  return (
    <form onSubmit={createDefinition} style={{ display: "grid", gap: 14, maxWidth: 680 }}>
      <div className="field"><label htmlFor="outcome-type">Outcome type</label><select id="outcome-type" className="input" value={type} onChange={(event) => changeType(event.target.value as (typeof TYPES)[number])}>{TYPES.map((item) => <option key={item}>{item}</option>)}</select></div>
      <div className="field"><label htmlFor="outcome-slug">Slug</label><input id="outcome-slug" className="input" value={slug} onChange={(event) => setSlug(event.target.value)} required maxLength={80} /></div>
      <div className="field"><label htmlFor="outcome-name">Display name</label><input id="outcome-name" className="input" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></div>
      <div className="field"><label htmlFor="outcome-value">Value (micro-USDC)</label><input id="outcome-value" className="input" value={value} onChange={(event) => setValue(event.target.value)} inputMode="numeric" required /></div>
      <div className="field"><label htmlFor="outcome-hold">Hold (seconds)</label><input id="outcome-hold" className="input" value={holdSeconds} onChange={(event) => setHoldSeconds(event.target.value)} inputMode="numeric" required /></div>
      <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13 }}>Required evidence: <code>{REQUIRED_FIELDS[type].join(", ")}</code></p>
      {error && <p role="alert" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      <div><button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Creating…" : "Create outcome definition"}</button></div>
    </form>
  );
}
