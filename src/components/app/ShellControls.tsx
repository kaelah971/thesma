"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { selectWorkspace } from "@/app/app/actions";
import styles from "./app.module.css";

export function WorkspaceSwitcher({ workspaces, currentId }: { workspaces: { id: string; name: string }[]; currentId: string | null }) {
  if (workspaces.length <= 1) {
    const only = workspaces[0];
    return (
      <div className={styles.wsStatic}>
        <span className={styles.wsLabel}>Workspace</span>
        <span className={styles.wsName}>{only?.name ?? "No workspace yet"}</span>
      </div>
    );
  }
  return (
    <form action={selectWorkspace} className={styles.wsStatic}>
      <label htmlFor="ws-select" className={styles.wsLabel}>
        Workspace
      </label>
      <select
        id="ws-select"
        name="workspaceId"
        defaultValue={currentId ?? undefined}
        className={styles.wsSelect}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </form>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={styles.signOut}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await fetch("/api/auth/signout", { method: "POST" }).catch(() => null);
        router.replace("/");
        router.refresh();
      }}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
