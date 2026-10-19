"use client";

import Link from "next/link";

/** Route boundary: a Scout/panel failure shows a recoverable panel, never a black page. */
export default function CreatorError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: "0 16px" }}>
      <p style={{ fontSize: 13, letterSpacing: 2, fontWeight: 800 }}>CREATOR / SOMETHING STALLED</p>
      <h1 style={{ fontSize: 24, margin: "8px 0" }}>Scout couldn&apos;t load this view.</h1>
      <p style={{ fontSize: 14, color: "var(--ink-2)" }}>
        Nothing was joined or changed. Try again, or head back to your creator home.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={reset}>
          Try again
        </button>
        <Link href="/creator" className="btn btn-sm">
          Back to creator home
        </Link>
      </div>
    </main>
  );
}
