/**
 * Production Content-Security-Policy (pure builder, no framework imports).
 *
 * Next.js streams page data as inline scripts (`self.__next_f.push(...)`)
 * and stamps a nonce onto every framework script it renders — but only when
 * it can extract that nonce from the **request's** `Content-Security-Policy`
 * (or `-Report-Only`) header during server rendering. The middleware must
 * therefore send the SAME policy value on the request headers (for nonce
 * extraction) and the response headers (for browser enforcement).
 *
 * Policy notes:
 * - `script-src 'self' 'nonce-…' 'strict-dynamic'`: modern browsers enforce
 *   nonce + trust-propagation and ignore the allowlist; pre-strict-dynamic
 *   browsers fall back to `'self'` + nonce. No `unsafe-inline` (browsers
 *   ignore it whenever strict-dynamic/nonce is active — keeping it only
 *   suggests inline scripts may run, which they must not). No `unsafe-eval`.
 * - `style-src 'self' 'unsafe-inline'`: React renders `style={}` props as
 *   inline style attributes, which require `unsafe-inline` (there is no
 *   strict-dynamic equivalent for styles). No external stylesheets.
 */
export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}
