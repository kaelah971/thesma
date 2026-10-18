"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, EmptyState, PageHeader, Pill } from "@/components/app/ui";
import { formatUsdc } from "@/lib/format";

type Turn = { from: "agent" | "you"; text: string };

const STARTER_QUESTIONS = [
  "What live campaigns match my preferences?",
  "Which market currently has the best fit?",
  "Why did you skip this one?",
  "Show my active campaigns.",
];

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? body?.message ?? `Request failed (${res.status})`);
  return body;
}

export default function SupplyAgentPanel() {
  const [status, setStatus] = useState<any>(null);
  const [matches, setMatches] = useState<any[]>(null as any);
  const [turns, setTurns] = useState<Turn[]>([{ from: "agent", text: "What kinds of outcome markets should I watch for you?" }]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<any>(null);
  const [input, setInput] = useState("");
  const [askInput, setAskInput] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api("/api/partners/me/agent/status"), api("/api/partners/me/agent/matches")]);
      setStatus(s);
      setMatches(m.matches);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, m] = await Promise.all([
          api("/api/partners/me/agent/status"),
          api("/api/partners/me/agent/matches"),
        ]);
        if (cancelled) return;
        setStatus(s);
        setMatches(m.matches);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function sendOnboarding() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const nextAnswers = { ...answers };
      const pendingKey = draft?.missing?.[0] ?? "categories";
      const keyMap: Record<string, string> = { categories: "categories", minBounty: "minBounty", autoJoin: "autoJoin", autoNegotiate: "autoNegotiate" };
      if (keyMap[pendingKey]) nextAnswers[keyMap[pendingKey]] = text;
      const res = await api("/api/partners/me/agent/onboard", { method: "POST", body: JSON.stringify({ answers: nextAnswers }) });
      setAnswers(nextAnswers);
      setDraft(res);
      setTurns((t) => [...t, { from: "you", text }, ...(res.nextQuestion ? [{ from: "agent" as const, text: res.nextQuestion.question }] : [{ from: "agent" as const, text: "Got it. Review your agent rules below, then confirm." }])]);
      setInput("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!draft || busy) return;
    setBusy(true);
    try {
      await api("/api/partners/me/agent/onboard/confirm", {
        method: "POST",
        body: JSON.stringify({ rules: draft.draft, confirmed: true }),
      });
      setTurns((t) => [...t, { from: "agent", text: "Rules confirmed. I'll watch the market and only act inside those limits." }]);
      setDraft(null);
      setAnswers({});
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api("/api/partners/me/agent/run", { method: "POST" });
      const done = res.joined.length > 0 ? `Joined ${res.joined.length} market(s).` : "No eligible markets to join right now.";
      const skipped = res.skipped.length > 0 ? ` Skipped ${res.skipped.length} with reasons on your dashboard.` : "";
      setTurns((t) => [...t, { from: "agent", text: done + skipped }]);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await api("/api/partners/me/agent/ask", { method: "POST", body: JSON.stringify({ question: text }) });
      setAskAnswer(res.answer);
      setAskInput("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Supply agent"
        title="My supply agent"
        description="Tell the agent what to watch in plain words. It converts your answers into typed rules — nothing becomes active until you confirm."
      />
      {error && (
        <Card tone="rose">
          <p style={{ margin: 0, fontSize: 14 }}>{error}</p>
          {error.includes("Partner profile") && (
            <p style={{ margin: "8px 0 0", fontSize: 14 }}>
              <Link href="/app/settings">Set up your Partner profile first</Link>
            </p>
          )}
        </Card>
      )}
      {status && (
        <Card
          title={
            <>
              Agent status <Pill tone="mint">{status.status}</Pill>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 14 }}>
            Watching {status.watching} live markets · {status.matches.length} match · {status.joinedCount} joined
            · {status.skipped.length} skipped · {status.blockedCategoryCount} blocked-category ·{" "}
            {status.negotiationsPending} negotiation(s) pending
          </p>
          <p style={{ margin: "8px 0 0", fontSize: 13, opacity: 0.75 }}>
            Auto-join {status.autoJoin ? "ON" : "OFF"} · Auto-negotiate {status.autoNegotiate ? "ON" : "OFF"}
            {status.autoNegotiateNote && ` — ${status.autoNegotiateNote}`}
          </p>
        </Card>
      )}
      <Card title="Onboarding chat">
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }} aria-live="polite">
          {turns.map((t, i) => (
            <p
              key={i}
              style={{
                margin: 0,
                fontSize: 14,
                padding: "8px 12px",
                borderRadius: 12,
                background: t.from === "agent" ? "var(--surface-2, #f4f4f4)" : "transparent",
                border: t.from === "agent" ? "none" : "1px solid var(--line, #e5e5e5)",
              }}
            >
              <strong>{t.from === "agent" ? "Agent" : "You"}:</strong> {t.text}
            </p>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendOnboarding()}
            placeholder="Answer the agent…"
            aria-label="Answer the agent"
            style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line, #e5e5e5)" }}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={sendOnboarding} disabled={busy}>
            Send
          </button>
        </div>
        {draft?.readyToConfirm && (
          <div style={{ marginTop: 16, border: "1px solid var(--line, #e5e5e5)", borderRadius: 12, padding: 16 }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Your agent rules</h3>
            <ul style={{ margin: "0 0 12px", paddingLeft: 20, fontSize: 14 }}>
              {draft.confirmationCard.map((line: string) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={confirm} disabled={busy}>
                Confirm rules
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setDraft(null);
                  setAnswers({});
                  setTurns([{ from: "agent", text: "No problem — what kinds of outcome markets should I watch for you?" }]);
                }}
              >
                Change something
              </button>
            </div>
          </div>
        )}
      </Card>
      <Card
        title="Matching markets"
        action={
          <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={busy}>
            Run agent
          </button>
        }
      >
        {!matches ? (
          <p style={{ margin: 0, fontSize: 14, opacity: 0.7 }}>Loading…</p>
        ) : matches.length === 0 ? (
          <EmptyState title="No matches right now" body="The agent recommends only markets that pass your rules." />
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {matches.map((m: any) => (
              <p key={m.campaignId} style={{ margin: 0, fontSize: 14 }}>
                <Link href={`/markets/${m.campaignId}`}>{m.workspaceName}</Link> · score {m.score} · {m.reasons.join(" ")}
              </p>
            ))}
          </div>
        )}
      </Card>
      <Card title="What is my agent doing?">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {STARTER_QUESTIONS.map((q) => (
            <button key={q} type="button" className="btn btn-sm" onClick={() => ask(q)} disabled={busy}>
              {q}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={askInput}
            onChange={(e) => setAskInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask(askInput)}
            placeholder="Ask about your markets…"
            aria-label="Ask your agent"
            style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line, #e5e5e5)" }}
          />
          <button type="button" className="btn btn-sm" onClick={() => ask(askInput)} disabled={busy}>
            Ask
          </button>
        </div>
        {askAnswer && <p style={{ margin: "12px 0 0", fontSize: 14, whiteSpace: "pre-line" }}>{askAnswer}</p>}
      </Card>
      {status && status.skipped.length > 0 && (
        <Card title="Skipped with reasons">
          <div style={{ display: "grid", gap: 8 }}>
            {status.skipped.map((s: any) => (
              <p key={s.campaignId} style={{ margin: 0, fontSize: 14 }}>
                <Link href={`/markets/${s.campaignId}`}>{s.campaignId.slice(0, 8)}…</Link> — {s.reason}
              </p>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
