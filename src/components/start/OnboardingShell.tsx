import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import styles from "./start.module.css";

export function OnboardingShell({
  eyebrow,
  title,
  copy,
  children,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.topbar}>
          <Logo />
          <div className={styles.topbarRight}>
            <Link href="/start?change=1">Change role</Link>
          </div>
        </div>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1>{title}</h1>
          <p>{copy}</p>
        </div>
        <div className={styles.formCard}>{children}</div>
      </div>
    </div>
  );
}
