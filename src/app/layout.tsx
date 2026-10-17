import type { Metadata, Viewport } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: {
    default: "Thesma — Pay for outcomes. Not promises.",
    template: "%s · Thesma",
  },
  description:
    "Launch outcome-based campaigns, verify real results, and settle payouts only when the proof checks out.",
  openGraph: {
    title: "Thesma — Pay for outcomes. Not promises.",
    description:
      "A market for verified business outcomes: fund a campaign, verify real customer results, settle USDC payouts with receipts.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#f6f5f1",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
