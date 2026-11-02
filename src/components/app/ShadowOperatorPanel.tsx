"use client";

import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import styles from "./operator.module.css";

type Mode = "AUTONOMOUS" | "SHADOW";
type ResponseKind = "AGREE" | "OVERRIDE" | "IGNORE";

type ShadowDecision = {
  id: string;
  family: string;
  targetId: string;
  recommendation: string;
  amountMicroUsdc: string | null;
  confidence: string | null;
  reasons: string[];
  executionStatus: "NOT_EXECUTED";
  generatedAt: string;
  response: { response: ResponseKind; reason: string | null; respondedAt: string } | null;
};

type Bucket = {
  generated: number;
  reviewed: number;
  agreements: number;
  overrides: number;
  ignored: number;
  agreementRateBps: number | null;
};

type ShadowData = {
  mode: Mode;
  decisions: ShadowDecision[];
  telemetry: Bucket & { byFamily: Record<string, Bucket>; byConfidence: Record<string, Bucket> };
};

function rate(value: number | null): string {
  return value === null ? "—" : `${(value / 100).toFixed(2)}%`;
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

/** Shadow recommendations, human review telemetry, and the visible no-execution boundary. */
export function ShadowOperatorPanel({ workspaceId, isOwner, campaignId }: { workspaceId: string; isOwner: boolean; campaignId: string | null }) {
  const [data, setData] = useState<ShadowData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  async function load() {
    const res = await getJson<ShadowData>(`/api/operator/shadow?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (res.ok) {
      setData(res.data);
      setError(null);
    } else setError(res.error);
  }

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await getJson<ShadowData>(`/api/operator/shadow?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (!live) return;
      if (res.ok) setData(res.data);
      else setError(res.error);
    })();
    return () => {
      live = false;
    };
  }, [workspaceId]);

  async function toggle() {
    setBusy(true);
    setError(null);
    const res = await postJson<{ mode: Mode }>("/api/operator/shadow/mode", { workspaceId, enabled: data?.mode !== "SHADOW" });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await load();
  }

  async function run() {
    setBusy(true);
    setError(null);
    const res = await postJson<ShadowData>("/api/operator/shadow/run", {
      workspaceId,
      ...(campaignId ? { verificationChecks: [{ campaignId }] } : {}),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    await load();
  }

  async function respond(decisionId: string, response: ResponseKind) {
    if (response === "OVERRIDE" && !overrideReason.trim()) {
      setError("Add a reason before overriding a recommendation.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await postJson("/api/operator/shadow/respond", {
      workspaceId,
      decisionId,
      response,
      ...(response === "OVERRIDE" ? { reason: overrideReason.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setOverrideReason("");
    await load();
  }

  const telemetry = data?.telemetry;
  return (
    <div className={styles.card} aria-label="Shadow operator">
      <h2>Shadow operator</h2>
      <p className={styles.summary}>
        Same deterministic kernels. Recommendations are recorded for review; payments, x402, invites, capital movement, and settlements stay blocked.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <span className="pill" data-tone={data?.mode === "SHADOW" ? "mint" : undefined}>
          {data?.mode ?? "LOADING"}
        </span>
        {isOwner && (
          <button type="button" className="btn btn-sm" onClick={toggle} disabled={busy || !data}>
            {data?.mode === "SHADOW" ? "Disable shadow" : "Enable shadow"}
          </button>
        )}
        {isOwner && data?.mode === "SHADOW" && (
          <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run recommendations"}
          </button>
        )}
      </div>
      {error && <p role="alert" className={styles.muted} style={{ color: "var(--danger, #b42318)", marginTop: 8 }}>{error}</p>}
      {!data && !error && <p className={styles.muted}>Loading shadow state…</p>}
      {telemetry && (
        <>
          <span className={styles.ctxLabel}>Agreement telemetry</span>
          <p className={styles.summary}>
            {telemetry.generated} generated · {telemetry.reviewed} reviewed · {telemetry.agreements} agree · {telemetry.overrides} overrides · {telemetry.ignored} ignored · {rate(telemetry.agreementRateBps)} agreement
          </p>
          <div className={styles.facts}>
            <dl>
              {Object.entries(telemetry.byFamily).map(([family, bucket]) => (
                <div key={family}>
                  <dt>{label(family)}</dt>
                  <dd className="tnum">{bucket.reviewed}/{bucket.generated} · {rate(bucket.agreementRateBps)}</dd>
                </div>
              ))}
            </dl>
          </div>
          <span className={styles.ctxLabel}>Confidence segmentation</span>
          <div className={styles.facts}>
            <dl>
              {Object.entries(telemetry.byConfidence).map(([confidence, bucket]) => (
                <div key={confidence}>
                  <dt>{label(confidence)}</dt>
                  <dd className="tnum">{bucket.reviewed}/{bucket.generated} · {rate(bucket.agreementRateBps)}</dd>
                </div>
              ))}
            </dl>
          </div>
        </>
      )}
      {data && data.decisions.length > 0 && (
        <>
          <span className={styles.ctxLabel}>Recent recommendations</span>
          <label htmlFor="shadow-override-reason" className={styles.muted} style={{ display: "block", marginTop: 6 }}>
            Override reason (required for override)
          </label>
          <input
            id="shadow-override-reason"
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            placeholder="e.g. BUSINESS_CONTEXT_MISSING"
            style={{ width: "100%", marginTop: 4 }}
          />
          <ul className={styles.history} style={{ marginTop: 6 }}>
            {data.decisions.slice(0, 8).map((decision) => (
              <li key={decision.id}>
                <strong>{label(decision.family)} · {label(decision.recommendation)}</strong>
                <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>
                  {decision.amountMicroUsdc && decision.amountMicroUsdc !== "0" ? `${formatUsdc(decision.amountMicroUsdc)} USDC · ` : ""}
                  {decision.confidence ?? "confidence unavailable"} · NOT EXECUTED
                </span>
                <span style={{ display: "block", fontSize: 12.5, opacity: 0.8 }}>{decision.reasons[0] ?? "No reason recorded."}</span>
                {decision.response ? (
                  <span style={{ display: "block", fontSize: 12.5, marginTop: 4 }}>
                    Human: <b>{decision.response.response}</b>{decision.response.reason ? ` · ${decision.response.reason}` : ""}
                  </span>
                ) : (
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                    {(["AGREE", "OVERRIDE", "IGNORE"] as const).map((response) => (
                      <button key={response} type="button" className={response === "AGREE" ? "btn btn-primary btn-sm" : "btn btn-sm"} onClick={() => respond(decision.id, response)} disabled={busy}>
                        {response}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {data && data.decisions.length === 0 && <p className={styles.muted} style={{ marginTop: 8 }}>No shadow recommendations yet.</p>}
    </div>
  );
}
