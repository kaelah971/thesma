import Image from "next/image";
import Link from "next/link";

/** Real Thesma brand assets (derived from docs/ui redesign/refs/logo.jpg). */
const MARK = { src: "/brand/thesma-mark.png", w: 306, h: 256 };
const WORDMARK = { src: "/brand/thesma-wordmark.png", w: 727, h: 93 };

/** The Thesma "T" mark. `tile` sets it on a soft surface for avatar use. */
export function LogoMark({ size = 28, tile = false }: { size?: number; tile?: boolean }) {
  const height = tile ? Math.round(size * 0.56) : size;
  const img = (
    <Image
      src={MARK.src}
      alt=""
      aria-hidden="true"
      width={Math.round((height * MARK.w) / MARK.h)}
      height={height}
      priority={!tile}
      style={{ display: "block", flex: "none" }}
    />
  );
  if (!tile) return img;
  return (
    <span
      aria-hidden="true"
      style={{
        display: "grid",
        placeItems: "center",
        flex: "none",
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        background: "#fff",
        boxShadow: "inset 0 0 0 1px rgba(19, 20, 23, 0.08)",
      }}
    >
      {img}
    </span>
  );
}

export function Logo({ href = "/", size = 28 }: { href?: string; size?: number }) {
  const wordHeight = Math.round(size * 0.44);
  return (
    <Link href={href} aria-label="Thesma home" style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.38) }}>
      <LogoMark size={size} />
      <Image
        src={WORDMARK.src}
        alt="Thesma"
        width={Math.round((wordHeight * WORDMARK.w) / WORDMARK.h)}
        height={wordHeight}
        priority
        style={{ display: "block" }}
      />
    </Link>
  );
}
