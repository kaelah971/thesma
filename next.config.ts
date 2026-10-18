import type { NextConfig } from "next";

/**
 * Public trust baseline. HSTS is already enforced by the hosting platform.
 *
 * Content-Security-Policy is NOT set here: it is issued per-request by
 * src/middleware.ts with a fresh nonce. Next.js streams page data as
 * inline scripts, so a static `script-src 'self'` would block them and
 * freeze every streamed route on its loading fallback. The middleware
 * passes the nonce via `x-nonce`, which the framework stamps onto its own
 * scripts — first-party-only execution is preserved. Everything else here
 * is static and safe to declare once.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
