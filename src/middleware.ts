import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildCsp, generateNonce } from "@/server/security/csp";

/**
 * Per-request Content-Security-Policy with a fresh nonce.
 *
 * The SAME policy value is set on the request headers (so Next.js can
 * extract the nonce during server rendering and stamp it onto framework
 * scripts — without this, every streamed/inline first-party script is
 * blocked and hydration never runs) and on the response headers (so the
 * browser enforces it). See `src/server/security/csp.ts` for the policy.
 *
 * Kept as `middleware.ts` (not `proxy.ts`): the rename is a convention
 * deprecation only, and the current form is fully supported.
 */
export function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // Framework nonce extraction reads the REQUEST Content-Security-Policy.
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
