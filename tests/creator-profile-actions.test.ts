import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  guestProfileAction,
  loadOrgInviteCampaigns,
  resolveProfileActions,
  type OrgInviteCampaignDeps,
} from "@/server/services/profileActions";

/**
 * Public-profile → collaboration bridge.
 *
 * Proves the /@handle action area routes each viewer correctly while the CTA
 * itself stays navigation-only: no invitation, referral, reservation, or
 * payout is ever created by resolving or clicking it. All fixtures use
 * synthetic ids/handles — nothing names a real creator.
 */

const CREATOR = "creator-u-1";

function deps(over: Partial<OrgInviteCampaignDeps> = {}): OrgInviteCampaignDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listMemberships(userId: string) {
      calls.push(`listMemberships:${userId}`);
      return [{ workspaceId: "ws-1", workspaceName: "Northstar", role: "ORGANIZATION_OWNER" }];
    },
    async listCampaigns(workspaceId: string) {
      calls.push(`listCampaigns:${workspaceId}`);
      return [{ id: "c-approved", state: "APPROVED" }];
    },
    async getIntent(campaignId: string) {
      calls.push(`getIntent:${campaignId}`);
      return "Acquire customers with attestations";
    },
    ...over,
  };
}

describe("profile action decisions", () => {
  it("creator owner sees the dashboard CTA routing to /creator", () => {
    const action = resolveProfileActions({ isSelf: true, isOrgMember: false, inviteOptions: [] });
    expect(action).toEqual({ kind: "self", dashboardHref: "/creator" });
    if (action.kind === "self") expect(action.dashboardHref).toBe("/creator");
    else expect.unreachable();
  });

  it("even an org-member creator viewing their own page gets the dashboard CTA, not an invite list", () => {
    const action = resolveProfileActions({ isSelf: true, isOrgMember: true, inviteOptions: [] });
    expect(action.kind).toBe("self");
  });

  it("org viewer gets Work-with-creator invite options into the existing flow", async () => {
    const d = deps();
    const { isOrgMember, options } = await loadOrgInviteCampaigns(d, "owner-1", CREATOR);
    expect(isOrgMember).toBe(true);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      campaignId: "c-approved",
      workspaceName: "Northstar",
      state: "APPROVED",
    });
    // Canonical campaign page + creator highlight — the existing invitation
    // flow does every auth/economics check downstream.
    expect(options[0].href).toBe(`/app/campaigns/c-approved?creator=${CREATOR}`);
    const action = resolveProfileActions({ isSelf: false, isOrgMember, inviteOptions: options });
    expect(action.kind).toBe("org-invite");
  });

  it("LIVE campaigns are invitable; non-invitable states are excluded", async () => {
    const d = deps({
      async listCampaigns() {
        return [
          { id: "c-live", state: "LIVE" },
          { id: "c-draft", state: "DRAFT" },
          { id: "c-review", state: "REVIEW" },
          { id: "c-funding", state: "FUNDING" },
          { id: "c-paused", state: "PAUSED" },
          { id: "c-closed", state: "CLOSED" },
        ];
      },
    });
    const { options } = await loadOrgInviteCampaigns(d, "owner-1", CREATOR);
    expect(options.map((o) => o.campaignId)).toEqual(["c-live"]);
  });

  it("org with no eligible campaign gets create/approve guidance, never a dead button", () => {
    const action = resolveProfileActions({ isSelf: false, isOrgMember: true, inviteOptions: [] });
    expect(action).toEqual({ kind: "org-empty", newCampaignHref: "/app/campaigns/new" });
  });

  it("logged-out visitors never see a dashboard CTA and route through the role flow", () => {
    const action = guestProfileAction();
    expect(action).toEqual({ kind: "guest", startHref: "/start?role=organization" });
    expect(JSON.stringify(action)).not.toMatch(/\/creator/);
  });

  it("creator A viewing creator B gets neutral actions only", () => {
    const action = resolveProfileActions({ isSelf: false, isOrgMember: false, inviteOptions: [] });
    expect(action).toEqual({ kind: "neutral" });
  });

  it("org CTA never exposes the creator private dashboard", async () => {
    const d = deps();
    const { isOrgMember, options } = await loadOrgInviteCampaigns(d, "owner-1", CREATOR);
    const orgAction = resolveProfileActions({ isSelf: false, isOrgMember, inviteOptions: options });
    const emptyAction = resolveProfileActions({ isSelf: false, isOrgMember: true, inviteOptions: [] });
    const guest = guestProfileAction();
    for (const a of [orgAction, emptyAction, guest]) {
      expect(JSON.stringify(a)).not.toMatch(/"\/creator"/);
    }
  });

  it("partner-role members are not treated as org viewers", async () => {
    const d = deps({
      async listMemberships() {
        return [{ workspaceId: "ws-1", workspaceName: "Northstar", role: "PARTNER" }];
      },
    });
    const { isOrgMember, options } = await loadOrgInviteCampaigns(d, "creator-a", CREATOR);
    expect(isOrgMember).toBe(false);
    expect(options).toEqual([]);
    expect(resolveProfileActions({ isSelf: false, isOrgMember, inviteOptions: options })).toEqual({ kind: "neutral" });
  });

  it("cross-workspace isolation holds: only the viewer's own org workspaces are queried", async () => {
    const queried: string[] = [];
    const d = deps({
      async listMemberships() {
        return [
          { workspaceId: "ws-mine", workspaceName: "Mine", role: "ORGANIZATION_MEMBER" },
          { workspaceId: "ws-theirs", workspaceName: "Theirs", role: "PARTNER" },
        ];
      },
      async listCampaigns(workspaceId: string) {
        queried.push(workspaceId);
        return [{ id: `c-${workspaceId}`, state: "APPROVED" }];
      },
    });
    const { options } = await loadOrgInviteCampaigns(d, "owner-1", CREATOR);
    expect(queried).toEqual(["ws-mine"]);
    expect(options.map((o) => o.workspaceName)).toEqual(["Mine"]);
  });

  it("resolving actions performs reads only — no invite/referral/reservation/payout surface", async () => {
    const d = deps();
    await loadOrgInviteCampaigns(d, "owner-1", CREATOR);
    const writes = d.calls.filter((c) => /insert|create|invite|referral|reserv|payout|fund|accept|join/i.test(c));
    expect(writes).toEqual([]);
    expect(d.calls).toContain("listMemberships:owner-1");
  });

  it("failures degrade to neutral instead of breaking the public profile", async () => {
    const d = deps({
      async listMemberships() {
        throw new Error("db down");
      },
    });
    const { isOrgMember, options } = await loadOrgInviteCampaigns(d, "owner-1", CREATOR);
    expect(isOrgMember).toBe(false);
    expect(options).toEqual([]);
  });

  it("options are bounded and labels fall back without intent text", async () => {
    const d = deps({
      async listCampaigns() {
        return Array.from({ length: 30 }, (_, i) => ({ id: `c-${i}`, state: "APPROVED" }));
      },
      async getIntent() {
        return null;
      },
    });
    const { options } = await loadOrgInviteCampaigns(d, "owner-1", CREATOR);
    expect(options.length).toBeLessThanOrEqual(10);
    expect(options[0].label).toBe("Untitled campaign");
  });
});

describe("profile bridge wiring", () => {
  const profilePage = readFileSync("src/app/[handle]/page.tsx", "utf8");
  const creatorPage = readFileSync("src/app/creator/page.tsx", "utf8");
  const campaignPage = readFileSync("src/app/app/campaigns/[id]/page.tsx", "utf8");
  const panel = readFileSync("src/components/app/CreatorMatches.tsx", "utf8");

  it("self view gates the dashboard CTA on ownership and links /creator", () => {
    expect(profilePage).toMatch(/isSelf/);
    expect(profilePage).toMatch(/Open creator dashboard/);
    expect(profilePage).toMatch(/href=\{action\.dashboardHref\}/);
  });

  it("org view links into the existing campaign invitation flow (no second system)", () => {
    const bridge = readFileSync("src/server/services/profileActions.ts", "utf8");
    expect(profilePage).toMatch(/Work with this creator/);
    expect(profilePage).toMatch(/o\.href/);
    expect(bridge).toMatch(/\/app\/campaigns\//);
    expect(bridge).toMatch(/\?creator=/);
    expect(profilePage).not.toMatch(/createInvitation|insertInvitation/);
    expect(bridge).not.toMatch(/createInvitation|insertInvitation|insertReferral|insertReservation|insertPayout/);
  });

  it("logged-out view routes through /start without touching /creator", () => {
    const bridge = readFileSync("src/server/services/profileActions.ts", "utf8");
    expect(profilePage).toMatch(/action\.startHref/);
    expect(bridge).toMatch(/\/start\?role=organization/);
  });

  it("/creator keeps a visible public-profile back-link", () => {
    expect(creatorPage).toMatch(/View public profile/);
    expect(creatorPage).toMatch(/href=\{\`\/\$\{row\.handle\}\`\}/);
  });

  it("campaign page accepts the creator highlight and the panel applies it only to ranked rows", () => {
    expect(campaignPage).toMatch(/highlightCreatorUserId/);
    expect(campaignPage).toMatch(/\?creator=/);
    expect(panel).toMatch(/highlightCreatorUserId/);
  });

  it("no creator handle is hardcoded in the bridge", () => {
    for (const src of [profilePage, readFileSync("src/server/services/profileActions.ts", "utf8"), creatorPage]) {
      expect(src).not.toMatch(/bgirl/i);
    }
  });
});
