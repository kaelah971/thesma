"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/Logo";
import styles from "./landing.module.css";

const LINKS = [
  { href: "/markets", label: "Live markets" },
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#verified-outcomes", label: "Verified outcomes" },
  { href: "#developers", label: "Developers" },
  { href: "#faq", label: "FAQ" },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={styles.nav}>
      <div className={styles.navInner}>
        <Logo />
        <nav aria-label="Primary" className={styles.navLinks}>
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className={styles.navActions}>
          <Link href="/signin" className={styles.navSignin}>
            Open app
          </Link>
          <Link href="/signin?next=/app/campaigns/new" className="btn btn-primary btn-sm">
            Launch a campaign
          </Link>
        </div>
        <button
          type="button"
          className={styles.navToggle}
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          <span data-open={open} />
        </button>
      </div>
      <div id="mobile-menu" className={styles.mobileMenu} data-open={open} hidden={!open}>
        <nav aria-label="Mobile">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </a>
          ))}
        </nav>
        <div className={styles.mobileActions}>
          <Link href="/signin" className="btn btn-ghost">
            Open app
          </Link>
          <Link href="/signin?next=/app/campaigns/new" className="btn btn-primary">
            Launch a campaign
          </Link>
        </div>
      </div>
    </header>
  );
}
