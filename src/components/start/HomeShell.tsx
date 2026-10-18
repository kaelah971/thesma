"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/brand/Logo";
import styles from "./start.module.css";

export function HomeShell({
  eyebrow,
  title,
  copy,
  homeHref,
  children,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  homeHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => null);
    router.replace("/");
    router.refresh();
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.topbar}>
          <Logo href={homeHref} />
          <div className={styles.topbarRight}>
            <Link href="/markets">Live markets</Link>
            <Link href="/start?change=1">Change role</Link>
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
        <div className={styles.hero} style={{ textAlign: "left", marginLeft: 0, marginRight: 0 }}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h1>{title}</h1>
          <p style={{ margin: 0 }}>{copy}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
