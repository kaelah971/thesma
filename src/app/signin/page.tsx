import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { landingFonts } from "@/components/landing/fonts";
import { Rail } from "@/components/ui/Rail";
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

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  if (isDbConfigured() && (await getSessionUser())) redirect(next);

  return (
    <div className={`${landingFonts} ${styles.page}`}>
      <div className={styles.panel}>
        <span className={styles.shine} aria-hidden="true" />
        <div className={styles.formSide}>
          <Logo />
          <div className={styles.formBody}>
            <h1>Welcome to Thesma</h1>
            <p>Sign in to manage campaigns, verified outcomes and payouts.</p>
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
