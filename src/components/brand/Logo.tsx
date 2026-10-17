import Link from "next/link";

/** Thesma mark: a θ seal — the thesis, verified. */
export function LogoMark({ size = 28, inverted = false }: { size?: number; inverted?: boolean }) {
  const tile = inverted ? "#ffffff" : "#131417";
  const stroke = inverted ? "#131417" : "#ffffff";
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="8.5" fill={tile} />
      <ellipse cx="14" cy="14" rx="6.1" ry="7.6" fill="none" stroke={stroke} strokeWidth="2.2" />
      <path d="M8.6 14h10.8" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ href = "/", inverted = false, size = 28 }: { href?: string; inverted?: boolean; size?: number }) {
  return (
    <Link
      href={href}
      aria-label="Thesma home"
      style={{ display: "inline-flex", alignItems: "center", gap: 10, fontWeight: 600, fontSize: 19, letterSpacing: "-0.02em" }}
    >
      <LogoMark size={size} inverted={inverted} />
      <span>Thesma</span>
    </Link>
  );
}
