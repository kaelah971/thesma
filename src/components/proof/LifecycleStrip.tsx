import type { LifecycleStep, LifecycleStepState } from "./lifecycle";

const DOT: Record<LifecycleStepState, { background: string; ring: string }> = {
  done: { background: "var(--mint-ink, #1b7650)", ring: "var(--mint, #dcf1e6)" },
  "active-info": { background: "var(--blue-ink, #3550c8)", ring: "var(--blue, #e0e8fb)" },
  "active-wait": { background: "var(--cream-ink, #b4561a)", ring: "var(--cream, #fbe9d8)" },
  pending: { background: "var(--line-2, #d7d3ca)", ring: "transparent" },
  terminal: { background: "var(--ink, #131417)", ring: "var(--ink, #131417)" },
};

const LABEL_TONE: Record<LifecycleStepState, string> = {
  done: "var(--ink, #131417)",
  "active-info": "var(--blue-ink, #3550c8)",
  "active-wait": "var(--cream-ink, #b4561a)",
  pending: "var(--ink-3, #8c8c94)",
  terminal: "var(--ink, #131417)",
};

/**
 * Canonical 5-step public lifecycle line. Wraps to a vertical stack on
 * narrow screens; never overflows horizontally.
 */
export function LifecycleStrip({
  steps,
  label,
  variant = "timeline",
}: {
  steps: LifecycleStep[];
  label?: string;
  variant?: "timeline" | "inline";
}) {
  if (variant === "inline") {
    return (
      <div
        role="list"
        aria-label={label ?? "Campaign lifecycle"}
        style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}
      >
        {steps.map((s) => {
          const dot = DOT[s.state];
          const dim = s.state === "pending";
          return (
            <span
              key={s.key}
              role="listitem"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
                fontWeight: 700,
                letterSpacing: "0.06em",
                color: dim ? "var(--ink-3, #8c8c94)" : LABEL_TONE[s.state],
                opacity: dim ? 0.75 : 1,
              }}
              title={s.sublabel ?? undefined}
            >
              <span
                aria-hidden="true"
                style={{ width: 8, height: 8, borderRadius: "50%", background: dot.background, flexShrink: 0 }}
              />
              {s.key}
            </span>
          );
        })}
      </div>
    );
  }
  return (
    <div role="list" aria-label={label ?? "Campaign lifecycle"} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {steps.map((s, i) => {
        const dot = DOT[s.state];
        const last = i === steps.length - 1;
        return (
          <div key={s.key} role="listitem" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  marginTop: 3,
                  background: dot.background,
                  boxShadow: dot.ring === "transparent" ? "none" : `0 0 0 4px ${dot.ring}`,
                }}
              />
              {!last && (
                <span
                  aria-hidden="true"
                  style={{ width: 2, flex: 1, minHeight: 18, background: "var(--line, #e5e5e5)", margin: "4px 0" }}
                />
              )}
            </div>
            <div style={{ paddingBottom: last ? 0 : 14, minWidth: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  color: LABEL_TONE[s.state],
                }}
              >
                {s.key}
              </p>
              {s.sublabel && (
                <p className="tnum" style={{ margin: "2px 0 0", fontSize: 13, opacity: 0.75 }}>
                  {s.sublabel}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
