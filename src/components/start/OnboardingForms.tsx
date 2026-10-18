"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api";
import styles from "./start.module.css";

async function saveProfile(body: Record<string, unknown>) {
  return postJson("/api/persona", body);
}

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {error}
    </p>
  );
}

export function CustomerForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (!name) return setError("Add a display name to continue.");
    setPending(true);
    setError(null);
    const res = await saveProfile({ persona: "customer", displayName: name, complete: true });
    setPending(false);
    if (!res.ok) return setError(res.error);
    router.replace("/customer");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className={styles.fields}>
      <h2>Your customer profile</h2>
      <p>Just the basics. Your activity appears here as you complete verified outcomes.</p>
      <div className="field">
        <label htmlFor="cu-name">Display name</label>
        <input id="cu-name" name="name" className="input" defaultValue={initialName} maxLength={100} autoComplete="name" />
      </div>
      <ErrorNote error={error} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Continue to For you"}
        </button>
      </div>
    </form>
  );
}

export function CreatorForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name) return setError("Add a display name to continue.");
    const handle = String(form.get("handle") ?? "").trim();
    if (handle && !/^[a-z0-9_]{3,30}$/i.test(handle.replace(/^@/, ""))) {
      return setError("Handle must be 3–30 lowercase letters, numbers or underscores.");
    }
    setPending(true);
    setError(null);
    const res = await saveProfile({
      persona: "creator",
      displayName: name,
      handle: handle || null,
      bio: String(form.get("bio") ?? "").trim() || null,
      category: String(form.get("category") ?? "").trim() || null,
      complete: true,
    });
    setPending(false);
    if (!res.ok) return setError(res.error);
    router.replace("/creator");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className={styles.fields}>
      <h2>Your creator profile</h2>
      <p>Only what you tell us — nothing is treated as verified reach. Follower counts are never self-reported as truth.</p>
      <div className={styles.row2}>
        <div className="field">
          <label htmlFor="cr-name">Display name</label>
          <input id="cr-name" name="name" className="input" defaultValue={initialName} maxLength={100} autoComplete="name" />
        </div>
        <div className="field">
          <label htmlFor="cr-handle">Handle (optional)</label>
          <input id="cr-handle" name="handle" className="input" maxLength={34} placeholder="@yourname" autoComplete="off" />
          <span className="form-note">Reserves your future public profile. Lowercase letters, numbers, _.</span>
        </div>
      </div>
      <div className="field">
        <label htmlFor="cr-category">Niche / category (optional)</label>
        <input id="cr-category" name="category" className="input" maxLength={100} placeholder="e.g. Fitness, Fintech, Food" />
      </div>
      <div className="field">
        <label htmlFor="cr-bio">Short bio (optional)</label>
        <textarea id="cr-bio" name="bio" className="input" rows={3} maxLength={500} placeholder="What does your audience trust you for?" />
      </div>
      <ErrorNote error={error} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Continue to creator home"}
        </button>
      </div>
    </form>
  );
}

export function OrganizationForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get("name") ?? "").trim();
    const category = String(form.get("category") ?? "").trim();
    if (!name) return setError("Add your company name to continue.");
    setPending(true);
    setError(null);
    const created = await postJson("/api/workspaces", { name, category: category || null });
    if (!created.ok) {
      setPending(false);
      return setError(created.error);
    }
    const marked = await saveProfile({ persona: "organization", complete: true });
    setPending(false);
    if (!marked.ok) return setError(marked.error);
    router.replace("/app");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className={styles.fields}>
      <h2>Create your workspace</h2>
      <p>A workspace holds your company&apos;s campaigns, budget, outcomes and receipts. You&apos;ll be its owner.</p>
      <div className="field">
        <label htmlFor="org-name">Company name</label>
        <input id="org-name" name="name" required maxLength={100} className="input" placeholder="Northwind Goods" />
      </div>
      <div className="field">
        <label htmlFor="org-category">Category (optional)</label>
        <input id="org-category" name="category" maxLength={100} className="input" placeholder="e.g. Apparel" />
      </div>
      <ErrorNote error={error} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create workspace"}
        </button>
      </div>
    </form>
  );
}

export function DeveloperForm({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    setPending(true);
    setError(null);
    const res = await saveProfile({
      persona: "developer",
      ...(name ? { displayName: name } : {}),
      project: String(form.get("project") ?? "").trim() || null,
      complete: true,
    });
    setPending(false);
    if (!res.ok) return setError(res.error);
    router.replace("/build");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className={styles.fields}>
      <h2>What are you building?</h2>
      <p>Optional — it helps Thesma point you at the right infrastructure. Stored on your profile only.</p>
      <div className="field">
        <label htmlFor="dev-name">Display name (optional)</label>
        <input id="dev-name" name="name" className="input" defaultValue={initialName} maxLength={100} autoComplete="name" />
      </div>
      <div className="field">
        <label htmlFor="dev-project">Your product in a sentence (optional)</label>
        <textarea id="dev-project" name="project" className="input" rows={3} maxLength={500} placeholder="e.g. A checkout app that pays creators per verified sale" />
      </div>
      <ErrorNote error={error} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Continue to Build home"}
        </button>
      </div>
    </form>
  );
}
