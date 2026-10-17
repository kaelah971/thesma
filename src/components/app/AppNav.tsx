"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./app.module.css";

const ITEMS = [
  { href: "/app", label: "Overview", icon: "M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z" },
  { href: "/app/campaigns", label: "Campaigns", icon: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" },
  { href: "/app/outcomes", label: "Outcomes", icon: "M4 10.5l3.5 3.5L16 5.5" },
  { href: "/app/payouts", label: "Payouts", icon: "M5 3h10v14l-2.5-1.5L10 17l-2.5-1.5L5 17zM8 7.5h4M8 10.5h4" },
  { href: "/app/operator", label: "Operator", icon: "M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z" },
  { href: "/app/activity", label: "Activity", icon: "M3 10h3l2-5 4 10 2-5h3" },
  { href: "/app/settings", label: "Settings", icon: "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8" },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="App" className={styles.nav}>
      {ITEMS.map((item) => {
        const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={styles.navItem}>
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
              <path d={item.icon} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
