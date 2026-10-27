"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/api";
import { formatUsdc } from "@/lib/format";

interface CreatorAuthority {
  campaignDiscovery: string;
  directInvitations: string;
  minimumBountyMicroUsdc: string;
  minConfidence: string;
  maxActiveCampaigns: string;
  maxAutoJoinsPerDay: string;
  blockedCategories: string[];
  allowedCategories: string[];
  hybridOffers: string;
  autoJoin: boolean;
}

/** Creator-side agent authority, derived strictly from existing Scout rules. No financial data. */
export function CreatorAutonomyPanel() {
  const [authority, setAuthority] = useState<CreatorAuthority | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await getJson<{ authority: CreatorAuthority }>("/api/creator/autonomy");
      if (live && res.ok) setAuthority(res.data.authority);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!authority) return null;
  return (
    <div style={{ border: "1px solid var(--line, #e5e5e5)", borderRadius: 12, padding: "10px 14px", marginTop: 12 }} aria-label="Agent authority">
      <strong style={{ fontSize: 13, letterSpacing: 1 }}>AGENT AUTHORITY</strong>
      <dl style={{ display: "grid", gap: 4, margin: "8px 0 0", fontSize: 12.5 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <dt style={{ opacity: 0.7 }}>Campaign discovery</dt>
          <dd style={{ margin: 0, fontWeight: 700 }}>{authority.campaignDiscovery}</dd>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <dt style={{ opacity: 0.7 }}>Direct invitations</dt>
          <dd style={{ margin: 0, fontWeight: 700 }}>{authority.directInvitations}</dd>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <dt style={{ opacity: 0.7 }}>Minimum bounty</dt>
          <dd style={{ margin: 0 }}>{formatUsdc(authority.minimumBountyMicroUsdc)} USDC</dd>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <dt style={{ opacity: 0.7 }}>Confidence / caps</dt>
          <dd style={{ margin: 0 }}>
            {authority.minConfidence}+ · max {authority.maxActiveCampaigns} active · {authority.maxAutoJoinsPerDay}/day
          </dd>
        </div>
        {authority.blockedCategories.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <dt style={{ opacity: 0.7 }}>Blocked</dt>
            <dd style={{ margin: 0 }}>{authority.blockedCategories.join(", ")}</dd>
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <dt style={{ opacity: 0.7 }}>Hybrid offers</dt>
          <dd style={{ margin: 0, fontWeight: 700 }}>{authority.hybridOffers.replace("_", " ")}</dd>
        </div>
      </dl>
      <p style={{ fontSize: 12, opacity: 0.7, margin: "8px 0 0" }}>
        {authority.autoJoin ? "Your agent may accept matching invitations automatically." : "Your agent recommends; you approve every acceptance."} Hybrid
        economics always need your review.
      </p>
    </div>
  );
}
