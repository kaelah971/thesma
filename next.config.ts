import type { NextConfig } from "next";

/**
 * Public trust baseline. HSTS is already enforced by the hosting platform;
 * everything else here is explicit so scanners and users can verify it.
 *
 * CSP notes:
 * - script-src 'self' only: all Thesma JS is first-party `/_next/static`.
 *   No analytics, no third-party scripts, no dynamic code execution.
 * - style-src allows 'unsafe-inline': Next.js injects compiled styles inline.
 * - img-src data:/blob: covers favicons and generated artwork.
 * - frame-ancestors 'none': Thesma must never render inside another site's
 *   iframe (clickjacking). Wallet flows run top-level only.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
