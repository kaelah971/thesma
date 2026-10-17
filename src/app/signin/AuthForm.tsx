"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiError } from "@/lib/api";
import styles from "./signin.module.css";

export function AuthForm({ next, initialMode }: { next: string; initialMode: "signin" | "signup" }) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const body: Record<string, string> = {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    };
    const name = String(form.get("name") ?? "").trim();
    if (mode === "signup" && name) body.name = name;
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res || !res.ok) {
      setError(await apiError(res, mode === "signin" ? "Couldn't sign in. Check your email and password." : "Couldn't create the account."));
      setPending(false);
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <div className={styles.form}>
      <div className={styles.tabs} role="tablist" aria-label="Account">
        <button type="button" role="tab" aria-selected={mode === "signin"} onClick={() => setMode("signin")}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
          Create account
        </button>
      </div>
      <form onSubmit={onSubmit} className={styles.fields}>
        {mode === "signup" && (
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" name="name" className="input" autoComplete="name" />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="email" required className="input" autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={mode === "signup" ? 8 : 1}
            className="input"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
          {mode === "signup" && <span className="form-note">At least 8 characters.</span>}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
