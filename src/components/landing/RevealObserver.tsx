"use client";

import { useEffect } from "react";

/**
 * Lightweight scroll motion for the landing page (no animation library).
 * - Marks `[data-reveal]` elements revealed as they enter the viewport.
 * - Toggles `data-inview` on `[data-inview-track]` so looping motion pauses offscreen.
 * Content is only hidden once this has mounted (html[data-reveal-ready]), and never
 * for users who prefer reduced motion.
 */
export function RevealObserver() {
  useEffect(() => {
    const root = document.documentElement;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;

    const revealIO = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.revealed = "true";
          revealIO.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    const trackIO = new IntersectionObserver((entries) => {
      for (const entry of entries) (entry.target as HTMLElement).dataset.inview = String(entry.isIntersecting);
    });

    root.dataset.revealReady = "true";
    document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => revealIO.observe(el));
    document.querySelectorAll<HTMLElement>("[data-inview-track]").forEach((el) => trackIO.observe(el));

    return () => {
      revealIO.disconnect();
      trackIO.disconnect();
      delete root.dataset.revealReady;
    };
  }, []);

  return null;
}
