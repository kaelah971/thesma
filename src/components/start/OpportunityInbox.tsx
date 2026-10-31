"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { postJson, serverErrorMessage } from "@/lib/api";
import { formatDate, formatDuration, formatUsdc } from "@/lib/format";
import styles from "./start.module.css";

interface Opportunity {
  id: string;
  campaignId: string;
  status: string;
  acceptedBy: "AGENT" | "CREATOR" | null;
  offered: {
    outcomeKind: string;
    bountyMicroUsdc: string;
    minQualifyingMicroUsdc: string | null;
    holdSeconds: number | null;
    bonus: Record<string, unknown>;
  };
  match: { score: number; confidence: string; action: string; reasons: string[] };
  campaign: { workspaceName: string; objective: string; category: string | null; deadline: string | null; state: string | null; marketStatus: string | null; fundingStatus: string | null };
  agent: { result: string; reasons: string[] } | null;
  referral: { code: string; path: string } | null;
  respondedAt: string | null;
}

function offerLine(offered: Opportunity["offered"]): string {
  const unit =
    offered.outcomeKind === "purchase" ? "verified purchase" : offered.outcomeKind === "signup" ? "verified signup" : "verified referral";
  return `${formatUsdc(offered.bountyMicroUsdc)} USDC per ${unit}`;
}

interface FrozenDealView {
  structure: string;
  baseAmountMicroUsdc: string;
  deliverable: { title: string; verification: string } | null;
  performanceBountyMicroUsdc: string;
  milestones: { threshold: number; amountMicroUsdc: string }[];
}

function frozenDeal(bonus: Record<string, unknown> | undefined): FrozenDealView | null {
  const d = (bonus as { deal?: unknown } | undefined)?.deal;
  if (!d || typeof d !== "object") return null;
  const v = d as Record<string, unknown>;
  if (typeof v.structure !== "string" || v.structure === "PERFORMANCE_ONLY") return null;
  return {
    structure: v.structure,
    baseAmountMicroUsdc: typeof v.baseAmountMicroUsdc === "string" ? v.baseAmountMicroUsdc : "0",
    deliverable: (v.deliverable ?? null) as FrozenDealView["deliverable"],
    performanceBountyMicroUsdc: typeof v.performanceBountyMicroUsdc === "string" ? v.performanceBountyMicroUsdc : "0",
    milestones: Array.isArray(v.milestones) ? (v.milestones as FrozenDealView["milestones"]) : [],
  };
}

/** Creator opportunity inbox: frozen org offers with human Accept / Decline. */
export function OpportunityInbox() {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/creator/invitations").then((r) => r.json().catch(() => null));
    if (Array.isArray(res?.opportunities)) {
      const rows = res.opportunities as Opportunity[];
      rows.sort((a, b) => {
        if ((a.status === "INVITED") !== (b.status === "INVITED")) return a.status === "INVITED" ? -1 : 1;
        return 0;
      });
      setItems(rows);
    }
    setLoaded(true);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function respond(id: string, action: "accept" | "decline") {
    setPending(id);
    setError(null);
    const res = await postJson<{ invitation?: Opportunity; referral?: { path: string } }>(
      `/api/creator/invitations/${id}/${action}`,
      {},
    ).catch(() => null);
    setPending(null);
    if (!res || !res.ok) {
      setError(serverErrorMessage(res as never, `Couldn't ${action} the invitation. Try again.`));
      return;
    }
    await load();
  }

  if (!loaded) return <div className={styles.panelEmpty}>Loading opportunities…</div>;
  if (items.length === 0) {
    return <div className={styles.panelEmpty}>No direct invitations yet. Scout will keep watching for opportunities.</div>;
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {error && (
        <p className="form-error" role="alert" style={{ fontSize: 12.5 }}>
          {error}
        </p>
      )}
      {items.map((o) => {
        const open = o.status === "INVITED";
        return (
          <div key={o.id} className={styles.panelEmpty} style={{ borderStyle: "solid" }}>
            <strong style={{ display: "block", fontSize: 14 }}>
              {o.campaign.workspaceName} · {o.status}
            </strong>
            {o.campaign.objective && <span style={{ display: "block", fontSize: 13, marginTop: 2 }}>{o.campaign.objective}</span>}
            {o.campaign.category && (
              <span style={{ display: "block", fontSize: 12.5, marginTop: 2, color: "var(--ink-2)" }}>{o.campaign.category}</span>
            )}
            <span className="tnum" style={{ display: "block", fontSize: 13, marginTop: 8, fontWeight: 700 }}>
              Your offer: {offerLine(o.offered)}
            </span>
            <span style={{ display: "block", fontSize: 12.5, marginTop: 2, color: "var(--ink-2)" }}>
              {o.offered.minQualifyingMicroUsdc ? `Qualifies on purchases of ${formatUsdc(o.offered.minQualifyingMicroUsdc)} USDC or more. ` : "Every verified outcome qualifies. "}
              {o.offered.holdSeconds ? `Eligible payout is held for ${formatDuration(o.offered.holdSeconds * 1000)} before settlement. ` : ""}
              {o.campaign.deadline ? `Campaign ends ${formatDate(o.campaign.deadline)}.` : ""}
            </span>
            {(() => {
              const deal = frozenDeal(o.offered.bonus);
              if (!deal) return null;
              const max = deal.milestones.reduce((s, m) => s + BigInt(m.amountMicroUsdc), BigInt(deal.baseAmountMicroUsdc));
              return (
                <span style={{ display: "block", fontSize: 12.5, marginTop: 8, borderTop: "1px solid var(--line, #e5e5e5)", paddingTop: 8 }}>
                  <strong>YOU CAN EARN (max {formatUsdc(max.toString())} USDC)</strong>
                  {BigInt(deal.baseAmountMicroUsdc) > 0n && (
                    <span style={{ display: "block", color: "var(--ink-2)" }}>
                      · {formatUsdc(deal.baseAmountMicroUsdc)} USDC base for “{deal.deliverable?.title ?? "the deliverable"}”
                    </span>
                  )}
                  {BigInt(deal.performanceBountyMicroUsdc) > 0n && (
                    <span style={{ display: "block", color: "var(--ink-2)" }}>
                      · {formatUsdc(deal.performanceBountyMicroUsdc)} USDC per verified outcome
                    </span>
                  )}
                  {deal.milestones.map((m) => (
                    <span key={m.threshold} style={{ display: "block", color: "var(--ink-2)" }}>
                      · {formatUsdc(m.amountMicroUsdc)} USDC bonus at {m.threshold} verified outcomes
                    </span>
                  ))}
                  <strong style={{ display: "block", marginTop: 4 }}>WHAT QUALIFIES</strong>
                  <span style={{ display: "block", color: "var(--ink-2)" }}>
                    Base pays only after the deliverable is verified — never for accepting. Milestones count verified outcomes only, never clicks.
                  </span>
                  <strong style={{ display: "block", marginTop: 4 }}>WHEN YOU GET PAID</strong>
                  <span style={{ display: "block", color: "var(--ink-2)" }}>
                    Performance pays through the verified-outcome path. Verified base and milestone bonuses are recorded payable; onchain settlement is not
                    supported for these in this slice.
                  </span>
                </span>
              );
            })()}
            <span style={{ display: "block", fontSize: 12.5, marginTop: 8 }}>
              <strong>Thesma Scout · {o.match.confidence} match ({o.match.score})</strong>
              <span style={{ display: "block", color: "var(--ink-2)" }}>{o.match.reasons.join(" · ") || "Matched on campaign fit."}</span>
            </span>
            {o.status === "ACCEPTED" && o.acceptedBy === "AGENT" && (
              <span style={{ display: "block", fontSize: 12.5, marginTop: 4 }}>
                <strong>Accepted by your agent</strong>
                <span style={{ display: "block", color: "var(--ink-2)" }}>
                  The frozen offer satisfied your Scout rules — {offerLine(o.offered)}, terms frozen at invite time.
                </span>
              </span>
            )}
            {o.status === "INVITED" && o.agent?.result === "REVIEW" && (
              <span style={{ display: "block", fontSize: 12.5, marginTop: 4 }}>
                <strong>Your review is required</strong>
                <span style={{ display: "block", color: "var(--ink-2)" }}>{o.agent.reasons.join(" · ")}</span>
              </span>
            )}
            {o.status === "INVITED" && o.agent?.result === "REFUSE" && (
              <span style={{ display: "block", fontSize: 12.5, marginTop: 4 }}>
                <strong>Your agent did not accept this</strong>
                <span style={{ display: "block", color: "var(--ink-2)" }}>{o.agent.reasons.join(" · ")}</span>
              </span>
            )}
            {o.status === "ACCEPTED" && o.referral && (
              <span style={{ display: "block", fontSize: 12.5, marginTop: 4 }}>
                Referral <Link href={o.referral.path}>/r/{o.referral.code}</Link>
              </span>
            )}
            <span style={{ display: "block", fontSize: 12, marginTop: 4, color: "var(--ink-2)" }}>
              Accepted ≠ earned · Verified ≠ paid · Submitted ≠ settled.
            </span>
            {open && (o.campaign.state !== "LIVE" || o.campaign.marketStatus !== "OPEN") && (
              <span style={{ display: "block", fontSize: 12.5, marginTop: 8, fontWeight: 700 }}>
                Awaiting campaign funding — your frozen offer is saved and becomes accept-ready when the market goes live.
              </span>
            )}
            <div className={styles.panelActions}>
              {open ? (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={pending === o.id || o.campaign.state !== "LIVE" || o.campaign.marketStatus !== "OPEN"}
                    title={o.campaign.state !== "LIVE" || o.campaign.marketStatus !== "OPEN" ? "Awaiting campaign funding" : "Accept"}
                    onClick={() => respond(o.id, "accept")}
                  >
                    {pending === o.id ? "Working…" : "Accept"}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={pending === o.id} onClick={() => respond(o.id, "decline")}>
                    Decline
                  </button>
                </>
              ) : (
                <Link href={`/markets/${o.campaignId}`} className="btn btn-sm">
                  View campaign
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
