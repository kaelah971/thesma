import type { Metadata } from "next";
import { Logo } from "@/components/brand/Logo";
import { AppNav } from "@/components/app/AppNav";
import { SignOutButton, WorkspaceSwitcher } from "@/components/app/ShellControls";
import styles from "@/components/app/app.module.css";
import { getAppSession } from "./data";

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
          </div>
          <SignOutButton />
        </div>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
