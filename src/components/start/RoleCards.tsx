"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./start.module.css";
import type { Persona } from "@/server/services/personas";

const ROLES: { persona: Persona; tone: string; tag: string; title: string; copy: string; cta: string }[] = [
  {
    persona: "customer",
    tone: "mint",
    tag: "Shop through creators",
    title: "Customer",
    copy: "Discover campaigns through creators you trust and keep track of the outcomes you've completed.",
    cta: "Continue as customer",
  },
  {
    persona: "creator",
    tone: "blue",
    tag: "Creator / KOL",
    title: "Creator / KOL",
    copy: "Join live campaigns, refer your audience and earn when verified outcomes happen.",
    cta: "Continue as creator",
  },
  {
    persona: "organization",
    tone: "lav",
    tag: "For companies",
    title: "Organization",
    copy: "Launch outcome campaigns and let Thesma coordinate creators, verification and payouts.",
    cta: "Continue as organization",
  },
  {
    persona: "developer",
    tone: "peach",
    tag: "Developer",
    title: "Build with Thesma",
    copy: "Use Thesma's verification, receipts and payout infrastructure in your own product.",
    cta: "Start building",
  },
];

export function RoleCards() {
  const router = useRouter();
  const [pending, setPending] = useState<Persona | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(persona: Persona) {
    setPending(persona);
    setError(null);
    // Cookie is best-effort pre-auth; /welcome re-resolves server-side.
    await fetch("/api/persona/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona }),
    }).catch(() => null);
    router.push("/welcome");
    router.refresh();
  }

  return (
    <>
      <div className={styles.grid} role="list">
        {ROLES.map((r) => (
          <button
            key={r.persona}
            type="button"
            role="listitem"
            className={styles.card}
            data-tone={r.tone}
            disabled={pending !== null}
            onClick={() => choose(r.persona)}
            aria-label={`${r.cta}`}
          >
            <span className={styles.cardTag}>{r.tag}</span>
            <h2>{r.title}</h2>
            <p>{r.copy}</p>
            <span className={styles.cardCta}>
              {pending === r.persona ? "Continuing…" : r.cta}
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2.5 7h8.5M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert" style={{ textAlign: "center", marginTop: 16 }}>
          {error}
        </p>
      )}
    </>
  );
}
