"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/brand/Logo";
import { Rail } from "@/components/ui/Rail";
import { postJson } from "@/lib/api";
import { campaignName, formatDuration, formatUsdc } from "@/lib/format";
import { answerOperator, SUGGESTED_PROMPTS, type OperatorBlock, type OperatorReply } from "@/lib/operator";
import { OperatorAutonomy } from "@/components/app/OperatorAutonomy";
import { CfoPanel } from "@/components/app/CfoPanel";
import { AutonomyPanel } from "@/components/app/AutonomyPanel";
import { GrowthPanel } from "@/components/app/GrowthPanel";
import { campaignFinancials, outcomeRows, RAIL, railIndex, verifiedCount, type WorkspaceSnapshot } from "@/lib/readmodel";
import styles from "./operator.module.css";

/** Wall clock for event handlers (answers asked later must count down from the moment they're asked). */
const clockNow = () => Date.now();

type NewMessage = { role: "user"; text: string } | { role: "thesma"; reply: OperatorReply };
type Message = NewMessage & { id: number };

const FIELD_LABELS: Record<string, string> = {
  targetOutcomeCount: "Target count",
  budgetMicroUsdc: "Budget",
  bountyFloorMicroUsdc: "Floor",
  bountyCeilingMicroUsdc: "Maximum per outcome",
  minQualifyingPurchaseMicroUsdc: "Minimum purchase",
  deadline: "Deadline",
};

function Blocks({ blocks }: { blocks: OperatorBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "facts")
          return (
            <div key={i} className={styles.facts}>
              {b.title && <span className={styles.factsTitle}>{b.title}</span>}
              <dl>
                {b.items.map((it) => (
                  <div key={it.label}>
                    <dt>{it.label}</dt>
                    <dd className="tnum">{it.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        if (b.kind === "list")
          return (
            <ul key={i} className={styles.list}>
              {b.items.map((it) => (
                <li key={`${it.title}-${it.meta}`}>
                  {it.href ? (
                    <Link href={it.href}>
                      <span className={styles.listText}>
                        <b>{it.title}</b>
                        <small>{it.meta}</small>
                      </span>
                      <span className="pill" data-tone={it.tone === "neutral" ? undefined : it.tone}>
                        {it.badge}
                      </span>
                    </Link>
                  ) : (
                    <span>{it.title}</span>
                  )}
                </li>
              ))}
            </ul>
          );
        return (
          <Link key={i} href={b.href} className={styles.linkBtn}>
            {b.label} →
          </Link>
        );
      })}
    </>
  );
}

export function OperatorWorkspace({ snapshot, initials }: { snapshot: WorkspaceSnapshot; initials: string }) {
  const router = useRouter();
  const renderNow = Date.parse(snapshot.generatedAt);
  const [messages, setMessages] = useState<Message[]>(() => [
    { id: 0, role: "thesma", reply: answerOperator("status", snapshot, renderNow) },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const push = (m: NewMessage) => {
    const id = nextId.current++;
    setMessages((prev) => [...prev, { ...m, id }]);
  };

  async function ask(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setInput("");
    push({ role: "user", text });
    const reply = answerOperator(text, snapshot, clockNow());
    if (!reply.draftIntent) return push({ role: "thesma", reply });

    setBusy(true);
    push({ role: "thesma", reply });
    const res = await postJson<{ campaign: { id: string }; missing: string[]; notes: string[] }>("/api/campaigns/draft", {
      workspaceId: snapshot.workspace.id,
      intentText: reply.draftIntent,
    });
    setBusy(false);
    if (!res.ok) {
      return push({ role: "thesma", reply: { intent: "draft", text: `I couldn't create the draft: ${res.error}`, blocks: [] } });
    }
    const missing = res.data.missing.map((m) => FIELD_LABELS[m] ?? m);
    push({
      role: "thesma",
      reply: {
        intent: "draft",
        text: missing.length
          ? `Draft created. It still needs: ${missing.join(", ")}. I didn't guess any of these.`
          : "Draft created with every required field. Review it, then request approval from the owner.",
        blocks: [{ kind: "link", label: "Open draft", href: `/app/campaigns/${res.data.campaign.id}?drafted=1` }],
      },
    });
    router.refresh();
  }

  const asked = messages.filter((m): m is Extract<Message, { role: "user" }> => m.role === "user").map((m) => m.text);
  const focus = snapshot.campaigns.find((c) => c.state === "LIVE") ?? snapshot.campaigns[0];
  const focusFin = focus ? campaignFinancials(focus.id, snapshot) : null;
  const nextHold = outcomeRows(snapshot, renderNow)
    .filter((r) => r.stage === "SAFETY_HOLD")
    .sort((a, b) => (a.holdRemainingMs ?? 0) - (b.holdRemainingMs ?? 0))[0];

  return (
    <div className={styles.layout}>
      <section className={styles.chat} aria-label="Operator conversation">
        <header className={styles.chatHead}>
          <div>
            <h1>Operator</h1>
            <p>Answers come from this workspace&apos;s live campaign state.</p>
          </div>
          {focus && (
            <span className="pill" data-tone={focus.state === "LIVE" ? "mint" : undefined}>
              {campaignName(focus.intentText).slice(0, 28)} · {focus.state}
            </span>
          )}
        </header>

        <div className={styles.messages} aria-live="polite">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className={styles.user}>
                <p>{m.text}</p>
                <span className={styles.avatar} aria-hidden="true">
                  {initials}
                </span>
              </div>
            ) : (
              <div key={m.id} className={styles.thesma}>
                <LogoMark size={30} tile />
                <div className={styles.bubble}>
                  <span className="sr-only">Thesma:</span>
                  <p>{m.reply.text}</p>
                  {m.reply.intent === "help" && (
                    <div className={styles.inlineChips}>
                      {SUGGESTED_PROMPTS.map((p) => (
                        <button key={p} type="button" onClick={() => ask(p)}>
                          {p}
                        </button>
                      ))}
                    </div>
                  )}
                  <Blocks blocks={m.reply.blocks} />
                </div>
              </div>
            ),
          )}
          {busy && (
            <div className={styles.thesma}>
              <LogoMark size={30} tile />
              <div className={styles.bubble}>
                <p className={styles.pending}>Preparing draft…</p>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            ask(input);
          }}
        >
          <span className="perimeter-light" aria-hidden="true" />
          <label htmlFor="operator-input" className="sr-only">
            Ask Thesma
          </label>
          <textarea
            id="operator-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={2}
            placeholder="Ask about campaigns, outcomes or payouts…"
          />
          <div className={styles.composerRow}>
            <div className={styles.chips}>
              {SUGGESTED_PROMPTS.slice(0, 4).map((p) => (
                <button key={p} type="button" onClick={() => ask(p)} disabled={busy}>
                  {p}
                </button>
              ))}
            </div>
            <button type="submit" className={styles.send} aria-label="Send" disabled={busy || !input.trim()}>
              <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 12V2M2.5 6.5 7 2l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </form>
      </section>

      <aside className={styles.side} aria-label="Context">
        <OperatorAutonomy workspaceId={snapshot.workspace.id} isOwner={snapshot.workspace.role === "ORGANIZATION_OWNER"} />
        <CfoPanel workspaceId={snapshot.workspace.id} isOwner={snapshot.workspace.role === "ORGANIZATION_OWNER"} />
        <AutonomyPanel workspaceId={snapshot.workspace.id} />
        <GrowthPanel
          workspaceId={snapshot.workspace.id}
          campaignId={focus ? focus.id : null}
          isOwner={snapshot.workspace.role === "ORGANIZATION_OWNER"}
        />
        {focus && focusFin && (
          <div className={styles.card}>
            <h2>Context</h2>
            <Link href={`/app/campaigns/${focus.id}`} className={styles.focusName}>
              {campaignName(focus.intentText)}
            </Link>
            <dl className={styles.ctxFacts}>
              <div>
                <dt>Verified</dt>
                <dd className="tnum">
                  {verifiedCount(snapshot, focus.id)}
                  {focus.targetOutcomeCount ? ` / ${focus.targetOutcomeCount}` : ""}
                </dd>
              </div>
              <div>
                <dt>Available</dt>
                <dd className="tnum">{formatUsdc(focusFin.available)} USDC</dd>
              </div>
              <div>
                <dt>Settled</dt>
                <dd className="tnum">{formatUsdc(focusFin.settled)} USDC</dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd className="tnum">{focus.market ? `${formatUsdc(focus.market.bountyMicro)} USDC` : "Market not open"}</dd>
              </div>
            </dl>
          </div>
        )}

        {nextHold && (
          <div className={`${styles.card} ${styles.hold}`}>
            <span className={styles.ctxLabel}>Next payout eligible in</span>
            <strong className="tnum">{formatDuration(nextHold.holdRemainingMs ?? 0)}</strong>
            <Rail steps={RAIL.map((s) => s.label)} current={railIndex(nextHold.stage)} size="sm" />
            <p>
              Outcome <span className="mono">{nextHold.id.slice(0, 8)}</span> · as of page load
            </p>
          </div>
        )}

        <div className={styles.card}>
          <h2>{asked.length ? "This session" : "Suggested"}</h2>
          <ul className={styles.history}>
            {(asked.length ? [...asked].reverse().slice(0, 6) : SUGGESTED_PROMPTS.slice(1)).map((q, i) => (
              <li key={`${q}-${i}`}>
                <button type="button" onClick={() => ask(q)} disabled={busy}>
                  {q}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
