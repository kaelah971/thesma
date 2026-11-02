"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { SafeDefinition, SafeIntegration } from "@/server/services/buildWithThesma";

const OUTCOME_TYPES = ["PURCHASE", "ACTIVATED_USER", "QUALIFIED_REFERRAL", "SUBSCRIPTION_STARTED"] as const;
const PARTICIPANTS = [
  { value: "CREATORS", label: "Creators / KOLs" },
  { value: "REFERRAL_PARTNERS", label: "Affiliates / referral partners" },
] as const;
const EVIDENCE: Record<(typeof OUTCOME_TYPES)[number], string[]> = {
  PURCHASE: ["purchaseId", "amountMicroUsdc", "purchasedAt"],
  ACTIVATED_USER: ["userId", "accountCreatedAt", "onboardingCompletedAt", "firstMeaningfulActionAt"],
  QUALIFIED_REFERRAL: ["referrerId", "referredSubjectId", "qualifiedAt"],
  SUBSCRIPTION_STARTED: ["subscriptionId", "startedAt"],
};

type Props = {
  projectId: string;
  definitions: SafeDefinition[];
  integrations: SafeIntegration[];
};

function toMicroUsdc(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return `${BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))}`;
}

export function DeveloperGrowthProgramForm({ projectId, definitions, integrations }: Props) {
  const router = useRouter();
  const [name, setName] = useState("ProofPilot Partner Growth");
  const [outcomeType, setOutcomeType] = useState<(typeof OUTCOME_TYPES)[number]>("ACTIVATED_USER");
  const [target, setTarget] = useState("100");
  const [budget, setBudget] = useState("500");
  const [cac, setCac] = useState("10");
  const [reward, setReward] = useState("8");
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>(["CREATORS", "REFERRAL_PARTNERS"]);
  const [definitionId, setDefinitionId] = useState("");
  const [integrationId, setIntegrationId] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [operatorMode, setOperatorMode] = useState("SHADOW");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchingDefinitions = useMemo(() => definitions.filter((definition) => definition.active && definition.outcomeType === outcomeType), [definitions, outcomeType]);
  const selectedDefinition = matchingDefinitions.find((definition) => definition.id === definitionId);

  function changeOutcome(next: (typeof OUTCOME_TYPES)[number]) {
    setOutcomeType(next);
    const matching = definitions.find((definition) => definition.active && definition.outcomeType === next);
    setDefinitionId(matching?.id ?? "");
  }

  function toggleParticipant(value: string) {
    setSelectedParticipants((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const budgetMicroUsdc = toMicroUsdc(budget);
    const maxVerifiedCacMicroUsdc = toMicroUsdc(cac);
    const rewardCeilingMicroUsdc = toMicroUsdc(reward);
    if (!budgetMicroUsdc || !maxVerifiedCacMicroUsdc || !rewardCeilingMicroUsdc) {
      setError("Budget, CAC and reward must be USDC amounts with up to 6 decimal places.");
      setPending(false);
      return;
    }
    const response = await fetch("/api/v1/programs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        name,
        objectiveOutcomeType: outcomeType,
        targetOutcomeCount: Number(target),
        budgetMicroUsdc,
        maxVerifiedCacMicroUsdc,
        rewardCeilingMicroUsdc,
        rewardStructure: "PERFORMANCE_ONLY",
        participantTypes: selectedParticipants,
        operatorMode,
        productUrl: productUrl || undefined,
        outcomeDefinitionId: selectedDefinition?.id || undefined,
        integrationId: integrationId || undefined,
      }),
    });
    const data = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok) {
      setError(data?.error?.message ?? "Could not create the Growth Program.");
      return;
    }
    router.push(`/build/programs/${data.program.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
      <div className="field"><label htmlFor="program-name">Program name</label><input id="program-name" className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></div>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}><legend style={{ fontWeight: 700, marginBottom: 8 }}>What do you want to grow?</legend><div className="field"><label htmlFor="program-outcome">Outcome</label><select id="program-outcome" className="input" value={outcomeType} onChange={(event) => changeOutcome(event.target.value as (typeof OUTCOME_TYPES)[number])}>{OUTCOME_TYPES.map((item) => <option key={item}>{item}</option>)}</select></div><p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13 }}>Verification signals: <code>{(selectedDefinition?.requiredEvidenceFields ?? EVIDENCE[outcomeType]).join(", ")}</code></p></fieldset>
      <div className="field"><label htmlFor="program-target">Target verified outcomes</label><input id="program-target" className="input" value={target} onChange={(event) => setTarget(event.target.value)} inputMode="numeric" min="1" type="number" required /></div>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}><legend style={{ fontWeight: 700, marginBottom: 8 }}>Economics <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>(USDC)</span></legend><div className="grid2"><div className="field"><label htmlFor="program-budget">Total program budget</label><input id="program-budget" className="input" value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" required /></div><div className="field"><label htmlFor="program-cac">Maximum verified CAC</label><input id="program-cac" className="input" value={cac} onChange={(event) => setCac(event.target.value)} inputMode="decimal" required /></div></div><div className="field"><label htmlFor="program-reward">Reward ceiling per verified outcome</label><input id="program-reward" className="input" value={reward} onChange={(event) => setReward(event.target.value)} inputMode="decimal" required /></div><p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13 }}>Reward model: <strong>Performance only</strong>. The reward cannot exceed the verified CAC ceiling.</p></fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10 }}><legend style={{ fontWeight: 700, marginBottom: 4 }}>Who can participate?</legend>{PARTICIPANTS.map((item) => <label key={item.value} style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={selectedParticipants.includes(item.value)} onChange={() => toggleParticipant(item.value)} />{item.label}</label>)}<p style={{ margin: 0, color: "var(--ink-2)", fontSize: 13 }}>Enrollment, attribution capture and the hosted participation page are available after creation.</p></fieldset>
      <div className="field"><label htmlFor="program-product-url">Product URL <span style={{ color: "var(--ink-3)" }}>(optional)</span></label><input id="program-product-url" className="input" type="url" value={productUrl} onChange={(event) => setProductUrl(event.target.value)} placeholder="https://proofpilot.example" /><span style={{ color: "var(--ink-2)", fontSize: 13 }}>Used only for referral-link examples and the return-to-product CTA. HTTPS is required in production.</span></div>
      <div className="field"><label htmlFor="program-integration">Product connection <span style={{ color: "var(--ink-3)" }}>(optional)</span></label><select id="program-integration" className="input" value={integrationId} onChange={(event) => setIntegrationId(event.target.value)}><option value="">Connect later</option>{integrations.filter((item) => item.status === "ACTIVE").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span style={{ color: "var(--ink-2)", fontSize: 13 }}>You can create the program before generating an API key.</span></div>
      <div className="field"><label htmlFor="program-operator">Operator mode</label><select id="program-operator" className="input" value={operatorMode} onChange={(event) => setOperatorMode(event.target.value)}><option value="SHADOW">SHADOW — recommend, execute nothing</option><option value="REVIEW">REVIEW — human decision boundary</option><option value="AUTONOMOUS">AUTONOMOUS — authority required</option></select></div>
      {error && <p role="alert" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      <div><button type="submit" className="btn btn-primary" disabled={pending || selectedParticipants.length === 0}>{pending ? "Creating…" : "Create Growth Program"}</button></div>
    </form>
  );
}
