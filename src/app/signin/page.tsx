import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { Rail } from "@/components/ui/Rail";
import { PersistRole } from "@/components/start/PersistRole";
import { ROLE_SIGNIN_COPY, parseRoleIntent } from "@/lib/roleIntent";
import { getSessionUser } from "@/server/auth/guard";
import { isDbConfigured } from "@/server/db/client";
import { AuthForm } from "./AuthForm";
import styles from "./signin.module.css";

export const metadata: Metadata = { title: "Sign in" };

/** Only same-origin relative paths are accepted as a post-auth destination. */
function safeNext(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/app";
}

function firstParam(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // Role-aware default: /welcome resolves the stored persona to the correct
  // onboarding or role home. Explicit ?next= destinations are still honored.
  const next = params.next === undefined ? "/welcome" : safeNext(params.next);
  // Preserve role intent explicitly: a validated ?role= drives role-specific
  // copy below and is echoed through RoleCards links and /welcome. Cookie
  // persistence goes through <PersistRole> → POST /api/persona/select,
  // because Server Components cannot set cookies at runtime (it 500s in
  // production). Unknown values fall back to generic auth — never an error,
  // never a bypass.
  const role = parseRoleIntent(firstParam(params.role));
  if (isDbConfigured() && (await getSessionUser())) redirect(next);
  const copy = role ? ROLE_SIGNIN_COPY[role] : null;

  return (
    <div className={styles.page}>
      {role && <PersistRole role={role} />}
      <div className={styles.panel}>
        <span className={styles.shine} aria-hidden="true" />
        <div className={styles.formSide}>
          <Logo />
          <div className={styles.formBody}>
            {role && (
              <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", opacity: 0.6 }}>
                Continuing as {role === "organization" ? "an organization" : role === "developer" ? "a builder" : `a ${role}`}
              </p>
            )}
            <h1>{copy?.headline ?? "Welcome to Thesma"}</h1>
            <p>{copy?.sub ?? "Sign in to manage campaigns, verified outcomes and payouts."}</p>
            {isDbConfigured() ? (
              <AuthForm next={next} initialMode={params.mode === "signup" ? "signup" : "signin"} />
            ) : (
              <p className="form-error" role="alert">
                Sign-in is unavailable: this deployment has no database configured.
              </p>
            )}
          </div>
          <p className={styles.legal}>Sign in with your work email. Payment keys are never stored in your browser.</p>
        </div>

        <aside className={styles.artSide} aria-hidden="true">
          <div className={styles.artWord}>Verified</div>
          <div className={styles.artCard}>
            <span className={styles.artLabel}>Payout in safety hold</span>
            <strong className="tnum">60 USDC</strong>
            <Rail steps={["Verify", "Hold", "Settle"]} current={1} size="sm" />
            <p>Verified, not yet paid. Payment waits until the campaign hold ends.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
