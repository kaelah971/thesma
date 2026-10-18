const DEFAULT_NOTES = [
  "VERIFIED ≠ PAID — verified means the outcome passed evidence checks. Payment is only final after the payout is reconciled against Arc.",
  "SUBMITTED ≠ SETTLED — submitted means a transaction was sent. Thesma only calls it settled after matching the onchain OutcomePaid event.",
];

/**
 * Compact trust band for the two semantic safeguards.
 * Rendered as a band, never tiny disclaimer copy.
 */
export function TruthNote({ items }: { items?: string[] }) {
  const notes = items && items.length > 0 ? items : DEFAULT_NOTES;
  return (
    <section
      aria-label="Settlement truth"
      style={{
        border: "1px solid var(--line, #e5e5e5)",
        borderLeft: "3px solid var(--mint-ink, #1b7650)",
        borderRadius: 12,
        background: "var(--surface, #fff)",
        padding: "12px 16px",
        display: "grid",
        gap: 8,
      }}
    >
      {notes.map((n) => (
        <p key={n.slice(0, 40)} style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
          {n}
        </p>
      ))}
    </section>
  );
}
