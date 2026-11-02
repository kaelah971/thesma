import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { SignOutButton } from "@/components/app/ShellControls";
import { DeveloperNav } from "./DeveloperNav";
import styles from "@/components/app/app.module.css";
import type { DeveloperContext } from "@/app/build/data";

export function DeveloperShell({ context, children }: { context: DeveloperContext; children: React.ReactNode }) {
  const initials = (context.user.name ?? context.user.email).slice(0, 2).toUpperCase();
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <Logo href="/build" />
        </div>
        <div className={styles.wsStatic}>
          <span className={styles.wsLabel}>Project</span>
          <span className={styles.wsName}>{context.projectName ?? "Set up your project"}</span>
        </div>
        <DeveloperNav />
        <div className={styles.sidebarFoot}>
          <span className={styles.userAvatar} aria-hidden="true">{initials}</span>
          <div className={styles.userMeta}>
            <span>{context.user.name ?? "Signed in"}</span>
            <small>{context.user.email}</small>
            <Link href="/start?change=1" style={{ fontSize: 12, marginTop: 4 }}>Change role</Link>
          </div>
          <SignOutButton />
        </div>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
