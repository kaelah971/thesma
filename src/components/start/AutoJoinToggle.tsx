"use client";

import Link from "next/link";
import { useState } from "react";
import { postJson } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import type { CreatorRulesInput } from "./CreatorPreferencesForm";

/**
 * Prominent AUTO-JOIN switch. Sends the FULL current rules with only the
 * autoJoin flag flipped — switching ON never weakens any other rule.
 */
export function AutoJoinToggle({ initial }: { initial: CreatorRulesInput }) {
  const [autoJoin, setAutoJoin] = useState(initial.autoJoin);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip(next: boolean) {
    if (next === autoJoin || pending) return;
    setPending(true);
    setError(null);
    const res = await postJson("/api/partners/me/rules", {
      minimumBountyMicroUsdc: initial.minimumBountyMicroUsdc,
      allowedCategories: initial.allowedCategories,
      blockedCategories: initial.blockedCategories,
      maxActiveCampaigns: initial.maxActiveCampaigns,
      autoJoin: next,
      minScoutConfidence: initial.minScoutConfidence,
      maxAutoJoinsPerDay: initial.maxAutoJoinsPerDay,
    }).catch(() => null);
    setPending(false);
    if (!res || !res.ok) {
      setError(res && !res.ok ? res.error : "Couldn't update auto-join. Try again.");
      return;
    }
    setAutoJoin(next);
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "10px 14px",
        border: "1px solid var(--line, #e5e5e5)",
        borderRadius: 12,
        padding: "10px 14px",
        marginTop: 12,
      }}
      role="group"
      aria-label="Scout auto-join"
    >
      <strong style={{ fontSize: 13, letterSpacing: 1 }}>AUTO-JOIN</strong>
      <button
        type="button"
        role="switch"
        aria-checked={autoJoin}
        disabled={pending}
        onClick={() => flip(!autoJoin)}
        className={autoJoin ? "btn btn-primary btn-sm" : "btn btn-sm"}
      >
        {pending ? "Saving…" : autoJoin ? "ON" : "OFF"}
      </button>
      <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
        {autoJoin
          ? "Thesma may automatically join eligible open campaigns or accept direct campaign invitations when every Scout rule is satisfied."
          : "Thesma can still recommend opportunities and surface invitations, but you approve participation yourself."}
      </span>
      {error && (
        <span className="form-error" role="alert" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
      <span className="tnum" style={{ fontSize: 12.5, color: "var(--ink-2)", flexBasis: "100%" }}>
        Auto-join: {autoJoin ? "ON" : "OFF"} · Minimum bounty: {formatUsdc(initial.minimumBountyMicroUsdc)} USDC ·
        Confidence: {initial.minScoutConfidence} · Max active: {initial.maxActiveCampaigns ?? "—"} ·
        Max joins/day: {initial.maxAutoJoinsPerDay ?? "—"}
        {initial.allowedCategories.length > 0 ? ` · Categories: ${initial.allowedCategories.join(", ")}` : ""}
      </span>
      <Link href="#scout-rules" style={{ fontSize: 12.5 }}>
        Edit Scout rules
      </Link>
    </div>
  );
}
