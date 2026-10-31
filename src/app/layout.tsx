import type { Metadata, Viewport } from "next";
import { body, display } from "./fonts";
import "./globals.css";

/**
 * Forced dynamic rendering (entire app).
 *
 * The middleware issues a global per-request CSP nonce (`src/middleware.ts`,
 * no matcher). Statically prerendered HTML is fixed at build time, so it
 * can never carry the request's fresh nonce — the framework's inline
 * scripts would ship without (or with a stale) nonce, the browser would
 * block them, and hydration would never run (dead mobile nav, stuck
 * loading fallbacks). Keeping this here — rather than per-page — guards
 * every current and future route against that regression class.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://thesma.vercel.app"),
  title: {
    default: "Thesma · Autonomous operators for growth campaigns",
    template: "%s · Thesma",
  },
  description:
    "Autonomous operators for growth campaigns. Pay only for verified results, with every payment bound to proof, budget and policy.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Thesma · Autonomous operators for growth campaigns",
    description:
      "Fund a campaign, verify real customer results and settle USDC payouts with a receipt for every payment.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Thesma · Autonomous operators for growth campaigns",
    description:
      "Fund a campaign, verify real customer results and settle USDC payouts with a receipt for every payment.",
  },
};

export const viewport: Viewport = {
  themeColor: "#f6f5f1",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
