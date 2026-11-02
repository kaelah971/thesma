"use client";

import { useState } from "react";
import type { SafeGrowthProgramParticipant, SafeGrowthProgramAnalytics } from "@/server/services/growthProgramParticipation";

interface Candidate {
  creatorUserId: string;
  creatorHandle?: string | null;
  handle?: string | null;
  matchScore?: number;
  confidence?: string;
  reliability?: { level?: string; score?: number };
}

export function DeveloperProgramParticipantsPanel({
  projectId,
  programId,
  participationStatus,
  operatorMode,
  participants: initialParticipants,
  analytics: initialAnalytics,
}: {
  projectId: string;
  programId: string;
  participationStatus: "CLOSED" | "INVITE_ONLY" | "OPEN";
  operatorMode: "SHADOW" | "REVIEW" | "AUTONOMOUS";
  participants: SafeGrowthProgramParticipant[];
  analytics: SafeGrowthProgramAnalytics;
}) {
  const [participants, setParticipants] = useState(initialParticipants);
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [mode, setMode] = useState(participationStatus);
  const [participantType, setParticipantType] = useState<"CREATOR" | "REFERRAL_PARTNER">("CREATOR");
  const [creatorUserId, setCreatorUserId] = useState("");
  const [externalPartnerId, setExternalPartnerId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const shadowBlocksInvites = operatorMode === "SHADOW" && mode === "INVITE_ONLY";

  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message ?? "Could not update participants.");
    return data;
  }

  async function changeMode(next: typeof mode) {
    setPending(true);
    setError(null);
    try {
      const data = await request(`/api/v1/programs/${programId}/participation`, { method: "POST", body: JSON.stringify({ projectId, participationStatus: next }) });
      setMode(data.program.participationStatus);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not change participation mode."); }
    setPending(false);
  }

  async function addParticipant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await request(`/api/v1/programs/${programId}/participants`, { method: "POST", body: JSON.stringify({ projectId, participantType, creatorUserId: participantType === "CREATOR" ? creatorUserId : undefined, externalPartnerId: participantType === "REFERRAL_PARTNER" ? externalPartnerId : undefined, displayName: participantType === "REFERRAL_PARTNER" ? displayName : undefined, participationSource: mode === "OPEN" ? "OPEN_JOIN" : "INVITE" }) });
      const refreshed = await request(`/api/v1/programs/${programId}/participants?projectId=${encodeURIComponent(projectId)}`);
      setParticipants(refreshed.participants); setAnalytics(refreshed.analytics);
      setCreatorUserId(""); setExternalPartnerId(""); setDisplayName("");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not add participant."); }
    setPending(false);
  }

  async function transition(participantId: string, action: "APPROVE" | "PAUSE" | "REMOVE") {
    setPending(true);
    setError(null);
    try {
      const data = await request(`/api/v1/programs/${programId}/participants/${participantId}`, { method: "POST", body: JSON.stringify({ projectId, action }) });
      setParticipants((current) => current.map((item) => item.id === participantId ? data.participant : item));
      const refreshed = await request(`/api/v1/programs/${programId}/participants?projectId=${encodeURIComponent(projectId)}`);
      setParticipants(refreshed.participants); setAnalytics(refreshed.analytics);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not update participant."); }
    setPending(false);
  }

  async function discover() {
    setPending(true); setError(null);
    try {
      const data = await request(`/api/v1/programs/${programId}/participants/candidates?projectId=${encodeURIComponent(projectId)}`);
      const groups = ["invite", "review", "skip", "notEligible"] as const;
      setCandidates(groups.flatMap((group) => (data.candidates?.[group] ?? [])).slice(0, 12));
    } catch (err) { setError(err instanceof Error ? err.message : "Creator discovery is unavailable."); }
    setPending(false);
  }

  return (
    <section className="card" style={{ marginTop: 12 }}>
      <div className="cardHead"><h2>Participants</h2><span className="cardLink">{analytics.activeParticipants} active · {analytics.invited} invited · {analytics.pendingReview} pending</span></div>
      <div className="grid2">
        <div style={{ display: "grid", gap: 14 }}>
          <div className="field"><label htmlFor="participation-mode">Participation mode</label><select id="participation-mode" className="input" value={mode} disabled={pending} onChange={(event) => void changeMode(event.target.value as typeof mode)}><option value="CLOSED">CLOSED</option><option value="INVITE_ONLY">INVITE_ONLY</option><option value="OPEN">OPEN</option></select></div>
          <form onSubmit={addParticipant} style={{ display: "grid", gap: 12 }}>
            <strong>Add participant</strong>
            <div className="field"><label htmlFor="participant-type">Participant type</label><select id="participant-type" className="input" value={participantType} onChange={(event) => setParticipantType(event.target.value as typeof participantType)}><option value="CREATOR">CREATOR</option><option value="REFERRAL_PARTNER">REFERRAL_PARTNER</option></select></div>
            {participantType === "CREATOR" ? <div className="field"><label htmlFor="creator-user-id">Creator user id</label><input id="creator-user-id" className="input" value={creatorUserId} onChange={(event) => setCreatorUserId(event.target.value)} placeholder="creator user id" required /></div> : <><div className="field"><label htmlFor="external-partner-id">External partner id</label><input id="external-partner-id" className="input" value={externalPartnerId} onChange={(event) => setExternalPartnerId(event.target.value)} placeholder="partner_123" required /></div><div className="field"><label htmlFor="partner-display-name">Display name</label><input id="partner-display-name" className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Acme Ambassador" required /></div></>}
            <button type="submit" className="btn btn-sm" disabled={pending || mode === "CLOSED" || shadowBlocksInvites}>{shadowBlocksInvites ? "Shadow blocks invitations" : mode === "OPEN" ? "Request participant" : "Invite participant"}</button>
          </form>
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}><strong>Creator discovery</strong><p style={{ color: "var(--ink-2)", fontSize: 13, margin: "6px 0 10px" }}>Reuse Thesma&apos;s capability graph and deterministic match score. Discovery is advisory; invitations never send an external notification and remain blocked in Shadow.</p><button type="button" className="btn btn-sm" onClick={() => void discover()} disabled={pending}>Find creator matches</button></div>
          {candidates.length > 0 && <div className="stack">{candidates.map((candidate) => <div key={candidate.creatorUserId} style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}><strong>{candidate.creatorHandle ?? candidate.handle ?? candidate.creatorUserId}</strong><div className="mono" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>score {candidate.matchScore ?? 0} · {candidate.confidence ?? "LOW"}{candidate.reliability?.level ? ` · ${candidate.reliability.level}` : ""}</div><button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => { setParticipantType("CREATOR"); setCreatorUserId(candidate.creatorUserId); }} disabled={pending}>Use for invite</button></div>)}</div>}
        </div>
        <div className="stack">
          {participants.length === 0 ? <p className="pageDesc">No participants yet. Closed means no new participant can be added.</p> : participants.map((participant) => <div key={participant.id} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{participant.handle ? `@${participant.handle}` : participant.displayName}</strong><span className="mono" style={{ fontSize: 11 }}>{participant.status}</span></div><div className="mono" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>{participant.participantType} · {participant.stats.verifiedOutcomes} verified · {participant.stats.attributedEvents} attributed</div>{participant.attribution ? <div style={{ fontSize: 13, marginTop: 5 }}>Attribution: <code>{participant.attribution.code}</code><br /><span style={{ color: "var(--ink-2)" }}>YOUR_PRODUCT_URL?ref={participant.attribution.code}</span></div> : <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 5 }}>Attribution identity pending activation.</div>}{participant.status === "INVITED" || participant.status === "APPLIED" || participant.status === "PAUSED" ? <button type="button" className="btn btn-sm" style={{ marginTop: 8, marginRight: 6 }} onClick={() => void transition(participant.id, "APPROVE")} disabled={pending}>Approve / activate</button> : null}{participant.status === "ACTIVE" ? <button type="button" className="btn btn-sm" style={{ marginTop: 8, marginRight: 6 }} onClick={() => void transition(participant.id, "PAUSE")} disabled={pending}>Pause</button> : null}{participant.status !== "REMOVED" ? <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => void transition(participant.id, "REMOVE")} disabled={pending}>Remove</button> : null}</div>)}
        </div>
      </div>
      <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 12, display: "flex", gap: 18, flexWrap: "wrap", color: "var(--ink-2)", fontSize: 13 }}><span>Attributed events: <strong>{analytics.attributedEvents}</strong></span><span>Verified attributed: <strong>{analytics.verifiedAttributedOutcomes}</strong></span><span>Unattributed: <strong>{analytics.unattributedOutcomes}</strong></span><span>Conflicts: <strong>{analytics.attributionConflicts}</strong></span></div>
      {error && <p role="alert" style={{ color: "var(--danger)", margin: "12px 0 0" }}>{error}</p>}
    </section>
  );
}
