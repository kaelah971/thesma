import Link from "next/link";
import {
  ARC_EXPLORER_FALLBACK,
  explorerBaseUrl,
  sourcifyContractUrl,
} from "@/lib/proof";

/**
 * Reusable public trust footer for unauthenticated surfaces.
 *
 * Every link is repo truth — nothing invented. General support has no
 * published channel, so the footer says so explicitly and points security
 * reports at /security (also published via /.well-known/security.txt).
 * Contract proof reuses the canonical Sourcify builder from `@/lib/proof`;
 * no duplicated constants.
 */
export const GITHUB_REPO_URL = "https://github.com/kaelah971/thesma";

export function PublicFooter() {
  return (
    <footer
      aria-label="Trust and legal"
      style={{
        borderTop: "1px solid var(--line, #e5e5e5)",
        marginTop: 8,
        padding: "24px 0 32px",
      }}
    >
      <nav
        aria-label="Trust, legal and proof"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 20px",
          fontSize: 13.5,
        }}
      >
        <Link href="/demo">Live proof</Link>
        <Link href="/markets">Markets</Link>
        <a href={sourcifyContractUrl()} target="_blank" rel="noreferrer">
          Verified contract
        </a>
        <a
          href={ARC_EXPLORER_FALLBACK}
          target="_blank"
          rel="noreferrer"
          aria-label={`Arc Mainnet explorer at ${explorerBaseUrl()}`}
        >
          Arc Mainnet
        </a>
        <Link href="/security">Security</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
      <p style={{ margin: "12px 0 0", fontSize: 12.5, opacity: 0.65, maxWidth: "60ch" }}>
        Security issues: see <Link href="/security">Security</Link>. General support channel not published yet.
      </p>
    </footer>
  );
}
