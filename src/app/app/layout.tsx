import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { AppNav } from "@/components/app/AppNav";
import { SignOutButton, WorkspaceSwitcher } from "@/components/app/ShellControls";
import styles from "@/components/app/app.module.css";
import { getAppSession } from "./data";
import {
  PERSONA_COOKIE,
  PERSONA_INTENT_COOKIE,
  parsePersona,
  personaFromEnum,
  resolveProductPersona,
} from "@/server/services/personas";

export const metadata: Metadata = { title: { default: "Overview", template: "%s · Thesma" } };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getAppSession();

  if (session.kind === "unconfigured") {
    return (
      <div className={styles.unconfigured}>
        <Logo />
        <h1>The app isn&apos;t connected to a database.</h1>
        <p>Set DATABASE_URL and run migrations to use campaigns, outcomes and payouts. The marketing site works without it.</p>
      </div>
    );
  }

  const jar = await cookies();
  const selectedPersona = parsePersona(jar.get(PERSONA_COOKIE)?.value);
  const explicitPersona = parsePersona(jar.get(PERSONA_INTENT_COOKIE)?.value);
  const persona = await resolveProductPersona({
    userId: session.user.userId,
    selectedPersona,
    explicitPersona,
    // Legacy developer accounts may have an organization persona row because
    // the pre-fix flow created their project through organization onboarding.
    // Membership is recovery evidence only; it never grants organization UI.
    legacyDeveloperSignal: selectedPersona === "developer" && session.workspaces.length > 0,
  });
  if (persona && personaFromEnum(persona.persona) === "developer") redirect("/build");
  const initials = (session.user.name ?? session.user.email).slice(0, 2).toUpperCase();

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <Logo href="/app" />
        </div>
        <WorkspaceSwitcher workspaces={session.workspaces} currentId={session.current?.id ?? null} />
        <AppNav />
        <div className={styles.sidebarFoot}>
          <span className={styles.userAvatar} aria-hidden="true">
            {initials}
          </span>
          <div className={styles.userMeta}>
            <span>{session.user.name ?? "Signed in"}</span>
            <small>{session.user.email}</small>
            <Link href="/start?change=1" style={{ fontSize: 12, marginTop: 4 }}>Change role</Link>
          </div>
          <SignOutButton />
        </div>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
