"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import styles from "./start.module.css";

export interface CreatorNotificationItem {
  id: string;
  type: string;
  campaignId: string | null;
  title: string;
  message: string;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

interface AutomationState {
  autoJoin: boolean | null;
  lastEvaluatedAt: string | null;
  lastAutoJoin: { campaignId: string; referralCode: string; at: string } | null;
}

/** Compact Scout activity inbox: unread count, deduped alerts, proof links. */
export function CreatorNotificationsPanel() {
  const [items, setItems] = useState<CreatorNotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [automation, setAutomation] = useState<AutomationState | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/creator/notifications").catch(() => null);
      if (cancelled) return;
      if (!res || !res.ok) {
        setLoaded(true);
        return;
      }
      const data = await res.json().catch(() => null);
      if (cancelled) return;
      if (!data) {
        setLoaded(true);
        return;
      }
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
      setUnread(typeof data.unreadCount === "number" ? data.unreadCount : 0);
      setAutomation(data.automation ?? null);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function markOne(id: string) {
    const res = await fetch(`/api/creator/notifications/${id}/read`, { method: "POST" }).catch(() => null);
    if (!res || !res.ok) return;
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
  }

  async function markAll() {
    const res = await fetch("/api/creator/notifications/read-all", { method: "POST" }).catch(() => null);
    if (!res || !res.ok) return;
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnread(0);
  }

  const proofLine = (n: CreatorNotificationItem): string | null => {
    if (n.type !== "AUTO_JOINED") return null;
    const m = n.metadataJson;
    const bits = [
      typeof m.score === "number" ? `score ${m.score}` : null,
      typeof m.confidence === "string" ? `${m.confidence} confidence` : null,
      typeof m.rule === "string" ? m.rule : null,
    ].filter(Boolean);
    return bits.length > 0 ? bits.join(" · ") : null;
  };

  return (
    <div>
      <p style={{ fontSize: 13 }}>
        Scout automation:{" "}
        <strong>{automation ? (automation.autoJoin ? "ON" : "OFF") : "—"}</strong>
        {automation?.lastEvaluatedAt && (
          <span style={{ color: "var(--ink-2)" }}> · Last check {formatDateTime(automation.lastEvaluatedAt)}</span>
        )}
        {automation?.lastAutoJoin && (
          <span style={{ color: "var(--ink-2)" }}>
            {" "}
            · Last auto-join{" "}
            <Link href={`/markets/${automation.lastAutoJoin.campaignId}`}>{automation.lastAutoJoin.campaignId.slice(0, 8)}…</Link>{" "}
            {formatDateTime(automation.lastAutoJoin.at)}
          </span>
        )}
        {!automation?.lastEvaluatedAt && automation && (
          <span style={{ color: "var(--ink-2)" }}> · No background run yet</span>
        )}
      </p>
      {!loaded ? (
        <div className={styles.panelEmpty}>Loading Scout activity…</div>
      ) : items.length === 0 ? (
        <div className={styles.panelEmpty}>No Scout alerts yet. Enable auto-join and check back after the next hourly run.</div>
      ) : (
        <>
          <p style={{ fontSize: 13 }}>
            {unread > 0 ? (
              <>
                <strong className="tnum">{unread} unread</strong>{" "}
                <button type="button" className="btn btn-sm" onClick={markAll}>
                  Mark all read
                </button>
              </>
            ) : (
              <span style={{ color: "var(--ink-2)" }}>All caught up.</span>
            )}
          </p>
          <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 10 }}>
            {items.slice(0, 20).map((n) => (
              <li
                key={n.id}
                className={styles.panelEmpty}
                style={{ borderStyle: "solid", opacity: n.readAt ? 0.72 : 1 }}
              >
                <strong style={{ display: "block", fontSize: 13 }}>
                  {!n.readAt && <span aria-label="unread">● </span>}
                  <span style={{ color: "var(--ink-2)", fontWeight: 600 }}>{n.type.replaceAll("_", " ")}</span> — {n.title}
                </strong>
                <span style={{ display: "block", fontSize: 13, marginTop: 2 }}>{n.message}</span>
                {proofLine(n) && (
                  <span className="tnum" style={{ display: "block", fontSize: 12, marginTop: 4, color: "var(--ink-2)" }}>
                    Why it qualified: {proofLine(n)}
                  </span>
                )}
                <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 6, fontSize: 12 }}>
                  <span style={{ color: "var(--ink-2)" }}>{formatDateTime(n.createdAt)}</span>
                  {typeof n.metadataJson.referralCode === "string" && (
                    <Link href={`/r/${String(n.metadataJson.referralCode)}`}>Referral link</Link>
                  )}
                  {n.campaignId && <Link href={`/markets/${n.campaignId}`}>View campaign</Link>}
                  {!n.readAt && (
                    <button type="button" className="btn btn-sm" onClick={() => markOne(n.id)}>
                      Mark read
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
