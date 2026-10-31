/**
 * Role-intent preservation for the public funnel:
 *   /demo → /start → /signin?role=<role>&next=/welcome → /welcome → role home
 *
 * Pure + client-safe: no framework, env, or database imports. The server
 * persona service (`src/server/services/personas.ts`) pulls in drizzle, so
 * this module re-declares the same four slugs and a test enforces parity —
 * intent validation must never drift from the server enum.
 *
 * The persona cookie/row only ever picks UI destinations (onboarding vs role
 * home). Authorization still comes exclusively from workspace_members +
 * ownership checks, so `?role=` can never create an authz bypass.
 */

export const ROLE_INTENTS = ["customer", "creator", "organization", "developer"] as const;
export type RoleIntent = (typeof ROLE_INTENTS)[number];

/** Validated role from a URL param, cookie hint, or API body. Unknown → null (generic auth). */
export function parseRoleIntent(value: unknown): RoleIntent | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (ROLE_INTENTS as readonly string[]).includes(v) ? (v as RoleIntent) : null;
}

/** One auth surface, contextual copy — never four separate auth pages. */
export const ROLE_SIGNIN_COPY: Record<RoleIntent, { headline: string; sub: string }> = {
  customer: {
    headline: "Discover campaigns worth acting on.",
    sub: "Sign in to find campaigns through creators you trust, complete the qualifying action, and see the proof behind every outcome.",
  },
  creator: {
    headline: "Earn from verified outcomes.",
    sub: "Sign in to find live opportunities, accept campaigns, and earn when your audience's verified outcomes settle.",
  },
  organization: {
    headline: "Launch an outcome campaign.",
    sub: "Sign in to launch and operate an outcome campaign — match creators, fund verified growth, and run payouts against proof.",
  },
  developer: {
    headline: "Build on verified outcomes.",
    sub: "Sign in to use Thesma's verification, receipt, and payout infrastructure in your own product. Verification and receipts are live on Thesma markets; API keys and sandbox are coming next.",
  },
};

/** Post-auth homes. Single source for docs/tests; runtime truth lives in `personaHome`. */
export const ROLE_HOME: Record<RoleIntent, "/customer" | "/creator" | "/app" | "/build"> = {
  customer: "/customer",
  creator: "/creator",
  organization: "/app",
  developer: "/build",
};

/** Role-preserving signin link. `next` must be a same-origin path; validated again server-side. */
export function signinHref(role: RoleIntent, next = "/welcome"): string {
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/welcome";
  return `/signin?role=${role}&next=${safeNext}`;
}
