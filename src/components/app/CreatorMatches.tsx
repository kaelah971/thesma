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

interface HybridForm {
  structure: string;
  baseUsdc: string;
  deliverableKind: string;
  deliverableTitle: string;
  milestones: string;
  allocationCount: string;
}

const EMPTY_HYBRID: HybridForm = {
  structure: "PERFORMANCE_ONLY",
  baseUsdc: "",
  deliverableKind: "content",
  deliverableTitle: "",
  milestones: "",
  allocationCount: "5",
};

/**
 * Empty-state copy: never claim "nobody completed onboarding" unless zero
 * creator personas were actually evaluated. Zero registered creators and
 * zero eligible matches are different truths with different next actions.
 */
export function matchesEmptyMessage(evaluated: number, eligibleCount: number): string | null {
  if (eligibleCount > 0) return null;
  if (evaluated === 0) return "No registered creators to match yet. Matches appear once creators complete onboarding.";
  return "No eligible matches for this campaign yet.";
}

/** Client-side max-exposure preview (server re-validates exactly). */
function previewMaxTotal(f: HybridForm, bountyMicro: string): string | null {
  try {
    const toMicro = (usdc: string) => BigInt(Math.round(Number(usdc) * 1_000_000));
    const bounty = BigInt(bountyMicro);
    const alloc = f.allocationCount.trim() === "" ? null : Number(f.allocationCount);
    if (f.structure === "PERFORMANCE_ONLY") return bountyMicro;
    if (alloc === null || !Number.isInteger(alloc) || alloc <= 0) return null;
    let total = bounty * BigInt(alloc);
    if (f.structure === "BASE_PLUS_PERFORMANCE" || f.structure === "HYBRID_FULL") {
      if (f.baseUsdc.trim() === "") return null;
      total += toMicro(f.baseUsdc);
    }
    if (f.structure === "MILESTONE_PLUS_PERFORMANCE" || f.structure === "HYBRID_FULL") {
      for (const line of f.milestones.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const [th, amt] = t.split(":");
        if (!th || !amt || !Number.isInteger(Number(th)) || Number(th) <= 0 || Number(amt) <= 0) return null;
        total += toMicro(amt);
      }
    }
    return total.toString();
  } catch {
    return null;
  }
}

function buildDealPayload(f: HybridForm, bountyMicro: string): Record<string, unknown> | undefined {
  if (f.structure === "PERFORMANCE_ONLY") return undefined;
  const toMicro = (usdc: string) => String(Math.round(Number(usdc) * 1_000_000));
  const deal: Record<string, unknown> = { structure: f.structure, performanceBountyMicroUsdc: bountyMicro };
  if (f.structure === "BASE_PLUS_PERFORMANCE" || f.structure === "HYBRID_FULL") {
    deal.baseAmountMicroUsdc = toMicro(f.baseUsdc);
    deal.deliverable = { kind: f.deliverableKind, title: f.deliverableTitle.trim() };
  }
  if (f.structure === "MILESTONE_PLUS_PERFORMANCE" || f.structure === "HYBRID_FULL") {
    deal.milestones = f.milestones
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [threshold, amount] = l.split(":");
        return { threshold: Number(threshold), amountMicroUsdc: toMicro(amount) };
      });
  }
  deal.allocationCount = f.allocationCount.trim() === "" ? null : Number(f.allocationCount);
  return deal;
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
  const [hybrid, setHybrid] = useState<HybridForm>(EMPTY_HYBRID);
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
    const deal = buildDealPayload(hybrid, report?.publicBountyMicroUsdc ?? "0");
    // Pre-funding invitations need an explicit offer (policy floor shown above).
    const offeredBountyMicroUsdc = report?.prefunding ? report.publicBountyMicroUsdc : undefined;
    const res = await postJson<{ invited: number; results: { creatorUserId: string; status: string; reason: string | null }[] }>(
      `/api/campaigns/${campaignId}/invitations`,
      creatorUserIds.length === 1
        ? { creatorUserId: creatorUserIds[0], ...(deal ? { deal } : {}), ...(offeredBountyMicroUsdc ? { offeredBountyMicroUsdc } : {}) }
        : { creatorUserIds, ...(deal ? { deal } : {}), ...(offeredBountyMicroUsdc ? { offeredBountyMicroUsdc } : {}) },
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
  if (!report) return <p style={{ fontSize: 13, opacity: 0.7 }}>Couldn&apos;t load creator matches. Try again.</p>;
  if (report.evaluated === 0) {
    return <p style={{ fontSize: 13, opacity: 0.7 }}>{matchesEmptyMessage(0, 0)}</p>;
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
          {report.prefunding ? " (advisory — policy floor until the market opens)" : ""}
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
          {tab === "recommended" && report.review.length > 0
            ? "No high-confidence matches right now. Check Review for close fits."
            : (matchesEmptyMessage(report.evaluated, report.invite.length + report.review.length) ??
              "No matches in this view yet.")}
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
                {m.reliability && (
                  <div style={{ fontSize: 12.5 }}>
                    <strong>
                      Creator reliability: {m.reliability.score} ({m.reliability.confidence}) · {m.reliability.level.replace("_", " ")}
                    </strong>
                    <span style={{ display: "block", color: "var(--ink-2)" }}>
                      {m.reliability.verifiedOutcomes} verified outcomes · {m.reliability.campaignsWithVerified} campaigns with verified results
                      {m.reliability.retainedOutcomes > 0 ? ` · ${m.reliability.retainedOutcomes} retained` : ""} ·{" "}
                      {m.reliability.settledCollaborations} settled collaborations
                    </span>
                  </div>
                )}
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
      <details style={{ fontSize: 12.5, border: "1px solid var(--line, #e5e5e5)", borderRadius: 12, padding: "8px 12px" }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Hybrid deal (optional)</summary>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <label style={{ display: "grid", gap: 4 }}>
            Structure
            <select value={hybrid.structure} onChange={(e) => setHybrid({ ...hybrid, structure: e.target.value })}>
              <option value="PERFORMANCE_ONLY">Performance only</option>
              <option value="BASE_PLUS_PERFORMANCE">Base + performance</option>
              <option value="MILESTONE_PLUS_PERFORMANCE">Milestones + performance</option>
              <option value="HYBRID_FULL">Base + milestones + performance</option>
            </select>
          </label>
          {(hybrid.structure === "BASE_PLUS_PERFORMANCE" || hybrid.structure === "HYBRID_FULL") && (
            <>
              <label style={{ display: "grid", gap: 4 }}>
                Base (USDC) — paid only for a verified deliverable, never on accept
                <input value={hybrid.baseUsdc} inputMode="decimal" placeholder="25" onChange={(e) => setHybrid({ ...hybrid, baseUsdc: e.target.value })} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                Deliverable kind
                <select value={hybrid.deliverableKind} onChange={(e) => setHybrid({ ...hybrid, deliverableKind: e.target.value })}>
                  <option value="content">Content (human review)</option>
                  <option value="tutorial">Tutorial (human review)</option>
                  <option value="community">Community (human review)</option>
                  <option value="verified-outcome">Verified outcome (automatic)</option>
                </select>
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                Deliverable title
                <input value={hybrid.deliverableTitle} placeholder="Launch video" onChange={(e) => setHybrid({ ...hybrid, deliverableTitle: e.target.value })} />
              </label>
            </>
          )}
          {(hybrid.structure === "MILESTONE_PLUS_PERFORMANCE" || hybrid.structure === "HYBRID_FULL") && (
            <label style={{ display: "grid", gap: 4 }}>
              Milestones — one “threshold:USDC” per line, from verified counts only
              <textarea value={hybrid.milestones} rows={2} placeholder={"10:20\n25:50"} onChange={(e) => setHybrid({ ...hybrid, milestones: e.target.value })} />
            </label>
          )}
          {hybrid.structure !== "PERFORMANCE_ONLY" && (
            <label style={{ display: "grid", gap: 4 }}>
              Allocation cap (bounds maximum exposure)
              <input value={hybrid.allocationCount} inputMode="numeric" onChange={(e) => setHybrid({ ...hybrid, allocationCount: e.target.value })} />
            </label>
          )}
          <span style={{ opacity: 0.75 }}>
            Maximum exposure:{" "}
            {(() => {
              const max = previewMaxTotal(hybrid, report?.publicBountyMicroUsdc ?? "0");
              return max === null ? "incomplete — fill every hybrid field" : `${formatUsdc(max)} USDC (frozen at invite)`;
            })()}
          </span>
        </div>
      </details>
      {inviteRows.length > 0 && (
        <div>
          <h4 style={{ fontSize: 13, margin: "4px 0 8px" }}>Invitations</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {inviteRows.map((row) => (
              <li key={row.id} style={{ fontSize: 12.5, display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "center" }}>
                <strong>{row.creatorHandle ? `@${row.creatorHandle}` : row.creatorUserId.slice(0, 8)}</strong>
                {(row.offered.bonus as { deal?: { structure?: string } } | undefined)?.deal?.structure &&
                  (row.offered.bonus as { deal: { structure: string } }).deal.structure !== "PERFORMANCE_ONLY" && (
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                      {(row.offered.bonus as { deal: { structure: string } }).deal.structure.replaceAll("_", " ")}
                    </span>
                  )}
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
