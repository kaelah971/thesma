"use client";

import { useCallback, useEffect, useState } from "react";
import { postJson, serverErrorMessage } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import type { MatchEngineReport, OrganizationCreatorMatch } from "@/server/services/matching";
import type { InvitationDto } from "@/server/services/invitations";

type Tab = "recommended" | "review" | "eligible";

interface InviteState {
  byCreator: Record<string, InvitationDto>;
}

/**
 * Organization creator discovery. Ranking comes only from the Slice 1
 * match service (deterministic, server-side); this panel filters and
 * invites. No client-side scoring anywhere.
 */
export function CreatorMatchesPanel({ campaignId }: { campaignId: string }) {
  const [report, setReport] = useState<MatchEngineReport | null>(null);
  const [invites, setInvites] = useState<InviteState>({ byCreator: {} });
  const [inviteRows, setInviteRows] = useState<InvitationDto[]>([]);
  const [tab, setTab] = useState<Tab>("recommended");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [m, inv] = await Promise.all([
      fetch(`/api/campaigns/${campaignId}/matches`).then((r) => r.json().catch(() => null)),
      fetch(`/api/campaigns/${campaignId}/invitations`).then((r) => r.json().catch(() => null)),
    ]);
    if (m && typeof m.evaluated === "number") setReport(m as MatchEngineReport);
    const rows = Array.isArray(inv?.invitations) ? (inv.invitations as InvitationDto[]) : [];
    const byCreator: Record<string, InvitationDto> = {};
    for (const row of rows) {
      if (!byCreator[row.creatorUserId] || row.status === "INVITED") {
        byCreator[row.creatorUserId] = row;
      }
    }
    setInvites({ byCreator });
    setInviteRows(rows);
    setLoaded(true);
  }, [campaignId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function invite(creatorUserIds: string[]) {
    setPending("bulk");
    setError(null);
    setNotice(null);
    const res = await postJson<{ invited: number; results: { creatorUserId: string; status: string; reason: string | null }[] }>(
      `/api/campaigns/${campaignId}/invitations`,
      creatorUserIds.length === 1 ? { creatorUserId: creatorUserIds[0] } : { creatorUserIds },
    ).catch(() => null);
    setPending(null);
    if (!res || !res.ok) {
      setError(serverErrorMessage(res as never, "Couldn't send invitations. Try again."));
      return;
    }
    const failed = res.data.results.filter((r) => r.status === "FAILED");
    if (failed.length > 0) {
      setError(`${failed.length} invitation${failed.length === 1 ? "" : "s"} failed: ${failed[0].reason ?? "unknown error"}`);
    } else {
      const n = res.data.results.filter((r) => r.status === "INVITED").length;
      const already = res.data.results.filter((r) => r.status === "ALREADY_INVITED").length;
      setNotice(n > 0 ? `Invited ${n} creator${n === 1 ? "" : "s"}.` : already > 0 ? "Already invited." : "No new invitations sent.");
    }
    setSelected([]);
    await load();
  }

  async function cancel(invitationId: string) {
    setPending(invitationId);
    setError(null);
    const res = await fetch(`/api/campaigns/${campaignId}/invitations`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId }),
    })
      .then((r) => r.json().catch(() => null))
      .catch(() => null);
    setPending(null);
    if (!res || res.error) {
      setError(serverErrorMessage(res, "Couldn't cancel the invitation. Try again."));
      return;
    }
    setNotice("Invitation cancelled.");
    await load();
  }

  if (!loaded) return <p style={{ fontSize: 13, opacity: 0.7 }}>Loading creator matches…</p>;
  if (!report || report.evaluated === 0) {
    return <p style={{ fontSize: 13, opacity: 0.7 }}>No registered creators to match yet. Matches appear once creators complete onboarding.</p>;
  }

  const list: OrganizationCreatorMatch[] =
    tab === "recommended" ? report.invite : tab === "review" ? report.review : [...report.invite, ...report.review];
  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(0, 20)));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {(["recommended", "review", "eligible"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={tab === t ? "btn btn-primary btn-sm" : "btn btn-sm"}
            aria-pressed={tab === t}
          >
            {t === "recommended" ? `Recommended (${report.invite.length})` : t === "review" ? `Review (${report.review.length})` : `All eligible (${report.invite.length + report.review.length})`}
          </button>
        ))}
        <span style={{ fontSize: 12.5, opacity: 0.7 }}>
          Offer: {formatUsdc(report.publicBountyMicroUsdc)} USDC per verified outcome
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert" style={{ fontSize: 12.5 }}>
          {error}
        </p>
      )}
      {notice && <p style={{ fontSize: 12.5, opacity: 0.8 }}>{notice}</p>}
      {list.length === 0 ? (
        <p style={{ fontSize: 13, opacity: 0.7 }}>
          {tab === "recommended"
            ? "No high-confidence matches right now. Check Review for close fits."
            : "No matches in this view yet."}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {list.map((m) => {
            const inv = invites.byCreator[m.creatorUserId];
            const isInvited = inv?.status === "INVITED";
            const busy = pending === m.creatorUserId || pending === "bulk";
            return (
              <li
                key={m.creatorUserId}
                style={{ border: "1px solid var(--line, #e5e5e5)", borderRadius: 12, padding: "12px 14px", display: "grid", gap: 6 }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 12px", alignItems: "center" }}>
                  <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={selected.includes(m.creatorUserId)}
                      onChange={() => toggle(m.creatorUserId)}
                      disabled={isInvited || busy}
                      aria-label={`Select ${m.handle ? `@${m.handle}` : "creator"}`}
                    />
                    <strong>{m.handle ? `@${m.handle}` : "Creator"}</strong>
                  </label>
                  {m.creatorType && <span style={{ fontSize: 12, opacity: 0.7 }}>{m.creatorType}</span>}
                  <span className="tnum" style={{ fontSize: 13, fontWeight: 700 }}>
                    {m.matchScore} match
                  </span>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{m.confidence} confidence</span>
                  {isInvited && <span style={{ fontSize: 12, fontWeight: 700 }}>INVITED</span>}
                </div>
                <div style={{ fontSize: 12.5 }}>
                  <strong>Why this creator?</strong>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {m.reasons.map((r) => (
                      <li key={r}>✓ {r}</li>
                    ))}
                    {m.warnings.map((w) => (
                      <li key={w} style={{ opacity: 0.7 }}>· {w}</li>
                    ))}
                  </ul>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Fit {m.fitScore} · Evidence {m.evidenceScore} · Economics {m.economicsScore} · Availability {m.availabilityScore}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {!isInvited ? (
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => invite([m.creatorUserId])}>
                      {busy ? "Working…" : "Invite creator"}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={pending === inv.id} onClick={() => cancel(inv.id)}>
                      {pending === inv.id ? "Working…" : "Cancel invitation"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {selected.length > 0 && (
        <div>
          <button type="button" className="btn btn-primary" disabled={pending === "bulk"} onClick={() => invite(selected)}>
            {pending === "bulk" ? "Inviting…" : `Invite selected (${selected.length})`}
          </button>
        </div>
      )}
      {inviteRows.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, margin: "4px 0 8px" }}>Invitations</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {inviteRows.map((row) => (
              <li key={row.id} style={{ fontSize: 12.5, display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "center" }}>
                <strong>{row.creatorHandle ? `@${row.creatorHandle}` : row.creatorUserId.slice(0, 8)}</strong>
                <span>
                  {row.status === "ACCEPTED"
                    ? row.acceptedBy === "AGENT"
                      ? "Accepted by creator agent"
                      : "Accepted by creator"
                    : row.status === "INVITED"
                      ? "INVITED"
                      : row.status === "DECLINED"
                        ? "Declined"
                        : "Cancelled"}
                </span>
                {row.status === "INVITED" && (
                  <button type="button" className="btn btn-sm" disabled={pending === row.id} onClick={() => cancel(row.id)}>
                    {pending === row.id ? "Working…" : "Cancel"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
