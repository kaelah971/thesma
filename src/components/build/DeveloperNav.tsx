"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/components/app/app.module.css";

const ITEMS = [
  { href: "/build", label: "Overview", icon: "M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z" },
  { href: "/build/programs", label: "Growth Programs", icon: "M3 5h14M5 3v4M15 3v4M4 9h4M12 9h4M4 13h4M12 13h4M4 17h12" },
  { href: "/build/integrations", label: "Integrations", icon: "M7 13l-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0M13 7l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0M7 13l6-6" },
  { href: "/build/outcomes", label: "Outcome definitions", icon: "M4 4h12v12H4zM7 8h6M7 11h6M7 14h3" },
  { href: "/build/events", label: "Events", icon: "M3 10h3l2-5 4 10 2-5h3" },
  { href: "/build/receipts", label: "Receipts", icon: "M5 3h10v14l-2.5-1.5L10 17l-2.5-1.5L5 17zM8 7.5h4M8 10.5h4" },
  { href: "/build/usage", label: "Usage / telemetry", icon: "M3 16V8M8 16V4M13 16v-6M18 16V6" },
  { href: "/build/docs", label: "Docs / quickstart", icon: "M4 3h9l3 3v11H4zM13 3v4h4M7 11h6M7 14h6" },
  { href: "/build/settings", label: "Settings", icon: "M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8" },
];

export function DeveloperNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Build with Thesma" className={styles.nav}>
      {ITEMS.map((item) => {
        const active = item.href === "/build" ? pathname === "/build" : pathname.startsWith(item.href);
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
