"use client";

import { useEffect } from "react";
import type { RoleIntent } from "@/lib/roleIntent";

/**
 * Persists a validated ?role= hint through the existing
 * POST /api/persona/select route (the only place that writes the HttpOnly
 * persona cookie — Server Components cannot set cookies at runtime).
 * Best-effort: the ?role= param itself already drives copy + /welcome
 * resolution, so a failed write degrades to generic auth, never an error.
 */
export function PersistRole({ role }: { role: RoleIntent }) {
  useEffect(() => {
    fetch("/api/persona/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: role }),
    }).catch(() => null);
  }, [role]);
  return null;
}
