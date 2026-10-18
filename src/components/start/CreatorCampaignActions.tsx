"use client";

import Link from "next/link";
import { useState } from "react";
import { postJson } from "@/lib/api";

/** Join a live campaign. Idempotent server-side: re-join reuses the same referral. */
export function JoinCampaignButton({
  campaignId,
  onJoined,
}: {
  campaignId: string;
  onJoined: (referralCode: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setPending(true);
    setError(null);
    const res = await postJson<{ referral: { code: string } }>(`/api/campaigns/${campaignId}/join`, {});
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onJoined(res.data.referral.code);
  }

  return (
    <div>
      <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={join}>
        {pending ? "Joining…" : "Join campaign"}
      </button>
      {error && (
        <p className="form-error" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Copy the stable tracked referral link. Absolute URL, clipboard with fallback. */
export function CopyReferralLink({ referralPath }: { referralPath: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}${referralPath}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={copy}
      aria-live="polite"
      title={`${window.location.origin}${referralPath}`}
    >
      {copied ? "Copied ✓" : "Copy referral link"}
    </button>
  );
}

/** Per-campaign actions: Join once, then View + Copy. */
export function CreatorCampaignActions({
  campaignId,
  initialReferralPath,
}: {
  campaignId: string;
  initialReferralPath: string | null;
}) {
  const [referralPath, setReferralPath] = useState<string | null>(initialReferralPath);

  if (!referralPath) {
    return (
      <JoinCampaignButton campaignId={campaignId} onJoined={(code) => setReferralPath(`/r/${code}`)} />
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      <Link href={`/creator/${campaignId}`} className="btn btn-primary btn-sm">
        View campaign
      </Link>
      <CopyReferralLink referralPath={referralPath} />
    </div>
  );
}
