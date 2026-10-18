import { IBM_Plex_Mono, Silkscreen } from "next/font/google";

/**
 * Thesma typography, loaded once in the root layout.
 * Display: Silkscreen (the face used by the Meros heading reference).
 * Body / product: IBM Plex Mono (the face used by the Tameion body reference).
 */
export const display = Silkscreen({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-display",
  display: "swap",
});

export const body = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});
