import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Per-request Content-Security-Policy with a fresh nonce.
 *
 * Next.js streams page data as inline scripts (`self.__next_f.push(...)`):
 * a static `script-src 'self'` (no nonces) blocks those scripts and leaves
 * every streamed route stuck on its loading fallback with dead
 * interactivity. The framework reads the `x-nonce` request header and
 * stamps its own scripts, so first-party-only execution is preserved:
 * external/unknown scripts still cannot run.
 *
 * `strict-dynamic` (+ `https:`/`http:`/`'unsafe-inline'` as spec-mandated
 * fallbacks that modern browsers ignore when a nonce or strict-dynamic is
 * present) keeps ancient browsers functional without weakening modern ones.
 * Eval-based script execution is never allowed.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: http: 'unsafe-inline'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
