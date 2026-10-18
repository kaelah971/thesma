"use client";

import { useState } from "react";

function shortHash(value: string, front = 10, back = 6): string {
  if (value.length <= front + back + 1) return value;
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

/**
 * A hash as an evidence object: truncated mono value + copy button +
 * explorer link where one exists. Never a bare uncopyable hash.
 */
export function EvidenceHash({
  value,
  explorerUrl,
  label,
  front,
  back,
}: {
  value: string;
  explorerUrl?: string | null;
  label?: string;
  front?: number;
  back?: number;
}) {
  const [copied, setCopied] = useState(false);
  const ariaLabel = label ?? `Copy ${value.slice(0, 18)}…`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%" }}
      title={value}
    >
      <code
        className="mono"
        style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {shortHash(value, front, back)}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={ariaLabel}
        title={copied ? "Copied" : "Copy full value"}
        style={{
          flexShrink: 0,
          border: "1px solid var(--line, #e5e5e5)",
          background: "var(--surface, #fff)",
          borderRadius: 999,
          padding: "2px 10px",
          fontSize: 12,
          fontWeight: 600,
          color: copied ? "var(--mint-ink, #1b7650)" : "var(--ink-2, #4b4d55)",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {explorerUrl && (
        <a
          href={explorerUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open in Arc explorer: ${value.slice(0, 18)}…`}
          title="Open in Arc explorer"
          style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: "var(--blue-ink, #3550c8)" }}
        >
          View ↗
        </a>
      )}
    </span>
  );
}
