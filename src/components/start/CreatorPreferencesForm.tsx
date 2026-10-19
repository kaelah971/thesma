"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatUsdc } from "@/lib/format";
import { serverErrorMessage } from "@/lib/api";

export interface CreatorRulesInput {
  autoJoin: boolean;
  minimumBountyMicroUsdc: string;
  allowedCategories: string[];
  blockedCategories: string[];
  minScoutConfidence: "HIGH" | "MEDIUM" | "LOW";
  maxActiveCampaigns: number | null;
  maxAutoJoinsPerDay: number | null;
}

/** Creator-controlled Scout rules. Thesma can only join inside these rules. */
export function CreatorPreferencesForm({ initial }: { initial: CreatorRulesInput }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [autoJoin, setAutoJoin] = useState(initial.autoJoin);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const micro = (v: string, fallback: string) => {
      const t = v.trim();
      if (!t) return fallback;
      if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
      const [whole, frac = ""] = t.split(".");
      return (BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6))).toString();
    };
    const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const num = (v: string) => (v.trim() === "" ? null : Number.parseInt(v.trim(), 10));
    const minBounty = micro(String(form.get("minBounty") ?? ""), initial.minimumBountyMicroUsdc);
    if (minBounty === null) return setError("Minimum bounty must be a USDC amount like 0.5.");
    const maxActive = num(String(form.get("maxActive") ?? ""));
    if (maxActive !== null && (!Number.isInteger(maxActive) || maxActive < 1)) return setError("Max active campaigns must be a positive whole number.");
    const maxJoins = num(String(form.get("maxJoins") ?? ""));
    if (maxJoins !== null && (!Number.isInteger(maxJoins) || maxJoins < 1)) return setError("Max joins per day must be a positive whole number.");
    setPending(true);
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/partners/me/rules`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimumBountyMicroUsdc: minBounty,
        allowedCategories: list(String(form.get("allowed") ?? "")),
        blockedCategories: list(String(form.get("blocked") ?? "")),
        maxActiveCampaigns: maxActive,
        autoJoin,
        minScoutConfidence: String(form.get("confidence") ?? "MEDIUM"),
        maxAutoJoinsPerDay: maxJoins,
      }),
    }).catch(() => null);
    setPending(false);
    if (!res || !res.ok) {
      setError("Couldn't save rules. Try again.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 10 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
        <input type="checkbox" checked={autoJoin} onChange={(e) => setAutoJoin(e.target.checked)} />
        Auto-join matching campaigns
      </label>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="pref-min">Minimum bounty (USDC)</label>
        <input id="pref-min" name="minBounty" className="input" defaultValue={formatUsdc(initial.minimumBountyMicroUsdc)} inputMode="decimal" />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="pref-allowed">Allowed categories (comma separated, blank = all)</label>
        <input id="pref-allowed" name="allowed" className="input" defaultValue={initial.allowedCategories.join(", ")} />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="pref-blocked">Blocked categories (comma separated)</label>
        <input id="pref-blocked" name="blocked" className="input" defaultValue={initial.blockedCategories.join(", ")} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="pref-conf">Min confidence</label>
          <select id="pref-conf" name="confidence" className="input" defaultValue={initial.minScoutConfidence}>
            <option value="HIGH">HIGH</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LOW">LOW</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="pref-max">Max active</label>
          <input id="pref-max" name="maxActive" className="input" defaultValue={initial.maxActiveCampaigns ?? ""} inputMode="numeric" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="pref-joins">Max joins/day</label>
          <input id="pref-joins" name="maxJoins" className="input" defaultValue={initial.maxAutoJoinsPerDay ?? ""} inputMode="numeric" />
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {saved && <p style={{ fontSize: 13, color: "var(--ink-2)" }}>Saved — Thesma can only join inside these rules.</p>}
      <div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
          {pending ? "Saving…" : "Save rules"}
        </button>
      </div>
    </form>
  );
}

/** Manual Run Scout: evaluates live candidates, auto-joins only permitted ones. */
export function RunScoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    setResult(null);
    const res = await fetch(`/api/creator/scout/run`, { method: "POST" })
      .then(
        (r) =>
          r.json() as Promise<{
            evaluated?: number;
            joined?: unknown[];
            refused?: unknown[];
            recommendedOnly?: unknown[];
            error?: { message?: string } | string;
          }>,
      )
      .catch(() => null);
    setPending(false);
    if (!res || typeof res.evaluated !== "number") {
      // Never render res.error directly: the API envelope carries an object.
      setError(serverErrorMessage(res, "Scout couldn't run right now. Try again."));
      return;
    }
    setResult(
      `Evaluated ${res.evaluated} · joined ${res.joined?.length ?? 0} · refused ${(res.refused ?? []).length} · review ${(res.recommendedOnly ?? []).length}.`,
    );
    router.refresh();
  }

  return (
    <span style={{ display: "inline-grid", gap: 6 }}>
      <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={run}>
        {pending ? "Running…" : "Run Scout"}
      </button>
      {error && (
        <span className="form-error" role="alert" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
      {result && <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{result}</span>}
    </span>
  );
}
