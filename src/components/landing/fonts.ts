import { IBM_Plex_Mono, Silkscreen } from "next/font/google";

/**
 * Landing typography. Loaded here (not in the root layout) so the fonts are
 * only preloaded on surfaces that render them: the landing page and sign-in.
 * Display: Silkscreen (the face used by the Meros heading reference).
 * Body: IBM Plex Mono (the face used by the Tameion body reference).
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

export const landingFonts = `${display.variable} ${body.variable}`;
