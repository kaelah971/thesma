"use client";

import Link from "next/link";
import { useState } from "react";
import { buildReferralUrl } from "@/sdk/browser";
import type { PublicGrowthProgram } from "@/server/services/publicGrowthPrograms";
import styles from "@/components/app/app.module.css";

type PublicParticipant = {
  id: string;
  participantType: "CREATOR" | "REFERRAL_PARTNER";
  displayName: string;
  handle: string | null;
  status: string;
  attribution: { id: string; code: string; status: string } | null;
};

function microUsdc(value: string): string {
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""} USDC`;
}

export function HostedGrowthProgram({ program }: { program: PublicGrowthProgram }) {
  const [participantType, setParticipantType] = useState<"REFERRAL_PARTNER" | "CREATOR">(program.participantTypes.includes("REFERRAL_PARTNERS") ? "REFERRAL_PARTNER" : "CREATOR");
  const [externalPartnerId, setExternalPartnerId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [participant, setParticipant] = useState<PublicParticipant | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/public/programs/${encodeURIComponent(program.slug)}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participantType, externalPartnerId: participantType === "REFERRAL_PARTNER" ? externalPartnerId : undefined, displayName: participantType === "REFERRAL_PARTNER" ? displayName : undefined, handle: handle || undefined }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? "Could not request participation.");
      setParticipant(data.participant);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request participation.");
    } finally {
      setPending(false);
    }
  }

  const activeReferralUrl = participant?.attribution?.code && program.productUrl
    ? buildReferralUrl({ destination: program.productUrl, referralCode: participant.attribution.code })
    : null;
  const statusCopy = program.participationStatus === "OPEN" ? "OPEN — requests are reviewed before activation" : program.participationStatus === "INVITE_ONLY" ? "INVITE ONLY — ask the program owner for an invitation" : "CLOSED — new participation is unavailable";

  return (
    <main className={styles.appShell} style={{ maxWidth: 980, margin: "0 auto", padding: "48px 24px" }}>
      <div className={styles.pageEyebrow}>BUILD WITH THESMA · PARTNER PROGRAM</div>
      <div className={styles.pageHeader} style={{ marginBottom: 20 }}><div className={styles.pageHeaderText}><h1>{program.name}</h1><p className={styles.pageDesc}>A verified {program.objectiveOutcomeType.replaceAll("_", " ").toLowerCase()} program powered by Thesma.</p></div><span className="badge badge-blue">{program.operatorMode}</span></div>
      <div className={styles.grid2}>
        <section className={styles.card} data-tone="cream"><div className={styles.cardHead}><h2>What counts</h2><span className="mono" style={{ fontSize: 11 }}>{program.status}</span></div><p style={{ fontSize: 18, fontWeight: 700 }}>{program.targetOutcomeCount} verified outcomes</p><p className={styles.pageDesc}>{program.verification.outcomeName}</p><div className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>Evidence: {program.verification.evidenceFields.join(", ")}<br />Hold: {program.verification.holdSeconds}s</div></section>
        <section className={styles.card} data-tone="mint"><div className={styles.cardHead}><h2>Terms</h2><span className="mono" style={{ fontSize: 11 }}>BOUNDED</span></div><p style={{ fontSize: 22, fontWeight: 700 }}>Up to {microUsdc(program.rewardCeilingMicroUsdc)}</p><p className={styles.pageDesc}>{program.rewardStructure.replaceAll("_", " ").toLowerCase()} · participant types: {program.participantTypes.join(" + ")}</p><p className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>Attributed ≠ verified · verified ≠ paid</p></section>
      </div>
      <section className={styles.card} style={{ marginTop: 12 }}><div className={styles.cardHead}><h2>Participation</h2><span className="mono" style={{ fontSize: 11 }}>{statusCopy}</span></div>{program.joinable ? <form onSubmit={join} style={{ display: "grid", gap: 12, maxWidth: 520 }}><div className="field"><label htmlFor="hosted-participant-type">Join as</label><select id="hosted-participant-type" className="input" value={participantType} onChange={(event) => setParticipantType(event.target.value as typeof participantType)}>{program.participantTypes.includes("REFERRAL_PARTNERS") && <option value="REFERRAL_PARTNER">Referral partner</option>}{program.participantTypes.includes("CREATORS") && <option value="CREATOR">Creator</option>}</select></div>{participantType === "REFERRAL_PARTNER" ? <><div className="field"><label htmlFor="hosted-partner-id">Your product partner ID</label><input id="hosted-partner-id" className="input" value={externalPartnerId} onChange={(event) => setExternalPartnerId(event.target.value)} placeholder="partner_123" required /></div><div className="field"><label htmlFor="hosted-display-name">Display name</label><input id="hosted-display-name" className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Your name or organization" required /></div></> : <p className={styles.pageDesc}>Creator participation reuses your existing Thesma creator identity. <Link href={`/signin?returnTo=${encodeURIComponent(`/g/${program.slug}`)}`}>Sign in to continue</Link>.</p>}<div className="field"><label htmlFor="hosted-handle">Public handle <span style={{ color: "var(--ink-3)" }}>(optional)</span></label><input id="hosted-handle" className="input" value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="your-handle" /></div><button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Requesting…" : participantType === "CREATOR" ? "Request as creator" : "Join as referral partner"}</button></form> : <p className={styles.pageDesc}>{statusCopy}. This page does not create an invitation or bypass program approval.</p>}{error && <p role="alert" style={{ color: "var(--danger)" }}>{error}</p>}{participant && <div className={styles.card} data-tone="lav" style={{ marginTop: 20, maxWidth: 640 }}><div className={styles.cardHead}><h2>{participant.status === "ACTIVE" ? "You're in." : "Request received."}</h2><span className="mono" style={{ fontSize: 11 }}>{participant.status}</span></div>{participant.attribution?.code ? <><p className={styles.pageDesc}>Your attribution identity is active.</p><div className="mono" style={{ fontSize: 13 }}>Referral code: <strong>{participant.attribution.code}</strong>{activeReferralUrl && <><br />Referral link: <a href={activeReferralUrl}>{activeReferralUrl}</a></>}</div></> : <p className={styles.pageDesc}>The program owner must activate this participant before an attribution identity is issued.</p>}</div>}</section>
      <section className={styles.card} style={{ marginTop: 12 }}><div className={styles.cardHead}><h2>Truth in the lifecycle</h2></div><div className={styles.stack}><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Attribution</strong><div className="mono" style={{ fontSize: 12, marginTop: 4 }}>A referral code connects a product event to a participant.</div></div><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Verification</strong><div className="mono" style={{ fontSize: 12, marginTop: 4 }}>Thesma evaluates evidence against the bounded {program.objectiveOutcomeType} policy.</div></div><div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>Settlement</strong><div className="mono" style={{ fontSize: 12, marginTop: 4 }}>SHADOW · NOT FUNDED · no payout or settlement is promised.</div></div></div></section>
      {program.productUrl && <p style={{ marginTop: 18, fontSize: 13, color: "var(--ink-2)" }}>Product: <a href={program.productUrl}>{program.productUrl}</a></p>}
      <p style={{ marginTop: 18, fontSize: 12, color: "var(--ink-3)" }}><Link href="/">Powered by Thesma</Link></p>
    </main>
  );
}
