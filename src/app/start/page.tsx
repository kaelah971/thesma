import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { Logo } from "@/components/brand/Logo";
import { RoleCards } from "@/components/start/RoleCards";
import { getSessionUser } from "@/server/auth/guard";
import { isDbConfigured } from "@/server/db/client";
import { getPartnerByUserId } from "@/server/services/partners";
import { listUserWorkspaces } from "@/server/services/workspaces";
import { PERSONA_COOKIE, getPersonaByUserId, parsePersona, personaFromEnum, personaHome } from "@/server/services/personas";
import styles from "@/components/start/start.module.css";

export const metadata: Metadata = { title: "Start" };

/** Returning users with a finished onboarding skip the gateway (unless ?change=1). */
async function returningDestination(): Promise<string | null> {
  if (!isDbConfigured()) return null;
  const user = await getSessionUser();
  if (!user) return null;
  const persona = await getPersonaByUserId(user.userId);
  if (!persona || !persona.onboardingCompletedAt) return null;
  const p = personaFromEnum(persona.persona);
  if (!p) return null;
  if (p === "organization") {
    const memberships = await listUserWorkspaces(user.userId).catch(() => []);
    if (memberships.length === 0) return null;
  }
  if (p === "creator") {
    const partner = await getPartnerByUserId(user.userId).catch(() => null);
    if (!partner) return null;
  }
  return personaHome(p);
}

export default async function StartPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const change = params.change === "1";
  // Honor an explicit role hint without tracking params: persist it server-side.
  const hinted = parsePersona(Array.isArray(params.role) ? params.role[0] : params.role);
  if (hinted) {
    (await cookies()).set(PERSONA_COOKIE, hinted, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  if (!change) {
    const dest = await returningDestination();
    if (dest) redirect(dest);
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.topbar}>
          <Logo />
          <div className={styles.topbarRight}>
            <Link href="/markets">Live markets</Link>
            <Link href="/signin">Sign in</Link>
          </div>
        </div>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>Role gateway</span>
          <h1>How will you use Thesma?</h1>
          <p>Choose what you&apos;re here to do. Thesma will shape the experience around you.</p>
        </div>
        <RoleCards />
        <p className={styles.footnote}>
          Just browsing? <Link href="/markets">Explore live markets</Link> — no login required.
        </p>
      </div>
    </div>
  );
}
