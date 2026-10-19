"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { serverErrorMessage } from "@/lib/api";

/** Follow/unfollow by handle (server resolves identity). Logged-out visitors route through signin and return. */
export function FollowButton({
  creatorHandle,
  initialFollowing,
  signedIn,
}: {
  creatorHandle: string;
  initialFollowing: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!signedIn) {
      router.push(`/signin?next=/${creatorHandle}`);
      return;
    }
    setPending(true);
    setError(null);
    const res = await fetch(`/api/creator/follow`, {
      method: following ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: creatorHandle }),
    })
      .then((r) => r.json() as Promise<{ following?: boolean; error?: { message?: string } | string }>)
      .catch(() => null);
    setPending(false);
    if (!res || typeof res.following !== "boolean") {
      setError(serverErrorMessage(res, "Couldn't update follow. Try again."));
      return;
    }
    setFollowing(res.following);
    router.refresh();
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button type="button" className={following ? "btn btn-sm" : "btn btn-primary btn-sm"} disabled={pending} onClick={toggle}>
        {pending ? "Working…" : following ? "Following" : "Follow"}
      </button>
      {error && (
        <span className="form-error" role="alert" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
    </span>
  );
}
