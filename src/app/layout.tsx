import type { Metadata, Viewport } from "next";
import { body, display } from "./fonts";
import "./globals.css";

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
